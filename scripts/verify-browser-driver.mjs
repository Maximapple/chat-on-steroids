/**
 * Drives the browser driver in a real browser, against a real page.
 *
 * The unit tests cover what can be decided without a browser: the refusal list, the input
 * vocabulary, the page reader against a synthetic DOM. None of that can tell you whether a
 * click actually lands, whether the page believes it, or whether a coordinate read off a
 * screenshot addresses the pixel it appears to. This can, and it is how five real defects were
 * found that the suite was green through.
 *
 * Deliberately not part of `verify` or CI. It needs a Chromium browser installed, and headless
 * capture is timing-dependent in a way that would make CI flaky for reasons that have nothing
 * to do with the code — see the compositor note below. Run it by hand when the driver changes:
 *
 *     npm run verify:browser
 *
 * ## Two accommodations, neither of which changes the code under test
 *
 * `debugger` and `<all_urls>` ship as optional permissions, granted from a click in the popup
 * that cannot be clicked headlessly, so a throwaway copy of the extension promotes exactly
 * those two to required and changes nothing else.
 *
 * The driver normally runs in the service worker. An MV3 worker is lazy and headless does not
 * expose it as a debuggable target, so the module is imported into the popup instead — an
 * ordinary extension page with the same `chrome.debugger` access, running the same file.
 *
 * ## The compositor
 *
 * `Page.captureScreenshot` answers when the renderer produces a frame, and a wheel event when
 * the compositor has taken it. Headless has no compositor driving frames on its own, so both
 * can stall for as long as you let them. The page is nudged and the observation retried here;
 * a wheel event may still not be acknowledged, and that is a property of headless rather than
 * of the driver — clicks, which are acknowledged directly, land every time.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(os.tmpdir(), `cos-browser-driver-${process.pid}`);
const copy = path.join(workspace, 'extension');
const profile = path.join(workspace, 'profile');
const port = 9400 + (process.pid % 200);
const pagePort = port + 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where a Chromium build usually lives, in the order worth trying.
 *
 * Chrome for Testing comes first, because installed Chrome can no longer be told to load an
 * unpacked extension: Chrome 137 removed `--load-extension`, and Chrome 152 here ignores it
 * under every documented re-enabling flag — it records zero extensions from the given path.
 * Chrome for Testing is the same Chromium, published by Google for exactly this purpose.
 * Edge still honours the switch, so it remains a usable fallback.
 */
const BROWSERS = [
  process.env['COS_BROWSER'],
  `${os.homedir()}/AppData/Local/chrome-for-testing/chrome-win64/chrome.exe`,
  `${os.homedir()}/.cache/puppeteer/chrome/win64/chrome.exe`,
  '/Applications/Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const browserPath = BROWSERS.find((candidate) => existsSync(candidate));
if (!browserPath) {
  console.error('No Chromium browser found. Set COS_BROWSER to one and try again.');
  process.exit(2);
}

rmSync(workspace, { recursive: true, force: true });
mkdirSync(copy, { recursive: true });
cpSync(path.join(root, 'extension'), copy, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions];
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions];
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));

