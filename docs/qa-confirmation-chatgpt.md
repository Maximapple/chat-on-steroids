# Confirmation round — ChatGPT, the browser tool

Paste everything below the line into a ChatGPT conversation with the Core and Desktop connectors
enabled. Short and targeted: these are the four browser steps that failed the last round, three of
which have since been fixed.

**Setup that matters.** The connector must actually be picked in ChatGPT, not merely running. The
app can only attribute a call once the extension has observed a real request id in a real ChatGPT
turn. If the app's status still reads "Pick the tunnel in ChatGPT", stop and fix that first —
every step here is unreachable without it.

---

You are confirming four browser fixes. Only use the public test site named here. Do not create
accounts or enter real personal data.

After each step write one line: `N. PASS`, `N. FAIL — <exact evidence>`, or `N. SKIP — <reason>`.
Quote literal error text; a paraphrase is worth far less. Never report a step you did not run.

1. `navigate` to `https://the-internet.herokuapp.com/dropdown`, then `observe`.
2. `set_value` on the dropdown with `Option 1`. Re-observe and confirm it now reads back as
   selected. Last round this silently did nothing: `click_ref`, keyboard, `set_value` and typing
   all reported success and the page still read "Please select an option". Report the exact value.
3. `set_value` on the same dropdown with `Purple`. It must be **refused by name, listing the
   available options** — not reported as success. Quote the refusal verbatim.
4. `navigate` to `/hovers` and `observe`. The three hover targets must now have refs, named from
   their captions (`name: user1` and so on). Last round the only ref on the page was an unrelated
   footer link. List the refs and names you see.
5. `move_ref` to one of those refs. Confirm the caption appears **without** a click.
6. `navigate` to `/login`, submit `tomsmith` / `SuperSecretPassword!` (the page's own documented
   demo credentials), and confirm you reach the secure area.
7. `click_ref` the Logout button. **This one is not fixed and could not be reproduced**, so the
   evidence matters more than the verdict. Whatever happens, report: the full `observe` entry for
   that button, the complete `click_ref` result including `hit` and `covered`, the page URL
   immediately after, and any console error. A fixture with the exact shape you reported last time
   (`hit=i covered=false`, an anchor whose centre resolves to an inline child) navigates correctly
   in real Chrome, so if this fails again the cause is something else and that evidence is the
   only way to find it.
8. `navigate` to `http://127.0.0.1:1/` — a port nothing is listening on. Report exactly what
   happens; a named refusal is the expected answer.
9. `detach`, then immediately `observe`. It may re-attach to an ordinary tab; that is deliberate
   and the tool says so. What must **not** happen is the thing you saw last round: a tab holding
   `chrome-error://chromewebdata/` returned as though it were a real page. Report the URL it gives
   you, or the refusal.
10. Final summary: a line per step, then every FAIL restated with its exact evidence.
