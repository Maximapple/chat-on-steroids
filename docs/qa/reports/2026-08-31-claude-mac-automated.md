# Claude on Mac — automated run, 2026-08-31

Source: `docs/qa/claude-on-mac-start-here.md`, branch `integrate/browser-and-desktop-064733`,
at commit `2164930` (working tree otherwise clean at the start of the run).

Machine: macOS 27.0 (build 26A5421a), arm64, Apple silicon. Swift 6.4
(`swiftlang-6.4.0.33.1`), Command Line Tools at `/Library/Developer/CommandLineTools`.

## 0. Toolchain — a finding before the list started

The machine had **no Node and no Homebrew**. `node`, `npm`, `nvm`, `volta`, `fnm`, `mise` and
`asdf` were all absent, and there is no `/opt/homebrew` or `/usr/local/Cellar`. Nothing in
sections 1–3 can run without Node 22 (`.github/workflows/ci.yml` pins `node-version: 22`).

Resolved by unpacking the official tarball, not by a package manager:

```
node-v22.23.2-darwin-arm64.tar.gz: OK      (shasum -a 256 -c against nodejs.org SHASUMS256.txt)
installed to ~/.local/node-v22.23.2
v22.23.2
10.9.8
```

Nothing was written to `/usr/local` or `/opt`. Removing `~/.local/node-v22.23.2` undoes it.

## 1. `npm ci`, then `npm run verify:ci` — PASS

`npm ci`:

```
added 426 packages, and audited 427 packages in 3s
found 0 vulnerabilities
```

`npm run verify:ci`:

```
> chat-on-steroids@2.0.2 rg
> node scripts/fetch-ripgrep.mjs

ripgrep 15.2.0 darwin-arm64 checksum ok (3750b2e93f37e0c6...)
ripgrep 15.2.0 darwin-arm64 staged
resources/rg mirrors darwin-arm64 for development

> chat-on-steroids@2.0.2 verify:privacy
> node scripts/verify-public-history.mjs

Public-history privacy check passed (64 commits, 3 tags).

> chat-on-steroids@2.0.2 typecheck
> tsc --noEmit -p tsconfig.json


 RUN  v4.1.10 <repo>


 Test Files  73 passed | 3 skipped (76)
      Tests  1835 passed | 97 skipped (1932)
   Start at  11:15:15
   Duration  19.48s (transform 5.31s, setup 0ms, import 53.63s, tests 48.24s, environment 3ms)


 RUN  v4.1.10 <repo>


 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  11:15:35
   Duration  5.55s (transform 277ms, setup 0ms, import 411ms, tests 5.08s, environment 0ms)
```

Exit code 0. Nothing failed.

**Note on the counts.** The hand-off says Windows gives 1910 passed / 22 skipped. macOS gives
1837 passed / 97 skipped. The **total is 1932 on both**, so this is platform gating, not a
missing or broken test: 75 tests that run on Windows are skipped here. No test that ran, failed.

## 2. `npm run verify:browser` — 23/23, after fixing a macOS-only harness bug

### First run — 0/2, with a misleading reason

`COS_BROWSER` pointed at a freshly downloaded Chrome for Testing 152.0.7977.64 (mac-arm64,
no quarantine xattr). Installed Chrome on this machine is 152.0.7977.65.

```
> chat-on-steroids@2.0.2 verify:browser
> node scripts/verify-browser-driver.mjs

FAIL  the extension loads and its popup resolves  — /private/tmp/.../chrome-mac-arm64/Google Chrome
FAIL  the run completed  — the extension was not loaded. Chrome 137 and later ignore --load-extension; use a Chrome for Testing build, or point COS_BROWSER at Edge.

0/2 checks passed
```

That message is wrong on macOS, and it was worth not believing. Launching the same binary by
hand with the same flags and listing the CDP targets:

```
path.resolve  : /var/folders/2r/.../T/extid-22725/extension          => id leocbpnabnaodoofjhoomofbmkhgjcek
realpathSync  : /private/var/folders/2r/.../T/extid-22725/extension  => id cienbmpeoehghbpemdjcmjbhlefgbmog
browser: Chrome/152.0.7977.64
--- all targets:
 [browser_ui] chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html
 [page] about:blank
 [browser_ui] chrome://webui-toolbar.top-chrome/
 [browser_ui] chrome://omnibox-popup.top-chrome/
 [service_worker] chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/thunk.js
 [service_worker] chrome-extension://glbjnfimcajjenihimblfaponejbkoph/background.js
 [service_worker] chrome-extension://cienbmpeoehghbpemdjcmjbhlefgbmog/background.js
```

The extension **does** load under Chrome for Testing 152 on macOS. It loads under the
`realpathSync` id. `scripts/verify-browser-driver.mjs` derived the id from `path.resolve(copy)`,
but Chromium hashes the symlink-resolved path — and on macOS `os.tmpdir()` is
`/var/folders/…`, a symlink to `/private/var/folders/…`. The harness therefore asked for a popup
at an id no target ever carried, got the chrome-error page that keeps the requested url, read
`chrome.runtime.id === null`, and reported Chrome's `--load-extension` removal as the cause.

Windows has no such symlink, which is why 23/23 there never exposed it.

Fixed by resolving the path on non-Windows only, leaving the proven-green Windows arithmetic
untouched.

### After the fix — 23/23