// The shapes that matter: a control named only by aria-label, a field, something hidden, and
// an iframe — which is the case that was invisible until the frame walk landed.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Driver fixture</title>
<style>body{font:14px system-ui;margin:0;padding:16px}</style>
<button id="go" aria-label="Run the thing">Run</button>
<input id="name" placeholder="Your name">
<button id="hidden" style="display:none">Never</button>
<button id="dbl" aria-label="Double me">Double</button>
<div id="pad" style="width:220px;height:70px;border:1px dashed #999">Drag pad</div>
<a id="onward" href="/second">Go onward</a>
<a id="leave" href="about:blank">Leave for a refused page</a>
<div id="log">nothing yet</div>
<div id="klog">no keys</div>
<div id="dlog">no dblclick</div>
<div id="draglog">no drag</div>
<div id="wheellog">no wheel</div>
<iframe id="frame" src="/frame" style="width:320px;height:80px;border:1px solid #ccc"></iframe>
<!-- Last, so the page can scroll without pushing anything above it out of the viewport. -->
<div id="tall" style="height:3000px">room to scroll</div>
<script>
document.getElementById('go').addEventListener('click', (e) => {
  document.getElementById('log').textContent = 'clicked trusted=' + e.isTrusted;
});
document.getElementById('name').addEventListener('input', () => {
  document.getElementById('log').textContent = 'typed:' + document.getElementById('name').value;
});
document.getElementById('name').addEventListener('keydown', (e) => {
  document.getElementById('klog').textContent = 'key:' + e.key + ' trusted=' + e.isTrusted;
});
document.getElementById('dbl').addEventListener('dblclick', (e) => {
  document.getElementById('dlog').textContent = 'dblclick trusted=' + e.isTrusted;
});
// Recorded as a sequence, because a drag that only lands its endpoints is not a drag: the
// press, at least one move while held, and the release all have to arrive, in that order.
const drag = [];
const pad = document.getElementById('pad');
pad.addEventListener('mousedown', (e) => { drag.length = 0; drag.push('down:' + e.isTrusted); });
pad.addEventListener('mousemove', (e) => {
  if (drag.length && e.buttons === 1 && !drag.includes('move:' + e.isTrusted)) drag.push('move:' + e.isTrusted);
});
window.addEventListener('wheel', (e) => {
  document.getElementById('wheellog').textContent =
    'wheel deltaY=' + e.deltaY + ' trusted=' + e.isTrusted;
}, { passive: true });
pad.addEventListener('mouseup', (e) => {
  drag.push('up:' + e.isTrusted);
  document.getElementById('draglog').textContent = drag.join(' ');
});
</script>`;

const FRAME = `<!doctype html><meta charset="utf-8"><title>inner</title>
<button id="inner">Inside the frame</button><span id="innerlog">idle</span>
<script>
document.getElementById('inner').addEventListener('click', (e) => {
  document.getElementById('innerlog').textContent = 'inner clicked trusted=' + e.isTrusted;
});
</script>`;

const SECOND = `<!doctype html><meta charset="utf-8"><title>Second document</title>
<h1>Second</h1>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/frame' ? FRAME : req.url.startsWith('/second') ? SECOND : PAGE);
});
await new Promise((resolve) => server.listen(pagePort, '127.0.0.1', resolve));

/**
 * Chromium's id for an unpacked extension: sha-256 of the load path, nibbles mapped a..p.
 *
 * The path it hashes is the *real* one, with symlinks resolved. On macOS `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`, so hashing the unresolved path
 * yielded an id no target ever carried: the popup opened as a
 * chrome-error page keeping the requested url, and the run blamed Chrome's `--load-extension`
 * removal for what was this arithmetic. Chrome for Testing 152 loads the extension here fine.
 *
 * Windows is left on `path.resolve` deliberately: it has no such symlink, its id is proven
 * correct against Chrome 152 and Edge, and `realpathSync` there can renormalise a path in ways
 * this cannot check from macOS.
 */
const extensionRoot = process.platform === 'win32' ? path.resolve(copy) : realpathSync(copy);
const digest = createHash('sha256')
  .update(Buffer.from(extensionRoot, process.platform === 'win32' ? 'utf16le' : 'utf8'))
  .digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join('');

// Headless by default, because that is what a build machine can run. A wheel event is only
// delivered to a page by a compositor that draws frames, and headless draws none — so the one
// property scroll has that matters, its direction, is unjudgeable there and the check below says
// so rather than passing. Run with --headed on a machine with a screen to actually judge it.
const headed = process.argv.includes('--headed');
const browser = spawn(browserPath, [
  ...(headed ? [] : ['--headless=new', '--disable-gpu']),
  `--user-data-dir=${profile}`,
  `--load-extension=${copy}`, `--remote-debugging-port=${port}`,
  '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
  '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${pagePort}/`
], { stdio: 'ignore' });
// Wait for the port to answer rather than guessing at a duration: Chrome for Testing takes
// noticeably longer to come up than Edge, and a fixed sleep turned that into "fetch failed".
let ready = null;
for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
  try {
    ready = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {
    await sleep(500);
  }
}
if (!ready) {
  console.error(`${browserPath} never opened its debugging port.`);
  process.exit(2);
}

