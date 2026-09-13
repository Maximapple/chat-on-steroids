# Confirmation round — macOS, Claude Code

Run of `docs/qa-confirmation-claude.md`. Repo at `273f310` plus this report. Installed build
**2.0.5+96ee587**, which was already the newest code commit on the machine — everything after it
(`661247a`, `273f310`) is documentation, and `git diff 96ee587..HEAD -- src/ extension/ native/
scripts/` is empty. I made no code changes this round, so there are no fix hashes to report.

## Baseline

| Check | Result | Note |
| --- | --- | --- |
| `npx tsc --noEmit` | clean | |
| `npx vitest run` | **2312 passed / 98 skipped** (83 files passed, 3 skipped) | brief expected 2383 — see below |
| `npm run verify:privacy` | passed (336 commits, 4 tags) | |
| `npm run verify:browser` | **61/61** | brief expected 60/60 — see below |
| `npm run verify:compact-chain` | verified, all 7 checkpoints + the control | app was running; the new "the app is running, so the chain can be checked at all" line appears |

Two expectation mismatches, both benign and neither a product fault:

- **2312, not 2383.** The suite is platform-gated — `test/codex-runtime-parity.test.ts` and others use
  `it.runIf(process.platform === 'win32')`. 2383 is a Windows figure; macOS legitimately runs fewer.
  Worth pinning the expected number per platform in the brief, or it will read as a regression every
  time someone runs it here.
- **61/61, not 60/60.** One more check than the brief expected, all passing. An off-by-one in the
  expectation, not a missing or extra test.

**Digest comparison** — repo, app bundle and userData all agree, and the connect line matches:

    shasum -a 256 extension/background.js | cut -c1-12      5d26e6060db0
    /Applications/…/Resources/extension/background.js       5d26e6060db0
    userData/extension/background.js                        5d26e6060db0
    verify:compact-chain printed                            5d26e6060db0
    2026-09-05T05:25:30  bridge: browser extension 2.0.5 connected (build 5d26e6060db0)

Zero `(build unreported)` lines on 2026-09-05; every such line in the log is from 2026-09-04
20:09–20:58, before the fix. My earlier finding stays closed.

---

## Part A — the three findings

### A1. Finding 1, the wedged chat — **NOT CONFIRMED LIVE. I could not force a stalled handoff.**

Saying so plainly, as the brief asks, rather than guessing.

All six continuations from the last round expired their six-hour TTL overnight; `continuations.json`
now holds zero entries, so there was nothing already stalled to observe. Forcing a fresh one needs
an automatic compaction to reach `dispatched-unresolved`, then its three *writing* pickups to fail
on a five-minute cadence — fifteen minutes in which ChatGPT's own transport has to keep failing.
That last part is the bit I cannot induce: last round's six arose from real
`assistant transport failure` events, not from anything I did. Closing the tab produces a different
stall shape, and a chat wedged that way would not have told me whether `compactionPickupsRemain()`
is what released the skip.

What I can say without claiming a live result: the change is narrow and its regression test drives
the real sequence (asking pickup → `sourceAttempt` → `sourceDispatch` → three writing pickups spent
→ a silent turn), and the commit records it confirmed failing without the fix. That is code
evidence, not the live confirmation the brief wanted, and I am not reporting it as one.

### A2. Finding 2, the path contract — **PASS**

Schema read from the running app:

    workdir: Working directory, as an app path in the approved roots — the form read.paths takes,
             e.g. /my-project. Defaults to the turn cwd. Paths inside cmd are not translated:
             keep them relative to it.

Both halves confirmed live against build 96ee587:

| Case | Result |
| --- | --- |
| `{"cmd":"pwd","workdir":"/chatgpt_homelab"}` | **accepted** — exit 0, output was the root's native path (redacted) |
| `{"cmd":"ls /chatgpt_homelab","workdir":"/chatgpt_homelab"}` | **refused** — `INVALID_COMMAND_PATH: /chatgpt_homelab is an app virtual path, but shell commands do not understand virtual paths. Use workdir plus a relative path, or use the approved folder's native filesystem path. No command was run.` |