```
PASS  the extension loads and its popup resolves  — chrome-extension://fgjoanmclohifbgongadpnpjickgaldn/popup.html
PASS  the fixture page is open  — http://127.0.0.1:9997/
PASS  the extension can see the page tab
PASS  the driver attaches over the DevTools protocol  — {"attached":true,"tabId":1901711707,"url":"http://127.0.0.1:9997/","title":"Driver fixture"}
PASS  observe reads the page  — Driver fixture
PASS  finds the main-frame controls  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  finds the control inside the iframe  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  omits what a pointer cannot reach  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  one screenshot pixel is one CSS pixel  — {"shot":{"w":756,"h":413},"viewport":{"width":756,"height":413}}
PASS  the page received a TRUSTED click  — clicked trusted=true
PASS  the field fired real input events  — typed:Maxim
PASS  the iframe received a TRUSTED click  — inner clicked trusted=true
PASS  the pointer overlay is drawn in the page
PASS  a keypress arrives as a TRUSTED key event  — key:Enter trusted=true
PASS  double_click produces a real dblclick  — dblclick trusted=true
PASS  a drag presses, moves while held, then releases  — down:true move:true up:true
PASS  navigate loads the requested document  — Second document
PASS  back returns the previous document  — Driver fixture
PASS  forward goes onward again  — Second document
PASS  reload keeps the same document  — Driver fixture
PASS  an unknown ref is refused rather than guessed  — BROWSER_BAD_REF: e999 is not from the most recent observation of this page
PASS  detach gives the tab back  — {"attached":false,"tabId":null,"url":null,"title":null}
PASS  detach removes the overlay

23/23 checks passed
```

`npm run typecheck` and `npm run verify:privacy` both still pass after the change.

## 3. The macOS desktop helper — built, ran, but did NOT reach the pointer path

`node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64`:

```
  CXX(target) Release/obj.target/macos_desktop_addon/addon.o
  SOLINK_MODULE(target) Release/macos_desktop_addon.node
gyp info ok
macOS arm64 desktop helper, in-process library and Node addon built and verified.
```

`node scripts/probe-macos-helper.mjs arm64`:

```
ok    the helper starts and answers — ok
      screenPermission=false accessibilityPermission=false
ok    it can be asked for the cursor — ok
      cursor={"x":1140,"y":492} foreground=599
ok    it can enumerate windows — ok
ok    a capture either works or is refused by name — refused SCREEN_PERMISSION_REQUIRED
      refused: SCREEN_PERMISSION_REQUIRED — enable Screen Recording for Chat On Steroids, then fully quit and reopen the app
ok    it lists windows to capture — ok
      10 windows listed, 10 not minimized
      window 599 "Terminal window" at 982,202 580x385
ok    it can put the pointer inside that window — refused ACCESSIBILITY_PERMISSION_REQUIRED
      pointer could not be moved (ACCESSIBILITY_PERMISSION_REQUIRED) — act requires Accessibility, which a runner rarely grants, so expect outside_region below
ok    it captures that window — refused SCREEN_PERMISSION_REQUIRED

macOS helper probe passed (7 answers)
```

### THE POINTER COMPOSITOR IS STILL UNTESTED

The probe passed on its own terms — named TCC refusals are the working code path it checks for,
and the helper starts, answers, reads the cursor and enumerates ten real windows. But:

- **No `pointer=` value was produced.** Neither capture reached the compositor; both were
  refused at the permission gate before any pixels were touched.
- `captureMode` reached neither `window` nor `screen`.

The reason is TCC attribution, not the code. macOS attributes the grant to the GUI ancestor of
the process tree, which for a `claude` session in a terminal is `Terminal.app`:

```
zsh -> claude -> zsh -> login -> Terminal.app -> launchd
```

`Terminal.app` holds neither Screen Recording nor Accessibility, so `screenPermission=false
accessibilityPermission=false` is the honest state of this run.

**Nothing here should be read as evidence that the pointer path works or does not work.** No
claim about it was made from reading the Swift, deliberately: the runbook records that a code
review of exactly this path already produced a confident wrong answer once.

To close it, one of:

1. Grant `Terminal.app` Screen Recording **and** Accessibility, fully quit and reopen Terminal
   (macOS caches the answer for the life of the process), and re-run
   `node scripts/probe-macos-helper.mjs arm64`.
2. Follow runbook section 1 against the installed app — the real product path — and record the
   `desktop timing … pointer=…` line from the Activity panel.

## Still outstanding — untested, not passed

Everything in "What needs a person" remains untested by this run:

- The pointer in a window screenshot (runbook §1) — **untested**, see above.
- The onboarding permission step: timing, deep-link targets, live refresh, both themes
  (runbook §2) — **untested**, needs granted TCC and a real desktop.
- QA cases 6.9, 6.3, 6.2, 6.4 and Test 5, Chrome's link-preview bubble versus foreground-window
  resolution (runbook §3) — **untested**.
- `docs/qa/chatgpt-desktop-qa-prompt.md`, the 32-check model → MCP → app → macOS script —
  **not run**; it cannot be driven from a terminal session.

## Documentation drift noticed

`docs/macos-qa-runbook.md` §4 still says the browser driver scores 16/16. The script asserts 23
checks, and the hand-off in `docs/qa/claude-on-mac-start-here.md` says 23. Not corrected here.
