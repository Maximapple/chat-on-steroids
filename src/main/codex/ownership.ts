/**
 * Which ChatGPT conversation owns a live `exec_command` session.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * conversation cannot even name another conversation's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere, and `write_stdin(session_id)`
 * on a numeric id from another chat would otherwise reach that chat's shell.
 *
 * This is an authorization boundary. A proven owner can only be continued by that same proven
 * conversation. Legacy/single-chat calls that carry no request identity are kept in a separate
 * anonymous bucket so existing terminal semantics still work, but a later proven chat cannot
 * adopt such a session and an anonymous call cannot touch a proven-owned session.
 */

import { requestCorrelation } from '../session/correlation.js';
import { advanceUncapturedAuthorization, resetUncapturedAuthorizationForTests } from '../mcp/call-context.js';
import { clearUncapturedWorkspace } from '../workspace.js';
import { unifiedExecManager } from './manager.js';

/** A terminal owner which is explicit but is not, and can never impersonate, a conversation. */
export const AUTHORIZED_UNCAPTURED_OWNER = '@authorized-uncaptured';

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, string | null>();

/**
 * The conversation behind an in-flight MCP request, when it is already proven.
 *
 * Never waits. The correlation registry resolves a request id the moment the page reports the
 * matching connector request, and everything here degrades to "unknown" rather than blocking a
 * command on browser evidence.
 */
export function provenConversation(requestId: string | null, conversationId: string | null): string | null {
  if (conversationId) return conversationId;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

/** Captured proof always wins; the fallback owner exists only when the user authorised it. */
export function execCallerOwner(
  requestId: string | null,
  conversationId: string | null,
  authorizedUncaptured = false
): string | null {
  return provenConversation(requestId, conversationId) ??
    (authorizedUncaptured ? AUTHORIZED_UNCAPTURED_OWNER : null);
}

/** Records the conversation that opened a still-running exec session. */
export function noteExecOwner(processId: number | null, conversationId: string | null): void {
  if (processId === null) return;
  owners.set(processId, conversationId);
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
}

/** The conversation that opened this session, or null when it was never proven. */
export function execOwner(processId: number): string | null {
  return owners.get(processId) ?? null;
}

/**
 * Whether `conversationId` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Anonymous sessions can only be continued by
 * anonymous callers; they are never adoptable by a later identified conversation. A process
 * with no registry entry at all is refused.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  if (!owners.has(processId)) return true;
  const owner = owners.get(processId);
  if (owner === null) return conversationId !== null;
  if (!conversationId) return true;
  return owner !== conversationId;
}

/**
 * Moves live process authority with a proven Compact & Resume chat A→B transition.
 *
 * Conversation ownership is the current representation used by the shared process manager.
 * Until it can be keyed directly by durable session principal, continuation publication must
 * move the processes opened by the old chat along with the session. This hook changes exactly
 * owners equal to `fromConversationId`: anonymous legacy sessions and processes belonging to
 * every other chat are untouched. It is app-internal and carries no discovery/wire surface.
 */
export function moveExecConversationOwners(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  for (const [processId, owner] of owners) {
    if (owner !== fromConversationId) continue;
    owners.set(processId, toConversationId);
    moved += 1;
  }
  return moved;
}

/** Every live session opened under one owner. Revocation is the only bulk question asked here. */
export function execProcessesOwnedBy(owner: string): number[] {
  const owned: number[] = [];
  for (const [processId, held] of owners) if (held === owner) owned.push(processId);
  return owned;
}

/**
 * Withdraws the authorised-uncaptured principal, immediately rather than prospectively.
 *
 * Turning the switch off used to change only what the *next* call was allowed to do: the config
 * flag stopped `execCallerOwner` minting the fallback owner, and that was the whole of it. Two
 * pieces of state outlived the decision. A background `exec_command` already owned by
 * `@authorized-uncaptured` kept running — the user had withdrawn the authority under which it was
 * started and the process carried on regardless — and the `authorized:uncaptured` workspace stayed
 * in the map for up to its twelve-hour TTL, so flipping the switch back on inside that window
 * resumed with the previous authorisation's learned folder instead of a clean one.
 *
 * A permission that can be revoked only for future calls is not really revocable, so this is the
 * revoke: kill what that principal started, forget that it owned it, and drop its workspace.
 *
 * Ownership is forgotten whether or not termination succeeded, and that direction is deliberate.
 * `execOwnershipDenied` refuses any process id it has no entry for, so a session this failed to
 * kill becomes unreachable rather than becoming anonymous and adoptable. Nothing here reads or
 * writes a conversation-keyed entry, so captured owners and their workspaces are untouched.
 */
export async function revokeAuthorizedUncaptured(): Promise<number> {
  // First, and before anything is enumerated. Any fallback call still inside its initial yield is
  // holding the previous grant, so advancing here is what makes it stale — including one that
  // returns during this very function, which the registry sweep below could never have seen.
  advanceUncapturedAuthorization();
  const processIds = execProcessesOwnedBy(AUTHORIZED_UNCAPTURED_OWNER);
  // Settled, not all: one session that refuses to die must not leave the rest running, and a
  // revocation that throws half-way through would leave the registry describing a state that is
  // neither the old one nor the new one.
  await Promise.allSettled(processIds.map((processId) => unifiedExecManager.terminateProcess(processId)));
  for (const processId of processIds) forgetExecOwner(processId);
  clearUncapturedWorkspace();
  return processIds.length;
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
  resetUncapturedAuthorizationForTests();
}
