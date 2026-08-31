# Browser control will not switch on — finding out why

The toggle does nothing when clicked. Nothing flips, nothing appears. That is a different
symptom from the one already fixed, where the switch flipped back after Chrome refused the
`debugger` permission — so the fix is not the answer here, and guessing further from Windows is
not worth your time.

This gets the decisive evidence in about two minutes. Do part 1 yourself; part 2 is a block to
paste into Claude on the Mac if part 1 does not already explain it.

---

## Part 1 — three things, by hand

### 1. Which build is running

Read the **window title** of Chat On Steroids.

- `Chat On Steroids 2.0.2+b556b8b` — current, carry on.
- `Chat On Steroids 2.0.2` with no commit, or just `Chat On Steroids` — **an older build**. Install
  the current DMG first; everything below would describe the wrong app.

### 2. Which extension Chrome actually has

Open `chrome://extensions`, find Chat On Steroids, and note:

- the **path** shown under the name after expanding **Details**
- whether pressing **Reload** (the circular arrow) changes anything

Then, in the app, press **Open extension folder** and compare the two paths. If Chrome is loading
a different folder than the app is offering, that is the whole problem: remove the extension in
Chrome and load the folder the app opens.

Chrome only re-reads a manifest on **Reload** or on a fresh **Load unpacked**. An extension left
in place since before this build still has the old manifest, in which `debugger` was optional —
and Chrome will never grant that.

### 3. What the popup says when you click

Right-click the Chat On Steroids extension icon → **Inspect popup**. A DevTools window opens.
Go to the **Console** tab, then click the Browser control toggle.

Report:

- every red line in the console, verbatim
- whether the **popup window closed** the moment you clicked
- whether any Chrome permission dialog appeared, even briefly

That third point matters more than it looks. `chrome.permissions.request()` closes the popup
while Chrome asks, by design. If the dialog does not appear — because it opened behind the
window, or was dismissed — the visible result is exactly "nothing happened", and the request is
abandoned rather than refused.

### The one paste that answers everything

With the popup's DevTools console open, paste this whole block and press Enter. It reports what
is loaded, instruments the toggle, and then you click it once.

```js
(() => {
  const m = chrome.runtime.getManifest();
  console.log('MANIFEST permissions          :', JSON.stringify(m.permissions));
  console.log('MANIFEST optional_permissions :', JSON.stringify(m.optional_permissions));
  console.log('debugger is required          :', (m.permissions || []).includes('debugger'));
  console.log('chrome.debugger available     :', typeof chrome.debugger);
  chrome.permissions.getAll((p) => console.log('HELD', JSON.stringify(p)));

  const t = document.getElementById('browserControlToggle');
  console.log('toggle found                  :', Boolean(t));
  console.log('row hidden                    :', t && t.closest('.row') ? t.closest('.row').hidden : 'n/a');
  console.log('error element present         :', Boolean(document.getElementById('browserControlError')));
  console.log('checked before                :', t && t.checked);

  // Does a change event reach a listener at all?
  if (t) t.addEventListener('change', () => console.log('CHANGE fired, checked =', t.checked), true);

  // Anything thrown inside the app's own handler would otherwise be invisible.
  window.addEventListener('error', (e) => console.log('THREW:', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', (e) => console.log('REJECTED:', String(e.reason)));

  console.log('--- now click the Browser control toggle once ---');
})();
```

Then click the toggle once and copy **everything** the console printed, including whatever
appears after the click.

If the popup closes on the click, reopen it with Inspect popup — the console window stays open
and keeps its history.

### What each answer means

- **`debugger is required: false`** — Chrome is running the old manifest. Reload the extension in
  `chrome://extensions`. Nothing else matters until this says true.
- **`toggle found: false`** or **`row hidden: true`** — the popup decided the browser cannot do
  this at all; send the whole output.
- **`CHANGE fired` never appears** — the click is not reaching the control. Send the output plus
  whether the checkbox visibly moved.
- **`CHANGE fired` appears and then nothing** — the handler ran and stalled or threw silently.
  This is the case I would most like to see, and `THREW`/`REJECTED` lines are the evidence.
- **The popup closes and the toggle is off when reopened** — Chrome's permission prompt took the
  popup with it and was never answered. That is a real defect in the flow and not your doing.

---

## Part 2 — paste into Claude on the Mac

Only needed if the three checks above did not settle it. Claude can read the files and compare
what is installed against what should be.

---

Browser control in the Chat On Steroids Chrome extension cannot be switched on: clicking the
toggle in the popup does nothing at all — no visible change, no error. Find out why. Do not
assume the manifest fix is the cause; that fix addressed a different symptom, where the toggle
flipped back after Chrome refused a permission.

Work from evidence, not from the source's intent. The source will tell you what should happen;
only the installed copies tell you what does.

1. **Establish what is installed.** Find the running app bundle and the extension folder it
   offers (`Open extension folder` resolves to a copy under the user's Application Support). Read
   that folder's `manifest.json` and report its `permissions` and `optional_permissions`
   verbatim. `debugger` must be in `permissions`, not in `optional_permissions`.

2. **Find what Chrome has actually loaded**, which may not be the same folder. Chrome records
   unpacked extensions in its profile preferences; the path is recorded there. Compare it with
   the folder from step 1 and say plainly whether they are the same directory — resolving
   symlinks, because `/var` and `/private/var` are the same place under different names.

3. **Compare the loaded copy against the repository.** Diff the loaded `popup.js`, `popup.html`
   and `browser-driver.js` against this checkout. Any difference means Chrome is running an older
   extension and nothing else matters until that is fixed.

4. **Check the wiring in the loaded copy specifically.** In the loaded `popup.js`, confirm that
   `browserControlToggle` has a `change` listener, that `showBrowserControlError` exists, and
   that `syncBrowserControl` can find `#browserControlError` in the loaded `popup.html`. A helper
   the popup calls but does not have would throw on first click, and a throw inside the handler
   leaves the toggle looking untouched.

5. **Consider the popup lifecycle.** `chrome.permissions.request()` closes the popup while Chrome
   prompts. If the prompt does not appear, the request is abandoned and the visible result is
   nothing happening. Say whether the code depends on the popup surviving the call, and whether
   the toggle state would be recoverable if it does not.

Report: what is installed, what Chrome loaded, whether they match, and the most likely cause with
the evidence for it. If the cause is that Chrome holds an older extension, say so first and
plainly — that is the cheapest thing to fix and it invalidates everything after it.
