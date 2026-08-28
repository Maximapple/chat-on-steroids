/**
 * The exec output budget as it survives the real handler wiring, over `tools/call`.
 *
 * `exec-output-budget.test.ts` pins the formatter, but it builds its own `ExecCommandToolOutput`
 * and therefore chooses the policy itself. That cannot see which constant `tools-core` actually
 * hands the process manager: a different policy at the handler would change how much output the
 * model really gets and leave every unit test passing.
 *
 * `max_output_tokens` no longer does anything — ChatGPT drops a tool result over roughly 10_000
 * tokens before the model reads it, so a larger budget could never be spent — so this pins both
 * halves of that decision through the server the connector really serves: the fixed default budget
 * is what a plain call gets, and a call still sending the retired parameter still runs, gets that
 * same budget, and is told the parameter was ignored.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';

/** Bytes the probe command writes to stdout. Comfortably past both budgets under test. */
const PROBE_BYTES = 200_000;

/**
 * Read a deterministic fixture from the approved workdir. This test is about retained output,
 * not shell formatting limits or setup-node discovery. macOS' shell printf rejects very large
 * field widths on some hosted images, while the same command succeeds under GNU/bash; letting
 * that platform detail decide whether the MCP call is an error defeats the purpose of the test.
 */
const PROBE_FILE = 'budget-output.txt';
const PROBE_CMD = process.platform === 'win32'
  ? `Get-Content -Raw -LiteralPath '${PROBE_FILE}'`
  : `cat '${PROBE_FILE}'`;

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function serve(): Promise<McpEndpoint> {
  // The real roots:add path persists validateNewRoot()'s canonical spelling. Hosted macOS
  // exposes temp paths through /var while realpath resolves them under /private/var, and some
  // Windows runners likewise expose temp directories through a redirected path. Injecting the
  // raw mkdtemp spelling here therefore creates a root production would never persist and makes
  // the sandbox correctly reject it as changed on disk before exec_command can test anything.
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-budget-')), []);
  await fs.writeFile(path.join(dir, PROBE_FILE), 'x'.repeat(PROBE_BYTES), 'utf8');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  await saveConfig({ ...cfg, roots: [{ name: 'probe', path: dir }], readOnly: false });
  return startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

/**
 * The server answers `tools/call` as a single Streamable HTTP SSE frame, so the JSON-RPC body
 * arrives in `data:` lines rather than as the whole response. Per the SSE spec several data lines
 * in one frame join with newlines.
 */
function sseJson(body: string): unknown {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  return JSON.parse(data === '' ? body : data);
}

interface ExecReply {
  text: string;
  isError: boolean;
}

/** One `exec_command` call, with whatever `extra` arguments the case is probing. */
async function execCall(url: string, extra: Record<string, unknown> = {}): Promise<ExecReply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'exec_command',
        arguments: { cmd: PROBE_CMD, workdir: '/probe', ...extra }
      }
    })
  });
  expect(response.status).toBe(200);
  const body = sseJson(await response.text()) as {
    error?: { message?: string };
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  // A schema rejection can surface as a JSON-RPC error or as an isError result depending on
  // where validation runs, and this test cares that it is refused, not which layer refused it.
  if (body.error) return { text: body.error.message ?? '', isError: true };
  return {
    text: body.result?.content?.find((part) => part.type === 'text')?.text ?? '',
    isError: body.result?.isError ?? false
  };
}

it('gives a plain exec_command call the fixed default output budget', async () => {
  endpoint = await serve();

  const reply = await execCall(endpoint.url);

  // The command really ran and really overflowed the budget.
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text).toContain('Process exited with code 0');
  expect(reply.text).toContain('Warning: truncated output');

  // DEFAULT_MAX_OUTPUT_TOKENS is 10_000, which is ~40 KB of retained output. Under the older
  // bytes:10_000 policy this would be ~10 KB, and under a 30_000-token budget ~120 KB, so the
  // window below fails if either the policy or the fixed default is changed by accident.
  expect(reply.text.length).toBeGreaterThan(30_000);
  expect(reply.text.length).toBeLessThan(60_000);
}, 30_000);

it('accepts a retired max_output_tokens, ignores its value, and says so', async () => {
  endpoint = await serve();

  // ChatGPT caches connector schemas, so conversations opened before the parameter was retired
  // keep sending it. Under `.strict()` that made the whole command fail with `Unrecognized key`
  // and produce no output at all. The key is taken and ignored instead, and the model is told in
  // the notes — it learns the parameter is gone without losing the command it actually ran.
  const reply = await execCall(endpoint.url, { max_output_tokens: 30_000 });

  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text).toContain('max_output_tokens is retired and was ignored');
  // The budget really is unmoved: 30_000 tokens would retain ~120 KB, the fixed default ~40 KB.
  expect(reply.text.length).toBeGreaterThan(30_000);
  expect(reply.text.length).toBeLessThan(60_000);
}, 30_000);
