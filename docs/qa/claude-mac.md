# Everything Claude Code runs on the Mac

Six parts. They are worth running because this machine can answer questions no other can: it has
Accessibility, a screen with a real compositor, and the packaged app as installed. A build machine
has none of those, and the repository's own suites say so out loud rather than passing — part 2
below turns three of those skips into answers.

Nothing here needs ChatGPT, and nothing here needs a person: every step is a command you can run.
Parts 1–4 do not even need the installed app; part 5 does.

Since the last run from this machine, five things changed because of what it found: the window
title carries the build again and `/hello` reports it too, scrolling goes through
`Input.synthesizeScrollGesture` because the wheel event does nothing in Chrome 152, a window being
moved is read a second time instead of being called inaccessible, a refused focus names the window
in front, and the browser check that hid a hard failure behind a green SKIP no longer does.

Paste everything below the line into Claude Code on the Mac.

---

You are verifying a macOS desktop-automation app called Chat On Steroids, from its repository, on
the machine it is meant to run on. Six parts, in order. Measure rather than reason: report what you
observe, including where it contradicts what the source says should happen. A contradiction is the
more valuable result — three rounds of this work have already been corrected by measurements that
disagreed with reasoning.

## 0. Setup, and the permission that decides whether any of this means anything

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git ~/chat-on-steroids   # skip if present
cd ~/chat-on-steroids
git fetch origin && git checkout integrate/browser-and-desktop-064733 && git pull --ff-only
npm ci
node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64
```

That leaves the helper at `resources/packaging/desktop/darwin/arm64/macos-desktop-helper`. It
speaks newline-delimited JSON on stdin and stdout; `{"op":"warm"}` is the cheapest call and its
reply carries `screenPermission` and `accessibilityPermission`.

**Two shapes for focus, and they answer different questions.** `{"op":"focus","id":N}` takes the
window id under `id` — pass it as `window` and the helper reads 0 — and it answers only
`focused: true|false`, never a reason. The reason comes from
`{"op":"act","actions":[{"type":"focus","window":N}]}`, which is the path that throws
`FOCUS_FAILED` with the clause that refused. Part 3 needs the second one; run both, since the
first tells you whether focus succeeded at all.

**Screen Recording and Accessibility must be granted to whichever application owns the terminal.**
macOS attaches the grant to the GUI ancestor — usually `Terminal.app` or your IDE — never to
`node`. Ask the helper for `{"op":"warm"}` and report both flags before anything else. If either
is false, say so plainly and say which parts below are therefore unmeasurable, rather than running
them and reporting nils as findings.

## 1. The suites, as they run anywhere

```sh
npm run verify:ci
```

Report the totals and anything that failed. This is the baseline: it should be green, and a
failure here changes what everything after it means.

## 2. The three things only a real screen can judge

A build machine drives no compositor and holds no Accessibility grant, so the repository's own
checks skip these and say why. This machine can answer them.

**2a. Browser driver, with a visible browser.**

```sh
npm run verify:browser -- --headed
```

Thirty-six checks against real Chrome. Scroll was the thing to watch, and the last run from this
machine is what finally explained it — the fault was in the harness, not in the browser. It opened
the extension popup as a new tab, which left the page under test in the *background*, and a
background tab is given no frames. `--headed` never helped because headed against headless was
never the axis; active against inactive was. Measured there: `visibilityState` was `"hidden"` while
the browser window stood plainly in front.

The fixture is activated before the scroll check now, and the direction is judged rather than
skipped — `0 → 300` even on a build machine with no screen at all, which is the first time this has
been judged anywhere.

Report the tally and every FAIL verbatim, and then specifically:

- Did **a positive scroll_y moves the page down** pass? It should, with real numbers on both sides.
- What `scrollTop` did it report before and after?
- Did **the page sees a trusted wheel event going down** pass, and with what deltaY?
- If a SKIP line appears at all, quote it in full. That would mean this machine cannot composite
  what it is being sent, which is a new finding rather than the old one.

**2b. The helper, running for real.**

```sh
node scripts/probe-macos-helper.mjs arm64
```

Report the tally and every failure. With permissions actually granted, checks that a build machine
sees refused should now do the thing instead — say which ones changed behaviour compared to what
the script says to expect.

**2c. The pointer, in a picture.** This is the oldest disputed claim in this project: the pointer
was reported as drawn when it was not, twice.

Open TextEdit with a document. Move the mouse into the middle of its window. Then, driving the
helper directly, capture that window (`{"op":"windows"}` to find its id, then
`{"op":"capture","id":<id>,"maxWidth":640,"file":"/tmp/shot.png"}`) and report the `pointer` field
of the reply verbatim — it is one of `drawn`, `outside_region`, `unavailable`, `buffer_unavailable`.

Then **look at the PNG** and say whether an arrow is actually visible, and whether its tip is where
the mouse was. The reply field and the picture are two different claims; report both, and say
plainly if they disagree.

Repeat with the pointer moved well outside that window. The field must say `outside_region` and the
picture must contain no pointer.

## 3. Focus — confirming an answer, not looking for one

This part was a hypothesis until the last run from this machine settled it, and settled it against
me. `FOCUS_FAILED` was not about Chromium's accessibility tree. Chrome's main window focuses in
every state tried — page loaded, cursor in a page text field, focus in the address bar — and
TextEdit never refuses at all. The one thing that refuses is the **transient omnibox container**:
a second Chrome window that appears on Cmd+L, `1402x136`, titled "Google Chrome window", which
`{"op":"windows"}` lists like any other and which a caller can address by mistake. Press Escape and
it disappears, and the main window focuses again.

The reason given was `another window of the same application is in front` — the second reason in
the list, not the accessibility one. Two things changed because of that:

- The reason **now names the window that is in front**, because "another window is in front" left
  nothing to do about it, while an id can be targeted or dismissed.
- Nothing was relaxed in the fence. It refused correctly; the caller was aimed at the wrong window.

So this part is now confirmation, and one open question.

**3a. Confirm.** Do all of this yourself; nothing here needs a person.

Open Chrome on an ordinary page (`open -a "Google Chrome" https://example.com`). Focus its main
window via `{"op":"act","actions":[{"type":"focus","window":<id>}]}` — it should succeed. Then open
the omnibox with the helper rather than by hand:
`{"op":"act","actions":[{"type":"focus","window":<id>},{"type":"keypress","keys":["command","l"]}]}`.
List windows again: a second Chrome window around `1402x136` should have appeared. Focus that one
and quote the refusal — it must read `another window of the same application is in front (window
N)`, with N the main window, and N must appear in `{"op":"windows"}`. Then dismiss it with a batch
that focuses the main window first, since a keystroke on its own is refused:
`{"op":"act","actions":[{"type":"focus","window":<main>},{"type":"keypress","keys":["escape"]}]}`.

