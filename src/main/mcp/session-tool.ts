/**
 * Model-facing access to the local recording.
 *
 * One tool, two operations:
 *  - search discovers recordings and finds which recording contains a term;
 *  - read returns an exact transcript/tool-call view of one explicit recording.
 *
 * No operation guesses the calling ChatGPT conversation. That is deliberate: cross-chat
 * recovery and concurrent-worker observation are the point of this surface, and making either
 * depend on browser identity recreates the 15-second identity wait this contract replaces.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SessionEvent, SessionSummary, StoredText } from '../../shared/session.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { getSession, listAllSessions, readEvents } from '../session/store.js';
import { noteCount, noteDetail } from './call-context.js';
import { expandStored, fail, guard, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';

const SEARCH_RESULT_TOKENS = 3_000;
const READ_RESULT_TOKENS = 5_000;
const SEARCH_RESULT_CHARS = SEARCH_RESULT_TOKENS * 4;
const READ_RESULT_CHARS = READ_RESULT_TOKENS * 4;
const SEARCH_ROWS = 30;
const SEARCH_SCAN_SESSIONS = 100;
const READ_BODY_CHARS = READ_RESULT_CHARS - 5_000;
const CURSOR_MAX_CHARS = 8_000;

const includeKind = z.enum(['user', 'assistant', 'tools', 'errors', 'agents']);
type IncludeKind = z.infer<typeof includeKind>;
const DEFAULT_INCLUDE: IncludeKind[] = ['user', 'assistant', 'tools', 'errors', 'agents'];

interface OpenMessageCheckpoint {
  id: string;
  chars: number;
  hash: string;
}

type SessionCursor =
  | { v: 1; kind: 'search'; query: string | null; offset: number }
  | {
      v: 1;
      kind: 'older';
      sessionId: string;
      beforeSeq: number;
      snapshot: number;
      include: IncludeKind[];
    }
  | {
      v: 1;
      kind: 'range';
      sessionId: string;
      mode: 'timeline' | 'update';
      startSeq: number;
      startOffset: number;
      originStartSeq: number;
      stopBeforeSeq: number | null;
      snapshot: number;
      include: IncludeKind[];
      olderBeforeSeq: number | null;
      after?: number;
      open?: OpenMessageCheckpoint[];
    }
  | {
      v: 1;
      kind: 'update';
      sessionId: string;
      after: number;
      include: IncludeKind[];
      open: OpenMessageCheckpoint[];
    }
  | {
      v: 1;
      kind: 'detail';
      sessionId: string;
      seq: number;
      offset: number;
      hash: string;
    };

interface TimelineItem {
  seq: number;
  event: SessionEvent;
  text: string;
  label: string;
}

interface SearchMatch {
  summary: SessionSummary;
  counts: Map<string, number>;
  anchorSeq: number | null;
  snapshot: number;
}

const cursorSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('search'),
    query: z.string().max(500).nullable(),
    offset: z.number().int().min(0)
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('older'),
    sessionId: z.string().min(8).max(64),
    beforeSeq: z.number().int().min(1),
    snapshot: z.number().int().min(0),
    include: z.array(includeKind).min(1).max(5)
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('range'),
    sessionId: z.string().min(8).max(64),
    mode: z.enum(['timeline', 'update']),
    startSeq: z.number().int().min(1),
    startOffset: z.number().int().min(0),
    originStartSeq: z.number().int().min(1),
    stopBeforeSeq: z.number().int().min(1).nullable(),
    snapshot: z.number().int().min(0),
    include: z.array(includeKind).min(1).max(5),
    olderBeforeSeq: z.number().int().min(1).nullable(),
    after: z.number().int().min(0).optional(),
    open: z
      .array(z.object({ id: z.string().max(160), chars: z.number().int().min(0), hash: z.string().length(16) }))
      .max(4)
      .optional()
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('update'),
    sessionId: z.string().min(8).max(64),
    after: z.number().int().min(0),
    include: z.array(includeKind).min(1).max(5),
    open: z
      .array(z.object({ id: z.string().max(160), chars: z.number().int().min(0), hash: z.string().length(16) }))
      .max(4)
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('detail'),
    sessionId: z.string().min(8).max(64),
    seq: z.number().int().min(1),
    offset: z.number().int().min(0),
    hash: z.string().length(16)
  })
]);

const inputSchema = z
  .object({
    action: z.enum(['search', 'read']).describe('search discovers recordings; read inspects one explicit recording.'),
    query: z.string().max(500).optional().describe('search only. Omit to list the 30 newest recordings.'),
    session_id: z.string().min(8).max(64).optional().describe('read only. Exact id returned by search.'),
    include: z
      .array(includeKind)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length, 'include entries must be unique')
      .optional()
      .describe('read only. Defaults to user, assistant, tools, errors and agents.'),
    tool_call: z
      .string()
      .regex(/^T[0-9A-Z]+$/i)
      .max(16)
      .optional()
      .describe('read only. Expand one short session-local tool reference such as T2F.'),
    cursor: z
      .string()
      .min(1)
      .max(CURSOR_MAX_CHARS)
      .optional()
      .describe('Opaque continuation, older-history, search-result or update checkpoint returned by this tool.')
  })
  .superRefine((input, ctx) => {
    if (input.action === 'search') {
      for (const field of ['session_id', 'include', 'tool_call'] as const) {
        if (input[field] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only valid with action=read` });
        }
      }
      if (input.cursor && input.query !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['query'], message: 'A search continuation cursor already contains its query' });
      }
      return;
    }

    if (!input.session_id) {
      ctx.addIssue({ code: 'custom', path: ['session_id'], message: 'session_id is required with action=read' });
    }
    if (input.query !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['query'], message: 'query is only valid with action=search' });
    }
    if (input.cursor && (input.include !== undefined || input.tool_call !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'A read cursor already contains its filters and mode; do not combine it with include or tool_call'
      });
    }
    if (input.tool_call && input.include !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['include'], message: 'include cannot be combined with tool_call' });
    }
  })
  .strict();

export function registerSessionTool(reg: SurfaceRegistrar): void {
  reg.register(
    'session',
    {
      title: 'Recorded sessions',
      description:
        'Search and read this app’s local recordings, including other and concurrently running chats. ' +
        'action=search lists the 30 newest sessions when query is omitted, or finds recordings containing a term. ' +
        'action=read requires session_id and returns exact user/assistant text plus compact tool headlines. ' +
        'Save update_cursor and pass it later to receive only activity not already read; pass a short T… reference as tool_call to inspect exact arguments and result.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) =>
      guard('session', async () => {
        if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Record sessions');
        if (input.action === 'search') return searchSessions(input.query, input.cursor);
        return readSession(input.session_id!, input.include, input.tool_call, input.cursor);
      })
  );
}

async function searchSessions(queryInput?: string, cursorInput?: string): Promise<ToolResult> {
  let query = queryInput?.trim() || null;
  let offset = 0;
  if (cursorInput) {
    const cursor = decodeCursor(cursorInput);
    if (!cursor || cursor.kind !== 'search') {
      return fail(
        'That search continuation is not one this app can still resolve — it has been evicted, ' +
          'or it was never a continuation this app issued. Repeat the search with query and no ' +
          'cursor.'
      );
    }
    query = cursor.query;
    offset = cursor.offset;
  }

  const sessions = await listAllSessions();
  if (sessions.length === 0) return ok('No recorded sessions exist on this machine yet.');
  if (offset >= sessions.length) return ok('No older recorded sessions remain.\nsearch_complete: true');

  const rows: string[] = [];
  let nextOffset = offset;
  let scanned = 0;
  if (!query) {
    while (nextOffset < sessions.length && rows.length < SEARCH_ROWS) {
      const row = formatSessionRow(sessions[nextOffset]!);
      if (rows.length > 0 && rowChars(rows, row) > SEARCH_RESULT_CHARS - 700) break;
      rows.push(row);
      nextOffset += 1;
    }
  } else {
    while (
      nextOffset < sessions.length &&
      scanned < SEARCH_SCAN_SESSIONS &&
      rows.length < SEARCH_ROWS
    ) {
      const summary = sessions[nextOffset]!;
      nextOffset += 1;
      scanned += 1;
      const match = await searchOneSession(summary, query);
      if (!match) continue;
      const row = formatSearchRow(match);
      if (rows.length > 0 && rowChars(rows, row) > SEARCH_RESULT_CHARS - 900) {
        nextOffset -= 1;
        break;
      }
      rows.push(row);
    }
  }

  const complete = nextOffset >= sessions.length;
  const next = complete ? null : encodeCursor({ v: 1, kind: 'search', query, offset: nextOffset });
  const heading = query
    ? `Recorded-session matches for ${JSON.stringify(query)} — newest sessions first`
    : 'Recorded sessions — newest first';
  const body = rows.length > 0 ? rows.join('\n\n') : query ? 'No matches in this scanned slice.' : 'No sessions in this slice.';
  const footer = [
    `sessions_returned: ${rows.length}`,
    query ? `sessions_scanned: ${scanned}` : null,
    `search_complete: ${complete}`,
    next ? `next_cursor: ${next}` : null
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
  noteCount(rows.length);
  noteDetail(complete ? 'complete' : 'more');
  return ok(boundResult(`${heading}\n\n${body}\n\n${footer}`, SEARCH_RESULT_CHARS));
}

async function searchOneSession(summary: SessionSummary, query: string): Promise<SearchMatch | null> {
  const needle = normaliseSearch(query);
  const counts = new Map<string, number>();
  let anchorSeq: number | null = null;
  let snapshot = 0;
  if (normaliseSearch(summary.title).includes(needle)) counts.set('title', 1);

  let events: SessionEvent[];
  try {
    events = await readEvents(summary.id);
  } catch {
    return counts.size > 0 ? { summary, counts, anchorSeq, snapshot } : null;
  }
  snapshot = maxSeq(events);
  for (const event of events) {
    const category = searchCategory(event);
    if (!category || !(await eventMatches(summary.id, event, needle))) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
    anchorSeq = event.seq;
  }
  return counts.size > 0 ? { summary, counts, anchorSeq, snapshot } : null;
}

function formatSessionRow(summary: SessionSummary): string {
  return (
    `${summary.id}  ${formatDate(summary.updatedAt)}  ${summary.endedAt === null ? 'active' : 'ended'}\n` +
    `  ${flat(summary.title, 180)}\n` +
    `  ${summary.userMessages} user · ${summary.toolCalls} tools · ${summary.events} events · ${summary.errors} errors`
  );
}

function formatSearchRow(match: SearchMatch): string {
  const parts = [...match.counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(' · ');
  const readCursor =
    match.anchorSeq && match.snapshot
      ? encodeCursor({
          v: 1,
          kind: 'range',
          sessionId: match.summary.id,
          mode: 'timeline',
          startSeq: match.anchorSeq,
          startOffset: 0,
          originStartSeq: match.anchorSeq,
          stopBeforeSeq: null,
          snapshot: match.snapshot,
          include: DEFAULT_INCLUDE,
          olderBeforeSeq: match.anchorSeq
        })
      : null;
  return (
    `${formatSessionRow(match.summary)}\n` +
    `  matches: ${parts}` +
    (readCursor ? `\n  read_cursor: ${readCursor}` : '')
  );
}

async function readSession(
  sessionId: string,
  includeInput?: IncludeKind[],
  toolCall?: string,
  cursorInput?: string
): Promise<ToolResult> {
  const summary = await getSession(sessionId);
  if (!summary) return fail(`Recorded session ${sessionId} does not exist.`);

  if (cursorInput) {
    const cursor = decodeCursor(cursorInput);
    if (!cursor || cursor.kind === 'search') {
      return fail(
        `That continuation is not one this app can still resolve — it has been evicted, or it was ` +
          `never a continuation this app issued. Read ${sessionId} again with no cursor to start ` +
          'from the newest activity.'
      );
    }
    if (cursor.sessionId !== sessionId) return fail('This cursor belongs to another recorded session.');
    if (cursor.kind === 'detail') return readToolDetail(sessionId, cursor.seq, cursor.offset, cursor.hash);
    if (cursor.kind === 'update') return readUpdate(summary, cursor);
    if (cursor.kind === 'older') return readOlder(summary, cursor);
    return readRange(summary, cursor);
  }

  if (toolCall) {
    const seq = toolRefSeq(toolCall);
    if (seq === null) return fail(`Invalid session-local tool reference ${toolCall}.`);
    return readToolDetail(sessionId, seq, 0, null);
  }

  const include = normaliseInclude(includeInput);
  const events = await readEvents(sessionId);
  const snapshot = maxSeq(events);
  const items = await timelineItems(sessionId, events.filter((event) => event.seq <= snapshot), include);
  if (items.length === 0) {
    const update = encodeCursor({
      v: 1,
      kind: 'update',
      sessionId,
      after: snapshot,
      include,
      open: []
    });
    return ok(
      `${sessionHeader(summary)}\n\nNo recorded entries match the selected categories.\n\n` +
        `caught_up: true\nupdate_cursor: ${update}`
    );
  }
  const startIndex = choosePageStart(items, items.length);
  const cursor: Extract<SessionCursor, { kind: 'range' }> = {
    v: 1,
    kind: 'range',
    sessionId,
    mode: 'timeline',
    startSeq: items[startIndex]!.seq,
    startOffset: 0,
    originStartSeq: items[startIndex]!.seq,
    stopBeforeSeq: null,
    snapshot,
    include,
    olderBeforeSeq: items[startIndex]!.seq
  };
  return readRangeFrom(summary, events, items, cursor, true);
}

async function readOlder(
  summary: SessionSummary,
  cursor: Extract<SessionCursor, { kind: 'older' }>
): Promise<ToolResult> {
  const events = await readEvents(summary.id);
  const items = await timelineItems(
    summary.id,
    events.filter((event) => event.seq <= cursor.snapshot),
    cursor.include
  );
  const stopIndex = items.findIndex((item) => item.seq === cursor.beforeSeq);
  if (stopIndex < 0) return fail('This older-history cursor is stale because its boundary changed. Start a new read.');
  if (stopIndex === 0) return ok(`${sessionHeader(summary)}\n\nBeginning of recorded history reached.`);
  const startIndex = choosePageStart(items, stopIndex);
  const range: Extract<SessionCursor, { kind: 'range' }> = {
    v: 1,
    kind: 'range',
    sessionId: summary.id,
    mode: 'timeline',
    startSeq: items[startIndex]!.seq,
    startOffset: 0,
    originStartSeq: items[startIndex]!.seq,
    stopBeforeSeq: cursor.beforeSeq,
    snapshot: cursor.snapshot,
    include: cursor.include,
    olderBeforeSeq: items[startIndex]!.seq
  };
  return readRangeFrom(summary, events, items, range, false);
}

async function readRange(
  summary: SessionSummary,
  cursor: Extract<SessionCursor, { kind: 'range' }>
): Promise<ToolResult> {
  const events = await readEvents(summary.id);
  const relevant =
    cursor.mode === 'update'
      ? events.filter((event) => event.seq > (cursor.after ?? 0) && event.seq <= cursor.snapshot).sort((a, b) => a.seq - b.seq)
      : events.filter((event) => event.seq <= cursor.snapshot);
  const items =
    cursor.mode === 'update'
      ? await updateItems(summary.id, relevant, cursor.include, cursor.open ?? [])
      : await timelineItems(summary.id, relevant, cursor.include);
  return readRangeFrom(summary, events, items, cursor, cursor.mode === 'timeline' && cursor.stopBeforeSeq === null);
}

async function readUpdate(
  summary: SessionSummary,
  cursor: Extract<SessionCursor, { kind: 'update' }>
): Promise<ToolResult> {
  const events = await readEvents(summary.id);
  const snapshot = maxSeq(events);
  if (snapshot <= cursor.after) {
    noteCount(0);
    return ok(
      `${sessionHeader(summary)}\n\nNo new recorded activity since checkpoint #${cursor.after}.\n\n` +
        `caught_up: true\nupdate_cursor: ${encodeCursor(cursor)}`
    );
  }
  const relevant = events.filter((event) => event.seq > cursor.after && event.seq <= snapshot).sort((a, b) => a.seq - b.seq);
  const items = await updateItems(summary.id, relevant, cursor.include, cursor.open);
  if (items.length === 0) {
    const next: Extract<SessionCursor, { kind: 'update' }> = { ...cursor, after: snapshot };
    return ok(
      `${sessionHeader(summary)}\n\nNo new selected activity since checkpoint #${cursor.after}.\n\n` +
        `caught_up: true\nupdate_cursor: ${encodeCursor(next)}`
    );
  }
  const range: Extract<SessionCursor, { kind: 'range' }> = {
    v: 1,
    kind: 'range',
    sessionId: summary.id,
    mode: 'update',
    startSeq: items[0]!.seq,
    startOffset: 0,
    originStartSeq: items[0]!.seq,
    stopBeforeSeq: null,
    snapshot,
    include: cursor.include,
    olderBeforeSeq: null,
    after: cursor.after,
    open: cursor.open
  };
  return readRangeFrom(summary, events, items, range, false);
}

async function readRangeFrom(
  summary: SessionSummary,
  allEvents: SessionEvent[],
  items: TimelineItem[],
  cursor: Extract<SessionCursor, { kind: 'range' }>,
  latestView: boolean
): Promise<ToolResult> {
  const startIndex = items.findIndex((item) => item.seq === cursor.startSeq);
  const originIndex = items.findIndex((item) => item.seq === cursor.originStartSeq);
  const stopIndex = cursor.stopBeforeSeq === null ? items.length : items.findIndex((item) => item.seq === cursor.stopBeforeSeq);
  if (startIndex < 0 || originIndex < 0 || stopIndex < 0 || startIndex >= stopIndex) {
    return fail('This read cursor is stale because the recorded snapshot changed. Start a new read.');
  }

  let body = '';
  let itemIndex = startIndex;
  let offset = cursor.startOffset;
  let continuation: Extract<SessionCursor, { kind: 'range' }> | null = null;
  while (itemIndex < stopIndex) {
    const item = items[itemIndex]!;
    if (offset > item.text.length) return fail('This read cursor points past the recorded entry. Start a new read.');
    const separator = body ? '\n\n' : '';
    const continuationLabel = offset > 0 ? `[continuation of ${item.label}]\n` : '';
    const room = READ_BODY_CHARS - body.length - separator.length - continuationLabel.length;
    if (room <= 0) break;
    const remaining = item.text.slice(offset);
    if (remaining.length > room) {
      const take = safeSliceLength(remaining, room);
      body += `${separator}${continuationLabel}${remaining.slice(0, take)}`;
      continuation = { ...cursor, startSeq: item.seq, startOffset: offset + take };
      break;
    }
    body += `${separator}${continuationLabel}${remaining}`;
    itemIndex += 1;
    offset = 0;
  }

  if (!continuation && itemIndex < stopIndex) {
    continuation = { ...cursor, startSeq: items[itemIndex]!.seq, startOffset: 0 };
  }
  const footer: string[] = [];
  if (continuation) {
    footer.push('caught_up: false', `continuation_cursor: ${encodeCursor(continuation)}`);
  } else {
    if (cursor.olderBeforeSeq !== null && originIndex > 0) {
      footer.push(
        `older_cursor: ${encodeCursor({
          v: 1,
          kind: 'older',
          sessionId: summary.id,
          beforeSeq: cursor.olderBeforeSeq,
          snapshot: cursor.snapshot,
          include: cursor.include
        })}`
      );
    }
    const reachesSnapshotEnd = cursor.stopBeforeSeq === null;
    if (reachesSnapshotEnd) {
      const open = await nextOpenCheckpoints(summary.id, allEvents, cursor, items, originIndex, stopIndex);
      footer.push(
        'caught_up: true',
        `update_cursor: ${encodeCursor({
          v: 1,
          kind: 'update',
          sessionId: summary.id,
          after: cursor.snapshot,
          include: cursor.include,
          open
        })}`
      );
    }
  }
  const heading = cursor.mode === 'update' ? `Session update after checkpoint #${cursor.after ?? 0}` : latestView ? 'Latest recorded context' : 'Recorded context';
  const output = `${sessionHeader(summary)}\n\n${heading}\n\n${body || '(no selected entries)'}\n\n${footer.join('\n')}`;
  noteCount(Math.max(0, itemIndex - startIndex + (body ? 1 : 0)));
  noteDetail(continuation ? 'continues' : cursor.mode === 'update' ? 'caught up' : 'page');
  return ok(boundResult(output, READ_RESULT_CHARS));
}

async function nextOpenCheckpoints(
  sessionId: string,
  allEvents: SessionEvent[],
  cursor: Extract<SessionCursor, { kind: 'range' }>,
  items: TimelineItem[],
  originIndex: number,
  stopIndex: number
): Promise<OpenMessageCheckpoint[]> {
  const open = new Map((cursor.open ?? []).map((entry) => [entry.id, entry]));
  const delivered = new Set(items.slice(originIndex, stopIndex).map((item) => item.seq));
  for (const event of allEvents) {
    if (event.kind !== 'assistant_message' || !event.messageId || !delivered.has(event.seq)) continue;
    if (event.final || event.state === 'final') open.delete(event.messageId);
    else {
      const exact = await expandStored(sessionId, event.message);
      open.set(event.messageId, {
        id: event.messageId,
        chars: exact.text.length,
        hash: shortHash(exact.text)
      });
    }
  }
  return [...open.values()].slice(-4);
}

async function timelineItems(
  sessionId: string,
  events: SessionEvent[],
  include: IncludeKind[]
): Promise<TimelineItem[]> {
  const selected = new Set(include);
  const items: TimelineItem[] = [];
  for (const event of events) {
    const item = await timelineItem(sessionId, event, selected);
    if (item) items.push(item);
  }
  return items;
}

async function timelineItem(
  sessionId: string,
  event: SessionEvent,
  include: ReadonlySet<IncludeKind>
): Promise<TimelineItem | null> {
  const when = formatTime(event.time);
  const agent = event.agent ? ` [${event.agent}]` : '';
  switch (event.kind) {
    case 'user_message': {
      if (!include.has('user')) return null;
      const message = await exactStored(sessionId, event.message);
      return item(event, `${when}${agent} USER\n${message}`, 'USER message');
    }
    case 'assistant_message': {
      if (!include.has('assistant')) return null;
      const unfinished = event.final || event.state === 'final' ? '' : ' [unfinished]';
      const message = await exactStored(sessionId, event.message);
      return item(
        event,
        `${when}${agent} ASSISTANT${unfinished}\n${message}`,
        'ASSISTANT message'
      );
    }
    case 'tool_call': {
      // A read of session A is itself recorded in the caller's session B after the result is
      // returned. Rendering those introspection calls would copy whole transcript pages back
      // into later transcript pages, and polling one's own update cursor could never become
      // quiet because every poll would present the previous poll. Keep the durable audit row,
      // but omit it from this model-facing projection and from discovery matching.
      if (event.call.tool === 'session') return null;
      if (!include.has('tools') && !(include.has('errors') && event.call.outcome !== 'ok')) return null;
      const metric = event.call.summary.metric ? ` · ${flat(event.call.summary.metric, 120)}` : '';
      const text =
        `${when}${agent} ${toolRef(event.seq)} ${event.call.tool} ${event.call.outcome.toUpperCase()} · ${event.call.durationMs} ms\n` +
        `${flat(event.call.summary.title, 600)}${metric}`;
      return item(event, text, `${toolRef(event.seq)} ${event.call.tool}`);
    }
    case 'page_tool':
      if (!include.has('tools')) return null;
      return item(event, `${when}${agent} ChatGPT native tool\n${event.label}`, 'native tool');
    case 'chat_error': {
      if (!include.has('errors')) return null;
      const message = await exactStored(sessionId, event.message);
      return item(event, `${when}${agent} ERROR\n${message}`, 'error');
    }
    case 'turn_end':
      if (!include.has('errors') || event.outcome === 'completed') return null;
      return item(
        event,
        `${when}${agent} TURN ${event.outcome.toUpperCase()}${event.detail ? `\n${event.detail}` : ''}`,
        'turn error'
      );
    case 'agent_message': {
      if (!include.has('agents')) return null;
      const message = await exactStored(sessionId, event.message);
      const route = event.delivery === 'sent' ? `${event.from} → ${event.to}` : `${event.from} → ${event.to} delivered`;
      return item(event, `${when} AGENT ${route}\n${message}`, 'agent message');
    }
    case 'handoff':
      return item(
        event,
        `${when} HANDOFF\n${event.chars} characters saved · reason: ${event.reason}`,
        'handoff'
      );
    default:
      return null;
  }
}

async function updateItems(
  sessionId: string,
  events: SessionEvent[],
  include: IncludeKind[],
  openInput: OpenMessageCheckpoint[]
): Promise<TimelineItem[]> {
  const open = new Map(openInput.map((entry) => [entry.id, entry]));
  const selected = new Set(include);
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.kind !== 'assistant_message' || !event.messageId || !selected.has('assistant')) {
      const regular = await timelineItem(sessionId, event, selected);
      if (regular) items.push(regular);
      continue;
    }
    const previous = open.get(event.messageId);
    if (!previous) {
      const regular = await timelineItem(sessionId, event, selected);
      if (regular) items.push(regular);
      continue;
    }
    const exact = await expandStored(sessionId, event.message);
    const text = exact.text;
    const prefixMatches =
      text.length >= previous.chars && shortHash(text.slice(0, previous.chars)) === previous.hash;
    const when = formatTime(event.time);
    const agent = event.agent ? ` [${event.agent}]` : '';
    const final = event.final || event.state === 'final';
    if (prefixMatches) {
      const suffix = text.slice(previous.chars);
      if (!suffix && final) {
        items.push(item(event, `${when}${agent} ASSISTANT finalized with no textual changes.`, 'ASSISTANT finalization'));
      } else if (suffix) {
        items.push(
          item(
            event,
            `${when}${agent} ASSISTANT CONTINUED${final ? ' [final]' : ' [unfinished]'}\n${suffix}${
              exact.complete ? '' : '\n[recording incomplete: overflow text is unavailable]'
            }`,
            'ASSISTANT continuation'
          )
        );
      }
      continue;
    }
    items.push(
      item(
        event,
        `${when}${agent} ASSISTANT REPLACED${final ? ' [final]' : ' [unfinished]'}\n` +
          'Discard the previously read unfinished version of this message.\n\n' +
          text +
          (exact.complete ? '' : '\n[recording incomplete: overflow text is unavailable]'),
        'ASSISTANT replacement'
      )
    );
  }
  return items;
}

async function readToolDetail(
  sessionId: string,
  seq: number,
  offset: number,
  expectedHash: string | null
): Promise<ToolResult> {
  const events = await readEvents(sessionId);
  const event = events.find((candidate) => candidate.seq === seq);
  if (!event || event.kind !== 'tool_call') return fail(`${toolRef(seq)} is not a recorded tool call in session ${sessionId}.`);
  const args = await expandStored(sessionId, event.call.args);
  const result = await expandStored(sessionId, event.call.result);
  const changes = event.call.changes?.length
    ? `\n\nChanges:\n${event.call.changes
        .map(
          (change) =>
            `- ${change.path}: +${change.added} -${change.removed}${change.approximate ? ' (approximate)' : ''}`
        )
        .join('\n')}`
    : '';
  const whole =
    `${toolRef(seq)} — ${event.call.tool}\n` +
    `Time: ${formatDate(event.time)}\nOutcome: ${event.call.outcome}\nDuration: ${event.call.durationMs} ms\n` +
    `Attribution: ${event.call.attribution}\n\n` +
    `Arguments (${event.call.args.chars} chars${args.complete ? '' : ', recording incomplete'}):\n${args.text}\n\n` +
    `Result (${event.call.result.chars} chars${result.complete ? '' : ', recording incomplete'}):\n${result.text}${changes}`;
  const hash = shortHash(whole);
  if (expectedHash && expectedHash !== hash) return fail('This tool-detail cursor is stale because the recorded call changed. Start the detail read again.');
  if (offset > whole.length) return fail('This tool-detail cursor points past the recorded call.');
  const room = READ_BODY_CHARS;
  const remaining = whole.slice(offset);
  const take = safeSliceLength(remaining, room);
  const chunk = remaining.slice(0, take);
  const nextOffset = offset + take;
  const footer =
    nextOffset < whole.length
      ? `\n\ncaught_up: false\ncontinuation_cursor: ${encodeCursor({
          v: 1,
          kind: 'detail',
          sessionId,
          seq,
          offset: nextOffset,
          hash
        })}`
      : '\n\ncaught_up: true';
  noteDetail(`${toolRef(seq)}${nextOffset < whole.length ? ' continues' : ''}`);
  return ok(boundResult(`${offset > 0 ? `[continuation of ${toolRef(seq)} ${event.call.tool}]\n` : ''}${chunk}${footer}`, READ_RESULT_CHARS));
}

function choosePageStart(items: TimelineItem[], stopIndex: number): number {
  let used = 0;
  let start = stopIndex;
  for (let index = stopIndex - 1; index >= 0; index--) {
    const cost = items[index]!.text.length + (start < stopIndex ? 2 : 0);
    if (used > 0 && used + cost > READ_BODY_CHARS) break;
    start = index;
    used += cost;
    if (used >= READ_BODY_CHARS) break;
  }
  return Math.max(0, Math.min(start, stopIndex - 1));
}

function searchCategory(event: SessionEvent): string | null {
  switch (event.kind) {
    case 'user_message':
      return 'user';
    case 'assistant_message':
      return 'assistant';
    case 'tool_call':
      if (event.call.tool === 'session') return null;
      return 'tools';
    case 'page_tool':
      return 'tools';
    case 'chat_error':
      return 'errors';
    case 'agent_message':
      return 'agents';
    default:
      return null;
  }
}

async function eventMatches(sessionId: string, event: SessionEvent, needle: string): Promise<boolean> {
  if (normaliseSearch(JSON.stringify(event)).includes(needle)) return true;
  for (const stored of eventStoredTexts(event)) {
    if (!stored.truncated) continue;
    const exact = await expandStored(sessionId, stored);
    if (normaliseSearch(exact.text).includes(needle)) return true;
  }
  return false;
}

function eventStoredTexts(event: SessionEvent): StoredText[] {
  switch (event.kind) {
    case 'user_message':
    case 'assistant_message':
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      return [event.message];
    case 'tool_call':
      return [event.call.args, event.call.result];
    default:
      return [];
  }
}

async function exactStored(sessionId: string, stored: StoredText): Promise<string> {
  const exact = await expandStored(sessionId, stored);
  return exact.text + (exact.complete ? '' : '\n[recording incomplete: overflow text is unavailable]');
}

function item(event: SessionEvent, text: string, label: string): TimelineItem {
  return { seq: event.seq, event, text, label };
}

function sessionHeader(summary: SessionSummary): string {
  return (
    `Session: ${summary.id}\nTitle: ${summary.title}\n` +
    `Started: ${formatDate(summary.startedAt)}\nUpdated: ${formatDate(summary.updatedAt)}\n` +
    `State: ${summary.endedAt === null ? 'active' : 'ended'}\n` +
    `Recorded: ${summary.userMessages} user · ${summary.toolCalls} tools · ${summary.events} events · ${summary.errors} errors`
  );
}

function normaliseInclude(input?: IncludeKind[]): IncludeKind[] {
  return input ? [...input] : [...DEFAULT_INCLUDE];
}

function maxSeq(events: readonly SessionEvent[]): number {
  let max = 0;
  for (const event of events) max = Math.max(max, event.seq);
  return max;
}

function toolRef(seq: number): string {
  return `T${seq.toString(36).toUpperCase()}`;
}

function toolRefSeq(ref: string): number | null {
  const match = /^T([0-9A-Z]+)$/i.exec(ref);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Continuations are handed out as a short reference, not as their own payload.
 *
 * A cursor is state, and it used to be transported by making the model copy it. The encoded
 * payload carries the session id, the mode, the sequence boundaries and one entry per partially
 * read assistant message, which measured 143 to 944 characters of base64 across twenty recorded
 * sessions — a median of 364. Every one of those characters had to be reproduced exactly, from
 * a string with no redundancy and no readable structure, and the failures show precisely what
 * that costs: of six failed `session` reads, five decoded to valid JSON with exactly one mutated
 * key — `snappshot`, `shopshot`, `sessiolId` twice, `startSSeq` — and the sixth stopped partway
 * through the blob. That is 8.3% of every call that carried a continuation, and the rate grows
 * with the length of the cursor, which grows as a chat is read.
 *
 * A twelve-character reference removes the transcription entirely: nothing about the state has
 * to survive a round trip through the model. The payload stays in this process, keyed by that
 * reference.
 *
 * What that trades away is a self-contained cursor, and both halves of the trade are paid for
 * here rather than assumed:
 *
 *  - *Restart.* An encoded payload survived the app being closed; a reference into a Map does
 *    not. So the map is snapshotted through the durable store, which is the same mechanism the
 *    pending-command queue uses for the same reason, and reloaded before the server serves. The
 *    cursor a chat is holding therefore still works tomorrow morning.
 *  - *Eviction.* The map is bounded, so some reference must eventually stop resolving, and
 *    insertion order is the wrong thing to evict by: a chat that has been paging one long
 *    recording for an hour would lose its place to a burst of newer chats. `recallCursor`
 *    therefore moves an entry to the end on every use, which makes the front of the map the
 *    least recently *used* reference — a claim the eviction test actually checks against a
 *    lowered cap. Across a restart the snapshot restores contents but not recency, which only
 *    costs an ordering, and at 300 live references a chat would have to sit unused through 300
 *    other continuations.
 *  - *Duplicates.* Identical state gets its existing reference back rather than a new one.
 *    Without that, a chat polling `caught_up: true` mints one reference per poll for a cursor
 *    that has not moved, and a single idle watcher would evict every other chat's place inside
 *    a few hundred polls. It also means a model that keeps re-sending the same continuation
 *    keeps seeing the same handle, which is what it already assumes.
 *
 * Base64 payloads issued before this change still decode, so a chat mid-read across an app
 * update is not broken; and a reference that has been evicted or predates the snapshot fails the
 * same way a corrupt payload always did, now saying which call resumes the read. Neither path
 * can return the wrong session's state: a decoded cursor is still checked against the requested
 * `session_id` by the caller.
 */
