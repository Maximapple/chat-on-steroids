# Everything Claude Code runs on the Mac

Six parts. They are worth running because this machine can answer questions no other can: it has
Accessibility, a screen with a real compositor, and the packaged app as installed. A build machine
has none of those, and the repository's own suites say so out loud rather than passing — part 2
below turns three of those skips into answers.

Nothing here needs ChatGPT. Parts 1–4 do not even need the installed app; part 5 does.

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

Thirty-three checks against real Chrome. The interesting one is scroll direction: a wheel event is
only delivered to a page by a compositor that draws frames, so on a build machine the check prints
`SKIP  scroll direction — no wheel reached the page (scrollTop=…)`. Here it should be able to
judge it.

Report the tally, every FAIL verbatim, and specifically **whether the scroll direction check ran or
skipped, and what scrollTop it measured**. If it still skips on a machine with a screen, that is a
finding in itself and worth more than the tally.

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

## 3. Why a visible Chrome window will not take focus

QA asked the desktop tool to focus a Chrome window that was plainly on screen and got back, after
2083 ms — the whole of the two-second deadline, so the condition it polls never became true:

```
FOCUS_FAILED: the requested window could not be activated
```

That condition wants three facts to name the same window: WindowServer z-order, the application's
`AXFocusedWindow`, and the window owning `AXFocusedUIElement` — the focused *control*. The
hypothesis is that the third cannot be satisfied for a Chrome window whose focus is inside web
content, because Chromium keeps its renderer accessibility tree off until a real assistive client
asks. That is also the stated reason the `browser` tool exists at all.

The third clause was added deliberately: accepting missing focus evidence would turn an unprovable
keyboard destination into global physical input. So if it is wrong, it is wrong in detail, not in
intent.

**3a. Is it Chrome, or every application?** The cheapest discriminator, so it comes first. Open
Chrome on an ordinary page (not ChatGPT) and TextEdit with a document. For each: bring it to the
front by hand, ask `{"op":"windows"}` and note the window id, then ask
`{"op":"focus","window":<that id>}`. Report both answers verbatim.

- TextEdit focuses and Chrome does not → Chrome-specific; 3b explains it.
- Both fail → the fault is in the fence itself; 3b still applies, the conclusion is broader.
- Both succeed → say so. Then the failure needs a condition this does not reproduce, and the next
  things to vary are whether the target was already frontmost and whether more than one Chrome
  window was open.

Then repeat the Chrome case twice more, because these change what `AXFocusedUIElement` is: with the
text cursor in the page's own text field, and with focus in Chrome's address bar.

**3b. Which clause refuses?** The helper says this itself — no instrumentation. The refusal reads
`FOCUS_FAILED: the requested window could not be activated: <reason>`, where the reason is one of:
another application is frontmost; another window of the same application is in front; the
application's focused window is `<window N | no window this scan can attribute>`; the focused
control belongs to `<window N | …>`; or focus moved while the window was being checked.

Quote the full refusal from each case above and report: which reason appears for Chrome, whether it
is the same in all three states, whether TextEdit refuses at all, and whether the reason names a
window id that `{"op":"windows"}` also lists.

If the reason is "the focused control belongs to no window this scan can attribute", the hypothesis
holds. If it is one of the first two, the hypothesis is wrong and the cause is about which window
was targeted, not about accessibility.

**Do not repair anything yet.** The obvious repair relaxes a security fence, and relaxing the wrong
one would turn an unprovable keyboard destination into global physical input.

## 4. Input, at the level under the app

Still driving the helper directly, so a failure here is the helper's and not the app's.

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

**5a. Build identity.** Report the window title of Chat On Steroids. It must read
`Chat On Steroids 2.0.2+<commit>`. Compare that commit with `git rev-parse --short HEAD` in the
checkout. Say whether they match — much of what follows only means something if they do.

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
