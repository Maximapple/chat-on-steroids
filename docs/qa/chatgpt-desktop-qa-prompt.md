# QA prompt for ChatGPT

Paste everything below the line into a ChatGPT conversation that has the Chat On Steroids
Desktop and Core apps connected, on the Mac under test. It exercises the product the way a user
would — model → MCP → app → macOS — which is the one path no test on a development machine can
reach.

Before you start, grant the permissions. Nothing below works without them, and only a person can
click them:

- **Screen Recording** and **Accessibility** for Chat On Steroids, in System Settings → Privacy &
  Security. The app's onboarding has a button for each pane.
- **Then fully quit the app and open it again.** macOS caches a permission answer for the life of
  the process; without the restart the app still cannot see what you just granted.
- Load the Chrome extension: `chrome://extensions` → Developer mode → Load unpacked → the folder
  the app's **Open extension folder** button opens. **Reload it** if it was already installed —
  an older copy has a manifest Chrome will not grant. Then switch **browser control** on in the
  popup and accept the site-access prompt. Debugger access comes with the install now, so Chrome
  does not ask for it here.
- **Use a new ChatGPT chat for this run.** A chat keeps the tool list it loaded when it opened,
  and `browser` is only in the list of a chat opened after the app started serving it.

---

You are testing the desktop and browser automation of an app called Chat On Steroids, connected
to you as MCP apps. Work through every section below in order.

## Before anything else: confirm this is the right build

Ask the user for the **window title** of Chat On Steroids. It must read:

```
Chat On Steroids 2.0.2+<commit>
```

with the commit matching the package they installed. A title without a commit is an older build:
**stop and say so**, because everything after it measures the wrong application. One question,
and it saves a run — an earlier one lost its whole priority section to exactly this.

## What changed since the previous run

The last run scored 30 pass, 7 fail, 1 skipped, and reached section E for the first time. Every
one of its seven failures has been addressed. Say for each check whether it differs from last
time, and treat the seven below as the point of this run.

- **15, drag with no effect.** Measured separately on the same machine: driving the helper
  directly moved the file 6 times out of 6, and an ablation showed interpolation is the one thing
  that matters. The suspicion is that the app's long-lived helper had gone blind to a Finder
  window opened after it started — a separate defect, now fixed. Retry even if the first attempt
  works, since the original failure was a first attempt that silently did nothing.
- **25, detach could not be done.** The tool offered no way to release a tab at all; the driver
  always could and only the schema never listed it. `detach` and `status` are actions now. Use
  the browser tool, not the extension popup — clicking the popup with desktop automation is what
  produced the false success last time.
- **33, browser scroll timed out.** A wheel event is acknowledged only when the compositor takes
  it, which sometimes never happens. Scrolling is judged by whether the page moved.
- **34, set_value appended instead of replacing.** It named a keystroke and left the browser to
  interpret it; it names the editing command now. Measured in a real browser: a field holding
  "OLD TEXT" set to "ONLY NEW" contains exactly "ONLY NEW", and an empty value empties it.
- **35, a revoked permission went unnoticed for 40 seconds.** The detection was never broken —
  107 sample points show the backend flips in the same instant. The row was polled every 30
  seconds. It is 6 now.
- **36, a reset permission showed "Not allowed".** macOS answers both permission APIs with a
  plain boolean and exposes nothing separating a refusal from never having been asked, so that
  distinction is not implementable. The label says "Not granted", which is true either way.
- **11, no foreground window while Chat On Steroids was itself in front.** Its own windows are
  deliberately never exposed — the model must not drive the app driving it — and the answer now
  says so instead of reporting an empty desktop.

Do not skip a section because an earlier one failed — note the failure and continue, so the
report covers everything.

Rules for the whole run:

- After each action, verify the *effect*, not just that the call returned. A tool that answers
  `ok` while nothing moved is the failure mode worth catching.
- When something fails, capture the exact error code and message verbatim. Do not paraphrase.
- Never retry a failed action more than twice. A loop of retries buries the evidence.
- If an action would type into or click on this conversation's own browser tab, stop and report
  it. That must be refused by the tool, and a refusal there is a pass, not a bug.

## A. Screenshots and the mouse pointer

This is the highest-priority section. A previous fix for it was wrong, so treat every claim here
as needing evidence.

1. Take a **full-screen** screenshot. Confirm you receive an image, and state its dimensions.
2. Take a screenshot of **one specific window** that is not Chat On Steroids — open TextEdit or
   Finder first so there is one. Before capturing, move the mouse pointer so it sits **inside
   that window**.
3. Look at the returned image. **Is the mouse pointer visible in it?** Answer plainly: yes or no.
   If yes, is its tip where you moved it, or is it offset?
4. Repeat step 2 with the pointer deliberately **outside** that window. The pointer should not
   appear in the image. Confirm.
5. Take a window screenshot while a **text field** is focused, so the pointer is an I-beam rather
   than an arrow. Report whether the I-beam appears, and whether it is centred on the position
   rather than hanging below-right of it.

## B. Clicking, typing and control discovery

6. Open TextEdit with a new blank document. List the controls the tools can see in it. Report how
   many, and whether the document's text area is among them.
7. Click into the document and type `Chat On Steroids QA` followed by Enter and a second line.
   Read the document back and confirm the text arrived exactly, including the line break.
