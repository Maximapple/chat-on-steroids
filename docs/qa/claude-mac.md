# Everything Claude Code runs on the Mac

Six parts. They are worth running because this machine can answer questions no other can: it has
Accessibility, a screen with a real compositor, and the packaged app as installed. A build machine
has none of those, and the repository's own suites say so out loud rather than passing — part 2
below turns three of those skips into answers.

Nothing here needs ChatGPT, and nothing here needs a person: every step is a command you can run.
Parts 1–4 do not even need the installed app; part 5 does.

Your last run was the cleanest of the series, and three things changed because of it.

**The probe measured whatever window happened to be first in the list**, not the one it opens for
itself — on a used desktop that was a Chrome new-tab page, whose contents animate, and 19,097
pixels differed between two captures of a window nobody had touched. It now looks for its own
window by title first.

**Its pointer verdict is no longer judged by a bounding box.** You were right that a single box
around every changed pixel is the wrong measure: the title-bar exclusion I added last round bought
one run before a blinking text caret took the verdict away again, 39 pixels against the pointer's
99. It now compares how busy the neighbourhood of the expected point is against the rest of the
frame. Checked against both sets of numbers you measured: the caret case confirms by a factor of
252, and the live Chrome window is still withheld, at 1.15.

**Part 3 asked for a refusal that should not happen** — `find_ui` on the omnibox container. You
measured that it answers with the container's own tree, and the source comment agrees. That
demand is gone from part 3 below.

Separately, a defect the ChatGPT run found: every screenshot of a *scrolled* page came back showing
the top of the document, because a capture clip is in document coordinates and the driver asked for
`y: 0`. `verify:browser` has a new check for it — part 2a below says what to look for.

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
- Did **a screenshot of a scrolled page shows where the page is** pass? This is new, and it is the
  check that finally caught a defect two QA rounds reported and nothing here could see: the fixture
  carries a coloured band at a known document offset, and the check works out which image row it
  must land on. It fails on the old code and passes on the new — both were watched. Report the
  scrollTop and the row it names.

**2b. The helper, running for real.**

```sh
node scripts/probe-macos-helper.mjs arm64
```

Report the tally and every failure. With permissions actually granted, checks that a build machine
sees refused should now do the thing instead — say which ones changed behaviour compared to what
the script says to expect.

Two changes since your last run, both from what you measured. It now prefers **its own** window —
the one titled `cos-probe-window.txt` — over the first usable one in the list. And the pointer
check reports `N changed within 32px of the pointer, M elsewhere` with both densities, then either
confirms or says the whole window was repainting. **Run it once on a busy desktop**, browser
windows and all, and say whether it still reaches a verdict. That was the condition it failed under
before, and it is the condition that matters.

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
a second Chrome window that appears on Cmd+L, `136` tall and as wide as its parent (the last run
measured 874, not the 1402 an earlier one did), titled "Google Chrome window", which
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

**Then ask `find_ui` about the container, addressing it under `id`.** Expect it to answer with the
container's *own* tree, at the container's own size — that is the correct behaviour and your last
run measured it. `UIA_NO_OWN_WINDOW` guards a case no known application produces; if you ever see
it fire here, that is the finding.

**And confirm the wrong key is still refused.** `{"op":"find_ui","window":N}` must answer
`BAD_REQUEST` naming both keys, rather than silently reading 0 and answering about the foreground
window. That silence cost you a whole round; check it on `find_ui`, `focus`, `capture` and
`snapshot`.

**3b. Built on your measurements — three things to check.**

You answered both questions, and both answers were acted on.

- **`focusable` exists, and it is opt-in.** `{"op":"windows","focusable":true}` reports it per
  window; a plain `{"op":"windows"}` does not, and pays nothing. Your numbers are the reason: the
  attribute costs 0.05 ms a window, reaching the element to ask costs 112–117 ms for a list of 26.
  Check that the omnibox container comes back `false` and ordinary windows `true`, and time both
  forms of the call. A window whose reading fails is reported `true` — refusing to drive something
  on a failed reading is worse than the reading's absence — and one with no element at all is
  `null`.
- **The title tie-break is now on the focus path too**, which is what your last run showed was
  missing. It went into `matchingAXWindow` and not into `unambiguousWindowID` — the function every
  focus and every input target goes through — so `find_ui` could separate two identical windows
  while any batch starting with `focus` still failed, and a focus that had *worked* was reported as
  `FOCUS_FAILED` because the window in front could not be attributed. The ChatGPT run met the same
  message from the other direction. Rebuild your 3b/2 case exactly — two Finder windows, same size,
  same position, different titles — and confirm the drag now goes through on the first attempt.
