# Browser control, on its own

Ten checks — 18–25 and 33–34 — which have never once executed across three QA runs, because the
browser tool was missing from the conversation each time. Everything else in the full script has
already been run and does not need repeating.

Use this after **deleting and recreating the Desktop connector in ChatGPT**, in a **new chat**. A
connector keeps the tool list it fetched when it was made, and a chat keeps the list it loaded
when it opened; recreating the connector is the step that was missing before.

No new package is needed. What matters is that the installed app serves the `browser` tool —
**Home → Health → Run checks** must show `Local server … offers 3 tools: browser, computer,
observe`. If it shows two, the Chrome extension is not connected and step E cannot run on any
build.

---

You are testing browser automation in an app called Chat On Steroids, connected to you as MCP
apps. Ten numbered checks, and one gate before them.

## The gate

List the exact tool names the Chat On Steroids Desktop connector offers you in this conversation.

- If `browser` is **not** among them: **stop.** Report the names you do see and say the ten
  checks below are not performable in this conversation. Do not substitute desktop clicking, the
  Chrome extension popup, or anything else. Three previous runs were lost to exactly this, and a
  substitute result is worse than none.
- If `browser` **is** there: say so and carry on.

## Rules

- Verify the *effect* of each action, not that the call returned. A tool answering `ok` while
  nothing changed is the failure worth catching, and this product has shipped that failure twice.
- Quote error codes and messages verbatim. Do not paraphrase.
- At most two attempts per check. A loop buries the evidence.
- If an action would touch the tab holding this conversation, stop and report it — that must be
  refused, and a refusal there is a pass.

## The checks

18. Open a new Chrome tab on `example.com` and attach browser control to it. Report what the tool
    says about which tab it holds.

19. Read the page structure. Report the page title and how many interactive elements were found.

20. Take a browser screenshot. Confirm you received an image, and confirm the **pointer overlay**
    is drawn on the page — browser control renders its own pointer, separate from the macOS one.

21. Go to a search engine. Click into the search field, type a query, press Enter, and confirm
    from the page that results loaded.

22. Back, then forward, then reload. After each, report the page **title**, so it is clear the
    document changed rather than only the address.

23. From the structure you read, click an element **by its ref** rather than by coordinate.
    Confirm the effect on the page.

    A previous run passed this while the call itself answered
    `BROWSER_TIMEOUT: the browser took the action but did not report a result`. If that happens
    again, quote it — and do **not** retry, which is what that message now tells you.

24. **The refusals.** Try to attach to the tab holding *this* conversation; then `chrome://settings`;
    then a `file://` URL. All three must be refused. Quote each error exactly. **Passing this
    check means being refused** — it is a security property, not a limitation.

25. `detach`, then `status`. Confirm the tool reports no tab under control and that the pointer
    overlay is gone from the page. Use the tool's own actions — do not click the extension popup;
    that is what produced a false success last time.

33. **Scroll direction.** With control attached to a long page, scroll down by a positive amount
    and confirm from a screenshot that the content moved **down**. Then scroll back up. This was
    inverted for a long time and never once verified end to end.

34. **set_value replaces, and clears.** In a field that already contains text, set a new value.
    The field must contain **only** the new text — a previous run got `OLD TEXTONLY NEW`. Then set
    an empty value and confirm the field is genuinely empty, not one character shorter.

## The report

For each check: the number, PASS / FAIL / NOT PERFORMABLE, and one or two sentences of what
actually happened. Verbatim error text for anything that failed.

Then three summary lines:

- Was the pointer overlay visible in a browser screenshot?
- Did all three refusals in check 24 refuse?
- Does `set_value` replace rather than append?

And anything that struck you as wrong, slow or dangerous that no check covers. On the last three
runs that section has been the most valuable part of the report.
