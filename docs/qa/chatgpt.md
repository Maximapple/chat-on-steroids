# Everything ChatGPT runs

Twelve checks. Ten of them — 18–25 and 33–34 — have never once executed across five QA runs; two
— 11 and 38 — failed in the last one and were fixed. Everything else in the old 38-check script
passed and is not repeated here. That script is in git history if a full regression run is ever
wanted again.

## Before you paste

1. Install the current DMG. The window title must read `Chat On Steroids 2.0.2+<commit>` with the
   commit from the release. A title without one is an older app and the run measures the wrong
   thing.
2. **Reload the extension** in `chrome://extensions`. The browser driver ships inside the
   extension, not the app, so a new package alone changes nothing in Chrome.
3. **Home → Health → Run checks** must show `Local server … offers 3 tools: browser, computer,
   observe`. Two means the extension is not connected and section B cannot run on any build.
4. **Delete and recreate the Desktop connector in ChatGPT, then open a new chat.** A connector
   keeps the tool list it fetched when it was made, and a chat keeps the list it loaded when it
   opened. This step is what three lost runs were missing.

Then paste everything below the line.

---

You are testing an app called Chat On Steroids, connected to you as MCP apps. Twelve numbered
checks, and one gate before them.

## The gate

List the exact tool names the Chat On Steroids Desktop connector offers you in this conversation.

- If `browser` is **not** among them: say so, skip section B, and do section A only. Do not
  substitute another tool for it. Three runs were lost to exactly that.
- If `browser` **is** there: say so and do both sections.

## Rules

- Verify the *effect* of each action, not that the call returned. A tool answering `ok` while
  nothing changed is the failure worth catching, and this product has shipped it twice.
- Quote error codes and messages verbatim. Do not paraphrase.
- At most two attempts per check.
- In section B, **use the `browser` tool and nothing else** — not `computer`, not the extension
  popup, not keyboard shortcuts. If something cannot be done with `browser`, that is the finding:
  report FAIL and name the action you looked for and did not find.
- The `browser` tool has no attach action. `navigate` starts a run: it takes the newest ordinary
  tab, or opens one if the browser has none.

## A. The desktop, two checks that failed last time

11. With two ordinary windows open and overlapping, ask which window is foreground, and verify
    against a screenshot. Then bring **Chat On Steroids itself** to the front and ask again.

    Its own windows are deliberately never exposed — the model must not drive the app driving
    it — so the answer must say that rather than report an empty desktop. Quote it.

38. **Do this last, and tell the user before you start.** It revokes a permission the run depends
    on, and this app deliberately makes its own window unautomatable, so if the connectors do not
    come back nothing you can do will restore them.

    Ask the user to switch **Accessibility** off for Chat On Steroids, then fully quit and reopen
    the app. The window must come back and the connector must answer: desktop actions should
    refuse with a named permission error, not with a dead tunnel. If the connectors do not
    return, ask the user to look in the app's **Activity** panel for a line beginning
    `automatic connect failed:` — it names which link is broken, which a dead tunnel alone does
    not.

    Recovery is manual: re-enable Chat On Steroids under System Settings → Privacy & Security →
    Accessibility (Device Control on newer macOS), then fully quit and reopen. Say this in the
    report rather than leaving the machine in that state without explanation.

## B. Browser control, never yet executed

18. `navigate` to `https://example.com`. Then `status`. Report which tab the tool says it holds —
    title and URL. Say whether Chrome had an ordinary tab open beforehand or the tool opened one.

19. `observe`. Report the page title and how many interactive elements (refs) came back.

20. From that same `observe`, confirm you received a screenshot, and confirm the **pointer
    overlay** is drawn on the page — browser control renders its own pointer, separate from the
    macOS one.

21. `navigate` to a search engine. Click into the search field, `type` a query, `keypress` Enter,
    then `observe` and confirm from the page that results loaded.

22. `back`, then `forward`, then `reload`. After each, `observe` and report the page **title**, so
    it is clear the document changed rather than only the address.

23. From the refs in your latest `observe`, use `click_ref` on an element rather than a
    coordinate. Confirm the effect.

    A previous run passed this while the call answered
    `BROWSER_TIMEOUT: the browser took the action but did not report a result`. If that happens
    again, quote it — and do not retry, which is what that message now tells you.

24. **The refusals.** `navigate` to each of these three in turn:
    `https://chatgpt.com/`, `chrome://settings`, `file:///etc/hosts`.

    All three must be refused, and the tab you were driving must be unchanged afterwards — check
    with `status`. Quote each error exactly. **Passing this check means being refused**: the model
    asking for browser control is sitting in a ChatGPT tab, and a driver able to go there could
    drive its own conversation.

25. `detach`, then `status`. Confirm the tool reports no tab under control, and that the pointer
    overlay is gone from the page. Use the tool's own actions — the previous run clicked the
    extension popup with desktop automation, which produced a false success.

33. **Scroll direction.** `navigate` to a long page, `scroll` down by a positive `scroll_y`, then
    `observe` and confirm from the screenshot that the content moved **down**. Then scroll back
    up. This was inverted for a long time and has never been verified end to end anywhere.

34. **set_value replaces, and clears.** In a field that already contains text, `set_value` a new
    string. The field must then contain **only** the new text — a previous run got
    `OLD TEXTONLY NEW`. Then `set_value` an empty string and confirm the field is genuinely
    empty, not one character shorter.

## The report

For each check: the number, PASS / FAIL / NOT PERFORMABLE, and one or two sentences of what
actually happened. Verbatim error text for anything that failed.

Then four summary lines:

- Was the pointer overlay visible in a browser screenshot?
- Did all three refusals in check 24 refuse, and did the driven tab survive them?
- Does `set_value` replace rather than append?
- Did the connectors come back after check 38?

And anything that struck you as wrong, slow or dangerous that no check covers. On the last five
runs that section has been the most valuable part of the report. In particular: say whether any
check made you want an action the tool does not have.
