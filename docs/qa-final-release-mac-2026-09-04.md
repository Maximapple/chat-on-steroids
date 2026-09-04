# Final release QA — macOS, 2026-09-04

The last gate before this branch is release-ready. Two things stand in the way: one open defect
that three sessions have failed to isolate, and the QA steps that have never run on any build.

Everything here is written for Mac Claude Code. Standing authorization to fix and push applies:
root cause first, smallest correct fix, a regression test confirmed failing without it, tsc and
the full suite green before every commit, no Claude attribution.

## Setup

`git pull` on `integrate/browser-and-desktop-064733` → `71d0c48` or later. Install the packaged
artifact from the newest green *Release candidate* run rather than dev mode: this is the final
pass, and it should measure the thing that ships.

## Part 1 — the open defect, now instrumented

**What is broken.** A page reports `sourceLost` when `send()` proves ChatGPT never took an armed
handoff. The app is meant to end the transaction. It does not: the continuation stays in
`dispatched-unresolved` until its six-hour TTL, and the chat loses browser recovery for that
whole window because `inspectSilentChats()` skips anything `pendingAutomaticContinuations()`
still names.

**What has been ruled out, so do not re-derive it.**

- The app's branch is live and correct — a direct `POST /compact` with
  `{conversationId, token, sourceLost:true}` returns `{"released":true}` and aborts the entry.
- The page genuinely calls it, with a token in scope: the same `token` binding that
  `sourceDispatch` uses eleven lines earlier, and that one demonstrably reaches the app.
- The worker's forwarding list contains `sourceLost`, and a test drives every entry in it.
- Ordering in `/compact` is fine: `sourceLost` precedes `cancel`, `ticket` and the default.
- The stale-worker theory is dead by your own manifest-bump evidence.
- There is no third whitelist: `ask()` spreads, `sendToWorker` passes through, the dispatcher
  hands the message to the handler whole.

**The one datum still missing** is what keys the give-up's POST actually carries. Two new things
make that a log read rather than a session:

1. `bridge: /compact start request — body keys: …` now logs on **every** start-shaped request,
   unconditionally. `sourceAttempt` and `sourceDispatch` reach the same route with their token
   intact on every compaction, so their key lists sit in the same log as the give-up's. **The
   diff between them is the answer.**
2. `bridge: browser extension <version> connected (build <digest>)` now reports six bytes of
   SHA-256 over the running `background.js`. Compare it to the repo:

       shasum -a 256 extension/background.js | cut -c1-12

   Equal means the worker running is the file on disk. Unequal means it is not, and that alone
   explains the whole defect — the earlier ternary-based worker drops a `sourceLost` message
   exactly this way, losing both token and flag and leaving the app to answer from its
   start-compaction branch, which is precisely what you measured.

**The run.** Install, confirm the build digest matches, force a send failure, read the log.
Report the two key lists verbatim. If the digest does *not* match, that is the finding — say so
and stop; the fix is a packaging or load-path question, not a code one.

If the keys show the field arriving and the app still not acting, that contradicts a passing
test and I want the raw log rather than a fix.

## Part 2 — never run on any build

Neither has ever been executed. Both are cheap and both are release-blocking in the sense that
nobody knows the answer.

- **`destinationLost`.** Written 2026-09-02, correct at both ends, and never once reached the app
  until `350c337` — so it has never been seen working. Drive a real Compact & Resume until chat B
  holds the brief in its composer, then clear the composer before the click lands. Confirm the
  page reports it, the app releases the armed dispatch, and the brief is offered to a fresh chat
  rather than sitting armed for the quarter-hour lease. If it cannot be triggered by hand, force
  it the way you forced the send failure — and if it turns out unreachable in practice, that is
  worth knowing and worth saying.
- **Steps 32–68** of `docs/qa-deep-claude-2026-09-04.md`: desktop surface, browser surface,
  multi-agent, blocked chats, recovery. Skipped for context in every prior run.

## Part 3 — the two ChatGPT findings still open

From the gauntlet run, both needing macOS:

- **Second-tab tracking.** A `target=_blank` click returned `createdTab={…}` but the next
  `status` reported only the held tab. Decide from the driver's contract whether that is correct
  ("status reports the tab I drive") or a genuine gap, then fix it or close it as a prompt error.
- **Unfocused type accepted.** `type` with the page body focused was silently accepted, where an
  earlier round found the opposite — everything refused with `INPUT_TARGET_LOST`. Something
  differs between those two cases and neither report captured what.

## Release decision

When Part 1 has an answer and Parts 2–3 are either passing or explicitly accepted as known gaps,
this branch is releasable. No version bump or tag is planned yet — the intent is a PR upstream
once it is bug-free, so `package.json` stays at 2.0.5 until that call is made.

Report pass/fail per item. For Part 1, the verbatim key lists and the digest comparison are the
report — no prose verdict is needed or wanted there.
