/**
 * Restart handover for the tunnel route (#1220).
 *
 * After the app restarts, OpenAI keeps routing calls from chats that already used the connector
 * to the previous tunnel-client process for about two minutes; new chats reach the new process
 * at once. tunnel-client keeps that routing state (its shard token) in memory only and sends no
 * goodbye when it stops, so nothing the new process can do shortens the window.
 *
 * What does shorten it: the previous process keeps running for that window and keeps forwarding
 * to the local MCP server, which the new app serves on the same port and paths. The old app
 * writes both here on quit; the new app takes them once, within a few minutes, and a detached
 * reaper ends the lingering process on its own whether or not a new app ever starts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** How long the previous tunnel-client keeps forwarding after a quit: past OpenAI's ~120 s route. */
export const TUNNEL_LINGER_MS = 150_000;
/** A handover older than this is not a restart; the next start makes fresh paths as usual. */
export const HANDOVER_MAX_AGE_MS = 5 * 60_000;

export interface EndpointHandover {
  port: number;
  /** Each surface's secret base path, `/mcp/<surface>/<token>`. */
  paths: Record<string, string>;
  savedAt: number;
}

const PATH = /^\/mcp\/[a-z]+\/[A-Za-z0-9_-]{43}$/;
let file: string | null = null;
let dataDir: string | null = null;

/** Where the handover lives: the app's private data directory, set once at startup. */
export function configureHandover(directory: string): void {
  dataDir = directory;
  file = path.join(directory, 'tunnel-handover.json');
}

/**
 * The tunnel-client to start. On Windows a running executable cannot be replaced, and the
 * previous one keeps running through an update, so the installer would fail on the bundled
 * copy: run a copy kept in the app's data folder instead, one per binary version.
 */
export async function runnableBinary(binary: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform !== 'win32' || !dataDir) return binary;
  try {
    const stat = await fs.stat(binary);
    const root = path.join(dataDir, 'tunnel-bin');
    const version = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    const target = path.join(root, version, path.basename(binary));
    const existing = await fs.stat(target).catch(() => null);
    if (existing?.size !== stat.size) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.copyFile(binary, temporary);
      await fs.rename(temporary, target);
    }
    // Older versions go once nothing runs them; a copy still in use simply stays until next time.
    for (const entry of await fs.readdir(root).catch(() => [] as string[])) {
      if (entry !== version) await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
    }
    return target;
  } catch {
    return binary;
  }
}

export async function saveHandover(handover: Omit<EndpointHandover, 'savedAt'>, now = Date.now()): Promise<void> {
  if (!file) return;
  const body = JSON.stringify({ ...handover, savedAt: now } satisfies EndpointHandover);
  // The paths are the local server's credentials: owner-only, and replaced atomically.
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** The previous run's endpoint, once. Read and deleted together; anything doubtful is null. */
export async function takeHandover(now = Date.now()): Promise<EndpointHandover | null> {
  if (!file) return null;
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch { return null; }
  await fs.rm(file, { force: true }).catch(() => {});
  try {
    const value = JSON.parse(text) as Partial<EndpointHandover>;
    const paths = value.paths && typeof value.paths === 'object' ? value.paths : null;
    if (!Number.isInteger(value.port) || value.port! < 1024 || value.port! > 65535 || !paths ||
        !Number.isFinite(value.savedAt) || now - value.savedAt! < 0 || now - value.savedAt! > HANDOVER_MAX_AGE_MS ||
        !Object.entries(paths).every(([surface, base]) => typeof base === 'string' && PATH.test(base) && base.startsWith(`/mcp/${surface}/`))) return null;
    return { port: value.port!, paths: paths as Record<string, string>, savedAt: value.savedAt! };
  } catch {
    return null;
  }
}

/**
 * Ends `pid` (and on POSIX its process group) after `ms`, from a detached helper that outlives
 * this app. The lingering tunnel-client is never this app's to forget: if no new app starts, it
 * still goes.
 */
export function reapLater(pid: number, ms: number, platform: NodeJS.Platform = process.platform, folder?: string): void {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  // The folder is the client's own temporary one (its log file); removed once the client is gone.
  const quoted = folder && /^[^"'$`\\\r\n]+$/.test(folder) ? folder : null;
  const child = platform === 'win32'
    // `timeout` needs a console; ping waits about one second per echo request without one.
    ? spawn('cmd.exe', ['/d', '/c', `ping -n ${seconds + 1} 127.0.0.1 >nul & taskkill /PID ${pid} /T /F >nul 2>&1` +
      (quoted ? ` & ping -n 3 127.0.0.1 >nul & rmdir /s /q "${quoted}"` : '')],
      { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', `sleep ${seconds}; kill -9 -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null` +
      (quoted ? `; rm -rf '${quoted}'` : '')],
      { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
