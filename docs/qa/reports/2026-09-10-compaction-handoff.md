# Compact & Resume: three defects behind a handoff that never lands

Field report and fix brief, 2026-09-09 / 2026-09-10. Written to be actioned directly.

**Status, 2026-09-10 evening.** Five defects, found while chasing one symptom.

| # | Defect | State |
|---|---|---|
| 1 | The claim outlives the command that made it | fixed, branch pushed |
| 2 | A restart orphans an open compaction | analysed, **not patched** — needs a decision (§4) |
| 3 | The replacement chat's permit is refused while its tab loads | fixed, **verified in production** (§4b) |
| 4 | The silence watchdog never escalates | **fixed** — verified 2026-09-11 (§4c) |
| 5 | The brief stays in the composer after a successful send | **open**, hypothesis only (§7) |
| 6 | Unwedging a broken chat is left to the user, though the app can already do it | **open** (§4d) |
| 7 | Session asset quota exceeded — evidence silently dropped | **open** (§4e) |

Defect 3 was the one that produced the visible symptom most often — a replacement chat that opens
and stays empty. Since the build carrying its fix, three consecutive handoffs have committed
cleanly. Defects 4 and 5 are what is left.

Identifiers below are abbreviated; conversation ids, session ids and absolute paths are
redacted as `<chat-A>`, `<session>`, `<home>`. Command ids are app-internal and kept as-is
because the log and the durable records have to line up.

---

## 1. Symptom

An automatic compaction produces its handoff brief, then never lands it. The app opens a
fresh ChatGPT tab, the tab stays on its `?clf=<id>` marker URL forever, and nothing else
happens. Fifteen minutes later the app gives up on that tab and opens another. Repeat until
the pickups are spent.

From the outside this is indistinguishable from "the extension is broken": no error, no ack,
no log line, an empty composer, and a chat card stuck on `Opening…`.

Observed on macOS 15 / app + extension 2.0.8, Chrome with the unpacked companion loaded.

## 2. What the evidence ruled out

Each of these was checked and is **not** the cause. Listed because they are the obvious
suspects and cost hours:

| Suspect | Evidence against |
|---|---|
| Extension not connected | Chrome held two ESTABLISHED TCP connections to `127.0.0.1:8765`; app was LISTEN |
| Service worker dead | Its `chrome.storage` LevelDB was being written seconds before each check |
| Content script not injected | `chrome.tabs.sendMessage(tabId, {type:'clf-recorder-ping'})` → `{ok: true, recorderVersion: 11}` |
| Tab discarded / frozen | `chrome.tabs.query` reported `status: 'complete', discarded: false` |
| Memory pressure | 51 % free of 24 GB; Chrome 2.3 GB across 13 processes |
| Project route (`/g/<id>/project`) | No `/g/` URL anywhere in Chrome's session; `project: null` in the durable record |
| SPA redirect stealing the marker | Address bar still showed `?clf=…#clf=…` after load |
| A draft blocking the bootstrap | Composer empty in both the marker tab and the source chat |
| Stale destination permit | `destinationSend.state` was `not-attempted`, so `beginContinuationDestinationSendNow` would have allowed it |

## 2b. Method — how the decisive evidence was obtained

Four hypotheses were formed by reading the source and all four were wrong. What settled it was
instrumenting the shipped extension, not reading it. Recorded here because the technique is
reusable and nothing else worked.

`content.js` funnels every message to the service worker through one function, `ask()`. Wrapping
it to append `{type, ok, error, flags, url}` to `chrome.storage.local` gives a complete
page↔worker transcript. The extension is loaded unpacked, so the file can be edited in place at
`<home>/Library/Application Support/chat-on-steroids/extension/content.js`; reload the extension
in `chrome://extensions` afterwards, and restore the file when finished. The store is readable
straight off disk — no console, no browser automation — under
`<chrome-profile>/Local Extension Settings/<extension-id>/`, as JSON inside the LevelDB files.

Two traps, both hit on the first attempt:

1. **Key collisions.** Every document writes the same key with its *own* in-memory array, so a
   busy tab overwrites a quiet one. The source chat polls about once a second; the replacement
   chat writes twice. Use a per-document key, or accept that only the newest write survives.
2. **Reading the store.** Several historical values of the key are present in the LevelDB files
   at once. Taking the *largest* array finds the noisy tab and silently discards the two lines
   that matter. Enumerate every occurrence and read them all.

## 3. Defect 1 — the claim outlives the command that made it (FIXED)