**My previous report was wrong on this and the brief is right.** I wrote that a model would pass the
root name to `workdir` and be refused. `workdir` accepts it and always did; the refusal I saw in the
parallel ChatGPT run came from a path written inside `cmd` (`find /chatgpt_homelab …`). The gap was
only in the advertisement, and it is now closed on the parameter itself.

### A3. Finding 3, the stale overlay — **PASS, cleared at 61 s**

Set up the exact condition: a real ChatGPT turn running `sleep 120; echo A3-DONE`, confirmed live
on the page (`Started sleep 120; echo A3-DONE  running  07:46:36`, Stop button showing, panel
reading "Waiting for a tool call — The current operation has not returned yet"). Then `SIGKILL` on
the app at 07:48:05 and timed the panel.

| t after kill | Panel |
| --- | --- |
| +2 s … +53 s | "Waiting for a tool call — The current operation has not returned yet" |
| **+61 s** | **"ChatGPT is still working — Waiting for the current response to make visible progress"** |

The stale count expired on the documented 60-second window and the panel stopped asserting a fact
about a dead process, while still describing what it can honestly observe. Last round the same panel
survived over ten minutes and a completed turn.

**A methodological note that matters for anyone repeating this.** My first attempt measured the
panel while polling with `observe`, and it looked like the bug had survived — the panel stayed up
past 90 s. It had not. Unattributed calls are conservatively visible to every conversation until
ownership lands, and each of my desktop calls genuinely runs for 20–35 s, so the app was truthfully
reporting a running call the whole time. The instrument was creating the symptom. I re-ran it using
macOS `screencapture` only, touching no app tooling between the kill and the reading. A timing check
on this panel is only valid if the observer makes no tool calls.

---

## Part B — attributable connector

**Not blocked.** The connector is picked in ChatGPT and calls attribute:
`request attribution: wfr_01a0700df41e79dcadb438f41a2e44c2 -> conversation 6a9ba975-…`.

### B4. Sub-agents end to end — **PASS for spawn → work → report → prime reads result.** Worker-blocked-mid-run **not run**.

Driven from a real ChatGPT conversation. App log:

    05:37:42  multi-agent: run fc108651-… started by conversation 6a9ba975-… with 1 worker(s)
    05:37:42  [prime] bridge: opening a fresh ChatGPT chat for worker:worker-1
    05:37:46  multi-agent: worker-1 is active in conversation 6a9baaa7-…
    05:37:54  [worker-1] tool exec_command rejected: WORKSPACE_REQUIRED: this multi-agent chat has
              no proven workspace. Supply an explicit approved workdir before running a command.
    05:38:20  [worker-1] tool exec_command zsh -> exit 0
    05:38:30  [worker-1] multi-agent: worker-1 is sleeping
    05:38:30  multi-agent: parked run fc108651-… — no worker is currently running

The worker's own chat rendered the whole timeline, labelled correctly ("This is worker-1 — the
instruction this app gave the worker, not something you typed"), including the `WORKSPACE_REQUIRED`
refusal, then `Ran uname -a`, `Messaged prime`, `Reported the finished task`. Real output came back:
a real `uname -a` line — `Darwin … 27.0.0 … RELEASE_ARM64_T6041 arm64`, hostname redacted.

**The prime read it.** Asked for the result, the prime returned `Worker worker-1 state: sleeping`
with the full block quoted verbatim — RESULT / VALIDATION / OUTPUT / BLOCKERS. That is the complete
loop the previous two rounds could never reach.

Not done: blocking a worker chat mid-run to confirm the slot frees. I ran out of reliable page
driving before reaching it (see the note below), and I would rather report it unrun than infer it.

### B5. A chat blocked mid-generation — **PASS**

Fully driven last round on build `c44be15`: ChatGPT rendered `CHAT_BLOCKED: the user blocked this
conversation from using local tools, and no tool was run`, closed the turn itself, showed the red
**Chat blocked** badge, wrote the durable row, and the very next call after release ran four seconds
later. `git diff c44be15..HEAD -- src/main/session/blocked-chats.ts src/main/mcp/kernel.ts
src/main/ipc.ts` is **empty**, so that path is byte-identical on the build under test.

