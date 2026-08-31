# Why focusing a Chrome window fails

QA asked the desktop tool to focus a Chrome window that was visibly there — `observe` had just
listed it — and got back, after 2083 ms:

```
FOCUS_FAILED: the requested window could not be activated
```

2083 ms is the whole of `focusWindow`'s two-second deadline, so the condition it polls never
became true. That condition is `inputTargetMatches`, and it requires three separate facts to
agree about the same window:

1. `frontWindowID(rows:focusedWindow:)` names it — WindowServer z-order, with the app's own
   transient child windows resolved by AX
2. `focusedAXWindowID` names it — the app's `AXFocusedWindow`
3. `focusedAXElementWindowID` names it — the window owning `AXFocusedUIElement`, the focused
   *control*

**The hypothesis is that clause 3 cannot be satisfied for a Chrome window whose focus is inside
web content.** This repository already knows that Chromium keeps its renderer accessibility tree
off until a real assistive client asks for it — that is the stated reason the `browser` tool
exists at all. If the renderer tree is off, `AXFocusedUIElement` inside a page may resolve to
nothing this scan can attribute to a window, and clause 3 refuses a window that is plainly
active. Clause 3 was added deliberately: accepting missing focus evidence would turn an
unprovable keyboard destination into global physical input. So if it is wrong, it is wrong in
detail, not in intent.

Confirm or refute that by measurement. A contradiction is the more useful result — the last three
rounds of this work were corrected by measurements that disagreed with my reasoning.

Paste everything below the line into Claude Code on the Mac. **No DMG and no installed app are
needed.**

---

Two questions about macOS window focus, both answered by measurement rather than by reading the
source. Report what you observe, including if it contradicts what the code says should happen.

Get the repository and build the helper — skip the clone if the directory is already there:

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git ~/chat-on-steroids
cd ~/chat-on-steroids
git fetch origin
git checkout integrate/browser-and-desktop-064733
git pull --ff-only
npm ci
node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64
```

That leaves the helper at `resources/packaging/desktop/darwin/arm64/macos-desktop-helper`, which
speaks newline-delimited JSON on stdin and stdout: `{"op":"windows"}` lists windows,
`{"op":"focus","window":<id>}` is the call that failed.

Screen Recording **and Accessibility** must be granted to whichever application owns the terminal
— macOS attaches the grant to the GUI ancestor, usually `Terminal.app`, not to `node`. Without
Accessibility every clause below reads nil and the measurement means nothing, so check this
first and say plainly whether it holds.

## 1. Is it Chrome, or is it every application?

This is the cheapest discriminator and it comes first.

Open Chrome with an ordinary page (not ChatGPT) and TextEdit with a document. Then, for **each**
of the two:

- bring it to the front by hand
- ask the helper `{"op":"windows"}` and note the window id
- ask `{"op":"focus","window":<that id>}`

Report both answers verbatim. If TextEdit focuses and Chrome does not, the fault is
Chrome-specific and question 2 explains it. If both fail, the fault is in the fence itself and
question 2 still applies but the conclusion is broader. If both succeed, say so — then the
failure needs a condition this test does not reproduce, and the next thing to vary is whether
the target window was already frontmost and whether more than one Chrome window was open.

Then repeat the Chrome case **twice more**, in these two states, because they change what
`AXFocusedUIElement` is:

- with the text cursor in the page's own text field (click into a search box first)
- with the focus in Chrome's address bar rather than in the page

## 2. Which of the three clauses is the one that refuses?

**The helper now says this itself** — no instrumentation, no source edits. The refusal reads

```
FOCUS_FAILED: the requested window could not be activated: <reason>
```

where the reason is one of: another application is frontmost; another window of the same
application is in front; the application's focused window is `<window N | no window this scan can
attribute>`; the focused control belongs to `<window N | …>`; or focus moved while the window was
being checked.

So just quote the full refusal from each case in question 1, verbatim. Report specifically:

- Which reason appears for Chrome, and whether it is the same in all three Chrome states?
- Does TextEdit refuse at all, and with which reason if so?
- Does the reason name a window id, and is it a window `{"op":"windows"}` also lists?

If the reason is "the focused control belongs to no window this scan can attribute", the
hypothesis holds and the fix is about clause 3 specifically. If it is one of the first two, the
hypothesis is wrong and the cause is about which window was targeted, not about accessibility.

## What to report

For each: what you did, what came back verbatim, and whether it agrees with the hypothesis that
clause 3 is the one refusing. If the measurement says otherwise, say what it says instead — that
is the more valuable answer, and do not repair anything yet. I want the measurement before the
fix, because the obvious repair here is to relax a security fence, and relaxing the wrong one
would turn an unprovable keyboard destination into global physical input.