const CURSOR_MEMORY = new Map<string, string>();
/** payload -> ref, so identical state resolves to the reference already handed out for it. */
const CURSOR_REFS = new Map<string, string>();
const CURSOR_MEMORY_MAX = 300;
let cursorLimit = CURSOR_MEMORY_MAX;
const CURSOR_REF = /^c[0-9a-hjkmnp-tv-z]{12}$/;
const CURSOR_STATE = 'session-cursors';
const CURSOR_STATE_VERSION = 1;

interface PersistedCursors {
  version: number;
  entries: Array<[string, string]>;
}

/**
 * Snapshot the map. Debounced and coalescing in `durable.ts`, so a chat paging quickly writes
 * once rather than once per page, and a lost snapshot costs continuations, never history.
 */
function saveCursors(): void {
  writeDurableSoon(CURSOR_STATE, { version: CURSOR_STATE_VERSION, entries: [...CURSOR_MEMORY] });
}

let cursorsRestored = false;
let restoringCursors: Promise<void> | null = null;

/** Reloads the references handed out before the last shutdown. Idempotent; call before serving. */
export async function restoreSessionCursors(): Promise<void> {
  if (cursorsRestored) return;
  if (restoringCursors) return restoringCursors;
  restoringCursors = (async () => {
    const saved = await readDurable<PersistedCursors>(CURSOR_STATE);
    if (saved?.version === CURSOR_STATE_VERSION && Array.isArray(saved.entries)) {
      for (const entry of saved.entries.slice(-CURSOR_MEMORY_MAX)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
        if (!CURSOR_REF.test(entry[0]) || entry[1].length > CURSOR_MAX_CHARS) continue;
        // Decoded here rather than on use: a payload that cannot become a cursor is not one this
        // process ever issued, and keeping it would spend an eviction slot on garbage.
        if (decodePayload(entry[1]) === null) continue;
        CURSOR_MEMORY.set(entry[0], entry[1]);
        CURSOR_REFS.set(entry[1], entry[0]);
      }
    }
  })();
  try {
    await restoringCursors;
    cursorsRestored = true;
  } finally {
    restoringCursors = null;
  }
}