### Mechanism

Redeeming a resume is what *claims* its brief. `claimContinuationNow(token, claimant)`
records the redeeming **command id** as `claimedBy`, so a second tab on the same marker
cannot be handed the same handoff twice:

```ts
// src/main/session/continuation.ts
if (entry.claimedBy !== null && entry.claimedBy !== claimant) return null;
```

An *automatic* ticket then deliberately outlives a failed attempt. `drop()` retires the
command but keeps the ticket, precisely so a later pickup can try again:

```ts
// src/main/bridge.ts, drop()
if (automaticResume) {
  commands = commands.filter((entry) => entry !== command);
  logWarn(`bridge: released ${specKey(command.spec)} browser attempt without closing its ticket — ${why}`);
  ...
}
```

The claim was **not** retired with it. Every later pickup is a fresh command id, which can
therefore never equal the `claimedBy` the dead command left behind. `claimContinuationNow`
refuses for the rest of the ticket's six-hour TTL, the command is handed out with an empty
brief, and the page stops without typing, without an ack and without a log line.

`releaseContinuationDestinationSendNow` is already exactly this transition, and its own
comment states the requirement:

> *The claim goes with the dispatch. It named the one command whose page was to send the
> brief; that page has sent nothing and its command is retired, so the next command — a fresh
> id — must be able to claim, or the released brief could never be offered again.*

It was only ever reached from the `/compact destinationLost` route — which a page sends
**after surviving its send**. A page that dies before one never sends it.

### Field evidence

`<home>/Library/Application Support/chat-on-steroids/state/continuations.json`, hours after
the first tab was closed:

```json
{
  "state": "claimed",
  "claimedBy": "253b3fcea4dce828",
  "handoffId": "2026-09-09-92d3cf4c",
  "sourceSend":      { "state": "sent", "messageId": "…" },
  "destinationSend": { "state": "not-attempted", "conversationId": null, "messageId": null }
}
```

`253b3fcea4dce828` was the command from pickup 1. The live command at that moment was
`1cf2cea330d67876`. `destinationSend` never left `not-attempted`, so nothing was ever
submitted under that claim.

The app log, with the heartbeats filtered out — four attempts, no acks, no failures:

```
20:24:51  handoff 2026-09-09-… prepared (54275 characters)
20:24:51  captured the compaction brief for <session>; opening the replacement chat
20:39:52  released resume:<session> browser attempt without closing its ticket — the chat this app opened did not report back in time
20:40:04  compaction ticket … opening pickup 1 of 3
20:40:05  opening a fresh ChatGPT chat for resume:<session>
20:55:06  released … did not report back in time
20:55:35  compaction ticket … opening pickup 2 of 3
20:55:35  opening a fresh ChatGPT chat for resume:<session>
```

### Fix

Branch `fix/wedged-compaction-recovery`, commit `db2678d`.

`drop()` takes the same transition, gated on `destinationSend` still being `not-attempted`,
so it can only release a brief that provably was not submitted. A dispatched one is left
exactly as before, because releasing that is the double send the function already refuses
for `sent`.

Regression test in `test/bridge.test.ts`:
`lets the next pickup claim a brief whose first chat died before typing anything`.

It drives the real bridge: an automatic ticket, a page that redeems and then never reports,
the command's deadline, and a second pickup that must still carry the same brief. Against
the previous `bridge.ts` the second redeem is refused with **409**.

## 4. Defect 2 — a restart orphans an open compaction (NOT FIXED — needs a decision)

### What is intentional

`compactionWatchFloor` is set to `Date.now()` when the bridge starts serving:

```ts
// src/main/bridge.ts
goalWatchFloor = Date.now();
compactionWatchFloor = goalWatchFloor;
```

and `compactionStillChased()` returns false for any entry opened before it. This is
deliberate, and the comment above it names this exact scenario:

> *…a continuation restored from disk has no watch and never will have one… That is the same
> wedged chat this exists to release, reached by the commoner route — the app was restarted
> while a handoff was open, which is exactly how the machine that reported it got there.*

The design is: don't chase it, but let `inspectSilentChats` reload the source chat, and let
the reloaded page pick the ticket back up through `maybeResumePendingCompaction()`.

### The residual gap (suspected, not proven)

In the field that rescue never fired. The app restarted at 21:05:12 and logged
`bridge: restored 1 chat command(s) from the previous run`; from then until the ticket was
manually cancelled there was no pickup, no reload, and no further log line at all.

