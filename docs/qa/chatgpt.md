# The full run — everything ChatGPT tests, without asking you anything

Thirty-three checks — numbered 1–25, 30–34, 37, 39 and 40 — all of them driven by the model
itself. Nothing here asks a person to look at a screen, click a permission, or read a window title.
(The last run counted them and found the header claiming thirty-four; it was right.)

Six checks from the old script are deliberately not here: 26–29 look at the onboarding screen, and
35, 36 and 38 need a permission switched off and back on. Chat On Steroids hides its own windows
from everything the model can see — deliberately, so the model cannot drive the app driving it —
and `tccutil` can revoke a permission but nothing can grant one back without a person. All six
passed on the last run; they are the ones to do by hand when there is time, and only then.

## Before you paste

1. Install the current DMG and open the app.
2. Reload the extension in `chrome://extensions`. The browser driver ships inside the extension,
   not the app, so a new package alone changes nothing in Chrome.
3. **Then reload the ChatGPT tab itself** — Cmd+R. Reloading an extension orphans its content
   script in every page already open, and that script is the first link in the chain that tells the
   app which conversation is calling. Skipping this cost an entire run: with a multi-agent run
   parked in the past, every Desktop call was refused with `CALLER_IDENTITY_REQUIRED` before it
   reached macOS, and all 33 checks came back unperformable.
4. Delete and recreate the Desktop connector in ChatGPT, then open a new chat. A connector keeps
   the tool list it fetched when it was made; three runs were lost to skipping this.

That is all. Paste everything below the line.

---

You are testing the desktop and browser automation of an app called Chat On Steroids, connected to
you as MCP apps. Work through every section in order. Everything below is yours to do — do not ask
the person running this to look at anything, click anything, or confirm anything.

## First: establish which build you are testing, yourself

Run this with the Core connector's shell tool:

```sh
curl -s http://127.0.0.1:8765/hello
```

The reply carries `build`, which reads `2.0.2+<commit>`. Report it. If it reads `2.0.2-dev` you
are testing somebody's working tree rather than a package, which is worth saying but not worth
stopping for. If the command fails, the bridge is not running — say so, and note that every
browser check below will therefore fail for that reason and not their own.

## What changed since the last run

**One defect, and it was the one you found.** Your last run failed check 33 on two independent
pages and was right both times; my previous attempt at it treated a symptom.

- **Every screenshot of a scrolled page was wrong, not just one taken after scrolling.** A capture
  clip is given in *document* coordinates, and the driver always asked for `y: 0` — the top of the
  document. On a scrolled page that region has mostly never been rasterised, so it came back blank,
  with the sliver that did overlap the viewport stranded far down the image. That is exactly what
  you described: blank above, `MARKER 008` left at its old position. The clip now starts where the
  viewport starts.

  This had gone unseen because no check anywhere looked at a pixel of a scrolled page — the one
  that decodes an image only compared its dimensions. There is now a check that fails on the old
  behaviour and passes on the new one, and it was watched doing both.

  **Check 33 is the one to watch, and check 20 with it**: any observation of a page that is not at
  its top went through the same path.

- Two things you reported as contract problems are fixed in the contract rather than argued with:
  the header's check count (above), and the `computer` tool's action list, which now says in the
  schema that only one UI-changing action goes per call. You should no longer discover that rule by
  being rejected.

- **`find_ui` is not on the surface you can see**, and you were right to say so. It is the
  helper's own operation, tested from the Mac. Nothing in this document asks you to test it.

Still worth confirming from earlier rounds: typing no longer loses text past a newline (check 7);
a click cannot escape the window it is leased to (check 10); the pointer line names the frame it
was handed (check 37); a missing window is named (check 31); `detach` says what it let go of
(check 25); and `/hello` reports `spoken`, so `compatible: false` on a plain curl is expected
rather than a mismatch.

**Two things earlier wording sent a run chasing, so they are stated plainly here.** A `move` whose
target is where the pointer already is answers `Done`, and that is correct: the postcondition is
that the pointer is at the requested point, and it is. The refusal that exists —
`POINTER_DID_NOT_MOVE` — is for a move that was *sent and not delivered*, and asking for the
current position cannot exercise it. And a capture taken immediately after a Finder file operation
can still show the file where it was: Finder repaints on its own schedule, and the shell is the
settled answer. Neither is a defect; report them only if they behave differently from this.

