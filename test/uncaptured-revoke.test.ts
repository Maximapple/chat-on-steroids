/**
 * Withdrawing the uncaptured-caller authorisation, as a revocation rather than a preference.
 *
 * The setting used to change only what the *next* call was allowed to do. Everything the
 * principal had already started outlived the decision: a background `exec_command` kept running
 * under an authority the user had just removed, and the `authorized:uncaptured` workspace sat in
 * the map until its TTL, so re-enabling inside that window resumed the previous authorisation's
 * learned folder. A permission that can only be revoked for future calls is not revocable, so
 * what is pinned here is that the switch kills what it authorised.
 *
 * Three shapes, because the state that must die is created at three different moments:
 *
 *  - a session already published when the switch flips (the registry sweep),
 *  - a session still inside `exec_command`'s initial yield, so the sweep cannot see it and the
 *    call is about to publish it (the fence after exec returns),
 *  - and the same in-flight session across a true -> false -> true flap, where the setting reads
 *    enabled again by the time the call returns and only the authorisation epoch can tell that
 *    the grant the call was admitted under is gone.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHORIZED_UNCAPTURED_OWNER,
  execOwner,
  execOwnershipDenied,
  execProcessesOwnedBy,
  noteExecOwner,
  resetExecOwnershipForTests,
  revokeAuthorizedUncaptured
} from '../src/main/codex/ownership.js';
import { EXEC_OUTPUT_CEILING_POLICY, unifiedExecManager } from '../src/main/codex/manager.js';
import { applyUnifiedExecEnv } from '../src/main/codex/unified-exec.js';
import { AUTHORIZED_UNCAPTURED_PRINCIPAL } from '../src/main/mcp/call-context.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor, workspaceEntries, workspaceForChat } from '../src/main/workspace.js';

/** A child that will not exit on its own, so only termination can end it. */
const FOREVER = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];

let dir = '';
let endpoint: McpEndpoint | null = null;
const started: number[] = [];

afterEach(async () => {
  for (const processId of started.splice(0)) {
    await unifiedExecManager.terminateProcess(processId).catch(() => undefined);
  }
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  resetExecOwnershipForTests();
  resetWorkspaces();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  // Termination returns before Windows has necessarily released the child's handle on its cwd,
  // and the temp dir *is* that cwd. Retry rather than let a lagging handle fail an unrelated
  // assertion — and never swallow it, because a directory that stays busy means a child this
  // test believed it had killed is still running.
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  dir = '';
});

/** Starts a live background session on the shared manager and returns its published id. */
async function background(): Promise<number> {
  const processId = unifiedExecManager.allocateProcessId();
  const output = await unifiedExecManager.execCommand({
    command: FOREVER,
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'revocation fixture child',
    processId,
    yieldTimeMs: 250,
    maxOutputTokens: undefined,
    truncationPolicy: EXEC_OUTPUT_CEILING_POLICY,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
  expect(output.processId).toBe(processId);
  started.push(processId);
  return processId;
}

const live = (processId: number): boolean =>
  unifiedExecManager.listProcesses().some((item) => item.processId === processId);

describe('revoking the uncaptured-caller authorisation', () => {
  it('kills what that principal started and leaves proven chats untouched', async () => {
    const fallback = await background();
    const captured = await background();
    noteExecOwner(fallback, AUTHORIZED_UNCAPTURED_OWNER);
    noteExecOwner(captured, 'conv-captured');
    setWorkspaceFor(AUTHORIZED_UNCAPTURED_PRINCIPAL, { virtual: '/probe/fallback', real: process.cwd() });
    setWorkspaceFor('chat:conv-captured', { virtual: '/probe/captured', real: process.cwd() });

    expect(await revokeAuthorizedUncaptured()).toBe(1);

    // Terminal death is immediate, not deferred to the next call or to a TTL.
    expect(live(fallback)).toBe(false);
    expect(execOwner(fallback)).toBeNull();
    expect(execProcessesOwnedBy(AUTHORIZED_UNCAPTURED_OWNER)).toEqual([]);
    // Forgotten, not made anonymous: an unowned id is refused rather than adoptable.
    expect(execOwnershipDenied(fallback, null)).toBe(true);
    // And the folder that principal had learned is gone, so re-enabling starts clean.
    expect(workspaceEntries().map((entry) => entry.key)).toEqual(['chat:conv-captured']);

    // Nothing conversation-keyed moved.
    expect(live(captured)).toBe(true);
    expect(execOwner(captured)).toBe('conv-captured');
    expect(execOwnershipDenied(captured, 'conv-captured')).toBe(false);
    expect(workspaceForChat('conv-captured')?.virtual).toBe('/probe/captured');
  }, 30_000);
});

/** The real server, serving one approved root, with the fallback principal switched on. */
async function serve(): Promise<McpEndpoint> {
  dir = await validateNewRoot(await fs.mkdtemp(path.join(os.tmpdir(), 'clf-revoke-')), []);
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  await saveConfig({
    ...cfg,
    roots: [{ name: 'probe', path: dir }],
    readOnly: false,
    uncapturedCaller: { enabled: true }
  });
  return startMcpServer(() => ({
    roots: [{ name: 'probe', path: dir }],
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools: false
  }));
}

/** The server answers `tools/call` as one Streamable HTTP SSE frame. */
function sseJson(body: string): any {
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
  sessionId: number | null;
}

/** One anonymous `exec_command`: no conversation id, so the kernel admits it as the fallback. */
async function execCall(url: string, cmd: string, yieldMs: number): Promise<ExecReply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exec_command', arguments: { cmd, workdir: '/probe', yield_time_ms: yieldMs } }
    })
  });
  expect(response.status).toBe(200);
  const body = sseJson(await response.text());
  const structured = body.result?.structuredContent as { session_id?: number } | undefined;
  return {
    text: body.error?.message ?? body.result?.content?.find((part: any) => part.type === 'text')?.text ?? '',
    isError: Boolean(body.error) || body.result?.isError === true,
    sessionId: structured?.session_id ?? null
  };
}

