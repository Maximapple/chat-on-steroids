# Everything Claude Code runs on the Mac

One measurement: why the desktop tool refuses to focus a Chrome window that is plainly on screen.

QA asked it to focus one and got back, after 2083 ms — the whole of the two-second deadline, so
the condition it polls never became true:

```
FOCUS_FAILED: the requested window could not be activated
```

That condition wants three facts to name the same window: WindowServer z-order, the application's
`AXFocusedWindow`, and the window owning `AXFocusedUIElement` — the focused *control*. The
hypothesis is that the third cannot be satisfied for a Chrome window whose focus is inside web
content, because Chromium keeps its renderer accessibility tree off until a real assistive client
asks. That is also the stated reason the `browser` tool exists at all.

The third clause was added deliberately: accepting missing focus evidence would turn an
unprovable keyboard destination into global physical input. So if it is wrong, it is wrong in
detail, not in intent — and the repair would relax a security fence, which is why this asks for
the measurement before the fix.

**No DMG and no installed app are needed.** Paste everything below the line into Claude Code on
the Mac.

---

Two questions about macOS window focus, both answered by measurement rather than by reading the
source. Report what you observe, including if it contradicts what the code says should happen.

Get the repository and build the helper — skip the clone if the directory is already there:

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git ~/chat-on-steroids
cd ~/chat-on-steroids
git fetch origin && git checkout integrate/browser-and-desktop-064733 && git pull --ff-only
npm ci
node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64
```

That leaves the helper at `resources/packaging/desktop/darwin/arm64/macos-desktop-helper`, which
speaks newline-delimited JSON on stdin and stdout: `{"op":"windows"}` lists windows,
`{"op":"focus","window":<id>}` is the call that failed.

Screen Recording **and Accessibility** must be granted to whichever application owns the terminal
— macOS attaches the grant to the GUI ancestor, usually `Terminal.app`, not to `node`. Without
Accessibility every clause below reads nil and the measurement means nothing, so check this first
and say plainly whether it holds.

## 1. Is it Chrome, or is it every application?

The cheapest discriminator, so it comes first.

Open Chrome with an ordinary page (not ChatGPT) and TextEdit with a document. Then, for **each**
of the two: bring it to the front by hand, ask `{"op":"windows"}` and note the window id, then ask
`{"op":"focus","window":<that id>}`.

Report both answers verbatim.

- TextEdit focuses and Chrome does not → the fault is Chrome-specific, and question 2 explains it.
- Both fail → the fault is in the fence itself; question 2 still applies, the conclusion is
  broader.
- Both succeed → say so. Then the failure needs a condition this test does not reproduce, and the
  next things to vary are whether the target window was already frontmost and whether more than
  one Chrome window was open.

Then repeat the Chrome case **twice more**, in these two states, because they change what
`AXFocusedUIElement` is:

- with the text cursor in the page's own text field (click into a search box first)
- with the focus in Chrome's address bar rather than in the page

## 2. Which of the three clauses refuses?

**The helper says this itself** — no instrumentation, no source edits. The refusal reads

```
FOCUS_FAILED: the requested window could not be activated: <reason>
```

where the reason is one of: another application is frontmost; another window of the same
application is in front; the application's focused window is `<window N | no window this scan can
attribute>`; the focused control belongs to `<window N | …>`; or focus moved while the window was
being checked.

So quote the full refusal from each case above, verbatim, and report:

- Which reason appears for Chrome, and is it the same in all three Chrome states?
- Does TextEdit refuse at all, and with which reason if so?
- Does the reason name a window id, and is it one `{"op":"windows"}` also lists?

If the reason is "the focused control belongs to no window this scan can attribute", the
hypothesis holds and the fix is about that clause specifically. If it is one of the first two, the
hypothesis is wrong and the cause is about which window was targeted, not about accessibility.

## What to report

For each: what you did, what came back verbatim, and whether it agrees with the hypothesis. If the
measurement says otherwise, say what it says instead — that is the more valuable answer, and the
last three rounds of this work were corrected by measurements that disagreed with reasoning.

**Do not repair anything yet.** The obvious repair relaxes a security fence, and relaxing the
wrong one would turn an unprovable keyboard destination into global physical input.