From the run before that, and still worth confirming: the window title carries the build again and
`/hello` reports it; scrolling goes through a scroll gesture because the wheel event does nothing
in Chrome 152; a window being moved is read a second time; a refused focus names the window in
front; navigate opens a page when none is open; status says where the driver is now; an unreadable
address is refused; a driven tab that lands on a refused page is let go of; the pointer overlay
survives a navigation; and letting go of a tab takes it out of the driven group.

## Rules

- Verify the *effect*, not that the call returned. A tool answering `ok` while nothing moved is
  the failure worth catching, and this product has shipped it twice.
- Quote error codes and messages verbatim.
- Never retry a failed action more than twice.
- Do not skip a section because an earlier one failed.
- In section E use the `browser` tool and nothing else. If something cannot be done with it, that
  is the finding: report FAIL and name the action you looked for and did not find.
- The `browser` tool has no attach action. `navigate` starts a run, taking the newest ordinary tab
  or opening one if the browser has none.
- The `computer` tool takes **one UI-changing action per call** — click, type, key, drag and the
  like. `focus`, `move`, `wait` and the clipboard actions are setup and may go with it. The schema
  says so now; batching two decisions is refused before anything runs.
- If an action would touch this conversation's own tab, stop and report it. That must be refused,
  and a refusal there is a pass.

## A. Screenshots and the mouse pointer

Open TextEdit yourself first — `open -a TextEdit` through the shell tool, and `osascript` if you
need a document in it.

1. Take a **full-screen** screenshot. Confirm you receive an image and state its dimensions.
2. Take a screenshot of one specific window that is not Chat On Steroids, with the pointer moved
   **inside that window** first.
3. Look at the image. **Is the pointer visible?** Yes or no. If yes, is its tip where you moved it?
4. Repeat with the pointer deliberately **outside** that window. It should not appear.
5. Capture a window while a text field is focused, so the pointer is an I-beam. Report whether it
   appears and whether it is centred on the position rather than hanging below-right.

## B. Clicking, typing and control discovery

6. In a blank TextEdit document, list the controls the tools can see. Report how many, and whether
   the document's text area is among them.
7. Click into the document and type `Chat On Steroids QA`, then Enter and a second line. Read the
   document back — through the shell tool if that is easier — and confirm the text arrived exactly.
8. Set a value directly into a text field rather than typing it, and confirm the contents.
9. Find a **disabled** control and try to click it. It must be refused with a named error.
10. Try to click at a coordinate outside every window (5,5) — first with no target window, then
    on the retry with one supplied. **Both must be refused.** The second was not: the click was
    sent, at 5,5, outside the very window it was leased to. It must now answer
    `OUTSIDE_TARGET_WINDOW`, naming that window and its bounds.

## C. Which window is in front

11. With two windows open and overlapping, ask which is foreground and verify against a screenshot.
    Then activate Chat On Steroids yourself (`open -a "Chat On Steroids"`) and ask again: its own
    windows are never exposed, so the answer must say that rather than report an empty desktop.
    Quote it.
12. In Chrome, hover a link until the preview bubble appears, then immediately ask which window is
    foreground. It must be Chrome's real window — not the bubble, not "none".
13. Bring a different app to the front and confirm the answer changes.

## D. Scrolling, dragging, keyboard

14. Scroll a long document down and back up. Confirm from screenshots that it moved both times.
15. Drag a **file** in Finder from one place to another and confirm with the shell tool that the
    file actually moved. Use a path with several waypoints, not two — two points is a teleport and
    starts no drag. If you drag selected text instead, press **inside the selection**; pressing
    outside it only moves the caret, which is what made this look broken once before.
16. Send Cmd+A then Cmd+C. Confirm the selection happened and the clipboard holds the text
    (`pbpaste` through the shell tool).
17. Send Escape, Tab and an arrow key. Judge each by its **actual** effect and read it back with
    the shell tool: Tab inserts a tab character, an arrow moves the caret. Do not ask for a
    postcondition the key does not have — Escape closes nothing in TextEdit, and demanding
    `window_closed` is a wrong expectation rather than a failure.

