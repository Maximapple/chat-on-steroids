# Confirmation round — Claude Code, macOS

Targeted, not another full sweep. The last round produced three findings and four browser
failures; this confirms what was fixed and closes the one open question. The four browser-tool
steps are **not** here — they need an attributed ChatGPT conversation and live in
`docs/qa-confirmation-chatgpt.md`.

Standing authorization to fix and push applies: root cause first, smallest correct fix, a
regression test confirmed failing without it, `tsc` and the full suite green before every commit,
no Claude attribution in commits, PRs or tags.

## Setup

`git pull` → `661247a` or later. Install the macOS arm64 artifact from the newest green *Release
candidate* run, fresh. Then baseline:

    npx tsc --noEmit
    npx vitest run
    npm run verify:privacy
    npm run verify:browser
    npm run verify:compact-chain

Expected: everything green, nothing failing. **Do not expect a particular count.** Both suites are
platform-gated — `it.runIf(process.platform === 'win32')` in the test suite, and one
`verify:browser` check that only runs on macOS — so the totals differ by platform and a figure
quoted from a Windows run reads as a regression here. It is not one. Judge by failures, not by
totals.

Two notes so you do not chase ghosts. `verify:browser` grew from 52 checks and now covers a native
select, a hover-revealed caption, a link click that works, a link click that reaches nothing, and a
tab holding Chrome's error page. `verify:compact-chain` needs the app running — start it first
(`npm run dev` or the installed build); it says so in one line rather than failing seven
checkpoints if you forget.

Confirm the digest `verify:compact-chain` prints matches the app's connect line.

## Part A — the three findings

1. **Finding 1, the wedged chat.** The product decision is unchanged: the ticket still runs to its
   six-hour deadline and nothing is abandoned early. What changed is that a chat whose compaction
   pickups are spent no longer loses browser recovery for that whole window — the skip now lasts
   exactly as long as the chat is still being chased. If you can arrange a stalled handoff, confirm
   the chat is still reloaded by the silence path afterwards. If you cannot force one, say so
   plainly; it is genuinely hard to arrange and a guess is worth nothing here.
2. **Finding 2, the path contract.** Read the `exec_command` schema. `workdir` should now say it
   takes the same form `read.paths` does, and that paths written inside `cmd` are not translated.
   Confirm both halves against the running app: a virtual `workdir` is accepted, and the same
   spelling inside `cmd` is refused. Note that the fix is the opposite of what the last report
   implied — `workdir` accepts virtual paths and always did; only `cmd` refuses them.
3. **Finding 3, the stale overlay.** Restart the app under a live turn with tool calls in flight.
   The "Waiting for N tool calls" panel must clear within about a minute rather than persisting.
   Last round it survived over ten minutes and a completed turn. Time it.

## Part B — what the last round could not reach

Only with an attributable connector. If calls arrive Unattributed, say so at the top and mark this
part blocked — do not spend the session working around it, and do not forge identity through
`/pair` and `/correlations`. You were right to refuse that.

4. Sub-agents end to end: spawn a prime, spawn a worker, have it do real work and report back,
   read the result from the prime. Then a worker blocked mid-run, and confirm the swarm slot frees
   rather than deadlocking.
5. A chat blocked **mid-generation**, not idle. Confirm the refusal is named, the turn stops
   cleanly, and releasing restores tools on the very next call.

## Report

Pass/fail per item with exact evidence, and every fix with its commit hash.

Then answer directly, in prose: **is there any defect here you would not ship?** And: is there
anything a first-time user would hit in the first ten minutes that would make them distrust the
app? That judgement is what this round is for.
