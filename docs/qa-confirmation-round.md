# Confirmation round — every fix from the release sign-off report

Short and targeted. The previous round produced three findings and four browser failures; six of
those are now fixed and one is not reproducible from the evidence given. This round confirms the
fixes on real hardware and closes the one open question.

Standing authorization to fix and push applies: root cause first, smallest correct fix, a
regression test confirmed failing without it, `tsc` and the full suite green before every commit,
no Claude attribution in commits, PRs or tags.

## Setup

`git pull` → `96ee587` or later. Install the macOS arm64 artifact from the newest green *Release
candidate* run, fresh. Then baseline:

    npx tsc --noEmit
    npx vitest run
    npm run verify:privacy
    npm run verify:browser
    npm run verify:compact-chain

`verify:browser` should report **60/60** and now covers a native select, a hover-revealed caption,
a link click, and a tab holding Chrome's error page. `verify:compact-chain` needs the app running —
it now says so in one line instead of failing seven checkpoints if you forget.

## Part A — the four browser fixes, on real pages

Use `https://the-internet.herokuapp.com`. These are the exact steps that failed last round.

1. **`/dropdown`** (was step 41). `set_value` on the select with `Option 1`, then re-observe and
   confirm it reads back. Then `set_value` with `Purple` and confirm the refusal **names the
   available options** rather than silently succeeding. This was the worst failure of the round:
   four different approaches all reported success and changed nothing.
2. **`/hovers`** (was step 47). `observe` and confirm the three hover wrappers now have refs, named
   from their captions (`name: user1` and so on). `move_ref` to one and confirm the caption appears
   without a click.
3. **`/secure` logout** (was step 44). Log in with `tomsmith` / `SuperSecretPassword!` — the page's
   own documented demo credentials — then `click_ref` the Logout button. **This one is not fixed
   and I could not reproduce it.** The reported evidence was `hit=i covered=false`; a fixture with
   exactly that shape — an anchor whose centre resolves to an inline child — navigates correctly
   in real Chrome, and that case is now covered. So if it fails again, the cause is something else:
   capture `observe` output for the button, the full `click_ref` result, and the page URL and any
   console error immediately after. That evidence is what is missing.
4. **`detach` then act** (was step 76). `detach`, then `observe`. It may still auto-attach — that
   is deliberate, and the tool description says so. What must **not** happen is what you saw: a
   tab holding `chrome-error://chromewebdata/` being returned as though it were a real page. Point
   a tab at something unreachable first, then detach and observe, and confirm a named refusal.

## Part B — the three findings

5. **Finding 1, the wedged chat.** The abandon-or-wait product decision is unchanged and the ticket
   still runs to its six-hour deadline. What changed is that a chat whose compaction pickups are
   spent no longer loses browser recovery for that whole window. If you can arrange a stalled
   handoff again, confirm the chat is still reloaded by the silence path afterwards. If you cannot
   arrange one, say so — it is genuinely hard to force.
6. **Finding 2, the path contract.** Read the `exec_command` schema. `workdir` should now say it
   takes the same form `read.paths` does, and that paths inside `cmd` are not translated. Confirm
   both halves are true: a virtual `workdir` works, the same spelling inside `cmd` is refused.
7. **Finding 3, the stale overlay.** Restart the app under a live turn with tool calls in flight.
   The "Waiting for N tool calls" panel must clear within about a minute rather than persisting.

## Part C — what last round could not reach

Only if the connector is attributable. If it is not, say so at the top and mark these blocked —
do not work around it, and do not forge identity through `/pair` and `/correlations`.

8. Sub-agents end to end: spawn a prime and a worker, real work, read the result from the prime.
9. A chat blocked mid-generation, not idle.
10. One real browser action driven from an attributed ChatGPT conversation.

## Report

Pass/fail per item with exact evidence. For item 3 especially: if it fails, the evidence matters
more than the verdict, because there is currently no theory that explains it.

Then answer the release question directly, in prose: **is there any defect here you would not
ship?** That sentence is what this round is for.
