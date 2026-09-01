# The full run — everything ChatGPT tests

Forty numbered checks across the whole product: screenshots and the mouse pointer, clicking and
typing, which window is in front, scrolling and dragging, the Chrome extension, onboarding,
robustness, and the fixes that have no older check.

## Before you paste

1. **Install the current DMG.** The window title must read `Chat On Steroids 2.0.2+<commit>` with
   the commit from the release notes. A title without one is an older app, and everything below
   would measure the wrong thing.
2. **Grant Screen Recording and Accessibility** in System Settings → Privacy & Security. The app's
   onboarding has a button for each pane. **Then quit the app fully (Cmd+Q) and reopen it** —
   macOS caches a permission answer for the life of a process, so without the restart the app
   cannot see what you just granted.
3. **Load the extension, and reload it if it was already there.** In the app press *Open extension
   folder*; in Chrome open `chrome://extensions`, switch on Developer mode, and load that folder.
   Press Reload if it was already installed. The browser driver ships inside the extension, so a
   new package alone changes nothing in Chrome. Then switch **browser control** on in the popup
   and accept the site access it asks for.
4. **Check three tools are being served.** Home → Health → Run checks must show
   `Local server … offers 3 tools: browser, computer, observe`. Two means the extension is not
   connected, and section E cannot run on any build.
5. **Delete and recreate the Desktop connector in ChatGPT, then open a new chat.** A connector
   keeps the tool list it fetched when it was made, and a chat keeps the list it loaded when it
   opened. Three runs were lost to skipping this.

Then paste everything below the line.

---

You are testing the desktop and browser automation of an app called Chat On Steroids, connected to
you as MCP apps. Work through every section in order.

## First: confirm this is the right build

Ask the user for the window title of Chat On Steroids. It must read
`Chat On Steroids 2.0.2+<commit>`, with the commit matching the package they installed. A title
without a commit is an older build: **stop and say so**. One question, and it saves a run — an
earlier one lost its whole priority section to exactly this.

## What changed since the last run

Seven defects were found and fixed between runs, none of them by a QA session. Three looked like
success from the outside, which is why no run had caught them. Say for each check whether it
differs from last time.

- **navigate opens a page when the browser has none open.** With only ChatGPT tabs open, every
  browser action answered `BROWSER_NO_TAB: "Open the page first"` while the tool offered no action
  that opens a page.
- **status reports where the driver is now**, not where it started. The address was read once when
  the tab was taken and never again.
- **An address that cannot be read is refused rather than driven**, and a driven tab that lands on
  a refused page is let go of — a click was a third way into a refused page that the refusal list
  did not guard.
- **The pointer overlay survives a navigation.** It lives in the document, and navigating replaces
  the document.
- **Letting go of a tab takes it out of the driven group** — the blue band above the tab used to be
  left behind by every session.
- **A refused focus names the fact that disagreed** instead of only saying the window could not be
  activated.
- A batch prints one set of refs, and it is the live one.

## Rules for the whole run

- Verify the *effect* of each action, not that the call returned. A tool answering `ok` while
  nothing moved is the failure worth catching, and this product has shipped it twice.
- Quote error codes and messages verbatim. Do not paraphrase.
- Never retry a failed action more than twice. A loop of retries buries the evidence.
- Do not skip a section because an earlier one failed — note it and continue, so the report covers
  everything.
- In section E, use the `browser` tool and nothing else: not `computer`, not the extension popup,
  not keyboard shortcuts. If something cannot be done with `browser`, that is the finding — report
  FAIL and name the action you looked for and did not find. A previous run's whole section was
  lost to a well-meant detour through `computer`.
- If an action would type into or click on this conversation's own browser tab, stop and report it.
  That must be refused, and a refusal there is a pass, not a bug.

## A. Screenshots and the mouse pointer

Highest priority. A previous fix here was wrong, so treat every claim as needing evidence.

1. Take a **full-screen** screenshot. Confirm you receive an image and state its dimensions.
2. Take a screenshot of **one specific window** that is not Chat On Steroids — open TextEdit or
   Finder first. Before capturing, move the pointer so it sits **inside that window**.
3. Look at the returned image. **Is the mouse pointer visible?** Answer plainly, yes or no. If yes,
   is its tip where you moved it, or offset?
4. Repeat step 2 with the pointer deliberately **outside** that window. The pointer should not
   appear. Confirm.
