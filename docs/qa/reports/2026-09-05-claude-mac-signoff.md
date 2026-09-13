# Release sign-off — macOS, Claude Code

Run of `docs/qa-release-signoff-claude.md`. Repo at `96f0fe0` + this report. Installed build
**2.0.5+c44be15** (`/Applications/Chat On Steroids.app`), which was already the newest artifact on
the machine.

## Attribution: arranged, with one limit that still bounds Parts C and E

**The connector is picked in ChatGPT and attribution works.** I typed a prompt into a real
conversation and the resulting call was attributed:

    2026-09-04T22:07:49.337Z  info  request attribution:
        wfr_01a06e7545c174848b02d0229564edc7 -> conversation 6a9b375e-2b7c-83ed-8475-4a29b51b3669

One correction to the brief's check: **`lastToolCallAt` alone does not prove attribution.** My own
Unattributed harness call set it non-null. The `request attribution: … -> conversation …` log line
is the fact worth reading; the `no page evidence for … within 20000ms` warning is its negative.

The limit that remains: attribution binds a *request id* to a conversation through page evidence,
so **I cannot originate an attributed call from my own MCP client at all** — not for want of
setup, but by design. Parts C, D and E can therefore only be driven by prompting ChatGPT through
the page. I did that for Part D's never-run item (below), where each interaction costs 3–4 desktop
calls at ~30 s each. That is affordable for one targeted test and not for a full sub-agent or
browser sweep, so **C and E are reported as not run rather than blocked** — the prerequisite
exists, the driving channel is too slow to cover them here.

Separately, note that a parallel ChatGPT-side run was already in progress on this machine and had
exercised sub-agents (`session … named for the worker chat this app opened`, 21:48) and the
browser surface. I have treated its conclusions as leads to verify, not as results.

**One thing I broke, stated plainly:** restarting the app to read its per-session MCP URL killed an
in-flight ChatGPT tool call in the user's own QA chat. See Finding 3.

## Baseline

    npx tsc --noEmit          clean
    npx vitest run            83 files passed / 3 skipped · 2309 passed / 98 skipped
    npm run verify:privacy    passed (326 commits, 4 tags)
    npm run verify:browser    47/47
    npm run verify:compact-chain  all 7 checkpoints + the no-checkpoint control

---

## Part A — what the last report left genuinely unrun

### A1. Block a chat mid-generation — **PASS**

Driven end to end against a real conversation. I sent `sleep 240; echo QA-A1-SECOND` into chat
`6a9b375e-…`, then blocked it 6 seconds later while the turn was actively generating.

| Claim | Evidence |
| --- | --- |
| refusal is named | ChatGPT's own turn rendered `CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run.` |
| no tool ran | app log `conversation 6a9b375e-… blocked; its tool calls are refused until it is released`; no `mcp/core` request followed |
| turn stops cleanly | the assistant closed the turn itself — "So there is no `QA-A1-SECOND` output to report." No hang, no retry loop |
| UI treatment | a red **Chat blocked** badge appeared in the composer |
| durable | `state/blocked-chats.json` → `{"conversationId":"6a9b375e-…","blockedAt":1788559835517}` |
| release restores on the **very next call** | released at 22:11:58 (`released; its tool calls run again`); the next prompt's call was attributed and ran at **22:13:56, 4 s after send**; blocked set back to `[]` |

### A2. Kill between the durable session move and its projection publish — **NOT RUN**

Needs a live Compact & Resume that reaches a destination chat. None does on this machine — see
Finding 1. The crash boundary itself could not be reached, so this remains genuinely untested.

### A3. `destinationLost` driven by hand — **NOT RUN, and blocked upstream of itself**

Driving it requires a real Compact & Resume to reach chat B with the brief in its composer. On
this machine no continuation has ever reached the destination leg at all: every one of the six on
disk sits at `destinationSend: not-attempted`. The hand-driven test is unreachable until Finding 1
is fixed. Its three links and the live join remain verified as recorded in the previous report.

### A4. Browser against a hostile page — **NOT RUN**

Needs the `browser` tool, which is attribution-fenced; see the attribution note.

---

## Part B — delta check on the shipping build

The only app-code change since the previously reported build (`71d0c48`) is
`extension/background.js` (`c44be15` + `30727cd`). No `src/` change at all, so the Desktop and
recovery results in the previous report stand unretested by choice, per the brief.

