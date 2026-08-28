/**
 * Connection adapters.
 *
 * The MCP server knows nothing about tunnels; it just serves a loopback URL. An
 * adapter's whole job is to make that URL reachable from ChatGPT and report state.
 * Adding another provider means adding one function here, not touching the tools.
 *
 * Two adapters ship:
 *  - openai: OpenAI's Secure MCP Tunnel. Outbound-only, nothing is published.
 *  - cloudflared: a generic HTTPS quick tunnel, for plans or accounts that cannot
 *    use the OpenAI tunnel. This one does create a public URL, so the secret path
 *    token in the URL is what keeps it private.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState, TunnelHealth, TunnelSettings } from '../../shared/types.js';
import { childEnv, terminateProcessTree } from '../exec.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { ago, POLL_FRESH_MS, readClientStatus, readPollHealth } from './health.js';
import { locateBinary } from './locate.js';

export interface TunnelReport {
  state: ConnectionState;
  detail: string;
  publicUrl?: string | null;
  /** Epoch ms of the last proven round trip to OpenAI, when the adapter knows one. */
  handshakeAt?: number | null;
  health?: TunnelHealth | null;
}

export interface TunnelStartOptions {
  /** Loopback MCP URL, including the secret path segment. */
  localUrl: string;
  settings: TunnelSettings;
  /** OpenAI control-plane API key, only for the openai adapter. */
  apiKey: string | null;
  /** Headers added only to tunnel-client's own MCP discovery/startup probes. */
  discoveryHeaders?: Record<string, string>;
  /**
   * Which connector this tunnel carries, for the log. Two of them run at once, so
   * without it every line appeared twice with nothing to say which one it was about.
   */
  label?: string;
  report: (report: TunnelReport) => void;
}

export interface TunnelHandle {
  stop: () => Promise<void>;
  /** Loopback base URL of the client's own health/metrics server, when it has one. */
  healthBase?: () => string | null;
}

export class TunnelError extends Error {}

export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

/**
 * Kills a child and everything it started. tunnel-client supervises cloudflared.
 *
 * Through the shared primitive rather than this module's own `spawn('taskkill')`, which
 * had the same defect the exec runner did and independently of it: the helper was looked
 * up on PATH, so an inherited path missing System32 meant the kill never started. That
 * failure arrives asynchronously as an `error` event, which the surrounding try/catch
 * could not reach and no listener handled — so the tunnel-client (and the cloudflared it
 * supervises) went on running while `stop()` reported success. terminateProcessTree uses
 * an absolute taskkill and falls back to signalling the pid directly.
 */
function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  void terminateProcessTree(pid).catch(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  });
}

/** Terminates an owned tunnel tree and waits for the child handle to observe exit. */
async function stopTree(child: ChildProcess | null, timeoutMs = 3_000): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('close', () => resolve());
  });
  await terminateProcessTree(child.pid).catch(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  });
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    let at = carry.indexOf('\n');
    while (at !== -1) {
      const line = carry.slice(0, at).trimEnd();
      carry = carry.slice(at + 1);
      if (line) onLine(line);
      at = carry.indexOf('\n');
    }
    if (carry.length > 16_384) carry = '';
  };
}

const AUTH_FAILURE = /\b(401|403|unauthorized|invalid[_ ]api[_ ]key|invalid_request_error|forbidden)\b/i;

/**
 * Errors that mean "this PC cannot reach OpenAI right now", as opposed to "the tunnel
 * is broken".
 *
 * tunnel-client polls the control plane continuously and retries these itself with its
 * own backoff, so they must change what the user is told without provoking a restart.
 * They are also the *only* signal that the connection is down: the client's /readyz is
 * a local health check that stays green throughout an outage, because from its point
 * of view nothing local has failed.
 */
const UNREACHABLE =
  /poll failed|no such host|dial tcp|i\/o timeout|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i;

/** Turns a Go network error into something worth showing a person. */
export function describeNetworkError(raw: string): string {
  if (/no such host|name resolution/i.test(raw)) return 'no internet connection';
  if (/connection (was )?(aborted|reset)|forcibly closed/i.test(raw)) return 'the connection dropped';
  if (/refused/i.test(raw)) return 'the connection was refused';
  if (/timeout/i.test(raw)) return 'the connection timed out';
  if (/network is (unreachable|down)|no route to host/i.test(raw)) return 'the network is unreachable';
  return 'a network error';
}