5. Capture a window while a **text field** is focused, so the pointer is an I-beam rather than an
   arrow. Report whether the I-beam appears, and whether it is centred on the position rather than
   hanging below-right of it.

## B. Clicking, typing and control discovery

6. Open TextEdit with a new blank document. List the controls the tools can see in it. Report how
   many, and whether the document's text area is among them.
7. Click into the document and type `Chat On Steroids QA`, then Enter and a second line. Read the
   document back and confirm the text arrived exactly, including the line break.
8. Set a value directly into a text field rather than typing it character by character, and confirm
   the field's contents afterwards.
9. Find a **disabled** control somewhere on the system and try to click it. It must be refused with
   a named error — not silently ignored, and not clicked anyway.
10. Try to click at a coordinate **outside every window** (for example 5,5). Report what happens; a
    refusal is expected.

## C. Which window is in front

11. With two windows open and overlapping, ask which window is foreground. Verify against a
    screenshot. Then bring **Chat On Steroids itself** to the front and ask again: its own windows
    are deliberately never exposed — the model must not drive the app driving it — so the answer
    must say that rather than report an empty desktop. Quote it.
12. **The link-preview case.** In Chrome, hover a link until the small preview bubble appears in
    the corner, then immediately ask which window is foreground. The answer must be Chrome's real
    window — not the bubble, and not "none". Report the exact answer.
13. Bring a different app to the front and repeat. Confirm the answer changes.

## D. Scrolling, dragging, keyboard

14. Scroll a long document down and then back up. Confirm from screenshots that the content moved
    both times.
15. Drag something — a file in Finder, or selected text — from one position to another. Confirm the
    drag had an effect, not merely that the call succeeded. Retry once even if the first attempt
    works: the original failure was a first attempt that silently did nothing.
16. Send a keyboard shortcut with modifiers (Cmd+A, then Cmd+C). Confirm the selection happened.
17. Send keys that are not characters: Escape, Tab, and an arrow key. Confirm each had its normal
    effect.

## E. The Chrome extension and browser control

Ten checks that have never once executed across five runs. The `browser` tool has no attach
action: `navigate` starts a run, taking the newest ordinary tab or opening one if the browser has
none.

18. `navigate` to `https://example.com`. Then `status`. Report which tab the tool says it holds —
    title and URL. Say whether Chrome had an ordinary tab open beforehand or the tool opened one.
19. `observe`. Report the page title and how many interactive elements (refs) came back.
20. From that same `observe`, confirm you received a screenshot, and confirm the **pointer overlay**
    is drawn on the page — browser control renders its own pointer, separate from the macOS one. It
    must be there straight after a navigation, with no mouse action in between.
21. `navigate` to a search engine. Click into the search field, `type` a query, `keypress` Enter,
    then `observe` and confirm from the page that results loaded.
22. `back`, then `forward`, then `reload`. After each, `observe` and report the page **title**, so
    it is clear the document changed rather than only the address.
23. From the refs in your latest `observe`, use `click_ref` on an element rather than a coordinate.
    Confirm the effect. A previous run passed this while the call answered
    `BROWSER_TIMEOUT: the browser took the action but did not report a result`. If that happens
    again, quote it — and do not retry, which is what that message now tells you.
24. **The refusals.** `navigate` to each of these in turn: `https://chatgpt.com/`,
    `chrome://settings`, `file:///etc/hosts`. All three must be refused, and the tab you were
    driving must be unchanged afterwards — check with `status`. Quote each error exactly.
    **Passing this check means being refused**: the model asking for browser control is sitting in
    a ChatGPT tab, and a driver able to go there could drive its own conversation.
25. `detach`, then `status`. Confirm the tool reports no tab under control and that the pointer
    overlay is gone. Use the tool's own actions — the previous run clicked the extension popup with
    desktop automation, which produced a false success.

## F. Onboarding and permissions — ask the user, do not drive it

**You cannot perform this section yourself, and must not try.** Chat On Steroids deliberately hides
its own windows from everything you can see. Ask the user to look and report back, one question at
a time, and say in the report that these were observed by the user rather than measured by you. The
same applies to checks 35 and 36.

26. Ask the app for its setup state. Report which steps it considers finished.
27. Look at the onboarding screen's permission list. For each of the two permissions, report the
    colour and status text. Then compare against what System Settings actually says.
