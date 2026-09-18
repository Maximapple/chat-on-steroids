import { statusForCaller } from '../agents.js';
import { runningToolProgress } from '../mcp/call-context.js';

/**
 * How long a worker's failure stays worth putting on the turn's wait caption.
 *
 * That caption answers "what is this turn waiting for". A failure is part of that answer while
 * the run is still going, and stops being one the moment it is only history — but the count it
 * came from never falls, so the caption stood indefinitely. Reported 2026-09-18 from the page:
 * `2 workers failed: … · 7 finished · 0 running · 2 failed`, unchanged across hours and three
 * Compact & Resume handoffs, naming two workers that had failed the previous day. Nothing was
 * running; nothing was being waited for; the line said otherwise every time it was read.
 *
 * A quarter of an hour is long enough that a failure is still the reason the turn looks odd,
 * and short enough that it cannot outlive the work it belonged to. The prime is told about each
 * failure separately and permanently; this is only the caption.
 */
const FAILED_WORKER_CAPTION_MS = 15 * 60_000;

/** Minimal presentation on the existing activity feed. No tasks, commands or identities leave the app. */
export function conversationProgress(conversationId: string, now = Date.now()) {
  let workers: { total: number; active: number; finished: number; failed: number; names: string[] } | null = null;
  try {
    const snapshot = statusForCaller({ conversationId });
    if (snapshot.self?.role === 'prime') {
      const list = snapshot.state.agents.filter(agent => agent.role === 'worker');
      const active = list.filter(agent => ['active', 'waking', 'detached'].includes(agent.state));
      // Recent ones only — see FAILED_WORKER_CAPTION_MS. A failure with no timestamp is counted:
      // absence of a time is not evidence that it is old, and dropping it would hide a fresh one.
      const failed = list.filter(agent => agent.state === 'failed' &&
        (agent.finishedAt === null || agent.finishedAt === undefined ||
          now < agent.finishedAt || now - agent.finishedAt < FAILED_WORKER_CAPTION_MS));
      if (list.length) workers = { total: list.length, active: active.length,
        finished: list.filter(agent => ['sleeping', 'finished'].includes(agent.state)).length,
        failed: failed.length,
        names: active.slice(0, 3).map(agent => (agent.label || 'Worker').slice(0, 60)) };
    }
  } catch { /* No enabled, exact broker owner means no worker claim for this conversation. */ }
  return { tools: runningToolProgress(conversationId), workers };
}
