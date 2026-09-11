# Chats that wedge mid-run: what is measured, and what three plausible causes are not

Field report, 2026-09-11. Standalone — the handoff defects it grew out of are fixed and merged;
see `2026-09-10-compaction-handoff.md` for those. This report is only about chats that stop
answering, and it is deliberately more about **refuted** explanations than new ones.

Conversation ids are shortened. Absolute paths are `<home>`.

---

## 1. Symptom

A chat stops producing anything. ChatGPT shows `Connection interrupted. Waiting for the complete
answer`. The app notices the silence, asks the browser to reload, the reloaded page comes back in
the same state, and the work does not continue until a human presses Stop in ChatGPT and types a
message — which does resume it, immediately and reliably.

The user's summary is the right frame: *it should never get this far.*

## 2. Scale, measured

From one app log covering roughly 36 hours of heavy use:

```
Chats with any activity:               49
Chats with at least one wedge:         18
```

More than a third. The distribution matters more than the count:

| Chat | transport failures | silence reloads | attributed requests |
|---|---|---|---|
| `6aa2a4b3…` | 12 | 20 | **3** |
| `6aa333ad…` | 12 | 16 | **4** |
| `6aa2e234…` | 10 | 14 | **4** |
| `6aa301cf…` | 3 | 6 | 4 |
| `6aa3865c…` | 3 | 3 | **2** |

These chats wedge after **two to four requests**. They are not chats that died of old age.

Under load the rate was **0.77 transport failures per 100 tool calls** — about one wedge every
130 tool calls, in a window with 5,333 tool calls at 254/hour.

## 3. What is already handled, and what it does not do