Re-confirmed today on 96ee587: block wrote
`{"conversationId":"6a9ba975-…","blockedAt":1788587606568}` and logged
`conversation 6a9ba975-… blocked; its tool calls are refused until it is released`; the red **Chat
blocked** badge rendered in the composer; release cleared the row and logged
`released; its tool calls run again`. The mid-generation *turn* behaviour is carried from last
round on the identical code path rather than re-driven, and I am flagging that rather than implying
I re-drove it.

---

## Other observations from this round

- **The model will lie about its own tool list.** Asked to spawn a worker, ChatGPT answered "I can't
  do this as requested because no `agents`/worker-spawning tool is available in this session". Asked
  immediately afterwards to list its tools, it printed all ten including
  `Chat_On_Steroids_Core.agents`, and then spawned a worker on the next turn. The app was exposing
  `agents` throughout. Not an app defect — but any QA driven by prompting will hit this, and a
  report that took the first answer at face value would have filed a phantom bug against discovery.
- **The exec ownership fence did real work.** After the A3 kill, ChatGPT retried its command and was
  refused: `write_stdin failed: session 20677 is not proven to belong to this durable Chat On
  Steroids session. Start your own with…`. It started its own and the turn completed with `A3-DONE`.
  A crash mid-command ended in a correct answer, which is the behaviour you want from that fence.
- **Unattributed repair fired twice** (`Reloaded chat to recover missing connector attribution`),
  triggered by my own harness's Unattributed calls rather than by any fault.
- **Page driving is the weak instrument here.** Typing into ChatGPT's composer through desktop
  automation failed silently several times — the click lands, the text goes nowhere, and only a
  screenshot reveals it. Two prompts were lost that way. It is why B4's second half is unrun.

## Machine restoration

App restarted normally, no debug port. No blocked chats, no active swarm run, zero continuations, no
stray `sleep` processes, config untouched, local tree clean. Left behind: several QA prompts in the
ChatGPT conversation `6a9ba975-…` ("Spawn Worker And Report") and its worker chat `6a9baaa7-…`,
which is sleeping with its slot free.

---

## The release question

**Is there any defect here I would not ship?** No — not in what this round measured. The three
findings from last round are fixed and two of them I confirmed live and precisely: the path contract
now states both halves and behaves as stated, and the stale panel expires at 61 seconds where it
used to sit for ten minutes. The one I could not confirm live, the wedged chat, is also the one I
was most worried about, and I want to be exact about my position: I am satisfied by the code and its
regression test that the recovery half is repaired, and I am not able to say from this machine that
it is. That is a gap in my evidence, not a defect I am carrying. The product decision underneath it
— that a stalled ticket still runs to its six-hour deadline — remains the right call to revisit
later, but it is a decision, not a bug.

What I would ship with open eyes rather than blind: sub-agents. The loop works, and it worked
first time, which is more than the previous two rounds could say. But one clean pass is not a
reliability claim, and the parts I did not reach — a worker blocked mid-run, slot accounting under
failure — are exactly where a broker deadlocks if it is going to.

**Would a first-time user hit something in the first ten minutes that made them distrust the app?**
Less than last round, and the change is real. The papercut I complained about is gone: `workdir` now
tells you it speaks the same path language as `read`, and warns that `cmd` does not. The other one I
flagged — a panel confidently asserting a tool call that no longer exists — now corrects itself
inside a minute.

What is left is quieter and I do not think it is fixable by a message. The app's failures are
mostly *refusals*, and they arrive as shouty uppercase tokens: `WORKSPACE_REQUIRED`,
`INVALID_COMMAND_PATH`, `CHAT_BLOCKED`, `STALE_UI_SNAPSHOT`, `INPUT_TARGET_LOST`. Every one of them
is correct, and every one names its own remedy — that is genuinely unusual and it is the app's best
quality. But a new user watching their assistant get refused four times in the first ten minutes
reads a pattern, not four correct decisions, and the pattern reads as "this thing does not work".
The worker in this very run hit `WORKSPACE_REQUIRED` on its first command, recovered on its own, and
finished the task correctly — and the transcript still shows a red `refused` badge as the second
thing that ever happened in that chat. I would not weaken a single fence to fix that. But if
anything is going to cost this app a first impression it has earned, it is that the successes are
silent and the refusals are loud.