8. Set a value directly into a text field rather than typing it character by character, and
   confirm the field's contents afterwards.
9. Find a **disabled** control somewhere on the system and try to click it. It must be refused
   with a named error, not silently ignored, and not clicked anyway.
10. Try to click at a coordinate that is **outside every window** (for example 5,5). Report what
    happens; a refusal is expected.

## C. Which window is in front

11. With two windows open and overlapping, ask which window is foreground. Verify against what
    you can see in a screenshot.
12. **The link-preview case.** In Chrome, hover a link until the small preview bubble appears in
    the corner, then immediately ask which window is foreground. The answer must be Chrome's real
    window — not the bubble, and not "none". Report the exact answer.
13. Bring a different app to the front and repeat. Confirm the answer changes.

## D. Scrolling, dragging, keyboard

14. Scroll a long document down and then back up. Confirm from screenshots that the content moved
    both times.
15. Drag something — a file in Finder, or selected text — from one position to another. Confirm
    the drag had an effect, not merely that the call succeeded.
16. Send a keyboard shortcut with modifiers (Cmd+A, then Cmd+C). Confirm the selection happened.
17. Send a key that is not a character: Escape, Tab, and an arrow key. Confirm each had its
    normal effect.

## E. The Chrome extension and browser control

18. Open a new Chrome tab on `example.com`. Attach browser control to it.
19. Read the page's structure through the browser tool. Report the page title and how many
    interactive elements it found.
20. Take a browser screenshot. Confirm you receive an image, and confirm the **pointer overlay**
    is visible on the page — browser control draws its own pointer, separate from the macOS one.
21. Navigate to a page with a form (`example.com` has none, so use any search engine). Click into
    the search field, type a query, and press Enter. Confirm the results page loaded.
22. Use back, then forward, then reload. After each, report the page title so it is clear the
    document changed and not just the address.
23. Find an element by reference from the structure you read, click it that way rather than by
    coordinate, and confirm the effect.
24. **The refusal test.** Try to attach browser control to the tab holding *this* ChatGPT
    conversation. It must be refused. Report the exact error. Then try `chrome://settings` and a
    `file://` URL. Both must be refused. This section passing is a security property, not a
    limitation.
25. Detach browser control. Confirm the pointer overlay disappears and the tab behaves normally.

## F. Onboarding and the permission step

26. Ask the app for its setup state. Report which steps it considers finished.
27. Look at the onboarding screen's permission list. For each of the two permissions, report the
    colour and status text shown. Then compare against what System Settings actually says.
28. Turn one permission **off** in System Settings, return to the app **without restarting it**,
    and report what the list shows. Then restart the app fully and report again. Note whether the
    amber restart note appears at the right moment.
29. Turn it back on. Confirm the row returns to green and loses its action button.

## G. Robustness

30. Start a screenshot, and while it is running, move the window being captured. Report what
    happens; a clean refusal naming a stale frame is correct, a wrong-looking image is not.
31. Ask for a screenshot of a window that has been closed in the meantime. Confirm the error names
    the missing window.
32. Ask for a screenshot with an absurdly large requested width. Confirm it is either clamped or
    refused, and that whatever comes back is coherent.

## H. Fixes with no previous check

These cover behaviour that changed since the last run and was never exercised.

33. **Scroll direction in the browser.** With browser control attached to a long page, scroll down
    by a positive amount and confirm from a screenshot that the content moved **down**, not up.
    Then scroll back. This was inverted and nothing caught it.
34. **Setting a value replaces rather than appends.** In a browser text field that already
    contains text, set a new value. The field must contain **only** the new text. Then set an
    empty value and confirm the field is empty, not merely one character shorter.
35. **The permission list notices a revocation on its own.** With everything granted, turn one
    permission off in System Settings and return to the app **without restarting**. Within about
    30 seconds the row must turn red by itself. Report how long it took.
36. **The restart note only when a restart helps.** With a permission at "Not asked yet" and none
    refused, confirm the amber restart note is **absent**. Then refuse one and confirm it appears.
37. **A pointer outside the captured window.** Move the pointer well outside a window, capture
    that window, and read the reported pointer line. It must say the pointer is outside the frame
    rather than print image coordinates that fall outside the image.
38. **The app survives a permission it does not have.** With Accessibility off, fully quit and
    reopen the app. The window must come back and the connector must answer — desktop actions
    should refuse with a named permission error, not with a dead tunnel.

---

# The report

Produce a single report at the end, in this shape. Be specific; a report that says "worked fine"
is not usable.

**Environment** — macOS version, Mac model and architecture, Chrome version, app version, and
whether Screen Recording and Accessibility were granted.

**Summary** — how many of the 38 numbered checks passed, failed, or could not be run, and the
three most serious problems in one line each.

**Section-by-section** — for every numbered check, including whether it differs from the previous run: the number, PASS / FAIL / SKIPPED, and one or
two sentences of what actually happened. For a FAIL, the verbatim error code and message.

**The pointer question** — answer these four directly, because they are the reason for this run:
is the pointer visible in a window screenshot; is it at the right position; is the I-beam shape
correct; and does it correctly stay absent when the pointer is outside the window.

**Anything unasked** — anything that struck you as wrong, slow, confusing or dangerous that no
numbered check covers. This section is often the most valuable one.