/** True when this machine can still resolve OpenAI's control plane. */
export function isUnreachableError(raw: string): boolean {
  return UNREACHABLE.test(raw);
}

export async function startTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  switch (opts.settings.kind) {
    case 'openai':
      return startOpenAiTunnel(opts);
    case 'cloudflared':
      return startCloudflared(opts);
    case 'manual':
      opts.report({
        state: 'connected',
        detail: 'Local server running. Expose it with your own tunnel and use the URL below.',
        publicUrl: null
      });
      return { stop: async () => {} };
    default:
      throw new TunnelError('Unknown connection type');
  }
}

// ------------------------------------------------------------------ OpenAI

/** How often /readyz is re-checked once the tunnel is up. */
const WATCH_INTERVAL_MS = 15_000;
/** How long a fresh tunnel-client gets to reach ready before we call it a failure. */
const READY_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
/** How often to look again while the control plane is unreachable. */
const OFFLINE_RECHECK_MS = 5_000;
/**
 * How long the client must go without complaining before we believe it is back.
 *
 * It has to exceed the client's own retry gap during an outage — observed at up to
 * ~20s — or the quiet between two failed retries would be mistaken for recovery.
 */
const RECOVERY_QUIET_MS = 30_000;
/**
 * How long a run of "cannot reach OpenAI" complaints must go without a completed poll
 * before the user is told the connection is down.
 *
 * One failed poll is not an outage. The client long-polls with a 30s timeout and retries
 * on its own backoff, so a single dropped read — routine on home Wi-Fi — used to flip the
 * UI to offline and log an alarming pair of lines, with "tunnel connected" following six
 * seconds later. Nothing had been wrong. What proves an outage is not the complaint, it
 * is the last *completed* poll failing to advance while the complaints keep coming, so a
 * run has to outlive a full poll cycle before it counts.
 */
const UNREACHABLE_CONFIRM_MS = 35_000;

/** A run of unreachable complaints not yet contradicted by a completed poll. */
export interface UnreachableRun {
  /** When the run began, or 0 when there is no run in progress. */
  since: number;
  /** The last completed poll known when it began; null if there had never been one. */
  handshakeBefore: number | null;
}

export const NO_OUTAGE: UnreachableRun = { since: 0, handshakeBefore: null };

/** True once a run has gone unanswered long enough to be an outage, not a retry. */
export function outageConfirmed(run: UnreachableRun, nowMs: number): boolean {
  return run.since !== 0 && nowMs - run.since >= UNREACHABLE_CONFIRM_MS;
}

/**
 * True when a poll has completed since the run began, which ends it.
 *
 * A run that started before the client had ever polled successfully ends on the first
 * success of any age; otherwise the timestamp has to have actually moved.
 */
export function outageRecovered(run: UnreachableRun, lastHandshake: number | null): boolean {
  if (run.since === 0 || lastHandshake === null) return false;
  return run.handshakeBefore === null || lastHandshake > run.handshakeBefore;
}

/**
 * Runs tunnel-client and keeps it running.
 *
 * The previous version reported "connected" once and then never looked again, so a
 * tunnel that died — or came up and later went unready — left the app claiming to be
 * connected while ChatGPT got nothing. Readiness is therefore re-checked on a timer
 * for as long as the connection is meant to be up, and a client that stops or goes
 * unready is restarted with backoff instead of being abandoned.
 */