/** Crockford-style base32 without the characters that read as each other in a monospaced font. */
function cursorRef(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = randomBytes(12);
  let ref = 'c';
  for (const byte of bytes) ref += alphabet[byte % alphabet.length];
  return ref;
}

function encodeCursor(cursor: SessionCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const existing = CURSOR_REFS.get(payload);
  // Unchanged state keeps its handle. Only the recency order moves, which the snapshot does
  // not carry anyway, so this deliberately does not rewrite the state file on every poll.
  if (existing !== undefined && recallCursor(existing) !== undefined) return existing;
  let ref = cursorRef();
  while (CURSOR_MEMORY.has(ref)) ref = cursorRef();
  CURSOR_MEMORY.set(ref, payload);
  CURSOR_REFS.set(payload, ref);
  while (CURSOR_MEMORY.size > cursorLimit) {
    const leastRecentlyUsed = CURSOR_MEMORY.entries().next();
    if (leastRecentlyUsed.done) break;
    const [evictedRef, evictedPayload] = leastRecentlyUsed.value;
    CURSOR_MEMORY.delete(evictedRef);
    // Only if it still points at the evicted reference: a payload is one ref at a time.
    if (CURSOR_REFS.get(evictedPayload) === evictedRef) CURSOR_REFS.delete(evictedPayload);
  }
  saveCursors();
  return ref;
}

