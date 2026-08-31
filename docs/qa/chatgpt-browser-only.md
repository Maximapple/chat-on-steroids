# Browser control, on its own

Ten checks — 18–25 and 33–34 — which have never once executed across four QA runs.

The first three runs lost them because the `browser` tool was missing from the conversation. The
fourth had the tool and lost them anyway, to a fault in this document: check 18 asked to "open a
new Chrome tab and attach browser control to it", and the tool can do neither. It has no action
that opens a tab and no action that attaches one. It takes the newest ordinary tab already open,
and `navigate` is how a run starts. Reading that correctly, the run reached for the `computer`
tool to press Cmd+T instead, and spent both its attempts failing in a subsystem these checks are
not about.

So the checks below are written in the tool's own vocabulary, and one rule forbids the detour.

Use this after **deleting and recreating the Desktop connector in ChatGPT**, in a **new chat**.

No new package is needed. **Home → Health → Run checks** must show `Local server … offers 3 tools:
browser, computer, observe`. If it shows two, the Chrome extension is not connected and section E
cannot run on any build.

The fifth run then failed on the other half of the same fault: Chrome had only ChatGPT tabs open,
and `BROWSER_NO_TAB` told the caller to "open the page first" while still offering no action that
opens a page. `navigate` now opens one when nothing is drivable, which is what makes check 18
performable at all — so this needs a build containing that fix, and the Chrome extension must be
**reloaded** in `chrome://extensions` after installing it, because the driver lives in the
extension rather than in the app.

---

You are testing browser automation in an app called Chat On Steroids, connected to you as MCP
apps. Ten numbered checks, and one gate before them.

## The gate

List the exact tool names the Chat On Steroids Desktop connector offers you in this conversation.

- If `browser` is **not** among them: **stop.** Report the names you do see and say the ten checks
  are not performable. Do not substitute anything. Three runs were lost to exactly this.
- If `browser` **is** there: say so and carry on.

## Rules

- **Use the `browser` tool and nothing else for these checks.** Do not use `computer`, the
  extension popup, or keyboard shortcuts to open tabs, focus windows or click things. If
  something cannot be done with the `browser` tool, **that is the finding** — report it as a FAIL
  and say which action you looked for and did not find. A previous run's whole section was lost
  to a well-meant detour through `computer`.
- The tool has no attach action. `navigate` starts a run: it takes the newest ordinary tab, or
  opens one if the browser has none.
- Verify the *effect* of each action, not that the call returned. A tool answering `ok` while
  nothing changed is the failure worth catching, and this product has shipped it twice.
- Quote error codes and messages verbatim. Do not paraphrase.
- At most two attempts per check.

## The checks

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

23. From the refs in your latest `observe`, use `click_ref` on an element rather than clicking a
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
    up. This was inverted for a long time and never verified end to end.

34. **set_value replaces, and clears.** In a field that already contains text, `set_value` a new
    string. The field must then contain **only** the new text — a previous run got
    `OLD TEXTONLY NEW`. Then `set_value` an empty string and confirm the field is genuinely
    empty, not one character shorter.

## The report

For each check: the number, PASS / FAIL / NOT PERFORMABLE, and one or two sentences of what
actually happened. Verbatim error text for anything that failed.

Then three summary lines:

- Was the pointer overlay visible in a browser screenshot?
- Did all three refusals in check 24 refuse, and did the driven tab survive them?
- Does `set_value` replace rather than append?

And anything that struck you as wrong, slow or dangerous that no check covers. On the last four
runs that section has been the most valuable part of the report. In particular: say whether any
check made you want an action the tool does not have.
