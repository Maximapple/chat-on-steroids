# Second confirmation round — macOS, Claude Code

Run of `docs/qa-confirmation-claude.md` (the retargeted version). Repo at `52ded86` plus my report
commits. Installed build **2.0.5+52ded86** — already the tip; `git diff 52ded86..HEAD -- src/
extension/ native/ scripts/ package.json` is empty. **No code changes were needed this round, so
there are no fix hashes to report.**

## Baseline — all green, no failures

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 2316 passed / 98 skipped (83 files passed, 3 skipped) — **0 failed** |
| `npm run verify:privacy` | passed (346 commits, 4 tags) |
| `npm run verify:browser` | **74/74** |
| `npm run verify:compact-chain` | verified — all 7 checkpoints plus the no-checkpoint control |

Judged by failures, not totals, as the brief asks. For the record the totals moved again (2312 →
2316, 61 → 74 browser checks); both are growth, nothing regressed.

**Digest** — repo, app bundle and the app's own connect line all agree:

    shasum -a 256 extension/background.js | cut -c1-12   5d26e6060db0
    /Applications/…/Resources/extension/background.js    5d26e6060db0
    verify:compact-chain printed                         5d26e6060db0
    07:37:10  bridge: browser extension 2.0.5 connected (build 5d26e6060db0)

---

## Part A — the one finding still open

### A1. Finding 1, the wedged chat — **UNCONFIRMED. No opportunity arose, and I did not manufacture one.**

No continuation existed at any point during this session (`continuations.json` held zero entries
throughout) and no compaction ticket was filed all day — `grep` for `auto-compaction ticket` and
`continuation … durably opened` on 2026-09-05 returns nothing. So there was no natural opportunity
to take, and per the brief I left it there rather than building one.

**But I found the instrument, and it is much cheaper than the one the brief was looking for.**

The brief frames the missing shape as "three spent `writing` pickups on an open ticket", which needs
fifteen minutes of ChatGPT's transport failing. `ffc2ef9` opened a second door to the same release,
and its own commit message says it is the commoner route — the one the reporting machine actually
took. `compactionStillChased()` now reads:

    if (compactionWatchFloor === null || entry.openedAt < compactionWatchFloor) return false;

`compactionWatchFloor` is set to the moment *this run* started serving (`bridge.ts:3722`, `:7243`).
So **any continuation restored from disk is permanently "not chased"** — no pickups need to be
spent, and no transport needs to fail. Restarting the app under an open ticket produces the exact
state the fix releases, on demand, in seconds.

The full recipe, for whoever runs it next:

1. Get one automatic continuation open (any real auto-compaction ticket will do).
2. **Restart the app.** The ticket is now below `compactionWatchFloor`, `compactionStillChased()`
   returns false forever, and no watch will ever be armed for it.
3. **Set `multiAgent.recoverAgentTabs: true` first**, or the test proves nothing. `inspectSilentChats`
   gates on `tabRecoveryWanted()`, which is `goalActiveFor(conversationId) ||
   config.multiAgent.recoverAgentTabs` (`bridge.ts:5267`). With it off — the default, and the
   setting on this machine — a silent chat has its silence marked *spent* and is never reloaded, so
   you would watch the release work and see nothing happen.
4. Let the chat go silent past its grant and watch for `queueBrowserRecovery(… 'silence' …)`.

Step 1 is the only expensive part left, and it is why I stopped: a genuine auto-compaction types a
handoff prompt into a real chat and opens a replacement chat, which is not something I will do
unasked to a shared ChatGPT account. Lowering `compaction.autoTokens` to force it is two config
changes and a real side effect on the user's chat history.

What this recipe does **not** cover is the original path — `watch.attempts <
COMPACTION_PICKUPS[watch.phase].attempts` — which still needs the transport failures. Both routes
converge on the same `compacting` set in `inspectSilentChats`, so exercising the restart route
would confirm the release; it would not confirm the pickup counter.

---

## Part B — the failure paths

**Attribution available**, so nothing here is blocked:
`request attribution: wfr_01a070933b3c7e998f927353f974f8da -> conversation 6a9bc7c8-…`.

### B4 (item 4). `WORKSPACE_REQUIRED` names the roots, and the worker acts in one step — **PASS**

The worker's first command, verbatim from the log:

    07:43:02  [worker-1] tool exec_command rejected in 0 ms: WORKSPACE_REQUIRED: this multi-agent
              chat has no proven workspace. Supply an explicit approved workdir before running a
              command. Approved roots: /chatgpt_homelab

The roots are now named. And it worked as intended — **the worker recovered in one step, with no
guessing round-trip**: its very next `exec_command` succeeded (`07:43:45 [worker-1] tool
exec_command zsh -> 4409`). One `agents` call sat between them, which was it messaging the prime,
not a retry. This was the report's own example of a loud refusal being the second thing that ever
happens in a worker's chat; it is still the second thing, but it now carries its own answer.

### B2 (item 2). A worker blocked mid-run — **PASS, slot freed, no deadlock**