/** Looks a reference up and marks it as the most recently used, which is what bounds eviction. */
function recallCursor(ref: string): string | undefined {
  const payload = CURSOR_MEMORY.get(ref);
  if (payload === undefined) return undefined;
  CURSOR_MEMORY.delete(ref);
  CURSOR_MEMORY.set(ref, payload);
  return payload;
}

function decodePayload(payload: string): SessionCursor | null {
  try {
    const raw = Buffer.from(payload, 'base64url').toString('utf8');
    return cursorSchema.parse(JSON.parse(raw)) as SessionCursor;
  } catch {
    return null;
  }
}

function decodeCursor(value: string): SessionCursor | null {
  const trimmed = value.trim();
  const payload = CURSOR_REF.test(trimmed) ? recallCursor(trimmed) : trimmed;
  if (payload === undefined) return null;
  return decodePayload(payload);
}

/** Test-only: the map is process state, and a suite that fills it must be able to empty it. */
export function resetSessionCursorsForTests(): void {
  CURSOR_MEMORY.clear();
  CURSOR_REFS.clear();
  cursorLimit = CURSOR_MEMORY_MAX;
  cursorsRestored = false;
  restoringCursors = null;
}

/**
 * Test-only: the production bound is 300, and a test that filled it would prove the bound
 * rather than the eviction order. Lowering it is the only way to watch which entry goes.
 */
