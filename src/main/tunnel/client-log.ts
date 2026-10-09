/**
 * Where tunnel-client writes its log: a file in the run's own folder, followed like a pipe.
 *
 * Not a pipe, because the client may outlive this app for the restart handover (#1220): a Go
 * program exits on its next write to a broken stdout pipe, which is every pipe once this app
 * has quit. Its own module so the lifecycle tests can stand in a pipe for it.
 */
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import path from 'node:path';

export interface ClientLog {
  stdio: StdioOptions;
  /** Starts delivering the client's output; returns the function that stops it. */
  attach: (proc: ChildProcess, onChunk: (chunk: Buffer) => void) => () => void;
}

export function openClientLog(folder: string, index: number): ClientLog {
  const file = path.join(folder, `client-${index}.log`);
  const fd = openSync(file, 'a', 0o600);
  return {
    stdio: ['ignore', fd, fd],
    attach: (_proc, onChunk) => {
      // The child holds its own copy now.
      closeSync(fd);
      return followFile(file, onChunk);
    }
  };
}

/**
 * Follows a file the way a pipe would be read: new bytes as they are appended, from the start.
 *
 * tunnel-client logs into a file rather than a pipe so that it can outlive this app for the
 * restart handover (#1220): a Go program exits on its next write to a broken stdout pipe.
 */
export function followFile(file: string, onChunk: (chunk: Buffer) => void, everyMs = 200): () => void {
  let offset = 0;
  let reading = false;
  let stopped = false;
  const read = async (): Promise<void> => {
    if (reading || stopped) return;
    reading = true;
    try {
      const handle = await fs.open(file, 'r');
      try {
        for (;;) {
          const chunk = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
          if (!bytesRead || stopped) break;
          offset += bytesRead;
          onChunk(chunk.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Not written yet, or already removed with its folder.
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void read(), everyMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