**Hypothesis to verify:** `inspectSilentChats` only iterates `activeUntil`, which is an
in-memory map populated by page activity. A fresh process has no grant for the source chat,
so the chat is never considered, and the designed rescue can never run for exactly the case
the comment says it exists for.

**What to check first** (do not patch before this is confirmed):

1. Instrument or unit-test `inspectSilentChats` with an empty `activeUntil` and one restored
   automatic continuation whose `openedAt` predates the floor. Assert whether any reload is
   queued. If none is, the gap is real.
2. If real, the narrow fix is to seed a grant — or to consider restored continuations
   directly — for chats named by commands restored from the previous run. Those are
   obligations this run *did* accept: the app says so in its own restore log line. Do **not**
   simply lower the floor; that would resurrect arbitrarily old tickets, which is what the
   floor exists to prevent.

## 4b. Defect 3 — the replacement chat's permit is refused while its tab is still loading (FIXED)

**This is the one that produces the common symptom: a replacement chat opens, and nothing is
ever typed into it.** Independent of defects 1 and 2, and by far the most frequent.

### Mechanism

`content.js` asks the app for permission before the irreversible send:

```js
const permit = await ask({ type: 'compact', token, destinationAttempt: true });
if (!permit || permit.ok !== true || !permit.data || permit.data.allowed !== true) {
  CLF_DOM.clearPromptExact(boot.text);
  return;                               // silent: no ack, no log, empty composer
}
```

The service worker never forwards it. Its route guard, in the `compact` handler:

```js
if (!ownsDocument(source) || !tab || tab.pendingUrl || tab.status === 'loading' ||
    !isChatGptUrl(tab.url) || conversationFromUrl(tab.url) !== cleanConversationId(message.conversationId))
  return { ok: false, error: 'stale_document' };
```

That guard is written for checkpoints that *name* a chat: the tab has to prove it settled on
that exact route. The two destination checkpoints name none — they come from a page opened at
`/?clf=<id>`, before ChatGPT has created anything — and a ChatGPT opened seconds ago is still
`loading`. So the normal case is refused.

Nothing downstream can see it, because the refusal is the worker's own and no request reaches
the app. `content.js` reads any non-ok reply as a denied permit; `fail()` would travel the same
call, so no ack escapes either. The app waits out its deadline and reports
`the chat this app opened did not report back in time`, which names the timeout, not the cause.

### Field evidence

Trace from the replacement tab itself, shipped extension 2.0.8, 2026-09-10:

```json
{"at":"04:39:55.218","type":"redeem","ok":true,"hasCommand":true,"textLen":48975,"url":"/?clf=42c8b63e3001a081"}
{"at":"04:39:58.262","type":"compact","flags":["destinationAttempt"],"ok":false,"error":"stale_document","url":"/?clf=42c8b63e3001a081"}
```

The brief was delivered in full and thrown away three seconds later. Four consecutive handoffs
failed exactly this way. The timing explains why this is intermittent rather than total: whether
the tab has finished loading when the permit is asked for depends on the machine and the network.

### Verified in production

Three consecutive handoffs on the build carrying this fix, same machine, same session:

| Time (UTC) | Brief | Captured → committed |
|---|---|---|
| 08:41:58 → 08:42:06 | 43,636 chars | 8.1 s |
| 10:25:18 → 10:25:26 | 56,202 chars | 8.2 s |
| 12:38:08 → 12:38:14 | 40,414 chars | 6.9 s |

The field that had been stuck on `not-attempted` through four failed attempts now reads:

```json
"state": "committed",
"destinationSend": { "state": "sent", "conversationId": "…", "messageId": "…" }
```

### Fix

Branch `fix/replacement-chat-permit-while-loading`, commit `6b6834b`.

The guard now splits on what the message claims. A checkpoint naming a chat still has to prove
the tab settled on that route — unchanged. A checkpoint naming none is judged on the document
lease `ownsDocument` already established, and refused only if the tab turns out to be showing
some other conversation.

Regression tests in `test/extension.test.ts`, driving the real service worker:
`forwards a replacement chat permit while the tab is still loading` / `… still pending`, plus
`forwards the destination checkpoints a replacement chat sends, which name no conversation`.

Note what the existing suite could not catch: every prior `/compact` test passes
`conversationId` alongside the token, because every one of them is the *source* chat. The
destination's shape — token and flag, no conversation — was untested, and it is the shape the
whole handoff depends on.