**The delta is the digest fix, and it works.** Since the c44be15 build started there are **zero**
`(build unreported)` lines, against three in the previous session. Better, the two browsers on this
machine are now correctly told apart:

    22:14:15  bridge: browser extension 2.0.5 connected (build 5d26e6060db0)   ← harness Chrome, repo extension
    22:14:23  bridge: browser extension 2.0.5 connected (build 88c1e4b2b15a)   ← everyday Chrome, app-bundled extension

`5d26e6060db0` matches `shasum -a 256 extension/background.js` at HEAD; `88c1e4b2b15a` matches the
copy inside the installed app. That is exactly the question the digest was added to answer, and my
previous finding is closed.

Two small notes on the brief itself: it says the guard is "bounded at 250 ms", but `30727cd`
widened it to 5000 ms; and `verify:compact-chain` loads `extension/` from the **repo**, not from the
installed app, so it measures HEAD's worker rather than the shipped one. Both are worth knowing
when reading its output as evidence about a build.

**New this session:** `STALE_UI_SNAPSHOT: the referenced accessibility control no longer belongs to
snapshot window 10694` fired live. That is the stale-ref refusal my previous report could only
reach through invented refs; the real path is now confirmed. Also confirmed working: the background
exec obligation fence, which refused an unrelated caller with `CALLER_IDENTITY_REQUIRED: completed
background exec results exist…` while results were owed to another session.

---

## Parts C, D, E

- **C, sub-agents end to end — NOT RUN.** Fences verified refusing in the previous report; the
  lifecycle needs prompt-driving that is too slow through the page. The parallel ChatGPT run did
  exercise workers and reported three sleeping with all slots free.
- **D, blocked chats — PARTIAL.** Mid-generation is done and passes (A1). Idle was covered by the
  earlier Mac session. **Not done:** a blocked *worker* chat, and the Goal/Loop-refused-from-a-
  blocked-composer claim — that one is not merely unrun but currently unverifiable on this machine,
  because Goal/Loop needs an OpenRouter key and none is configured (`goal.enabled: false`).
- **E, browser over MCP — NOT RUN.** The delivery path from an attributed ChatGPT call remains
  unexercised by me. `verify:browser` covers the driver, not the delivery.

---

## Findings

### Finding 1 — Compact & Resume never reaches a destination chat here (highest severity)

Six continuations on disk, spanning 16:29–20:42, every one identical in shape:

    state: awaiting-summary   sourceSend: dispatched-unresolved   destinationSend: not-attempted   to: null

Six for six, the source leg arms and dispatches the handoff prompt into chat A and the summary
never arrives. The log shows why each began to fail — `assistant transport failure — bringing the
compaction pickup for … forward`, immediately after each ticket was filed — and then the phase
pickups exhaust in order (`writing pickup 1 of 3`, `2 of 3`, `3 of 3`) and the entry sits until its
six-hour TTL, at which point it is abandoned correctly:
`continuation OONUUGOJ abandoned — the handover never landed and was given up on`.

The trigger looks environmental (ChatGPT transport failures, plus tabs the user closed —
`closed its last tab — not reopened: tab recovery is off for this chat`, with
`recoverAgentTabs: false`). The *behaviour* is not: the end state is a chat wedged for six hours
that is also skipped by `inspectSilentChats()` because `pendingAutomaticContinuations()` still
names it, so it loses browser recovery for the whole window. The `sourceLost` give-up added in
`085f233` is the right fix for the case where a page is alive to report; it cannot help when the
page is gone, which is the case that actually happened six times today. The independent ChatGPT run
reached the same wall from the other side: "because no replacement chat was created, there was no
lineage, landing time, moved history, or retired chat to test."

I did not fix this. The root cause is a design gap, not a defect I can close with a small correct
change: something has to end or re-file a continuation whose page will never come back, and
choosing between abandoning early and waiting out the TTL is a product decision.

### Finding 2 — the model-facing path contract is inconsistent between `read` and `exec_command`

`read.paths` advertises `Paths inside the live approved roots: /chatgpt_homelab`. `exec_command`'s
`workdir` says only `Working directory for the command. Defaults to the turn cwd.` — it never says
a virtual path is refused. A model that learns the root name from `read` and passes it to
`exec_command` gets `INVALID_COMMAND_PATH: /chatgpt_homelab is an app virtual path, but shell
commands do not understand virtual paths.` The parallel ChatGPT run hit exactly this.

