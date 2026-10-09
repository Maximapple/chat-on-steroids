import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';

const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
    return { on: () => undefined, unref: () => undefined };
  }
}));

const { configureHandover, saveHandover, takeHandover, reapLater, HANDOVER_MAX_AGE_MS } = await import('../src/main/tunnel/handover.js');

const token = 'A'.repeat(43);
const paths = { core: `/mcp/core/${token}`, desktop: `/mcp/desktop/${'b'.repeat(43)}` };

describe('tunnel restart handover (#1220)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('clf-handover-');
    configureHandover(dir);
    spawned.length = 0;
  });
  afterEach(async () => { await removeTempDir(dir); });

  it('hands the previous run\'s port and paths to the next start exactly once', async () => {
    await saveHandover({ port: 52011, paths }, 1_000);
    expect(await takeHandover(1_000 + 60_000)).toEqual({ port: 52011, paths, savedAt: 1_000 });
    expect(await takeHandover(1_000 + 60_000)).toBeNull();
    await expect(fs.access(path.join(dir, 'tunnel-handover.json'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('keeps the paths readable by their owner only', async () => {
    await saveHandover({ port: 52011, paths }, 1_000);
    expect((await fs.stat(path.join(dir, 'tunnel-handover.json'))).mode & 0o777).toBe(0o600);
  });

  it('treats an old handover as no restart, and deletes it', async () => {
    await saveHandover({ port: 52011, paths }, 1_000);
    expect(await takeHandover(1_000 + HANDOVER_MAX_AGE_MS + 1)).toBeNull();
    await expect(fs.access(path.join(dir, 'tunnel-handover.json'))).rejects.toThrow();
  });

  it.each([
    ['a privileged port', { port: 80, paths }],
    ['a path for another surface', { port: 52011, paths: { core: `/mcp/desktop/${token}` } }],
    ['a short token', { port: 52011, paths: { core: '/mcp/core/short' } }],
    ['a path outside /mcp', { port: 52011, paths: { core: `/admin/core/${token}` } }]
  ])('refuses %s', async (_name, handover) => {
    await saveHandover(handover, 1_000);
    expect(await takeHandover(2_000)).toBeNull();
  });

  it('refuses a file that is not a handover', async () => {
    await fs.writeFile(path.join(dir, 'tunnel-handover.json'), 'not json');
    expect(await takeHandover()).toBeNull();
  });

  it('ends a lingering client from a detached helper that outlives the app', () => {
    reapLater(4242, 150_000, 'darwin');
    reapLater(4242, 150_000, 'win32');
    expect(spawned[0]).toMatchObject({ command: '/bin/sh', options: { detached: true, stdio: 'ignore' } });
    expect(spawned[0]!.args[1]).toBe('sleep 150; kill -9 -4242 2>/dev/null || kill -9 4242 2>/dev/null');
    expect(spawned[1]).toMatchObject({ command: 'cmd.exe', options: { detached: true, stdio: 'ignore', windowsHide: true } });
    expect(spawned[1]!.args.at(-1)).toBe('ping -n 151 127.0.0.1 >nul & taskkill /PID 4242 /T /F >nul 2>&1');
  });
});

describe('tunnel-client log file (#1220)', () => {
  it('delivers appended output in order, from the start, until stopped', async () => {
    const { followFile } = await import('../src/main/tunnel/client-log.js');
    const dir = await makeTempDir('clf-client-log-');
    try {
      const file = path.join(dir, 'client-1.log');
      const seen: string[] = [];
      const stop = followFile(file, chunk => seen.push(chunk.toString()), 20);
      await new Promise(resolve => setTimeout(resolve, 60));
      await fs.appendFile(file, '{"msg":"one"}\n');
      await vi.waitFor(() => expect(seen.join('')).toBe('{"msg":"one"}\n'), { timeout: 2_000, interval: 20 });
      await fs.appendFile(file, '{"msg":"two"}\n');
      await vi.waitFor(() => expect(seen.join('')).toBe('{"msg":"one"}\n{"msg":"two"}\n'), { timeout: 2_000, interval: 20 });
      stop();
      await fs.appendFile(file, '{"msg":"three"}\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(seen.join('')).not.toContain('three');
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('runnable tunnel-client copy (#1220)', () => {
  it('runs a per-version copy on Windows so the installer can replace the bundled one', async () => {
    const dir = await makeTempDir('clf-runnable-');
    try {
      configureHandover(dir);
      const { runnableBinary } = await import('../src/main/tunnel/handover.js');
      const bundled = path.join(dir, 'tunnel-client.exe');
      await fs.writeFile(bundled, 'binary v1');
      const first = await runnableBinary(bundled, 'win32');
      expect(first).not.toBe(bundled);
      expect(await fs.readFile(first, 'utf8')).toBe('binary v1');
      expect(await runnableBinary(bundled, 'win32')).toBe(first);
      await fs.writeFile(bundled, 'binary v2, longer');
      const second = await runnableBinary(bundled, 'win32');
      expect(second).not.toBe(first);
      expect(await fs.readFile(second, 'utf8')).toBe('binary v2, longer');
      await expect(fs.access(first)).rejects.toThrow();
      expect(await runnableBinary(bundled, 'darwin')).toBe(bundled);
    } finally {
      await removeTempDir(dir);
    }
  });
});