## 4c. Defect 4 — the silence watchdog never escalates (FIXED 2026-09-11)

A chat whose turn breaks on ChatGPT's side is reloaded every three minutes, indefinitely, with
no escalation and no stopping condition — including after the app has itself declared the turn
dead.

### Measurement

Conversation wedged on ChatGPT's own `Connection interrupted. Waiting for the complete answer`.
One hour of app log, one conversation:

```
13:49:16  silence-reload        two-minute watchdog fires
13:49:48  transport-failure     the reloaded page reports the same error, 32 s later
13:51:48  silence-reload
13:52:18  transport-failure
…
14:45:35  silence-reload        still going
```

**16 silence reloads and 12 assistant-error reports in one hour.** The user's own view of the
chat shows the matching pair repeating: `↻ Reloaded chat to recover an unresponsive open turn`
followed seconds later by `! Connection interrupted`.

The decisive detail: at 14:43 the app recorded

```
turn_end  outcome=stalled  "no visible output and no progress for ten minutes"
```

and reloaded again at 14:45:35. Its own verdict that the turn is dead does not stop the loop.

### Why it does not stop

Two triggers reach `queueBrowserRecovery`, and only one is bounded. The assistant-error path
spends exactly one reload per turn:

```ts
if (reason === 'assistant-error') {
  const spent = turnRepairSpent.get(conversationId);
  if (spent && turnKeyFor(live) === spent.turnKey) return false;
}
```

The silence watchdog has no such budget, deliberately — the comment above it argues that it asks
the chat-level question, is the answer to a stuck turn-scoped repair, and is "not something one
may mute". Only `BROWSER_RECOVERY_COOLDOWN_MS` (3 minutes) paces it. That is exactly the observed
cadence.

The intent is sound; the outcome is a livelock. The remedy is provably ineffective after the
first attempt — the state being recovered from is ChatGPT's, not the page's — and there is no
next step after it fails sixteen times.

### What to decide before patching

Do **not** simply cap the silence watchdog: the comment explains what that breaks, and a muted
liveness check is how a wedged chat went unnoticed before. The missing piece is an escalation,
not a limit. Options, in the order they seem worth testing:

1. **Notice repetition.** N consecutive silence reloads that each end in the same assistant
   error is a different state from N unrelated silences. `turnRepairSpent` already models
   "this remedy is spent for this turn"; the analogous per-chat concept does not exist.
2. **Escalate rather than stop.** A chat proven unrecoverable is precisely what Compact & Resume
   exists for. Filing a ticket would move the work to a fresh chat instead of reloading a dead
   one — but note it needs ChatGPT to write the brief, and in this state ChatGPT is what is
   broken, so this cannot be the only path.
3. **Surface it.** Sixteen silent retries with no user-visible verdict is its own defect. The
   app knew at 14:43 that the turn was dead and said so only to its log.

### Recovering a chat sitting in this state

`isChatBlocked` refuses every recovery trigger — all of them converge on `queueBrowserRecovery` —
so blocking the chat stops the loop. The work itself has to move to a new chat by hand: automatic
compaction will not fire below `compaction.autoTokens` (310,845 against 400,000 when this was
measured), and a manual one needs the very ChatGPT turn that is broken.

### Fixed, and verified in production

A later build caps the loop and explains itself. Measured 2026-09-11 on the same wedged shape:

```
05:33:50  silent for two minutes — asking the browser to reload 6aa3865c…
05:34:09  assistant transport failure
05:36:09  silent for two minutes — reload
05:36:39  assistant transport failure
05:38:39  silent for two minutes — reload
05:39:08  assistant transport failure
05:41:08  ⚠ answered 3 silence reloads with the same failure — not reloading it again
```

Three attempts instead of sixteen, and a note written into the session the user can read:

> Stopped reloading this chat: 3 reloads each came back with the same failure — "Connection
> interrupted. Waiting for the complete answer". The turn is broken on ChatGPT's side, which a
> reload cannot repair. Continue in a new chat, or send a message here to start a fresh turn.

All three options from this section are implemented: repetition is noticed, the verdict is
surfaced, and the user is told what to do. What is *not* implemented is doing it — see §4d.

## 4d. Defect 6 — unwedging is left to the user, though the app can already write the message (OPEN)

The note above ends with the remedy: *"send a message here to start a fresh turn."* Confirmed by
the user on 2026-09-11: pressing Stop in ChatGPT and typing anything does resume the work, and the
session picks straight back up — 05:46:55 attribution, 05:47:12 a tool call, running again.