export function setSessionCursorLimitForTests(limit: number): void {
  cursorLimit = limit;
}

/** Test-only: eviction and recency are properties of the map, so a test has to be able to see it. */
export function sessionCursorRefsForTests(): string[] {
  return [...CURSOR_MEMORY.keys()];
}

function formatDate(time: number): string {
  return new Date(time).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function formatTime(time: number): string {
  return new Date(time).toISOString().slice(11, 19);
}

function flat(text: string, cap: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= cap ? value : `${value.slice(0, cap - 1)}…`;
}

function normaliseSearch(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}

function rowChars(rows: string[], next: string): number {
  return rows.reduce((total, row) => total + row.length + 2, 0) + next.length;
}

function safeSliceLength(text: string, wanted: number): number {
  let end = Math.max(0, Math.min(text.length, wanted));
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return Math.max(1, end);
}

function boundResult(text: string, cap: number): string {
  // Every producer reserves room for its cursor/footer before adding exact recorded content.
  // Never cut here: doing so could sever the very cursor needed to recover the remainder, or
  // silently shorten a user/assistant message. A missed budget calculation is a tool bug and
  // fails explicitly rather than returning a result that only looks complete.
  if (text.length > cap) throw new Error(`Session result exceeded its ${cap / 4}-token output budget`);
  return text;
}