## E. The Chrome extension and browser control

18. `navigate` to `https://example.com`, then `status`. Report the tab, title and URL, and whether
    Chrome had an ordinary tab open beforehand or the tool opened one.
19. `observe`. Report the page title and how many refs came back.
20. From that same `observe`, confirm you received a screenshot and that the **pointer overlay** is
    drawn — with no mouse action between the navigation and the look.
21. `navigate` to a search engine, click the field, `type` a query, `keypress` Enter, `observe`,
    confirm results loaded.
22. `back`, `forward`, `reload`. After each, `observe` and report the page **title**.
23. `click_ref` an element from your latest `observe` rather than a coordinate. Confirm the effect.
24. **The refusals.** `navigate` to `https://chatgpt.com/`, then `chrome://settings`, then
    `file:///etc/hosts`. All three must be refused and the driven tab must survive — check with
    `status`. Quote each error. **Passing means being refused.**
25. `detach`, then `status`. `detach` now names what it let go of — `let go of tab N — title
    (url); no tab is under control` — so quote it and confirm `status` agrees. Do not try to
    prove the overlay is gone: no action reads a tab the tool has released, the last run was
    right to report that as a gap, and the overlay's absence is proven in the driver suite
    against the page itself.

## F. Fixes with no older check

33. **Scroll direction.** `navigate` to a long page, `scroll` with a positive `scroll_y`, `observe`,
    and confirm from the screenshot that the content moved **down**. Then scroll back. This has
    never been judged anywhere — a build machine cannot deliver a wheel event — so this run is the
    first that can.
34. **set_value replaces, and clears.** In a field that already contains text, `set_value` a new
    string; it must contain **only** that. Then `set_value` an empty string and confirm it is
    genuinely empty.
37. **A pointer outside the captured window.** Move the pointer well outside a window and capture
    that window **in the same call**, then read the reported pointer line. It must say the
    pointer is outside the frame rather than print coordinates outside the image — and the frame
    it names must be the picture you were just handed. The last run saw an older frame named
    there, which was true of that frame and about a different image.
39. **A click cannot walk into a refused page.** With a page under control, `navigate` to a page
    you control that links somewhere refused — `data:text/html,<a href="about:blank">go</a>` will
    not do, since data: is refused itself, so use any real page with an `about:blank` link, or
    make one with the shell tool and serve it from `python3 -m http.server`. `click_ref` the link.
    The next browser action must be refused with `BROWSER_URL_REFUSED`, and `status` must report no
    tab under control.
40. **The driven-tab band.** While a tab is under control, `status` must say
    `in driven group <N>`. After `detach` it must say no tab is under control. You do not need to
    look at the tab strip — the group is in the answer.

## G. Robustness

30. Start a screenshot while the window is being moved. Move it yourself: run a loop in the
    background through the shell tool, for example
    `osascript -e 'tell application "System Events" to tell process "TextEdit" to repeat 40 times
    set position of window 1 to {100, 100} … end repeat'`, or simply nudge it repeatedly, and
    capture during it. The correct answers are a clean stale-frame refusal or, now,
    `WINDOW_MOVING` naming where it went. A screenshot plus `UIA_FAILED` is the old wrong answer
    and worth reporting if you still see it.
31. Ask for a screenshot of a window closed in the meantime. The error must name the missing
    window.
32. Ask for a screenshot with an absurdly large width. It must be clamped or refused.

---

# The report

**Environment** — macOS version, Mac model, Chrome version, and the `build` string from `/hello`.

**Summary** — how many of the 33 checks passed, failed, or could not be run, and the three most
serious problems in one line each.

**Check by check** — number, PASS / FAIL / NOT PERFORMABLE, whether it differs from the previous
run, and one or two sentences of what happened. Verbatim error text for failures.

**The pointer questions** — is the pointer visible in a window screenshot; is it at the right
position; is the I-beam correct; does it stay absent when outside the window.

**Anything unasked** — anything wrong, slow, confusing or dangerous that no check covers. On five
runs this has been the most valuable section. In particular: did any check make you want an action
a tool does not have?