**Then ask `find_ui` about the container.** It used to answer with the *main* window's tree and
`ok: true`, because Chrome gives both windows the same accessibility id — so a caller clicking
those elements clicked into a window it never named. It must now refuse with `UIA_NO_OWN_WINDOW`,
naming both sizes. A snapshot of that same window should still return its picture, with the
controls reported unavailable rather than the whole call failing. Check both.

**3b. The open question, which is a judgement rather than a measurement.** `windows` lists that
transient container as an ordinary window, and it is not one anybody would want to drive. Say
whether you think it should be listed at all — and what distinguishes it, in the data the helper
already has, from a window that should be. A wrong exclusion rule here hides real windows, so this
is asked as a question and not as a change.

## 4. Input, at the level under the app

Still driving the helper directly, so a failure here is the helper's and not the app's.

**Three call shapes the last run had to discover by hitting them.** `drag` takes `xs` and `ys`,
not `path`. `targetWindow` belongs on the request, beside `actions` — putting `window` on the
action leases nothing and you get `INPUT_TARGET_REQUIRED`. And a keystroke needs a window, so put
`{"type":"focus","window":N}` first in the same batch.

**4a. A drag that moves something.** Put a file and a target folder in one Finder window. Ask the
helper to drag the file onto the folder — a `{"op":"act","actions":[…]}` batch with a `drag` whose
path has several points, not two. Check the filesystem afterwards. Report whether it moved, and how
many points the path had.

**4b. Typing where it was aimed.** Focus a TextEdit document, send text through the helper, and read
the file back. Confirm the characters arrived exactly, including any line break.

**4c. The input fence refuses what it cannot prove.** With TextEdit in front, ask the helper to send
input aimed at a *different* window's id. It must refuse by name — `INPUT_TARGET_LOST` — rather than
type into whatever happens to be focused. Quote the refusal. This is the check that matters most in
this part: a fence that fails open here types into the wrong window.

## 5. The installed app, if one is installed

Skip if no DMG is installed, and say so.

**5a. Build identity, which was broken and is the reason this part exists.**

The last run from this machine found the window title carrying no build at all: Electron replaced
it with the document title as soon as the page loaded, so the one place a build could be read said
nothing, and the run could not determine which app it was measuring. Two things changed.

Ask the app over the loopback bridge — this is new, and it is the answer to "which build is
running" that a command can get:

```sh
curl -s http://127.0.0.1:8765/hello
```

Report `build` verbatim. It must read `2.0.2+<commit>`; `2.0.2-dev` means a working tree rather
than a package.

Then read the window title from the helper's window list for the Chat On Steroids process. It must
now carry the same string. **If the title is still bare `Chat On Steroids`, the fix did not take
and that is the most important line in your report.**

Compare the commit against `git rev-parse --short HEAD`. Say whether they match — much of what
follows only means something if they do.

**5b. The extension Chrome actually loaded.** The app offers an extension folder under Application
Support. Find it, and find what Chrome has loaded (Chrome records unpacked extensions in its
profile preferences). Say plainly whether they are the same directory, resolving symlinks —
`/var` and `/private/var` are the same place under different names. Then diff the loaded
`browser-driver.js`, `background.js` and `popup.js` against this checkout. **Any difference means
Chrome is running an older extension, and nothing measured through it is about this build.**

**5c. The manifest.** In the loaded copy, report `permissions` and `optional_permissions` verbatim.
`debugger` must be in `permissions`, not in `optional_permissions` — Chrome silently drops it from
the optional list, which is what once made browser control impossible to switch on.

## 6. What to report

Part by part: what you ran, what came back verbatim, and whether it agrees with what this document
says to expect. Then, plainly:

- Were Screen Recording and Accessibility actually granted to the terminal?
- `verify:ci` and `verify:browser --headed`: totals, and every failure.
- **Scroll direction: judged or skipped, and the measured scrollTop.**
- **The pointer: what the reply field said, and what the picture showed. Did they agree?**
- Which clause refuses a Chrome focus request, quoted.
- Did the drag move the file, and did the input fence refuse a mis-aimed keystroke?
- Does the extension Chrome loaded match this checkout?

Then anything that struck you as wrong, slow or dangerous that no part above covers. On the last
five rounds that section has been the most valuable part of the report.