The reload loop itself is fixed and merged (tip commit *"Stop reloading a chat that answers every
reload the same way"*). Measured before and after, on the same shape:

| | reloads | outcome |
|---|---|---|
| 2026-09-10 | 16 in one hour | ran until the user intervened |
| 2026-09-11 | 3, then stopped | verdict written into the session |

The note it writes:

> Stopped reloading this chat: 3 reloads each came back with the same failure — "Connection
> interrupted. Waiting for the complete answer". The turn is broken on ChatGPT's side, which a
> reload cannot repair. Continue in a new chat, or send a message here to start a fresh turn.

That is correct and honest. It is also where the app stops. **The remedy is still performed by a
human**, every time, on a session that has spanned twenty-five chats. See §8.

## 4. Three refuted hypotheses

Each of these looked convincing in aggregate and did not survive a control. They are written up
because the aggregates are still there to be rediscovered, and two of them nearly went into a
report as findings.

### 4.1 The `browser` tool — REFUTED

The tool is new since 2.0.2, and its calls are slow: median 8.8 s, 90th percentile 31.1 s, eleven
calls over 60 s, three over 120 s, longest **195 s**. Per-day aggregate:

| Day | transport | silence | browser calls | avg | max |
|---|---|---|---|---|---|
| 09-09 | 0 | 0 | 37 | 5.4 s | 20.6 s |
| 09-10 | 38 | 72 | 192 | 17.2 s | 195.3 s |
| 09-11 | 4 | 7 | 80 | 14.2 s | 45.7 s |

Compelling, and wrong. The temporal control:

```
Last browser call before each transport failure, 09-10 13:39 … 14:43:
  gap 73,950 s … 77,753 s   (twenty-plus hours)
  duration of that call: 1.1 s

Median duration of the last browser call before a failure:  7.8 s
Median duration of all browser calls:                       8.8 s
```

The 09-10 wedges happened in a window with **no browser activity at all**, and the calls preceding
failures are indistinguishable from the general population. Both browser use and wedges rose on
the same day, but not together in time.

### 4.2 The build that shipped on 09-10 — REFUTED

Same version number, two builds, a sharp-looking boundary:

| Extension build | Window | transport | silence |
|---|---|---|---|
| `7346727efe01` | 09-09 17:44 → 09-10 08:39 | 0 | 0 |
| `4d1511ba8553` | 09-10 08:39 → 09-11 05:39 | 42 | 79 |

The control:

| Window | Hours | Tool calls | Tools/h | Turns |
|---|---|---|---|---|
| A (`7346727efe01`) | 14.9 | **4** | 0.3 | 8 |
| B (`4d1511ba8553`) | 21.0 | 5,333 | 254.0 | 102 |

Window A is overnight and essentially idle. Zero wedges in four tool calls is not evidence of
anything. Any "before/after a build" comparison on this log has to normalise by load first.

### 4.3 A version regression visible in stored sessions — NOT SUPPORTED

Error counts across all 318 stored sessions, back to 2026-08-28, show no version cliff. The two
spikes (08-30 at 13.2 errors/100 tool calls, 09-04 at 81.9) are QA and self-test sessions, and
`meta.errors` counts tool errors rather than wedges, so it is the wrong instrument for this
question in any case.

**The user's recollection that this did not happen in 2.0.2 could not be tested.** The app log
only reaches back to 2026-09-09, and the one comparatively clean window in it was idle.

## 5. The load-profile hypothesis — REFUTED

Stated as a hypothesis, not a finding.

The wedging chats are all successors in one Compact & Resume chain, now twenty-five long. Each
one opens with a 40,000–55,000 character brief as its first user message and then, within
minutes, spawns three worker agents and runs dozens of connector calls, several of them tens of
seconds long. They wedge after two to four requests.

A chat that starts at that size and immediately drives that much traffic may simply be a harder
thing for ChatGPT's transport than a conversation that grew normally.

**Measured, and it does not hold.** Every handoff in every stored session was matched against the
outcome of the turn that followed it — 62 pairs:

| Brief size | bad outcomes (failed / stalled / interrupted) | rate |
|---|---|---|
| < 50,000 chars | 3 / 32 | 9.4 % |
| ≥ 50,000 chars | 6 / 30 | 20.0 % |

Fisher exact, two-sided: **p = 0.294**. The direction matches the hypothesis and the sample does
not support it — a split like this arises by chance in roughly one experiment in three. A single
data point argues against it directly: the smallest failure sits at 41,330 characters, in the
middle of the unremarkable range, carrying exactly the same message as the one at 67,266.

Two things the same measurement does establish:

- **9 of 62 handoffs — one in seven — are followed by a turn that fails, stalls or is
  interrupted.** That is the rate worth quoting, and it is not size-dependent.
- **The failures are two distinct kinds**, which earlier sections wrongly lumped together:
  `Message delivery timed out. Please try again.` (3 cases, at 41k / 61k / 67k) and `no visible
  output and no progress for ten minutes` (4 cases, at 51k / 51k / 61k / 69k). The first is
  ChatGPT's delivery; the second is an answer that never arrives. Separated, the counts are too
  small for any claim at all.

A further observation against the load framing: the wedge measured on 2026-09-11 at 12:32 hit a
session **two chats old**, started that morning. Not a long chain.

## 6. What would settle it

1. **Wedge rate against starting brief size.** Do chats opened with a 55k brief wedge more often
   than those opened with 40k? Needs more data points than the handful in one log; the data is
   already recorded per continuation (`handoffId`, `chars`) and per chat.
2. **A control run with workers and the browser tool switched off**, in the same chain, on the
   same work. If the wedges stop, the load profile is the cause and the version is not.
3. **Whether ChatGPT's own connector timeout is involved.** Three calls over 120 s were observed.
   If the transport gives up at a threshold, calls above it should correlate with failures *in
   the same turn* — the test in §4.1, restricted to the turn rather than the day.

## 7. How to measure, on any install

The app log is the instrument; `<home>/Library/Application Support/chat-on-steroids/app.log`.

```sh
# wedges per chat, with how much work that chat had done
grep -oE "asking the browser to (recover|reload) [0-9a-f-]{36}" app.log | sort | uniq -c | sort -rn

# always normalise by load before comparing two windows
grep -c "request attribution" app.log     # turns
grep -cE "\btool \w+ (ok|rejected)" app.log   # tool calls
```

Per-session detail lives in `<home>/…/sessions/<id>/`: `meta.json` for counters,
`events.jsonl` for `turn_start` / `turn_end` with outcomes (`completed`, `stopped`,
`interrupted`, `stalled`) and for the notes the app writes when it gives up.

## 8. Adjacent, and worth their own decisions

### 8.1 Unwedging is still manual, though the app can already write the message

Confirmed on 2026-09-11: Stop in ChatGPT plus any typed message resumes the run immediately
(05:46:55 attribution, 05:47:12 a tool call, running again). The app diagnoses the state and then
hands the remedy to the user.

`src/main/goal.ts` already drafts exactly such a message — that is the whole Goal loop, and
`GOAL_SYSTEM_TRAILER` is the instruction for producing one. The gap is wiring, not capability.
Three things to settle first:

- Can the content script press Stop in the `Connection interrupted` state? The user has to do it
  by hand today; whether the page can is unverified and is the first thing to measure.
- What is the budget? A chat that breaks every turn must not become a loop of generated messages.
  `turnRepairSpent` is the existing model for "this remedy is spent".
- Should it be opt-in? Typing into someone's chat unasked is what the rest of this codebase is
  careful about; it probably belongs behind the same switch as the Goal loop.

### 8.2 Session assets are dropped once the quota is hit

Every `browser` result in the sampled window:

```
warn  session asset not stored: Session asset quota exceeded
warn  session <id>: overflow text not stored: Session asset quota exceeded
```

Twenty-plus in one window, one per call, each call having taken 10–45 s to produce. Screenshots
and overflow text are discarded while the run continues as though they were kept. Two costs: the
evidence for investigations like this one thins out exactly when a session is long enough to need
it, and a compaction brief is written from what the session holds, so a quota-exhausted session
hands its successor a poorer brief.

Not investigated: what the quota is, whether it is per session or global, whether anything prunes
it. Reaching it may be by design; reaching it *silently* is not.

### 8.3 The worker badge says less than it knows

`extension/content.js` shows `A worker needs attention` when `workers.active === 0` and
`workers.failed > 0`. The signal is real — a worker failed — but it names neither which nor why,
and the user reports seeing it often. The branch already builds a `finished · running · failed`
summary one line above.

## 9. The two branches from an earlier draft — CORRECTED, do not merge

An earlier version of this report asked for `fix/restored-compaction-silence-check` and
`fix/checkpoint-relay-allowlist` to be merged. **That was wrong and has been verified as wrong.**

Neither branch is an ancestor of `origin/integrate/browser-and-desktop-064733` — they hang off a
much older base, and diffing them against the tip shows thousands of deletions, i.e. the tip is far
ahead. But their *content* is in, as of `fa12c17`:

```
restoredResumeTokens in src/main/bridge.ts:        6 occurrences
compactCheckpointFields in extension/background.js: 2 occurrences
destinationLost in COMPACT_CHECKPOINT_FLAGS:        present
```

Merging them would drag an old tree back over a newer one. Don't.

*(Note on method: the first attempt at this check returned all zeros and appeared to contradict
the claim. The cause was the shell, not the repository — zsh applies history-style modifiers to
`$T:src/...` and `$T:extension/...`, silently mangling the ref. Brace the variable: `${T}:path`.)*

## 9b. The brief left in the composer — MEASURED, cause located

Reported repeatedly by the user: after a handoff commits and the new chat is working, the whole
brief is still sitting in that chat's message box, under the message it was sent as. An earlier
report carried a hypothesis about the receipt comparison failing on a clamped 44,000-character
bubble. **That hypothesis is wrong.** The cleanup is not failing its comparison — it is never
reached.

### Measurement

`clearAcknowledgedBootstrap` in `extension/content.js` was wrapped to record every entry into
`chrome.storage.local` (method in §7 of `2026-09-10-compaction-handoff.md`). During the window the
tracer was live:

| | count |
|---|---|
| `resume` handoffs that committed | **3** (22:48:16, 04:41:03, 05:57:09) |
| `resume` entries recorded by the tracer | **0** |
| `worker` / `revive` entries recorded in the same window | 9 |

The tracer demonstrably worked — nine worker and revival bootstraps recorded, each showing the
healthy shape `ackOk: true, draftHeld: false → gate-refused`, meaning the composer was already
empty and there was nothing to clear. Not one resume.

### Where it goes

`extension/content.js`, the ack loop after a bootstrap send:

```js
for (let tries = 0; tries < 80; tries++) {
  await sleep(500);
  const found = boot.type === 'resume' ? bootstrapConversation() : CLF_DOM.conversationId();
  if (found) {
    …
    const acknowledged = await ask({ type: 'ack', … conversationId: found … });
    await clearAcknowledgedBootstrap(acknowledged);   // ← the only clear
    return;
  }
}
// Sent, but this tab never saw an id …
await ask({ type: 'ack', id: boot.id, status: 'sent', agent, client: RUN_ID });   // ← no clear
```

For a resume the loop polls `bootstrapConversation()` for 80 × 500 ms = 40 s. If it never returns
an id the loop falls through to a bare ack, and the draft is never considered.

That the loop does exhaust is corroborated independently. Every commit in the log reads:

```
bridge: resume:… is done — the marked replacement message committed the continuation
```

Six consecutive handoffs, all committed **from the server-authored marker, never from the page's
ACK** — which is exactly what a page that never obtained an id would produce. The handoff succeeds
anyway, which is why the failed half went unnoticed.

### What is still unknown

Why `bootstrapConversation()` returns nothing for 40 s in a chat that demonstrably has an id —
the app is committing against it seconds later. That is the thing to measure next, and it matters
beyond the composer: a resume whose page never binds its id also never runs
`rememberResumeGoalPending`, so whatever depends on that is silently skipped too.

### What not to do

Do not simply add a clear to the fall-through. It would tidy the symptom and leave the page still
failing to bind its own conversation — and the earlier `clearPromptExact` fix was already removed
once, in `c7e7344`, for being the wrong layer.

## 9c. Why the receipt fails — MEASURED, and it is neither of the two candidates as stated

`matchesSubmittedUser` was instrumented in the shipped extension, recording six values per call
and no text content. One resume handoff, 2026-09-11 12:58.

### Raw lines

Successor chat, 120 calls:

```
{"at":"12:58:43.366","exit":"compared","turnFound":false,"conversationSame":null,"authored":0,
 "branch":"message.text","actualLen":69504,"expectedLen":60425,"squeezedEqual":false,
 "result":false,"path":"/c/WEB:153a2e6b-…"}
{"at":"12:58:43.533","exit":"fiber-conversation-mismatch","turnFound":true,
 "conversationSame":false,"expectedLen":60425,"result":false,"path":"/c/WEB:153a2e6b-…"}
{"at":"12:58:44.370","exit":"fiber-conversation-mismatch","turnFound":true,
 "conversationSame":false,"expectedLen":60425,"result":false,"path":"/c/WEB:153a2e6b-…"}
… 116 further fiber-conversation-mismatch, path "/c/6aa3fb02-…"
```

Totals: `fiber-conversation-mismatch` **119**, `compared` **1**, spanning 12:58:43.533 to
12:59:21.515 — **38 seconds**, i.e. the 80 × 500 ms poll window running to exhaustion.

Control, from the established chat in the same store:

```
{"at":"12:54:26.493","exit":"compared","turnFound":false,"authored":0,"branch":"message.text",
 "actualLen":5758,"expectedLen":5801,"squeezedEqual":true,"result":true,"path":"/c/6aa3e67c-…"}
```

The function works normally in a chat that already exists.

### What the lines say

**Candidate (a) is the cause, but not in the form it was proposed.** The proposal was Fiber's
*provisional* thread id — a transitional state. The measurement shows it is not transitional:

```
path "/c/WEB:153a2e6b-…"          4 calls
path "/c/6aa3fb02-…"            116 calls
```

Only the first four calls happen while the address still carries the `WEB:` client-side thread id.
The remaining **116 mismatches occur after the route has settled on the real conversation id** —
`CLF_DOM.conversationId()` returns the real one, and the Fiber turn keeps returning the
provisional one. They never converge, and the guard

```js
if (turn && turn.conversationId !== CLF_DOM.conversationId()) return false;
```

therefore refuses for the rest of the window.

**Candidate (b) is refuted, in the opposite direction to the one proposed.** The single call that
reached the text comparison did so before any Fiber turn existed, and fell back to `message.text`:

```
actualLen 69504   expectedLen 60425   diff +9079   squeezedEqual false
```

The rendered bubble is **9,079 characters longer** than what was sent, after whitespace is
squeezed out of both. Not a clamped bubble — a longer one. What those extra characters are was
not measured and is the obvious next question, but truncation is excluded.

### Consequences

Both symptoms follow from this single refusal, as predicted:

- `send()`'s only admissible proof in a brand-new chat is this function, so it returns false and
  `content.js` takes its silent return — the composer keeps the brief.
- The ack loop polls the same failing probe for 40 s, exhausts, and sends the bare ack that clears
  nothing.
- The page never binds its own conversation, so the commit arrives from the server-authored marker
  instead — which the log shows for every handoff — and `rememberResumeGoalPending` never runs.

### What this does not settle

Whether the Fiber turn's provisional id ever updates, or whether the branch is permanently
detached for a resumed chat. 120 calls over 38 seconds say it does not update within the window
that matters; they say nothing about a minute later. That is one more instrumented handoff away,
and it decides whether the fix is "wait longer" (it is not, the window is already 40 s) or "stop
comparing against the Fiber turn's conversation id in a chat this page just created".

## 10. What not to do

- **Do not compare two time windows without normalising by load.** §4.2 is what that looks like.
- **Do not read a per-day aggregate as a mechanism.** §4.1 is what that looks like.
- **Do not cap the silence watchdog further.** It is already capped at three, and the comment
  above it explains why muting it is worse than the loop was.
- **Do not treat `meta.errors` as a wedge count.** It counts tool errors.
- **Do not quote a rate difference without testing it.** §5's 9.4 % against 20.0 % looks like a
  finding and is `p = 0.294`. Three of the seven hypotheses this investigation discarded died to
  a control that was run after the aggregate had already been believed.

## 11. Defect 8 — the connector card ChatGPT no longer renders the old way (FIXED)

Separate from the wedges, found while chasing a tab that kept reopening. Two defects, one branch:
`fix/connector-card-without-report-entity` (`d013681`, `0e7df3d`, `777f9f1`).

### Measurement

`pluginSnapshot()` in `extension/fiber.js` was instrumented in the shipped extension — it runs in
the page's MAIN world, which is the same place a console one-liner would run, so no browser
automation was needed. `content.js` persisted what it recorded. Fourteen readings, seven minutes
apart, every one identical:

```
panels=1 buttons=9 resultBuilt=true toolCount=7 observedCard=false controlFound=false

button 1, level 23, via connectorId   reportEntity=false  headerTrailing=false
  connectorId, plugin, publishConnectorHref, legacyRemovalAction, deleteDisabledTooltip,
  isConnectionStateUnavailable, isDeleting, isInstalledByDefault, isPending,
  isUninstallDisabled, onDelete, onDisableSync, onDisconnect, onEditDescription,
  onEditLogo, onEditName, onReconnect, onRemove, showDisconnect, showReconnect,
  showUninstall, showUninstallAllAccountsWarning

button 2, level  7, via connector.id  actions=7   { actions, connector, isLoadingActions, link }
button 2, level  9, via connector.id  actions=null { connector, isLoadingConnector, link }
```

`reportEntity` and `headerTrailingContent` are gone from every props form in the panel. The tools
read perfectly — `resultBuilt`, seven of them. The snapshot was complete and failed only on
`if (!result || !observedCard) return null;`.

### The two fixes

**The card.** It is now also accepted in the shape above. The condition's purpose is unchanged —
prove the *card* is rendered, not that some fiber carries the connector id, which a list row or a
prefetch cache does too — so the new shape proves it through that connector's own mutations:
three of `onRemove`, `onDelete`, `onDisconnect`, `onReconnect`, `onEditName`, `onEditLogo`,
`onEditDescription`, `onDisableSync`, alongside `connectorId` and a `plugin` object. Counted
rather than named, so a renamed handler does not cost the card. The old shape still works and the
existing test pinning the refusal without a card is untouched.

With the card recognised and `headerTrailingContent` absent, the snapshot reports
`refreshAvailable: false` — the manual branch that existed all along, which ends the request and
tells the user.

**The silence.** `refreshManagedPlugin` returned false without reporting when the view could not
be read, which is why the durable row carried no `error` after thirty hours. It now reports —
gated on still owning the page, because `waitPageView` also yields null when this document stops
being the one the request belongs to, and a navigation is not the page failing to render a card.
The existing navigation case caught that: the first attempt at this fix broke it.

### Two corrections to the original report of this defect

- **The 30-second cadence is not confirmed in the field.** Chrome's history shows clusters at app
  starts — 12:51, then 03:58, then 19:11 the previous day. Six tabs over thirty hours, not a
  per-minute loop. `RETRY_PERIOD_MIN = 0.5` is read correctly in the source but does not produce
  that cadence in practice.
- **`refreshManagedPlugin` never runs on page load**, only on a service-worker message
  (`content.js:11297`). A plain reload of the affected tab therefore triggers nothing, which is
  why the diagnostic had to post `clf-plugin-ask` itself.

### Still open, needs a real click

Whether "Refresh" now lives in the menu behind the `Plugin actions` button. A synthetic click does
not open it (`aria-expanded` stays false), and calling page callbacks is out of bounds. That
decides whether the feature returns or simply ends cleanly through the manual branch — which now
works either way.
