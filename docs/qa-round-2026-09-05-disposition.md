# Disposition — release sign-off round of 2026-09-05

Every item the macOS Claude Code report and the parallel ChatGPT run raised, and what happened to
it. Written so the next reader does not have to reconstruct which findings were defects, which
were correct behaviour, and which were gaps in evidence rather than in the app.

Evidence is named where it exists. "Live" means driven against a real page or a running app on
this branch, not asserted from a test.

## Defects, fixed

| Item | Cause | Evidence |
| --- | --- | --- |
| **Dropdown never changed** (ChatGPT 41) | `set_value` was click + select-all + insertText. Chrome paints a native `<select>` popup in the browser process, so no synthetic event reaches an option — the call succeeded and did nothing. | Live on `/dropdown`: `{"set":"g1_e0","value":"1","selected":"Option 1"}`. Unmatched option refused by name with the options listed, control untouched. |
| **`/hovers` exposed no refs** (ChatGPT 47) | `observe` collected only interactive elements. The wrapper is a plain `div` and the caption is `display:none` until hovered, so `move_ref` had nothing to aim at on its own headline case. | Live on `/hovers`: all three targets exposed, `move_ref` reveals the caption. |
| **Logout did not actuate** (ChatGPT 44) | Not a click defect. A Chrome-native password dialog over the tab swallows input; `elementFromPoint` cannot see browser UI, so `covered` is honestly false and the click reports success. | The real button was driven from a clean profile and **worked** — `hit=i covered=false navigated=true` → `/login`, carrying the exact signature the failing runs reported. A link click that reaches nothing now says so. |
| **Chrome error page returned as the site** (ChatGPT 76) | `chrome.tabs` and `Page.getNavigationHistory` both report the *requested* address for a failed load. Only the frame tree reports `chrome-error://chromewebdata/`. Every guard was asking a lying surface. | Measured against a dead port; `verify:browser` covers refuse → stay detached → and still be able to leave. |
| **A stalled compaction took browser recovery with it** (Finding 1, recovery half) | `inspectSilentChats` skipped a chat for the whole life of a continuation, not just while it was being chased. | Two tests, each confirmed failing without the fix. |
| **A handoff open across a restart, same shape** | A continuation restored from disk never gets a watch, and "no watch yet" was read as "about to be armed". | Test confirmed failing without the fix. |
| **The `exec_command` path contract was half-stated** (Finding 2) | `workdir` accepts virtual paths and always did; `cmd` is not translated. The description said neither. | Confirmed live both ways in the reporting round. |
| **A stale "Waiting for N tool calls" panel** (Finding 3) | The count describes another process's memory and nothing expired it, so a failed poll froze the last number forever. | Confirmed live: cleared at 61 s where it had survived ten minutes. |

## Correct behaviour, made easier to act on

The report's closing judgement was that the app's failures are refusals, they are correct, and a
run that meets four in ten minutes reads a pattern rather than four right decisions. No fence was
weakened. Two refusals now name the remedy they already knew:

- `WORKSPACE_REQUIRED` lists the approved roots. A worker meets this on its first command.
- `INPUT_TARGET_LOST` / `STALE_UI_SNAPSHOT` / `FOCUS_FAILED` against a browser window point at the
  `browser` tool, which drives a page over CDP and needs no desktop focus. That sentence existed
  only in a source comment.

The `WORKSPACE_REQUIRED` fence itself was deliberately left alone. Skipping it when a single root
is approved looks safe and is not: the failure it exists for happened *inside* one root, so a root
count cannot see the ambiguity.

## Not defects

- **The model denied having an `agents` tool, then used it.** The app exposed it throughout. A
  report that took the first answer at face value would have filed a phantom bug.
- **Unattributed repair fired twice.** Triggered by the reporting harness's own unattributed calls.
- **`INPUT_TARGET_LOST` against a browser.** The fence failing closed on honest ignorance of where
  input would land, which is its job. Only the message changed.
- **Test and check counts differing from the brief.** Both suites are platform-gated. The briefs no
  longer quote totals, because a Windows figure reads as a regression on macOS.

## Open, and why

- **Finding 1, live.** Forcing it needs an automatic compaction at `dispatched-unresolved` and then
  fifteen minutes of ChatGPT's own transport failing, which cannot be induced on demand. Both the
  recovery half and the restart half are covered by tests confirmed to fail without their fixes.
  This is a gap in evidence, not a defect being carried, and both the reporting round and this one
  reached that conclusion independently.
- **The connector path.** Local probes drive the driver directly; they cannot cover attribution
  through ChatGPT itself. The layer between — the MCP renderer — is covered, and one real defect
  was found there: a note long enough to be truncated past its own remedy.
- **A mid-generation block, driven fresh.** The last round carried it from an earlier build on a
  byte-identical code path rather than re-driving it.

## Gates at the time of writing

    npx tsc --noEmit          clean
    npx vitest run            2389 passed, 27 skipped
    npm run verify:browser    73/73 against real Chrome
    npm run verify:compact-chain   7 checkpoints + control, app running
    npm run verify:privacy    passed

Upstream: 0 behind, v2.0.5 still upstream's newest tag.
