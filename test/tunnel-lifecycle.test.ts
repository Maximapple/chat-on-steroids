import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const children: any[] = [];

  const emitter = () => {
    const listeners = new Map<string, Listener[]>();
    return {
      on(name: string, listener: Listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return this;
      },
      once(name: string, listener: Listener) {
        const wrapped: Listener = (...args) => {
          listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== wrapped));
          listener(...args);
        };
        listeners.set(name, [...(listeners.get(name) ?? []), wrapped]);
        return this;
      },
      emit(name: string, ...args: any[]) {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
      }
    };
  };

  const spawn = vi.fn(() => {
    const events = emitter();
    const child: any = {
      ...events,
      pid: 10_000 + children.length,
      exitCode: null,
      stdout: emitter(),
      stderr: emitter(),
      kill: vi.fn()
    };
    children.push(child);
    return child;
  });

  const terminate = vi.fn(async (pid: number) => {
    const child = children.find((entry) => entry.pid === pid);
    if (child && child.exitCode === null) {
      child.exitCode = 0;
      // A real child emits both, and `exit` is the one the supervisors listen to for a crash.
      // Emitting only `close` would hide the exact race this fixture is used to reproduce: a
      // deliberate kill provoking the dead generation's own exit handler.
      child.emit('exit', 0);
      child.emit('close', 0);
    }
  });

  /**
   * A latch that parks `launch` inside the health-file cleanup it awaits before spawning.
   *
   * That await is the stop-during-launch seam: `launch` checks `stopped` before it, so a
   * Disconnect landing inside it used to be overtaken and a client spawned anyway. Reproducing
   * that needs the await held open across the `stop()` call, which real I/O does only by luck.
   */
  const rmGate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };

  return { children, spawn, terminate, rmGate };
});

vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
vi.mock('../src/main/exec.js', () => ({
  childEnv: () => ({}),
  terminateProcessTree: fixture.terminate
}));
vi.mock('../src/main/tunnel/locate.js', () => ({ locateBinary: () => 'cloudflared-test' }));
/**
 * The OpenAI path touches the real filesystem — a temp working directory, and a health-URL file it
 * clears before each launch and polls for afterwards. Real I/O settles on libuv's thread pool,
 * which `advanceTimersByTimeAsync` does not wait for, so under fake timers a launch would spawn at
 * an unpredictable point (observably: during a *later* test). These stubs make the same sequence
 * resolve on the microtask queue instead. `readFile` always fails, which is what "the client never
 * published a health URL" looks like and is what drives the ready-timeout branch under test.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      mkdtemp: async (prefix: string) => `${prefix}fixture`,
      rm: async () => {
        // One-shot: park only the launch being armed. `stop()` clears the working directory
        // through this same call, and gating that too would deadlock the test on its own latch.
        if (!fixture.rmGate.hold) return undefined;
        fixture.rmGate.hold = false;
        await new Promise<void>((resolve) => {
          fixture.rmGate.release = resolve;
        });
        return undefined;
      },
      readFile: async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }
    }
  };
});

const { startTunnel } = await import('../src/main/tunnel/index.js');

describe('cloudflared process ownership', () => {
  it('restarts a crashed generation, ignores its late output, and cancels restart on stop', async () => {
    vi.useFakeTimers();
    const reports: any[] = [];
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings: { kind: 'cloudflared', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
      apiKey: null,
      report: (report) => reports.push(report)
    });

    expect(fixture.children).toHaveLength(1);
    const first = fixture.children[0];
    first.stderr.emit('data', Buffer.from('INF https://first.trycloudflare.com\n'));
    expect(reports.at(-1)).toMatchObject({ state: 'connected', publicUrl: 'https://first.trycloudflare.com/secret' });

    first.exitCode = 1;
    first.emit('exit', 1);
    expect(reports.at(-1)).toMatchObject({ state: 'connecting-tunnel', publicUrl: null });
    expect(String(reports.at(-1)?.detail)).toContain('Reconnecting in 2s');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.children).toHaveLength(2);
    const second = fixture.children[1];
    first.stderr.emit('data', Buffer.from('INF https://stale.trycloudflare.com\n'));
    expect(reports.at(-1)?.publicUrl).not.toBe('https://stale.trycloudflare.com/secret');
    second.stderr.emit('data', Buffer.from('INF https://second.trycloudflare.com\n'));
    expect(reports.at(-1)).toMatchObject({ state: 'connected', publicUrl: 'https://second.trycloudflare.com/secret' });

    second.exitCode = 2;
    second.emit('exit', 2);
    await handle.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.children).toHaveLength(2);
    vi.useRealTimers();
  });
});

/**
 * The OpenAI client's supervisor, which had no generation fence at all.
 *
 * Cloudflared has carried one since it was written. This path did not, and the gap was reachable:
 * both of its failure branches killed the client and then called `retry`, while killing it makes
 * that same process emit `exit`, whose handler calls `retry` first. One failed generation was
 * therefore answered twice — `attempts` rose by two, so the backoff doubled per failure and hit
 * the ceiling in half the failures it should have, and the second call overwrote the first's
 * reason with the less useful exit text.
 *
 * Counting is the whole assertion. Both the buggy and the fixed version end up with one running
 * client, because each `retry` clears the previous timer; what differs is how many replacements
 * were scheduled to get there, which is visible in the backoff the user is shown.
 */