That is the complaint, and it is a fair one: a session that runs for days across twenty-five chats
now needs a human to notice a stall and type a line, every time. The app diagnoses the state
correctly and then stops one step short of fixing it.

**The machinery already exists.** `src/main/goal.ts` writes the next user message into a chat by
itself — that is the whole Goal loop, and `GOAL_SYSTEM_TRAILER` is literally the instruction for
producing one:

> *That was the conversation. Now write the next message as the user: name what they asked for
> that is still not done, and tell ChatGPT to keep going.*

So the missing piece is a wiring decision, not a new capability: when the silence watchdog gives
up on a chat, hand that chat to the same drafting path instead of only writing a note. Points to
settle before building it:

- **Is the turn stoppable from the page?** The user has to press Stop first. Whether the content
  script can do that reliably in the `Connection interrupted` state is unverified and is the first
  thing to measure.
- **How many times?** This needs its own budget, or a chat that breaks every turn becomes an
  expensive loop of generated messages. The `turnRepairSpent` pattern is the model.
- **Does the user want it?** Automatically typing into someone's chat is exactly what the rest of
  this codebase is careful about. It likely belongs behind the same switch as the Goal loop.

## 4e. Defect 7 — session assets are dropped once the quota is hit (OPEN)

Every `browser` tool result since 05:17 on 2026-09-11:

```
warn  session asset not stored: Session asset quota exceeded
warn  session 2026-09-06-067c31da: overflow text not stored: Session asset quota exceeded
```

Twenty-plus in the sampled window, one per browser call, each of which had taken 10–45 seconds to
produce. Screenshots and overflow text are silently discarded while the run continues as if they
had been kept.

Two consequences worth separating. The evidence for *this* investigation gets thinner the longer a
session runs — which is precisely when it is needed. And a compaction brief is written from what
the session holds, so a quota-exhausted session hands its successor a poorer brief than it could.

Not investigated: what the quota is, whether it is per session or global, and whether anything
prunes it. A session at twenty-five chats and 106 errors reaching it may be working as designed;
reaching it *silently*, and continuing to pay for work whose output is thrown away, is not.

### Minor, same area: the worker badge says less than it knows

`extension/content.js` shows `A worker needs attention` whenever `workers.active === 0` and
`workers.failed > 0`. The signal is real — a worker did fail — but the label names neither which
worker nor why, and the user reports seeing it often. Worth a sentence of detail from the same
`summary` the branch already builds.

## 5. Reproducing on Windows

Everything here is platform-independent: the bridge, the continuation store and the tests are
plain Node. Nothing in the repro touches macOS APIs.

```sh
npm ci
npm run typecheck

# defect 1
npx vitest run test/bridge.test.ts -t "lets the next pickup claim a brief"
# defect 3
npx vitest run test/extension.test.ts -t "while the tab is still"
```

Expected: each **passes** on its own branch and **fails** on the branch point — defect 1 with a
409 on the second redeem, defect 3 with `stale_document`. Reverting only the production file
while keeping the test is the honest check that the test catches the defect rather than the
harness.

Full gate: `npm run verify`.

Baselines, so a run can be compared honestly. They differ because the branch point moved
between the two investigations:

| Branch point | Full suite | Pre-existing failures |
|---|---|---|
| 2026-09-09 (2.0.6) | 3030 passed | `fsops` 1, `mcp` 5, `renderer-usage` 1 |
| 2026-09-10 (2.0.8) | 3553 passed | `mcp` 1, `renderer-usage` 3 |

Both sets fail identically before and after the changes here. Do not chase them.