Set up so the block landed genuinely mid-run: worker-1's task was `sleep 240; echo WORKER-LONG`,
backgrounded as pid 4409 and being polled by `write_stdin` when I blocked its chat.

    07:46:06  conversation 6a9bc7f9-… blocked; its tool calls are refused until it is released
    07:47:14  [worker-1] tool write_stdin ok in 191492 ms      ← the polls in flight completed
    07:47:27  multi-agent: worker-1 is sleeping                 ← 81 s after the block

| Check | Result |
| --- | --- |
| slot frees | worker-1 left the live agent list; `swarm.json` went to `runId: null`, `agents: []` |
| the run parks rather than hanging | the whole run parked with worker-1 `sleeping` in the dormant run |
| no deadlock | zero `AGENTS_BUSY` on 2026-09-05 — the only two in the entire log are from 2026-09-03 and unrelated |

Timing worth writing down: the slot does not free on the block itself, it frees on the next
`sweepStaleSwarm` pass (`STALE_SWARM_SWEEP_MS = 30_000`). Measured 81 s end to end, because the
in-flight `write_stdin` polls had to return first. A tester who checks the swarm state ten seconds
after blocking will see `active` and think it deadlocked. It has not.

### B3 (item 3). A chat blocked mid-generation — **PASS, driven on this build**

Driven rather than carried this time. The prime chat was running `sleep 240; echo PRIME-LONG`
(backgrounded as session 14220 at 07:51:33); I blocked it at **07:51:34**, one second later, with
the turn still open.

| Claim | Evidence |
| --- | --- |
| turn stops cleanly | the assistant closed the turn itself: "The command was started in `/chatgpt_homelab` as session `14220`, but tool access was blocked before it could retrieve its final output." No hang, no retry loop |
| refusal is named | forced a call while blocked; ChatGPT quoted it verbatim: `CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run` |
| UI treatment | red **Chat blocked** badge in the composer |
| durable | `{"conversationId":"6a9bc7c8-…","blockedAt":1788594694669}`, cleared to `[]` on release |
| release restores on the **very next call** | released ~07:58:0x; next call attributed 07:58:29 and `tool exec_command zsh -> exit 0` at **07:58:32** |

One detail better than required: the blocked refusal still carried the background-command recovery
notice — `--- Background command recovery --- Background session 14220 finished with exit code 0 and
has unread output. Poll it with w…`. Blocking a chat does not lose the output it was owed.

**A note on measuring this.** The first mid-generation block I ran produced *no* `CHAT_BLOCKED` at
all, because the model simply concluded the turn instead of making another call. `CHAT_BLOCKED`
never appears in `app.log` — it is returned in the tool result and rendered in the page, nowhere
else. Confirming this item requires forcing a tool call while blocked; watching the log for it will
show nothing and mean nothing.

---

## Machine restoration

App restarted normally, no debug port. No blocked chats, zero continuations, no live swarm run, no
stray `sleep` processes, config untouched (I changed no settings this round), local tree clean.
Left behind: two QA chats in the user's ChatGPT account — `6a9bc7c8-…` ("Spawn Worker") and its
worker chat `6a9bc7f9-…`, whose worker is sleeping with its slot free.

---

## The release question

**Is there any defect here I would not ship?** No. Every item this round measured passed, and the
two that mattered most passed on their failure paths rather than their happy paths — which is the
only kind of pass that counts for a broker. Blocking a worker mid-run frees its slot and parks the
run instead of wedging it; blocking a chat mid-generation stops the turn cleanly, names the refusal,
and hands tools back on the very next call three seconds later. The one item still open, the wedged
chat, is open on my evidence and not on the code: I have now read that path twice and found the
second door `ffc2ef9` closed, and my inability to confirm it live is a fact about a shared ChatGPT
account rather than about the app.

If I were arguing against shipping, the honest case is not a defect but a shape: this app's hardest
behaviour is all in the recovery paths, and the recovery paths are exactly the ones nobody can drive
on demand. Three rounds in, the wedged chat has been fixed twice and confirmed live zero times. That
is not a reason to hold the release — but it is a reason to build step 1 of that recipe into a
script, the way `verify:compact-chain` was built, so the fourth round is not a fourth judgement call.

**Would a first-time user hit something in the first ten minutes that made them distrust the app?**
Less than at any point in these three rounds, and one specific thing got measurably better. Last
round I complained that a worker's second-ever action was a red `refused` badge with no way forward.
That refusal now ends `Approved roots: /chatgpt_homelab`, and I watched the worker read it and get
the command right on the next try with no round-trip. That is the whole difference between a fence
that teaches and a fence that just says no, and it is worth more than it looks.

What is left is the thing I would still not call a defect. The app's competence is expressed almost
entirely through refusals — `WORKSPACE_REQUIRED`, `CHAT_BLOCKED`, `INVALID_COMMAND_PATH`,
`STALE_UI_SNAPSHOT` — and every one of them is correct, self-explaining, and invisible when it
works. A new user's first ten minutes will contain more red text than green, and the red text is the
app doing its job. I would not soften one of them. But I would put a single sentence somewhere a
user reads before their first session — that refusals here are load-bearing and each one names its
own fix — because the app currently relies on the user inferring that from four examples, and the
first impression lands before the fourth example does.