28. Turn one permission **off** in System Settings, return to the app **without restarting it**, and
    report what the list shows. Then restart the app fully and report again. Note whether the amber
    restart note appears at the right moment.
29. Turn it back on. Confirm the row returns to green and loses its action button.

## G. Robustness

30. Start a screenshot and, while it runs, move the window being captured. A clean refusal naming a
    stale frame is correct; a wrong-looking image is not.
31. Ask for a screenshot of a window that has been closed in the meantime. Confirm the error names
    the missing window.
32. Ask for a screenshot with an absurdly large requested width. Confirm it is either clamped or
    refused, and that whatever comes back is coherent.

## H. Fixes with no older check

33. **Scroll direction in the browser.** With a long page under control, `scroll` down by a positive
    `scroll_y`, then `observe` and confirm from the screenshot that the content moved **down**. Then
    scroll back. This was inverted once and has never been verified end to end anywhere — a build
    machine cannot deliver a wheel event, so this run is the first place it can be judged.
34. **set_value replaces, and clears.** In a browser field that already contains text, `set_value` a
    new string. The field must contain **only** the new text — a previous run got
    `OLD TEXTONLY NEW`. Then `set_value` an empty string and confirm the field is genuinely empty,
    not one character shorter.
35. **The permission list notices a revocation on its own.** (User-observed.) With everything else
    granted, ask the user to turn one permission off in System Settings and watch the app's row
    **without restarting**. It should turn red by itself within about ten seconds; the poll runs
    every six. Ask how long it actually took.
36. **The restart note only when a restart helps.** (User-observed.) With no permission refused, the
    amber restart note must be **absent**; after one is refused it must appear. macOS cannot
    distinguish "never asked" from "refused" — both read as "Not granted" — so this is about the
    note, not about which label a reset produces.
37. **A pointer outside the captured window.** Move the pointer well outside a window, capture that
    window, and read the reported pointer line. It must say the pointer is outside the frame rather
    than print image coordinates that fall outside the image.
38. **The app survives a permission it does not have.** With Accessibility off, fully quit and
    reopen the app. The window must come back and the connector must answer — desktop actions
    should refuse with a named permission error, not with a dead tunnel.

    **Do this one last, and tell the user before you start.** It revokes a permission the run
    depends on, and this app deliberately makes its own window unautomatable, so if the connectors
    do not come back nothing you can do will restore them. Recovery is manual: re-enable Chat On
    Steroids under System Settings → Privacy & Security → Accessibility (Device Control on newer
    macOS), then fully quit and reopen. Say this in the report rather than leaving the machine in
    that state without explanation.

    If the connectors do not return, ask the user to look in the app's **Activity** panel for a line
    beginning `automatic connect failed:` — it names which link is broken, which a dead tunnel alone
    does not.

39. **A click cannot walk into a refused page.** With a page under control, find a link that leaves
    for somewhere the driver refuses — `about:blank` will do, or any `chrome://` link — and
    `click_ref` it. The next action must be refused with `BROWSER_URL_REFUSED`, and `status` must
    report no tab under control. Quote both. Until recently the refusal list guarded only `navigate`
    and the initial attach, so a link was a way around it.
40. **The driven-tab band goes when the session goes.** While a tab is under control, ask the user
    whether it sits in a blue group labelled *Chat On Steroids* above the tab strip. Then `detach`
    and ask again: the band must be gone. It is the visible answer to "is something driving this
    tab", and it used to be left behind by every session.

---

# The report

One report at the end, in this shape. Be specific; "worked fine" is not usable.

**Environment** — macOS version, Mac model and architecture, Chrome version, app version, and
whether Screen Recording and Accessibility were granted.

**Summary** — how many of the 40 checks passed, failed, or could not be run, and the three most
serious problems in one line each.

**Section by section** — for every numbered check: the number, PASS / FAIL / NOT PERFORMABLE,
whether it differs from the previous run, and one or two sentences of what actually happened. For a
FAIL, the verbatim error code and message.

**The pointer questions** — answer these four directly, because they are why this run exists: is the
pointer visible in a window screenshot; is it at the right position; is the I-beam shape correct;
and does it correctly stay absent when the pointer is outside the window.

**Anything unasked** — anything that struck you as wrong, slow, confusing or dangerous that no
numbered check covers. On the last five runs this section has been the most valuable part of the
report. In particular: say whether any check made you want an action a tool does not have.
