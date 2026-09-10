# Compact & Resume: three defects behind a handoff that never lands

Field report and fix brief, 2026-09-09 / 2026-09-10. Written to be actioned directly.

**Status:** defects 1 and 3 are fixed on pushed branches. Defect 2 is analysed and deliberately
not patched — it needs a decision, see section 4. Defect 3 is the one that produced the visible
symptom most often: a replacement chat that opens and stays empty.

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

## 7. Related, separate

`fix/handoff-composer-residue` fixes a fourth defect found in the same area: after a *successful*
handoff send, neither the replacement chat nor the source chat cleared the composer, so the whole
brief stayed in the message box under the message it had just been sent as. Independent of the
three above.

## 8. Branches

| Branch | Covers | State |
|---|---|---|
| `fix/replacement-chat-permit-while-loading` | defect 3 | pushed, tests green |
| `fix/wedged-compaction-recovery` | defect 1 | pushed, tests green |
| `fix/handoff-composer-residue` | section 7 | pushed, tests green |
| — | defect 2 | not started, see section 4 |

All three are based on `origin/integrate/browser-and-desktop-064733`. None has been merged, and
none is in any installed build: reproducing any of these defects on a running install is expected
until a build carries the fix.