/** A command that outlives the initial yield, so the call is still in flight when we flip. */
const SLEEP_CMD = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';

/** Exactly what `settings:save` does when the switch goes true -> false. */
async function disable(): Promise<void> {
  await saveConfig({ ...getConfig(), uncapturedCaller: { enabled: false } });
  await revokeAuthorizedUncaptured();
}

async function enable(): Promise<void> {
  await saveConfig({ ...getConfig(), uncapturedCaller: { enabled: true } });
}

describe('revoking while a fallback exec_command is still inside its initial yield', () => {
  it('refuses to publish the session the switch no longer authorises', async () => {
    endpoint = await serve();

    const inFlight = execCall(endpoint.url, SLEEP_CMD, 4_000);
    // Inside the yield: the ownership registry has nothing to sweep yet, so the sweep alone
    // could never see this session. The fence after exec returns is what must catch it.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(execProcessesOwnedBy(AUTHORIZED_UNCAPTURED_OWNER)).toEqual([]);
    await disable();

    const reply = await inFlight;
    expect(reply.isError, reply.text).toBe(true);
    expect(reply.text).toContain('uncaptured-caller access was turned off');
    expect(reply.sessionId).toBeNull();
    // The child is dead and nothing was recorded as owned by the withdrawn principal.
    expect(execProcessesOwnedBy(AUTHORIZED_UNCAPTURED_OWNER)).toEqual([]);
    expect(unifiedExecManager.listProcesses()).toEqual([]);
  }, 30_000);

  it('still refuses across a true -> false -> true flap, and lets a genuinely new call through', async () => {
    endpoint = await serve();

    const inFlight = execCall(endpoint.url, SLEEP_CMD, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await disable();
    // Back on before the call returns. The live setting now reads enabled again, so only the
    // epoch stamped when this call was admitted can tell that its grant was retired.
    await enable();

    const reply = await inFlight;
    expect(reply.isError, reply.text).toBe(true);
    expect(reply.text).toContain('uncaptured-caller access was turned off');
    expect(unifiedExecManager.listProcesses()).toEqual([]);

    // Re-enabling is a new grant, not a resurrection of the old one: a call admitted after it
    // works normally.
    const fresh = await execCall(endpoint.url, SLEEP_CMD, 300);
    expect(fresh.isError, fresh.text).toBe(false);
    expect(fresh.sessionId).not.toBeNull();
    started.push(fresh.sessionId as number);
    expect(execProcessesOwnedBy(AUTHORIZED_UNCAPTURED_OWNER)).toEqual([fresh.sessionId]);
  }, 30_000);
});