Not fixed, deliberately: the refusal already names the correction ("Use workdir plus a relative
path, or use the approved folder's native filesystem path. No command was run."), so the cost is
one round-trip and the caller is taught. It is a papercut in the contract, not a defect — but it is
the papercut a first-time user is most likely to meet, so it belongs in Part F rather than in a
patch I make on my own judgement.

### Finding 3 — a stale "waiting for N tool calls" overlay survives an app restart

Restarting the app under a live ChatGPT turn left the page overlay reading **"Waiting for a tool
call — The current operation has not returned yet"**, and later **"Waiting for 2 tool calls"**. It
persisted for over ten minutes and across a *completed* turn, including after the blocked turn had
ended. The in-flight calls died with the old process and nothing told the page. I caused the
restart, so treat the trigger as artificial — but an app restart is an ordinary event (the updater
performs one), and the page is left asserting something untrue about local state.

---

## Part F — the release question

**Is there any defect I would not ship?** One: Finding 1. Not because compaction sometimes fails —
it depends on ChatGPT's own transport, and failing is allowed — but because of what failure leaves
behind. A chat that loses a handoff is wedged for six hours *and silently loses browser recovery
for that entire window*, because it is still named by `pendingAutomaticContinuations()` and
therefore skipped by `inspectSilentChats()`. The user sees a chat that has simply stopped working
and nothing tells them why or offers a way out. Six of these accumulated on one machine in a single
afternoon. Everything else I found this round is a papercut, a diagnostic gap, or already fixed.
I would ship the rest.

**Would a first-time user hit something in the first ten minutes that made them distrust the app?**
Two things, in order of likelihood. The first is Finding 2 — the app teaches you a path spelling in
one tool and refuses it in another. It self-corrects in one round-trip, so it costs trust rather
than time. The second is subtler and worse: the app's most impressive feature is the one most
likely to fail in front of them. Auto-compaction fires unprompted at a threshold, and when it
fails it fails invisibly — no error, no notice, just a chat that stops behaving. A first-time user
will not connect "the app compacted my chat" with "this chat is now wedged", because nothing in the
UI draws that line. By contrast the parts that are genuinely solid — the sandbox, exec, the
identity fences — are solid in a way that is only visible when you try to break them, which a new
user will not do. The failure is louder than the success.

**The weakest part of the surface, and is it documented where a user would find it?** Compact &
Resume, without much competition. It is the longest-lived transaction in the app, it spans three
processes that can each die independently, and it is the only mechanism whose failure mode
degrades an *unrelated* subsystem — browser recovery. The evidence is not subtle: two of the three
open items in the previous brief were about its give-up paths, `destinationLost` went two full days
dead in production without a single test noticing, and the whole `verify:compact-chain` script
exists because unit tests structurally cannot see the seams it fails in.

It is documented, thoroughly — in `AGENTS.md` §4.1, in the source comments, in this directory. All
of that is maintainer-facing. A user reads `README.md`, and what a user needs to know is not the
continuation state machine; it is one sentence saying that if a chat stops responding after an
automatic compaction, the fix is to reload the tab, and that `recoverAgentTabs` is the switch that
would have done it for them. That sentence does not exist anywhere a user would find it. The
weakness is documented for the people who already understand it and undocumented for the people
who will hit it.

Second, and more narrowly: the browser surface is materially slower and less deterministic than
Core — the parallel run measured 5–14 s per call and a transient `Connection failed.` that
succeeded on retry, and saw `navigate` report success for a domain that did not resolve, with only
a follow-up observation exposing `DNS_PROBE_FINISHED_NXDOMAIN`. I did not verify those myself and
flag them as that run's claims, but they are consistent with a surface I would not point at
unattended work yet.

---

## Machine restoration

App restarted normally, no debug port open. Blocked set empty. No stray processes. Config
untouched. Clipboard untouched this round. The six pre-existing continuations left exactly as
found. Local tree clean.

Two things I could not undo: three QA prompts are appended to the user's ChatGPT chat
`6a9b375e-…` ("Final release check summary"), and the completed background exec results from those
`sleep` commands are still owed to session `2026-09-04-e7768b5e` until that chat reads them.