/** One target's CDP session. Every call is bounded: a silent hang would read as a pass. */
async function attachTarget(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const waiting = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('socket failed')));
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    const settle = waiting.get(frame.id);
    if (settle) {
      waiting.delete(frame.id);
      settle(frame);
    }
  });
  return {
    close: () => socket.close(),
    evaluate: (expression) =>
      new Promise((resolve) => {
        const message = {
          id: ++id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        };
        // Longer than the driver's own compositor deadline, or this gives up first and reports
        // a driver failure that is really a harness one.
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          resolve({ error: 'evaluate timed out' });
        }, 90_000);
        waiting.set(message.id, (frame) => {
          clearTimeout(timer);
          const details = frame.result?.exceptionDetails;
          resolve(
            details
              ? { error: `${details.text} ${details.exception?.description ?? ''}`.trim() }
              : { value: frame.result?.result?.value }
          );
        });
        socket.send(JSON.stringify(message));
      })
  };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 150) : ''}`);
};

let popup;
let pageCdp;
try {
  await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`,
    { method: 'PUT' }
  );
  await sleep(3000);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const popupTarget = list.find((t) => t.url.includes(extensionId) && t.url.includes('popup.html'));
  const pageTarget = list.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${pagePort}/`));
  if (!popupTarget || !pageTarget) {
    check('the extension loads and its popup resolves', false, 'no target at the popup url');
    throw new Error('missing targets');
  }

  popup = await attachTarget(popupTarget.webSocketDebuggerUrl);

  // A target carrying the popup url proves nothing: a browser that refused to load the
  // extension navigates to chrome-error and keeps the requested url. Ask the page what it is.
  // Without this the run reported a passing load and then failed six checks further down with
  // "cannot read properties of undefined", which names the symptom instead of the cause.
  const identity = await popup.evaluate(`(() => {
    try { return chrome?.runtime?.id ?? null; } catch { return null; }
  })()`);
  const loaded = identity.value === extensionId;
  check('the extension loads and its popup resolves', loaded,
    loaded ? popupTarget.url : `${browserPath} did not load the extension (chrome.runtime.id=${identity.value})`);
  if (!loaded) {
    throw new Error(
      'the extension was not loaded. Chrome 137 and later ignore --load-extension; use a ' +
      'Chrome for Testing build, or point COS_BROWSER at Edge.'
    );
  }
  check('the fixture page is open', Boolean(pageTarget), pageTarget.url);
  pageCdp = await attachTarget(pageTarget.webSocketDebuggerUrl);
  const run = (expression) => popup.evaluate(expression);
  const readPage = async (expression) => (await pageCdp.evaluate(expression)).value;

  /*
   * The service worker, not just this page.
   *
   * Everything below drives the driver from the popup, which is an ordinary extension page and
   * can do things a service worker cannot. The worker is where browser control actually runs,
   * and it failed there for months while this run stayed green: it loaded the driver with a
   * dynamic import, which the specification forbids on ServiceWorkerGlobalScope, so every
   * browser_* message answered with an error and the popup switch silently showed off.
   *
   * One message settles it. It reaches the worker, which must have evaluated its imports to
   * answer at all.
   */
  const workerReply = await run(`(async () => {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'browser_status' });
      return JSON.stringify({ reply, lastError: chrome.runtime.lastError?.message ?? null });
    } catch (e) {
      return JSON.stringify({ threw: String(e && e.message ? e.message : e) });
    }
  })()`);
  const worker = JSON.parse(workerReply.value ?? '{}');
  check('the service worker loads the driver and answers',
    worker?.reply?.ok === true,
    workerReply.value ?? workerReply.error);

  const tabInfo = await run(`(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => (t.url || '').startsWith('http://127.0.0.1:${pagePort}/'));
    return JSON.stringify({ id: t?.id ?? null });
  })()`);
  const tab = JSON.parse(tabInfo.value ?? '{}');
  check('the extension can see the page tab', Boolean(tab.id), tabInfo.error ?? '');

  const attached = await run(`(async () => {
    globalThis.__driver = await import('./browser-driver.js');
    return JSON.stringify(await globalThis.__driver.browserDriver.attach(${tab.id}));
  })()`);
  check('the driver attaches over the DevTools protocol',
    String(attached.value ?? '').includes('"attached":true'), attached.value ?? attached.error);

  // Nudge the page to dirty itself, then retry: the first capture on an idle headless tab
  // waits for a frame nothing has asked for. Never awaits requestAnimationFrame, which does
  // not fire without a compositor — waiting on it is a hang, not a workaround.
  let observed = { error: 'not attempted' };
  for (let attempt = 1; attempt <= 4; attempt++) {
    await pageCdp.evaluate(
      `document.body.style.outline = '1px solid rgba(0,0,0,' + (Math.random() * 0.01) + ')'`
    );
    observed = await run(`(async () => {
      try {
        const o = await globalThis.__driver.browserDriver.observe({ includeScreenshot: true });
        return JSON.stringify({
          title: o.title, viewport: o.viewport,
          shot: o.screenshot ? { w: o.screenshot.width, h: o.screenshot.height } : null,
          elements: o.elements.map((e) => ({ ref: e.ref, name: e.name }))
        });
      } catch (e) { return JSON.stringify({ retry: (e.code || '') + ' ' + e.message }); }
    })()`);
    if (observed.value && !String(observed.value).includes('"retry"')) break;
    console.log(`   (headless capture stalled, attempt ${attempt})`);
    await sleep(1500);
  }

  const view = JSON.parse(observed.value ?? '{}');
  const names = (view.elements ?? []).map((e) => e.name);
  check('observe reads the page', view.title === 'Driver fixture', view.title ?? observed.error);
  check('finds the main-frame controls',
    names.includes('Run the thing') && names.includes('Your name'), names.join(' | '));
  check('finds the control inside the iframe', names.includes('Inside the frame'), names.join(' | '));
  check('omits what a pointer cannot reach', !names.includes('Never'), names.join(' | '));
  check('one screenshot pixel is one CSS pixel',
    Boolean(view.shot) && view.shot.w === view.viewport?.width && view.shot.h === view.viewport?.height,
    JSON.stringify({ shot: view.shot, viewport: view.viewport }));

  const refFor = (name) => (view.elements ?? []).find((e) => e.name === name)?.ref;
  const act = async (action) => {
    const reply = await run(`(async () => {
      try { return JSON.stringify(await globalThis.__driver.browserDriver.act(${JSON.stringify(action)})); }
      catch (e) { return 'ACTION_REFUSED ' + (e.code || '') + ': ' + e.message; }
    })()`);
    const text = String(reply.value ?? reply.error ?? '');
    // Surfaced immediately: a refusal swallowed here turns into a check that fails with
    // "nothing happened", which points at the page instead of at the call.
    if (text.startsWith('ACTION_REFUSED')) throw new Error(`${action.type} → ${text}`);
    return reply;
  };
  /** A point inside an element, in the CSS pixels the driver's coordinates are expressed in. */
  const centreOf = async (id) => JSON.parse(await readPage(
    `(() => { const r = document.getElementById('${id}').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        left: Math.round(r.x), top: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); })()`
  ));

  await act({ type: 'click_ref', ref: refFor('Run the thing') });
  await sleep(400);
  const log = await readPage(`document.getElementById('log').textContent`);
  // The whole reason this goes through the DevTools protocol: a content script's events are
  // isTrusted:false, and real pages reject those for anything that matters.
  check('the page received a TRUSTED click', log === 'clicked trusted=true', log);

  await act({ type: 'set_value', ref: refFor('Your name'), text: 'Maxim' });
  await sleep(400);
  const typedLog = await readPage(`document.getElementById('log').textContent`);
  check('the field fired real input events', typedLog === 'typed:Maxim', typedLog);

  /*
   * Replacing, not appending — and then clearing.
   *
   * QA set a field holding "OLD TEXT" to "ONLY NEW" and got "OLD TEXTONLY NEW", then set it to
   * empty and watched the old contents survive. Both are the same missing selection: the
   * modifier described a keystroke and left the browser to decide what it meant. The earlier
   * check here started from an empty field, so it could never see either.
   */
  await act({ type: 'set_value', ref: refFor('Your name'), text: 'OLD TEXT' });
  await sleep(300);
  await act({ type: 'set_value', ref: refFor('Your name'), text: 'ONLY NEW' });
  await sleep(300);
  const replaced = await readPage(`document.getElementById('name').value`);
  check('set_value replaces what a field already holds', replaced === 'ONLY NEW', String(replaced));

  await act({ type: 'set_value', ref: refFor('Your name'), text: '' });
  await sleep(300);
  const cleared = await readPage(`document.getElementById('name').value`);
  check('an empty set_value empties the field', cleared === '', JSON.stringify(cleared));

  const innerRef = refFor('Inside the frame');
  if (innerRef) await act({ type: 'click_ref', ref: innerRef });
  await sleep(500);
  const innerLog = await readPage(
    `document.getElementById('frame').contentDocument.getElementById('innerlog').textContent`
  );
  check('the iframe received a TRUSTED click', innerLog === 'inner clicked trusted=true', innerLog);

  check('the pointer overlay is drawn in the page',
    (await readPage(`Boolean(document.getElementById('__cos_pointer__'))`)) === true);

  // keypress: a key the page can name, arriving as trusted. set_value already proved the
  // input event; this proves the keyboard path, which is a different protocol call.
  await act({ type: 'click_ref', ref: refFor('Your name') });
  await act({ type: 'keypress', keys: ['Enter'] });
  await sleep(400);
  const keyLog = await readPage(`document.getElementById('klog').textContent`);
  check('a keypress arrives as a TRUSTED key event', keyLog === 'key:Enter trusted=true', keyLog);

  const dblBox = await centreOf('dbl');
  await act({ type: 'double_click', x: dblBox.x, y: dblBox.y });
  await sleep(400);
  const dblLog = await readPage(`document.getElementById('dlog').textContent`);
  check('double_click produces a real dblclick', dblLog === 'dblclick trusted=true', dblLog);

  // A drag has to be press, move-while-held, release — in that order. Endpoints alone would
  // pass a naive check while dragging nothing.
  const box = await centreOf('pad');
  await act({
    type: 'drag',
    path: [
      { x: box.left + 15, y: box.top + 15 },
      { x: box.left + Math.round(box.w / 2), y: box.top + Math.round(box.h / 2) },
      { x: box.left + box.w - 15, y: box.top + box.h - 15 }
    ]
  });
  await sleep(600);
  const dragLog = await readPage(`document.getElementById('draglog').textContent`);
  check('a drag presses, moves while held, then releases',
    dragLog === 'down:true move:true up:true', dragLog);

  /*
   * Scroll direction, judged by where the page ended up.
   *
   * This check used to swallow the error and, when the page's wheel listener had not fired, print
   * a SKIP blaming headless — leaving the tally green. A run on a Mac with a visible browser
   * proved that wrong twice over: it still skipped, and underneath it a BROWSER_TIMEOUT was being
   * caught and discarded. A check that turns a hard failure into "not judgeable" and keeps the
   * total green is worse than no check, because it manufactures confidence.
   *
   * So the error is not swallowed, and the judgement is the scroll position: a positive scroll_y
   * must leave the page further down than it started. The sign is the part worth guarding — the
   * driver once negated both deltas and scrolled every page backwards, and nothing noticed.
   */
  // Bring the fixture to the front first. Opening the extension popup earlier made it the active
  // tab, so the page under test sat in the background — and a background tab is given no frames,
  // which is why this printed a skip even on a machine with a screen. Measured on a Mac:
  // visibilityState was "hidden" while the browser window was plainly in front, and activating the
  // tab made the same scroll move the page 300 pixels immediately.
  await fetch(`http://127.0.0.1:${port}/json/activate/${pageTarget.id}`, { method: 'PUT' }).catch(() => {});
  await sleep(400);
  const before = Number(await readPage(`document.scrollingElement.scrollTop`));
  const scrolled = await run(`(async () => {
    try {
      await globalThis.__driver.browserDriver.act({ type: 'scroll', x: 400, y: 300, scroll_y: 300 });
      return 'ok';
    } catch (error) { return (error.code || '') + ': ' + error.message; }
  })()`);
  await sleep(700);
  const after = Number(await readPage(`document.scrollingElement.scrollTop`));
  const wheelLog = String(await readPage(`document.getElementById('wheellog').textContent`));
  // Two different facts, and only one of them is judgeable everywhere. That the page was told, in
  // the right direction, is delivery — this machine can decide it. That the page then moved is
  // compositing, and a build machine drives no frames, so it cannot. Splitting them is what stops
  // this check from either failing forever on a build machine or, as it did before, printing a
  // green SKIP over a swallowed BROWSER_TIMEOUT.
  const wheelArrived = /trusted=true/.test(wheelLog) && /deltaY=[1-9]/.test(wheelLog);
  if (after > before) {
    check('a positive scroll_y moves the page down', true, `before=${before} after=${after}`);
  } else if (wheelArrived) {
    console.log(
      `SKIP  the page moving — a trusted wheel arrived going down (${wheelLog}) but nothing ` +
        `composited it (scrollTop ${before}→${after}). Only a machine with a screen can judge this.`
    );
  } else {
    check('a positive scroll_y moves the page down', false,
      `before=${before} after=${after} wheel=${wheelLog} act=${scrolled.value ?? scrolled.error}`);
  }
  // Separately: the page is told about it as a real wheel, which is what a site's own handlers
  // need. Reported rather than asserted exactly — a gesture arrives as several events, so no one
  // number is the total.
  check('the page sees a trusted wheel event going down',
    /trusted=true/.test(wheelLog) && /deltaY=[1-9]/.test(wheelLog), wheelLog);

  // Back to the top, so the checks after this one see the page where they expect it.
  await run(`(async () => {
    try { await globalThis.__driver.browserDriver.act({ type: 'scroll', x: 400, y: 300, scroll_y: -600 }); } catch {}
  })()`);

  // Navigation, and the history either side of it. back must return the document that was
  // there before, not merely change the url.
  await act({ type: 'navigate', url: `http://127.0.0.1:${pagePort}/second` });
  await sleep(900);
  const secondTitle = await readPage(`document.title`);
  check('navigate loads the requested document', secondTitle === 'Second document', String(secondTitle));

  // The overlay lives in the document, and navigating replaces the document. It was drawn once
  // at attach and then only by mouse actions, so between navigating and looking there was
  // nothing to see — which is exactly the order the QA script asks for in its pointer check:
  // navigate, observe, is the pointer there.
  check('the pointer overlay survives a navigation',
    (await readPage(`Boolean(document.getElementById('__cos_pointer__'))`)) === true);

  // The driver attached while the fixture root was open, so anything still reporting that root
  // is answering with where the run began. The address and title were captured once at attach
  // and never updated, and status is exactly what a caller uses to confirm where it is — a
  // stale answer there does not read as missing information, it reads as confirmation.
  const afterNavigate = await run(
    `(async () => JSON.stringify(await globalThis.__driver.browserDriver.status()))()`
  );
  check('status reports the page the driver is on now, not the one it started on',
    String(afterNavigate.value ?? '').includes('/second'),
    afterNavigate.value ?? afterNavigate.error);

  await act({ type: 'back' });
  await sleep(900);
  const backTitle = await readPage(`document.title`);
  check('back returns the previous document', backTitle === 'Driver fixture', String(backTitle));

  await act({ type: 'forward' });
  await sleep(900);
  const forwardTitle = await readPage(`document.title`);
  check('forward goes onward again', forwardTitle === 'Second document', String(forwardTitle));

  await act({ type: 'back' });
  await sleep(900);
  await act({ type: 'reload' });
  await sleep(900);
  const reloadedTitle = await readPage(`document.title`);
  check('reload keeps the same document', reloadedTitle === 'Driver fixture', String(reloadedTitle));

  const refused = await run(`(async () => {
    try { await globalThis.__driver.browserDriver.act({ type: 'click_ref', ref: 'e999' }); return 'NOT REFUSED'; }
    catch (e) { return (e.code || '') + ': ' + e.message; }
  })()`);
  check('an unknown ref is refused rather than guessed',
    String(refused.value ?? '').startsWith('BROWSER_BAD_REF'), refused.value ?? refused.error);

  // Through the worker, the way the tool reaches it — the driver's own method is checked below,
  // but a model can only call detach if the message that carries it works. QA had to click the
  // extension popup with desktop automation because this route was not offered at all.
  const workerDetach = await run(`(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'browser_detach' });
    return JSON.stringify(reply);
  })()`);
  check('the worker can be told to let go of the tab',
    String(workerDetach.value ?? '').includes('"attached":false'),
    workerDetach.value ?? workerDetach.error);

  const detached = await run(`(async () => JSON.stringify(await globalThis.__driver.browserDriver.detach()))()`);
  check('detach gives the tab back',
    String(detached.value ?? '').includes('"attached":false'), detached.value ?? detached.error);
  check('detach removes the overlay',
    (await readPage(`Boolean(document.getElementById('__cos_pointer__'))`)) === false);

  // The group is the visible answer to "is this tab being driven" — a blue band above the tab,
  // labelled with the app's name. It was created on attach and never removed, so every session
  // left one behind: a tab still advertising that something drives it when nothing does. An
  // indicator that exists to be trusted is the worst one to leave lying.
  const grouping = await run(`(async () => {
    const driver = globalThis.__driver.browserDriver;
    await driver.act({ type: 'navigate', url: 'http://127.0.0.1:${pagePort}/' });
    const held = await driver.status();
    const during = (await chrome.tabs.get(held.tabId)).groupId;
    const reported = held.groupId;
    await driver.detach();
    const after = (await chrome.tabs.get(held.tabId)).groupId;
    return JSON.stringify({ during, reported, after });
  })()`);
  const bands = (() => {
    try { return JSON.parse(String(grouping.value ?? '{}')); } catch { return {}; }
  })();
  check('letting go of a tab takes it back out of the driven group',
    Number.isInteger(bands.during) && bands.during !== -1 && bands.after === -1,
    grouping.value ?? grouping.error);
  // And status says which group, so the claim the band makes can be checked by whoever is driving
  // rather than only by a person looking at the tab strip.
  check('status reports the group the driven tab is in',
    bands.reported === bands.during, grouping.value ?? grouping.error);

  // The refusal list guards attach and navigate. A click is the third way a driven tab can
  // change page, and it went through neither: click a link and the tab lands wherever the link
  // points, with the debugger session still on it. The list exists so the driver can never
  // reach ChatGPT's own tabs — "refused at the lowest level rather than anywhere it could later
  // be forgotten" — and a link is exactly where it was forgotten. about:blank stands in for a
  // refused destination here because it needs no network.
  const wandered = await run(`(async () => {
    const driver = globalThis.__driver.browserDriver;
    await driver.act({ type: 'navigate', url: 'http://127.0.0.1:${pagePort}/' });
    const view = await driver.observe();
    const link = (view.elements || []).find((element) => (element.name || '').includes('refused'));
    if (!link) return JSON.stringify({ error: 'no refused link in the observation' });
    await driver.act({ type: 'click_ref', ref: link.ref });
    await new Promise((resolve) => setTimeout(resolve, 900));
    let refusal = 'NOT REFUSED';
    try {
      await driver.act({ type: 'type', text: 'this must not reach a refused page' });
    } catch (error) {
      refusal = (error.code || '') + ': ' + error.message;
    }
    const status = await driver.status();
    return JSON.stringify({ refusal, attached: status.attached, url: status.url });
  })()`);
  const landed = (() => {
    try { return JSON.parse(String(wandered.value ?? '{}')); } catch { return {}; }
  })();
  check('a driven tab that lands on a refused page is let go of',
    String(landed.refusal ?? '').startsWith('BROWSER_URL_REFUSED') && landed.attached === false,
    wandered.value ?? wandered.error);

  // An address the extension cannot read must be refused, not allowed. `tab.url` is undefined
  // for every tab the extension has no access to, and the refusal list is written against that
  // field, so allowing an unknown value switches the list off exactly where it cannot be
  // checked — including for the ChatGPT tabs it exists to protect.
  const unreadable = await run(`(async () => JSON.stringify([
    globalThis.__driver.refusedUrl(undefined),
    globalThis.__driver.refusedUrl(''),
    globalThis.__driver.refusedUrl('https://example.com/')
  ]))()`);
  check('an address that cannot be read is refused',
    unreadable.value === '[true,true,false]', unreadable.value ?? unreadable.error);

  // The dead end QA walked into twice. With no ordinary page open the driver said "open the
  // page first" and offered no action that opens one, so ten checks were reported as not
  // performable against a capability that worked. navigate carries its own address, so it is
  // the one action that can start from nothing. Proven the only way that means anything: by
  // closing every ordinary tab first and then asking.
  //
  // This runs last because it closes the fixture page the checks above are driving.
  const fromNothing = await run(`(async () => {
    const closed = [];
    for (const tab of await chrome.tabs.query({})) {
      if (/^chrome(-extension)?:/i.test(tab.url || '')) continue;
      closed.push(tab.id);
      await chrome.tabs.remove(tab.id);
    }
    const before = await globalThis.__driver.browserDriver.status();
    await globalThis.__driver.browserDriver.act({
      type: 'navigate',
      url: 'http://127.0.0.1:${pagePort}/second'
    });
    const after = await globalThis.__driver.browserDriver.status();
    return JSON.stringify({
      closed,
      before: before.attached,
      after: after.attached,
      tabId: after.tabId,
      url: after.url
    });
  })()`);
  const opened = (() => {
    try { return JSON.parse(String(fromNothing.value ?? '{}')); } catch { return {}; }
  })();
  check('navigate opens a page when the browser has none open',
    opened.before === false && opened.after === true &&
      // A tab it opened, not one it found: every tab that existed was closed above, and the
      // one being driven must not be among them. Without this the check would pass on a
      // leftover tab and prove nothing about the path it exists to prove.
      Array.isArray(opened.closed) && opened.closed.length > 0 &&
      !opened.closed.includes(opened.tabId) &&
      String(opened.url ?? '').includes('/second'),
    fromNothing.value ?? fromNothing.error);
} catch (error) {
  check('the run completed', false, String(error?.message ?? error));
} finally {
  popup?.close();
  pageCdp?.close();
  browser.kill();
  server.close();
  // Best effort: the browser does not release its profile the instant it is killed, and a
  // leftover temp directory is not a reason to fail a run whose checks all passed.
  await sleep(500);
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`(left ${workspace} behind; the browser still had it open)`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
