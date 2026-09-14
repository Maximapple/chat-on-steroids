# Compact & Resume: a handoff that opens tab after tab and never types

Field report and fix brief, 2026-09-09. Written to be actioned directly.

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

## 5. Reproducing on Windows

Everything here is platform-independent: the bridge, the continuation store and the tests are
plain Node. Nothing in the repro touches macOS APIs.

```sh
npm ci
npm run typecheck
npx vitest run test/bridge.test.ts -t "lets the next pickup claim a brief"
```

Expected: **passes** on `fix/wedged-compaction-recovery`, **fails with 409** on the branch
point. Reverting only `src/main/bridge.ts` while keeping the test is the honest check that
the test catches the defect rather than the harness.

Full gate: `npm run verify`.

Baseline on this branch point, so a run can be compared honestly: **7 pre-existing failures**
— `test/fsops.test.ts` (1), `test/mcp.test.ts` (5), `test/renderer-usage.test.ts` (1). They
are unrelated to this change and fail identically before and after it.

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

## 7. Related, separate

`fix/handoff-composer-residue` fixes a different defect found in the same area: after a
successful handoff send, neither the successor chat nor the source chat cleared the composer,
so the whole brief stayed in the message box under the message it had just been sent as.
Independent of the two defects above.