async function startOpenAiTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('tunnel-client', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'tunnel-client was not found. Install it from github.com/openai/tunnel-client, or point at it in Connection settings.'
    );
  }
  if (!TUNNEL_ID_PATTERN.test(opts.settings.tunnelId)) {
    throw new TunnelError('Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.');
  }
  if (!opts.apiKey) {
    throw new TunnelError('Add your OpenAI tunnel API key first.');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-'));
  const healthFile = path.join(workDir, 'health.url');

  const args = [
    'run',
    '--control-plane.tunnel-id',
    opts.settings.tunnelId,
    '--health.listen-addr',
    '127.0.0.1:0',
    '--health.url-file',
    healthFile,
    '--log.format',
    'json',
    '--log.level',
    'info'
  ];

  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** Consecutive failed attempts, which is what the backoff grows on. */
  let attempts = 0;
  /**
   * Which client process a callback speaks for.
   *
   * Cloudflared already had this fence; this path did not, and the gap was a real double-retry.
   * `watch` answered an unready client with `await stopTree(child)` followed by `retry(...)` — but
   * stopping the tree makes that same process emit `exit`, whose listener calls `retry` first. One
   * failed generation therefore scheduled two replacements: `attempts` rose twice, so the backoff
   * doubled per failure and reached MAX_BACKOFF_MS in half the failures it should have, and the
   * second call overwrote the first's timer and its reason with the less useful exit text. The
   * ready-timeout path had the identical shape.
   *
   * It is also what makes a stale callback harmless. `clearTimeout` cannot cancel a `watch` tick
   * that has already begun, and such a tick resumes after its awaits holding `child` — which by
   * then may be the *next* client. Comparing the generation it was started for against the current
   * one is what stops a dead watch from killing its own replacement.
   */
  let generation = 0;
  /** Whether this generation's failure has already been answered. Reset by the next launch. */
  let finished = false;
  let lastError = '';
  /** Names this connector in the log, since core and desktop both run one of these. */
  const tag = opts.label ? `${opts.label} tunnel` : 'tunnel';
  /** When the client last said it could not reach the control plane. */
  let lastUnreachable = 0;
  let unreachableReason = '';
  /** The complaint run currently in progress, if any. See UNREACHABLE_CONFIRM_MS. */
  let run: UnreachableRun = NO_OUTAGE;
  /** Epoch ms of the last control-plane poll the client completed. The proof. */
  let lastHandshake: number | null = null;
  /** Poll errors already reported, so only new ones reach the log. */
  let pollErrors = 0;
  /** When the current client process reached ready, for the first-poll grace period. */
  let launchedAt = 0;
  /** The client's local health server, once it has published its port. */
  let healthBase: string | null = null;
  /** Last snapshot of what the client says about itself, for the UI. */
  let health: TunnelHealth | null = null;
  /** What the UI was last told, so a state is only re-reported when it changes. */
  let shown: 'connected' | 'offline' | null = null;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const showConnected = (): void => {
    const first = shown !== 'connected';
    shown = 'connected';
    if (first) logInfo(`${tag} connected`);
    // Re-reported on every tick, so the UI can show how fresh the proof is.
    opts.report({
      state: 'connected',
      detail: lastHandshake
        ? `Connected. Last verified handshake with OpenAI ${ago(lastHandshake)}. Pick the tunnel in ChatGPT.`
        : 'Connected. Pick the tunnel in ChatGPT.',
      handshakeAt: lastHandshake,
      health
    });
  };

  const showOffline = (): void => {
    if (shown === 'offline') return;
    shown = 'offline';
    logWarn(
      `${tag} offline: ${unreachableReason} (last verified handshake ${ago(lastHandshake)})`
    );
    opts.report({
      state: 'offline',
      detail: `This PC cannot reach OpenAI — ${unreachableReason}. Last verified handshake ${ago(lastHandshake)}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying on its own.`,
      handshakeAt: lastHandshake,
      health
    });
  };

  /**
   * Refreshes the snapshot the UI shows, from the two local endpoints the client
   * publishes. Called on the same tick that decides connected-vs-offline, so the
   * numbers on screen are never older than the state next to them.
   */
  const refreshHealth = async (base: string): Promise<number | null> => {
    const [poll, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    if (poll?.lastSuccessMs) lastHandshake = poll.lastSuccessMs;
    // A poll completing after the complaints began is proof the link came back, so the
    // run ends here and the blip is never shown to anyone.
    if (outageRecovered(run, lastHandshake)) run = NO_OUTAGE;
    health = {
      pollErrors: poll?.errors ?? null,
      uptimeSeconds: client?.uptimeSeconds ?? null,
      route: client?.route ?? null,
      probe: client?.probe ?? null,
      clientVersion: client?.version ?? null
    };
    if (poll && poll.errors !== null && poll.errors > pollErrors) {
      // Rate-limited by definition: only a rising count says anything new. Info, not
      // warn: the client retries these itself, and `showOffline` covers the case where
      // the retries stop working.
      logInfo(
        `${tag}: ${poll.errors - pollErrors} more poll error(s) from the control plane (${poll.errors} total)`
      );
      pollErrors = poll.errors;
    }
    return poll === null ? null : (poll.lastSuccessMs ?? 0);
  };

  /**
   * Records a "cannot reach OpenAI" complaint from the client's own log.
   *
   * Deliberately does not change what the user sees. The client retries these itself and
   * usually wins within seconds; `watch` is what decides, once the run has outlived a poll
   * cycle with nothing completing. One line per run is logged so a genuine outage still
   * leaves a trail, without a paragraph of Go socket text per attempt.
   */
  const noteUnreachable = (raw: string): void => {
    lastUnreachable = Date.now();
    unreachableReason = describeNetworkError(raw);
    if (run.since === 0) {
      run = { since: lastUnreachable, handshakeBefore: lastHandshake };
      logInfo(`${tag}: ${unreachableReason}; the client is retrying`);
    }
  };

  /**
   * Answers one failed generation with exactly one replacement.
   *
   * `retire` exists because claiming the failure and starting the replacement are not the same
   * moment. When the failure is "this client is broken", the old tree still has to be killed, and
   * `stopTree` can spend up to three seconds doing it — longer than the two-second first backoff.
   * Arming the timer up front therefore let a stuck old tree still be alive when its replacement
   * spawned, which breaks the invariant this whole path exists to keep: one owned tunnel process
   * at a time. The generation is claimed immediately, so the `exit` this kill provokes cannot
   * schedule a second replacement; the timer is armed only once the tree is actually gone.
   */
  const retry = (detail: string, from: number, retire?: () => Promise<void>): void => {
    // Exactly one replacement per failed generation, whichever caller notices the failure first.
    if (stopped || finished || from !== generation) return;
    finished = true;
    attempts += 1;
    shown = null;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempts - 1));
    opts.report({
      state: 'connecting-tunnel',
      detail: `${detail} Reconnecting in ${Math.round(wait / 1000)}s…`
    });
    clearTimer();
    if (!retire) {
      timer = setTimeout(() => void launch(), wait);
      return;
    }
    void (async () => {
      await retire().catch(() => {});
      // Disconnect during the kill is the case this re-check is for: `stop()` has already run
      // `clearTimer`, and arming a fresh one afterwards would relaunch a tunnel the user stopped.
      if (stopped || from !== generation) return;
      clearTimer();
      timer = setTimeout(() => void launch(), wait);
    })();
  };

  /**
   * Watches the client for as long as it is meant to be up.
   *
   * Two different failures have to be told apart. A client that goes unready is broken
   * and gets restarted. A client that cannot reach OpenAI is fine and is already
   * retrying — restarting it would only slow the recovery down — so that one is
   * reported and waited out. /readyz cannot distinguish them, because it stays green
   * while the machine is offline.
   *
   * What can distinguish them is the client's own poll metric: the timestamp of the
   * last control-plane poll that actually completed. Fresh means a live round trip to
   * OpenAI happened within the last poll cycle, which is the only honest basis for
   * saying "connected". The log lines only supply the wording for *why* it is down.
   */
  const watch = (base: string, from: number): void => {
    clearTimer();
    timer = setTimeout(
      () => {
        void (async () => {
          if (stopped || from !== generation) return;
          const ready = await probe(`${base}/readyz`);
          // Re-checked after every await: this tick may have been overtaken by a replacement
          // while the probe was in flight, and `child` would then be the new client.
          if (stopped || from !== generation) return;
          if (!ready.ok) {
            logWarn(`${tag} went unready: ${ready.detail}`);
            // Claim the retry before stopping the tree, not after. Stopping it makes this same
            // process emit `exit`, and whichever call arrives first is the one that decides the
            // backoff and the reason the user is shown — so the reason worth showing goes first
            // and the exit listener finds the generation already answered.
            retry(ready.detail || 'The tunnel stopped responding.', from, () => stopTree(child));
            return;
          }

          const read = await refreshHealth(base);
          if (stopped || from !== generation) return;

          // A client that has only just started may not have completed its first poll
          // yet; that is not an outage, so it gets one poll cycle of grace.
          const since = lastHandshake ?? launchedAt;
          const stale =
            read === null
              ? Date.now() - lastUnreachable < RECOVERY_QUIET_MS
              : Date.now() - since > POLL_FRESH_MS || outageConfirmed(run, Date.now());

          if (stale) {
            if (!unreachableReason) unreachableReason = 'it stopped answering';
            showOffline();
          } else {
            showConnected();
          }
          watch(base, from);
        })();
      },
      shown === 'offline' ? OFFLINE_RECHECK_MS : WATCH_INTERVAL_MS
    );
  };

  const launch = async (): Promise<void> => {
    if (stopped) return;
    clearTimer();
    // A new client is a new generation: callbacks left over from the previous one now fail their
    // fence, and this one has not yet been answered.
    const mine = ++generation;
    finished = false;
    lastError = '';
    // A stale URL from the previous run would otherwise be read as this run's.
    await fs.rm(healthFile, { force: true }).catch(() => {});
    // Disconnect can land inside that await. Without this the stop would be overtaken and a fresh
    // client spawned after the user had already stopped the tunnel, with nothing left to kill it.
    if (stopped || mine !== generation) return;

    opts.report({
      state: 'connecting-tunnel',
      detail: attempts === 0 ? 'Starting tunnel client…' : 'Reconnecting…'
    });

    // The API key goes in the child's environment, never on the command line, so it
    // cannot be read out of the process list by other software on the machine.
    const discoveryHeaders = Object.entries(opts.discoveryHeaders ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join(', ');
    const proc = spawn(binary, args, {
      // Keep both credentials and the secret local MCP path out of argv/process listings.
      // tunnel-client officially supports these environment-backed configuration fields.
      env: childEnv({
        CONTROL_PLANE_API_KEY: opts.apiKey ?? '',
        MCP_SERVER_URL: `url=${opts.localUrl},channel=main`,
        ...(discoveryHeaders ? { MCP_DISCOVERY_EXTRA_HEADERS: discoveryHeaders } : {})
      }),
      windowsHide: true,
      // Own a POSIX process group so stopTree terminates any helpers the client starts.
      // Windows uses taskkill /T and keeps its existing launch semantics.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = proc;

    let done = false;

    const handleLine = (line: string): void => {
      if (AUTH_FAILURE.test(line)) {
        // A bad key or tunnel ID will not fix itself, so this one is terminal.
        done = true;
        stopped = true;
        clearTimer();
        killTree(proc);
        opts.report({
          state: 'auth-failed',
          detail: 'The tunnel rejected the API key or tunnel ID. Check both in Connection settings.'
        });
        return;
      }

      // tunnel-client emits structured JSON. Do not treat the mere presence of an
      // `error` field as an ERROR-level event: some healthy startup WARN records carry
      // internal diagnostics there. In particular, loopback Harpoon auto-registration
      // warnings are followed by a healthy /readyz and are not actionable for users.
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const level = String(event['level'] ?? '').toUpperCase();
        const message = String(event['msg'] ?? 'tunnel-client event');
        if (
          level === 'WARN' &&
          message === 'harpoon host auto-registration failed' &&
          event['inclusion_reason'] === 'loopback'
        ) {
          return;
        }
        if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
          const errText = event['error'] ? String(event['error']) : '';
          lastError = `${level} ${message}${errText ? `: ${errText}` : ''}`.slice(0, 400);
          if (isUnreachableError(message) || isUnreachableError(errText)) {
            // Retry chatter. noteUnreachable logs one plain line per run rather than a
            // socket dump per attempt, and the state it leads to is decided in `watch`.
            noteUnreachable(errText || message);
          } else {
            logWarn(`${tag}: ${lastError}`);
          }
        }
        return;
      } catch {
        // Older clients or crash paths may still print plain text.
      }
      if (/\b(error|fatal|warn)\b/i.test(line)) {
        lastError = line.slice(0, 400);
        if (isUnreachableError(line)) noteUnreachable(line);
        else logWarn(`${tag}: ${lastError}`);
      }
    };

    proc.stdout.on('data', lineReader(handleLine));
    proc.stderr.on('data', lineReader(handleLine));

    proc.on('exit', (code) => {
      if (stopped || proc !== child) return;
      done = true;
      logWarn(`${tag} client exited with code ${code}`);
      retry(lastError || `Tunnel client stopped (exit ${code}).`, mine);
    });

    proc.on('error', (err) => {
      if (stopped || proc !== child) return;
      done = true;
      logError(`${tag} client failed to start: ${err.message}`);
      retry(`Could not start tunnel-client: ${err.message}`, mine);
    });

    // /readyz on the client's own health server is the authoritative "it works"
    // signal; the process being alive proves nothing.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!done && !stopped && Date.now() < deadline) {
      const base = await readHealthUrl(healthFile);
      if (base) {
        const ready = await probe(`${base}/readyz`);
        if (ready.ok) {
          attempts = 0;
          shown = null;
          healthBase = base;
          launchedAt = Date.now();
          pollErrors = 0;
          run = NO_OUTAGE;
          await refreshHealth(base);
          if (Date.now() - lastUnreachable < RECOVERY_QUIET_MS) showOffline();
          else showConnected();
          watch(base, mine);
          return;
        }
        lastError = ready.detail || lastError;
      }
      await delay(1000);
    }
    if (!done && !stopped) {
      // Same order as the unready path above, and for the same reason: the timeout is the reason
      // worth reporting, and stopping the tree would otherwise let the exit listener report first.
      retry(lastError || 'The tunnel did not become ready within 60 seconds.', mine, () => stopTree(proc));
    }
  };

  void launch();

  return {
    healthBase: () => healthBase,
    stop: async () => {
      stopped = true;
      clearTimer();
      await stopTree(child);
      child = null;
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function readHealthUrl(file: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    return text.startsWith('http') ? text.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

interface ProbeResult {
  ok: boolean;
  /** The body tunnel-client returned, which names the reason it is not ready. */
  detail: string;
}

async function probe(url: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    // /readyz answers 503 with the reason in the body — "oauth discovery failed: …",
    // "mcp probe failed: …" — which is far more useful than a generic message.
    const body = await res.text().catch(() => '');
    return { ok: res.ok, detail: body.trim().slice(0, 200) };
  } catch {
    return { ok: false, detail: '' };
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- cloudflared

async function startCloudflared(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('cloudflared', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'cloudflared was not found. It ships alongside tunnel-client, or install it from Cloudflare, then point at it in Connection settings.'
    );
  }

  const local = new URL(opts.localUrl);
  const origin = `${local.protocol}//${local.host}`;

  const args = [
    'tunnel',
    '--no-autoupdate',
    '--url',
    origin,
    // Without this the origin would see the public trycloudflare hostname and our
    // loopback Host check would reject the request.
    '--http-host-header',
    local.host
  ];

  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempts = 0;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const launch = (): void => {
    if (stopped) return;
    clearTimer();
    let connected = false;
    let finished = false;
    let lastError = '';
    opts.report({
      state: 'connecting-tunnel',
      detail: attempts === 0 ? 'Starting cloudflared…' : 'Reconnecting cloudflared…'
    });

    const proc = spawn(binary, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Tunnel providers need the ordinary OS environment, never credentials inherited
      // from a terminal that happened to launch Electron.
      env: childEnv()
    });
    child = proc;

    const retry = (detail: string): void => {
      if (stopped || finished || proc !== child) return;
      finished = true;
      attempts += 1;
      const wait = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (attempts - 1));
      opts.report({
        state: 'connecting-tunnel',
        detail: `${detail} Reconnecting in ${Math.round(wait / 1000)}s…`,
        publicUrl: null
      });
      clearTimer();
      timer = setTimeout(launch, wait);
      timer.unref?.();
    };

    const handleLine = (line: string): void => {
      if (stopped || finished || proc !== child) return;
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
      if (match && !connected) {
        connected = true;
        attempts = 0;
        clearTimer();
        const publicUrl = `${match[0]}${local.pathname}`;
        logInfo('quick tunnel connected');
        opts.report({
          state: 'connected',
          detail: 'Connected. Paste the URL below into ChatGPT as a custom connector.',
          publicUrl
        });
        return;
      }
      if (/\berr\b|\berror\b|\bfatal\b/i.test(line)) {
        lastError = line.slice(0, 400);
        logWarn(`cloudflared: ${lastError}`);
      }
    };

    proc.stdout.on('data', lineReader(handleLine));
    proc.stderr.on('data', lineReader(handleLine));
    proc.on('exit', (code) => {
      if (stopped || finished || proc !== child) return;
      logWarn(`cloudflared stopped with code ${code}`);
      retry(lastError || `cloudflared stopped (exit ${code}).`);
    });
    proc.on('error', (err) => {
      if (stopped || finished || proc !== child) return;
      logWarn(`cloudflared failed to start: ${err.message}`);
      retry(`Could not start cloudflared: ${err.message}.`);
    });

    timer = setTimeout(() => {
      if (stopped || finished || connected || proc !== child) return;
      const detail = lastError || 'cloudflared did not report a public URL within 45 seconds.';
      // Fence the exit callback before killing this timed-out generation; otherwise its exit
      // and the timeout would each schedule a replacement.
      finished = true;
      void stopTree(proc).finally(() => {
        if (stopped || proc !== child) return;
        finished = false;
        retry(detail);
      });
    }, 45_000);
    timer.unref?.();
  };

  launch();

  return {
    stop: async () => {
      stopped = true;
      clearTimer();
      const owned = child;
      child = null;
      await stopTree(owned);
    }
  };
}
