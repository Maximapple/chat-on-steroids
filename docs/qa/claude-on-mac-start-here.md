# Starting a Claude Code session on the Mac

A Claude Code conversation does not move between machines, and it does not need to: everything
that matters is in this repository. Clone it on the Mac, run `claude` in it, and paste the block
below the line. It says what has been done, what has not, and what only that machine can answer.

Do the automated part first. It is quick, it needs no permissions, and a failure there changes
what is worth doing by hand.

---

You are picking up work on this repository on a Mac. The branch is
`integrate/browser-and-desktop-064733`. Everything checkable on Windows has been checked:
`verify:ci` is green (1910 passed, 22 skipped), the browser driver scores 23/23 against real
Chrome 152 and against Edge, and all six release platforms build. Two things could never be
checked from there, and this machine is the only place they can be.

Read `docs/macos-qa-runbook.md` first — it has the detail, including a table mapping each
`pointer=` verdict to a verdict. `docs/extension-parity.md` records how this extension compares
to ChatGPT's own, in case that comes up.

## What to run

1. `npm ci`, then `npm run verify:ci`. It should be green. If it is not, that is a real finding —
   it has never been run on macOS.

2. `npm run verify:browser`. This drives a real browser against a real page and asserts 23 things,
   among them that a click arrives with `isTrusted: true`, that the same holds inside an iframe,
   and that one screenshot pixel is one CSS pixel. It has only ever run on Windows.

   Chrome 137 and later ignore `--load-extension`, so installed Chrome cannot be driven this way.
   The script prefers a Chrome for Testing build and says plainly if the extension did not load.
   If none is present, fetch one from
   `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`
   (mac-arm64 or mac-x64) and point `COS_BROWSER` at it. This is a harness limitation only —
   users install through **Load unpacked**, which still works.

3. `node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64`, then
   `node scripts/probe-macos-helper.mjs arm64`. This starts the native helper and asks it for the
   cursor, the window list, and two captures. On a CI runner it reports
   `pointer=system captureMode=screen` — the display path, where ScreenCaptureKit draws the
   pointer itself. On a real desktop with a real window it should reach `captureMode=window`,
   which is the hand-composited path, and that is the code that was once wrong. Report the exact
   `pointer=` value.

## What needs a person, and why

The pointer in a window screenshot, the appearance of the onboarding permission step, and
Chrome's link-preview bubble all need granted TCC permissions and a real pointer at a real
position. The runbook lists them. Do not claim any of them from reading code — a code review of
that pointer path already produced a confident wrong answer once.

There is also `docs/qa/chatgpt-desktop-qa-prompt.md`, a 32-check script meant to be pasted into
ChatGPT with the app connected. That exercises model → MCP → app → macOS, which is the real
product path and not something you can drive from here. If a report comes back from it, the
failures in it are yours to investigate and fix.

## How to behave about it

Say what you ran and what it printed. If something is untested, say untested rather than
implying otherwise — that distinction is the whole reason this file exists. The pointer work has
already been claimed fixed once on the strength of correct-looking code, and it was not fixed.
