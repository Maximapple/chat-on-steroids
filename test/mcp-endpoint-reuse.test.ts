/**
 * #1220: after a restart the previous tunnel-client still forwards to the previous local port
 * and paths for a short while. The new server serves them when it can, and fresh ones when not.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath } from '../src/main/config.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';

let dir = '';
const endpoints: McpEndpoint[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.stop().catch(() => undefined);
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function start(reuse: Parameters<typeof startMcpServer>[1] = null): Promise<McpEndpoint> {
  const cfg = defaultConfig();
  const endpoint = await startMcpServer(() => ({ roots: [], caps: cfg.capabilities, readOnly: true }), reuse);
  endpoints.push(endpoint);
  return endpoint;
}

const pathsOf = (endpoint: McpEndpoint) =>
  Object.fromEntries(Object.entries(endpoint.urls).map(([surface, url]) => [surface, new URL(url).pathname]));

it('serves the previous run\'s port and paths when it takes them over', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-reuse-'));
  initConfigPath(dir);
  const first = await start();
  const handover = { port: first.port, paths: pathsOf(first) };
  await first.stop();
  endpoints.splice(endpoints.indexOf(first), 1);

  const second = await start(handover);
  expect(second.port).toBe(handover.port);
  expect(pathsOf(second)).toEqual(handover.paths);
});

it('falls back to a fresh port and fresh paths when the old port is taken', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-mcp-reuse-'));
  initConfigPath(dir);
  const first = await start();
  const handover = { port: first.port, paths: pathsOf(first) };
  await first.stop();
  endpoints.splice(endpoints.indexOf(first), 1);
  const squatter = net.createServer();
  squatter.listen(handover.port, '127.0.0.1');
  await once(squatter, 'listening');
  try {
    const second = await start(handover);
    expect(second.port).not.toBe(handover.port);
    for (const [surface, base] of Object.entries(pathsOf(second))) expect(base).not.toBe(handover.paths[surface]);
  } finally {
    squatter.close();
  }
});