describe('openai tunnel-client generation ownership', () => {
  const settings = {
    kind: 'openai' as const,
    tunnelId: `tunnel_${'a'.repeat(32)}`,
    desktopTunnelId: '',
    binaryPath: ''
  };

  it('answers one failed generation with exactly one replacement', async () => {
    vi.useFakeTimers();
    const started = fixture.children.length;
    const reports: any[] = [];
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: (report) => reports.push(report)
    });

    // The health URL file is never written, so the client never reaches ready and the launch
    // loop runs to its 60s deadline — the second of the two paths that used to double-retry.
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.children.length).toBe(started + 1);

    // Past the 60s ready deadline but inside the 2s backoff it arms, so the replacement has been
    // scheduled and has not yet spawned. That gap is where the doubled `attempts` was visible.
    await vi.advanceTimersByTimeAsync(61_000);

    const reconnects = reports.filter((report) => String(report.detail).includes('Reconnecting in'));
    // Two here is the bug: one from the ready-timeout branch, one from the `exit` its own kill
    // provoked. The second would also have said 4s, having counted the same failure twice.
    expect(reconnects).toHaveLength(1);
    expect(String(reconnects[0].detail)).toContain('Reconnecting in 2s');
    // The reason the branch actually had, not the exit code its kill produced.
    expect(String(reconnects[0].detail)).toContain('did not become ready');
    // Still only the one client: the replacement is armed after the kill settles, never beside it.
    expect(fixture.children.length).toBe(started + 1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fixture.children.length).toBe(started + 2);

    await handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    // Nothing relaunches after Disconnect, including from a retirement that was already in flight.
    expect(fixture.children.length).toBe(started + 2);
    vi.useRealTimers();
  });

  it('does not spawn a client for a generation the user stopped mid-launch', async () => {
    vi.useFakeTimers();
    const started = fixture.children.length;
    fixture.rmGate.hold = true;
    const handle = await startTunnel({
      localUrl: 'http://127.0.0.1:1234/secret',
      settings,
      apiKey: 'sk-tunnel-test',
      report: () => {}
    });

    // `launch` checks `stopped` once, then awaits clearing the stale health file. It is parked in
    // that await now. A Disconnect landing here used to be overtaken: the spawn went ahead once
    // the await resolved, leaving a tunnel process the handle it came from no longer knew about.
    expect(fixture.children.length).toBe(started);
    await handle.stop();
    fixture.rmGate.release?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fixture.children.length).toBe(started);
    fixture.rmGate.hold = false;
    fixture.rmGate.release = null;
    vi.useRealTimers();
  });
});