If Node is missing on the test machine, Electron's bundled runtime works:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  node_modules/vitest/vitest.mjs run test/bridge.test.ts
```

(On Windows: `node_modules\electron\dist\electron.exe` with the same env var.)

## 6. Recovering an install that is already wedged

The fix prevents the state; it does not clear one that exists. For a machine sitting in it:

1. In the source chat, press **Cancel** on the card showing `Opening…`. That is offered in
   this exact stage (`job.stage === 'opening'` → `action: 'cancel'`).
2. Send any short message in that chat. If the context is over `compaction.autoTokens`, the
   automatic ticket refiles at once — with a fresh claim, and opened after the watch floor so
   it is chased again.
3. The brief is never lost either way. It is on disk at
   `<home>/Library/Application Support/chat-on-steroids/sessions/<session>/handoffs/<id>.json`,
   field `text`, and can be pasted into a new chat by hand.

Clearing `claimedBy` in `state/continuations.json` by hand also works, but only with the app
quit, and it does not help while defect 2 keeps the ticket from being picked up again.

## 7. Defect 5 — the brief stays in the composer after a successful send (OPEN, hypothesis only)

After a handoff commits, the whole brief is still sitting in the replacement chat's message box,
underneath the message it was just sent as. Confirmed by the user on 2026-09-10, on the build
where the handoff itself works.

**Correction to an earlier version of this report.** `fix/handoff-composer-residue` no longer
fixes this. That branch received `c7e7344` — *"Drop the composer clear that 2.0.7 supersedes,
keep the test that found it"* — and is already contained in the current tip. The
`clearPromptExact` call it added is gone, replaced by `clearAcknowledgedBootstrap`. **Do not
reinstate the old fix**: it would defeat what the replacement protects, namely that a draft the
user typed after the send is never erased.

The replacement clears only against a receipt:

```js
const clearAcknowledgedBootstrap = async acknowledged => {
  if (acknowledged?.ok !== true || acknowledged.data?.ok === false || !bootstrapDraft.current()) return;
  const receipt = await waitPageView(() => {
    const latest = CLF_DOM.messages().filter(m => m.role === 'user').at(-1);
    return latest?.id !== priorBootstrapUser && matchesSubmittedUser(latest, boot.text);
  }, …, 15000);
  if (receipt) await bootstrapDraft.clear();
};
```

and `matchesSubmittedUser` compares the *entire* rendered text against what was sent:

```js
return typeof actual === 'string' && actual.length <= 256000 &&
       sendText(actual) === sendText(expected);
```

**Hypothesis, unproven:** at ~44,000 characters ChatGPT clamps the user message in the DOM, so
`actual` is truncated, the comparison fails, `waitPageView` times out after 15 s, and the draft is
deliberately kept. That would also explain why short worker bootstraps are unaffected.

**Verify before changing anything.** Either drive the real content script through the jsdom
harness in `test/content-script.test.ts` with a long resume bootstrap whose rendered user message
is clamped, or measure it on the running extension using the method in §2b. A tracer for exactly
this decision — ack ok, draft held, receipt landed, `actualLen` against `expectedLen` — was left
installed at `<home>/Library/Application Support/chat-on-steroids/extension/content.js`, with the
original at `~/Downloads/content.js.backup2-2026-09-10`; it records nothing until the extension is
reloaded in `chrome://extensions`, and any new build overwrites that folder.

If the hypothesis holds, the direction is to stop hanging the receipt on a full-text comparison
the page provably cannot satisfy — the stable message id plus a prefix, or Fiber's `rawText`
rather than the bubble. What is *not* an option is dropping the comparison: it is what stops an
unrelated draft from being deleted.

## 8. Branches

| Branch | Covers | State |
|---|---|---|
| `fix/replacement-chat-permit-while-loading` | defect 3 | pushed, tests green, **verified in production** |
| `fix/wedged-compaction-recovery` | defect 1 | pushed, tests green, not yet in a build |
| `fix/handoff-composer-residue` | superseded | its fix was dropped by `c7e7344`; see §7 |
| — | defect 2 | not started, see §4 |
| — | defect 4 | **fixed in a later build**, see §4c |
| — | defect 6 | not started, see §4d |
| — | defect 7 | not started, see §4e |
| — | defect 5 | not started, see §7 |

Branches are based on `origin/integrate/browser-and-desktop-064733`. Only defect 3's fix is known
to be in an installed build; reproducing defects 1, 2, 4 or 5 on a running install is expected.

## 9. Order of work

1. **Defect 6** — the one the user actually feels: a long-running session now stalls until a human
   types a line. The capability exists (§4d); what is missing is a decision about stopping the
   broken turn, a budget, and a switch.
2. **Defect 5** — a live tracer is already installed and needs one handoff to answer it. Cheapest
   evidence available, and it is the defect the user sees on every successful handoff.
3. **Defect 7** — cheap to scope, and it quietly degrades every other investigation here.
4. **Defect 2** — needs a measurement before anything is changed, and the behaviour it resembles
   is intentional. Least urgent: it only bites after an app restart during an open compaction.

Defect 4 is fixed and verified; defects 1 and 3 are fixed, 3 verified in production.

Defect 1's fix is written and green but has never run in a build. Whatever else happens, getting
it into one is worth more than another round of analysis.