- **`focusable` says why it does not know.** When the answer is `null` there is now a
  `focusableUnknown` beside it, reading `"ambiguous"` or `"unavailable"`. Your three identical DMG
  windows should read `ambiguous`; a window with no accessibility representation at all reads
  `unavailable`. One of those a caller can act on, the other not, and `null` alone said neither.
- **With the *same* title as well**, confirm the refusal names the candidates it could not
  separate, rather than only saying it could not.
- **The `UIA_NO_OWN_WINDOW` comment says what you measured**: the attribute is unsupported here,
  -25205, none of 26 windows matched by id. Nothing to test; it is recorded so the next reader is
  not told an anecdote.

**3c. This round, both items come from findings — yours and ChatGPT's.**

- **Your `snapshot` finding is fixed at the root you named.** The enumeration is gone. The test now
  asks what the failure *is*: only a target-identity failure — `WINDOW_NOT_FOUND`, `WINDOW_MOVING`,
  `BAD_REQUEST` — discards the capture, and every other failure keeps the already-valid image and
  reports `uiUnavailable`. So the next code split cannot take a code off a list again.

  Your own measurement has already been repeated on your machine, so do not spend the round on it:
  two Chrome windows at 200,200 800x600 both titled `Example Domain` — identical geometry and
  identical title, which is the condition — and `snapshot` with `includeUi` answered `ok: true`,
  `image: {1280x960}`, `uiUnavailable: {"code": "UIA_AMBIGUOUS_WINDOW", …}` for both of them.
  Before the fix that was `ok: false, image: null`. Confirm it in passing if it is free; the
  picture is what makes the refusal’s advice — move or close one of them — followable at all,
  which was the worse half of that defect.
- **A scroll now reports what happened to it.** ChatGPT met a native scroll answering `Done` with
  the document unmoved, and nothing in the reply separated "the app ignored the wheel" from "the
  wheel went somewhere else" — the window server delivers a scroll to whatever is under the
  pointer, which need not be the window holding the lease. `act` now returns a `scroll` object:
  `hitPid`, `hitRole`, `reachedTarget`, and `positionBefore`/`positionAfter`/`moved` read from the
  scroller itself, and both are proven: your ten scrolls composed to six decimal places, and the
  tenth correctly reported `moved: false` at the end of the document.

  **You asked the cost question and answered it, so the wait is now built on your number.** 2495 ms
  for ten scrolls, 234 ms each, against a scroller that finished moving after 21 to 26 ms — the
  wait was roughly five times the thing it was waiting for. I did not take your 50 ms: a second
  fixed number would have been a second guess, and you were explicit that you had not measured an
  animating scroller. It now polls every 10 ms until two readings agree, with your 120 ms as the
  ceiling, so nothing waits longer than before and an animated scroller is still waited for. One
  subtlety your data forced: the poll compares against the reading taken *before* the wheel, not
  against itself, because at 10 ms nothing has moved yet — comparing a reading to itself would
  answer `moved: false` a third of the way to the movement even starting.

  **Re-run your ten-scroll measurement.** I expect roughly 40 ms per scroll where it moves, and the
  full 120 ms only where it does not — the end-of-document case. If an animating scroller is within
  reach, that is the one measurement neither of us has.

**And the older open question, for reference.** Your answer last round — list it, do
not exclude it, and carry the difference in a field such as `focusable: false` — is the one I
agree with. Two things have to be true before it can be built, and only this machine can say
whether they are.

The cheap signal does not work: the helper already filters the window list to `layer == 0`
(`main.swift:216`), so the container is a normal-layer window and its layer cannot tell it apart
from any other. That leaves whether it can be made main at all. So, using the Accessibility API
directly rather than the helper:

- For the omnibox container **and** for Chrome's main window, report whether `kAXMainAttribute` is
  settable — `AXUIElementIsAttributeSettable(window, kAXMainAttribute, &settable)`. If it comes
  back `false` for the container and `true` for the main window, that is the field's definition and
  I will build it on that.
- Then time it: how long does one such call take, and how long would it take for every window in
  a 25-window list? `windows` is called constantly, and a field that turns a fast list into a slow
  one is not worth having. Say what you measure; if it is expensive, say so and I will make the
  field something a caller asks for rather than something every list pays for.

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
