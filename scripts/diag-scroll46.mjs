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
import { writeFileSync as _wfs } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPNG } from './lib/read-png.mjs';

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
<!-- Reveals itself only under the pointer, and only for a real mouseover: a hover that is not
     delivered leaves this reading "no hover", which a click could never distinguish. -->
<button id="hovertarget" aria-label="Hover me">Hover me</button>
<!-- A real checkbox and a text field side by side: the collector must report a checked state for
     the first and none for the second. The checked property is a boolean on every input, so the
     naive reading gave the text field one too. (No backticks in here: this page is a template
     literal, and a backtick ends it.) -->
<input id="agree" type="checkbox" aria-label="Agree to terms">
<div id="hoverlog">no hover</div>
<iframe id="frame" src="/frame" style="width:320px;height:80px;border:1px solid #ccc"></iframe>
<!-- A small horizontally-scrollable strip, absolutely positioned so it costs the rest of the
     fixture no layout shift and sits well clear of the (400,300) point the page-scroll checks
     use. Its own content is wider than its box, so scrolling it is a real, judgeable movement. -->
<div id="wide" style="position:absolute;left:16px;top:460px;width:200px;height:40px;overflow-x:auto;white-space:nowrap;border:1px solid #999">
  <span style="display:inline-block;width:700px;padding:0 8px">a strip of content much wider than its own box</span>
</div>

<!-- DIAGNOSE-FIXTURE: dicht gepackt, wie eine erzeugte QA-Seite. Der Streifen ist das echte
     Ziel; darum herum steht alles, was einen Punkt-Treffertest auf das Falsche fuehren kann. -->
<div id="panel" style="position:absolute;left:16px;top:600px;width:520px;height:300px;border:2px solid #444;padding:6px;font:12px monospace">
  <pre id="statuslog" style="margin:0;height:52px;width:500px;overflow:auto;background:#eee">status: idle
line two of the log
line three of the log
line four, wider than the box by a good margin indeed and then some more</pre>
  <textarea id="notes" style="margin-top:4px;width:500px;height:46px">notes field, default overflow auto</textarea>
  <div id="strip" style="margin-top:4px;width:500px;height:44px;overflow-x:auto;white-space:nowrap;border:1px solid #999">
    <span style="display:inline-block;width:1800px;padding:0 8px">STRIP-CONTENT wider than its own box, by a lot, so scrolling it is real movement</span>
  </div>
  <div id="hoverbait" style="position:absolute;left:430px;top:150px;width:80px;height:60px;background:rgba(255,0,0,0.15);border:1px solid red"></div>
  <div id="baitlog" style="font:11px monospace">bait: untouched</div>
  <a id="blank" href="/second" target="_blank" aria-label="Open in a new tab">Open in a new tab</a>
</div>
<script>
document.getElementById('hoverbait').addEventListener('mouseover', () => {
  document.getElementById('baitlog').textContent = 'bait: hovered';
  document.getElementById('hoverbait').style.height = '120px';
});
document.getElementById('strip').addEventListener('scroll', () => {
  document.getElementById('statuslog').textContent =
    'strip scrollLeft=' + Math.round(document.getElementById('strip').scrollLeft);
});
</script>
<!-- Last, so the page can scroll without pushing anything above it out of the viewport. -->
<div id="tall" style="height:3000px">room to scroll</div>
<!-- A band at a known place in the document, so a screenshot of a scrolled page can be judged by
     its pixels instead of by a scroll counter. Well below the fold and transparent to the pointer,
     so no other check can see it. -->
<div id="band" style="position:absolute;left:0;top:1400px;width:100%;height:300px;background:#0060ff;pointer-events:none"></div>
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
document.getElementById('hovertarget').addEventListener('mouseover', (e) => {
  document.getElementById('hoverlog').textContent = 'hovered trusted=' + e.isTrusted;
});
document.getElementById('hovertarget').addEventListener('click', () => {
  document.getElementById('hoverlog').textContent = 'clicked, which a hover must not do';
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
    /** Any CDP method, so a check can report what the browser actually answered. */
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const message = { id: ++id, method, params };
        const timer = setTimeout(() => {
          waiting.delete(message.id);
          resolve({ error: `${method} timed out` });
        }, 30_000);
        waiting.set(message.id, (frame) => {
          clearTimeout(timer);
          resolve(frame.error ? { error: JSON.stringify(frame.error) } : (frame.result ?? {}));
        });
        socket.send(JSON.stringify(message));
      }),
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

  // A stale extension answered a whole QA round once, and its report read as three broken fixes
  // rather than one unreloaded browser. The stamp is a digest of the running driver source, so a
  // run can say which code it measured. It has to be present and it has to be a digest, not the
  // word the catch clause falls back to.
  const stamped = JSON.parse(attached.value ?? '{}');
  check('status names the driver that answered',
    /^[0-9a-f]{12}$/.test(String(stamped.build ?? '')), JSON.stringify({ build: stamped.build ?? null }));

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
          data: o.screenshot?.data ?? null,
          elements: o.elements.map((e) => ({ ref: e.ref, name: e.name, checked: e.checked, value: e.value }))
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
  const checkable = (view.elements ?? []).find((e) => e.name === 'Agree to terms');
  const textField = (view.elements ?? []).find((e) => e.name === 'Your name');
  check('a checkbox reports whether it is ticked',
    checkable?.checked === 'false', JSON.stringify(checkable ?? null));
  check('a text field reports no checked state at all',
    textField !== undefined && !textField.checked, JSON.stringify(textField ?? null));
  check('omits what a pointer cannot reach', !names.includes('Never'), names.join(' | '));
  /*
   * Decoded, not taken on trust. This compared the driver's reported width against the viewport
   * width — and the driver reported the width it had *asked* for, so the two were the same number
   * from the same source and the check could not fail. Underneath it, on every Retina display, the
   * image was coming back at twice that: a clip's scale multiplies the display's scale factor
   * rather than replacing it. A Mac run measured 2400x1630 while this printed 1200x815 and passed.
   */
  if (!view.shot || !view.data) {
    check('one screenshot pixel is one CSS pixel', false, JSON.stringify({ shot: view.shot }));
  } else {
    const firstShot = path.join(profile, 'first-observe.png');
    writeFileSync(firstShot, Buffer.from(view.data, 'base64'));
    const decoded = readPNG(firstShot);
    check('one screenshot pixel is one CSS pixel',
      decoded.width === view.viewport?.width && decoded.height === view.viewport?.height,
      JSON.stringify({ png: { w: decoded.width, h: decoded.height }, reported: view.shot, viewport: view.viewport }));
  }

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


  // ============ Sichtbarkeit als Bedingung, dann die Streifen ============
  const activate = async (targetId) => {
    await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`, { method: 'PUT' }).catch(() => {});
    await sleep(400);
  };
  const visibility = async () => String(await readPage(`document.visibilityState`));

  const poll = async (id, label, pt, sx, seconds = 6) => {
    const t0 = Date.now();
    const readNow = async () => Number(await readPage(`document.getElementById('${id}').scrollLeft`));
    const before = await readNow();
    const vis = await visibility();
    const replyP = run(`(async () => {
      const t = Date.now();
      try { const r = await globalThis.__driver.browserDriver.act(
        { type: 'scroll', x: ${pt.x}, y: ${pt.y}, scroll_x: ${sx}, scroll_y: 0 });
        return JSON.stringify({ ms: Date.now()-t, ...r }); }
      catch (e) { return JSON.stringify({ ms: Date.now()-t, error: (e.code||'')+': '+e.message,
        beforeDebug: e.beforeDebug ?? null, afterDebug: e.afterDebug ?? null }); }
    })()`);
    const samples = []; let done = false, firstMove = null;
    replyP.then(() => { done = true; });
    while (!done || Date.now() - t0 < seconds * 1000) {
      const v = await readNow();
      samples.push(`${Date.now()-t0}:${v}`);
      if (firstMove === null && v !== before) firstMove = Date.now() - t0;
      if (Date.now() - t0 > (seconds + 6) * 1000) break;
      await sleep(150);
    }
    const p = JSON.parse(String((await replyP).value ?? '{}'));
    const finalValue = await readNow();
    const dbg = p.beforeDebug ?? p.afterDebug;
    console.log(`\n### ${label}   #${id}, Punkt ${pt.x},${pt.y}, visibilityState=${vis}`);
    console.log(`  Aufruf ${p.ms} ms | Antwort moved=${p.moved} acknowledged=${p.acknowledged}${p.error ? ' | ' + p.error.split('.')[0] : ''}`);
    console.log(`  ${id}.scrollLeft ${before} -> ${finalValue};  erste Bewegung: ${firstMove === null ? 'keine' : firstMove + ' ms'}`);
    console.log(`  getroffen: ${dbg ? (dbg.matched ? dbg.matched.tag + '#' + dbg.matched.id + ' canX=' + dbg.matched.canX + ' scrollWidth=' + dbg.matched.scrollWidth + '/' + dbg.matched.clientWidth + ' overflowX=' + dbg.matched.overflowX : 'KEINES -> Fallback auf window') : '(kein _debug)'}`);
    if (dbg) console.log(`  _debug (voll): ${JSON.stringify(dbg)}`);
    console.log(`  Verlauf: ${samples.filter((_, i) => i % 4 === 0).join(' ')}`);
    check(`${label}`, (finalValue > before) === (p.moved === true),
      `${before} -> ${finalValue}, gemeldet moved=${p.moved}, visibilityState=${vis}`);
    return { before, finalValue, p, firstMove, vis };
  };

  const strip = await centreOf('strip');
  const wide = await centreOf('wide');
  console.log(`Streifen (gedraengt): ${JSON.stringify(strip)}`);
  console.log(`#wide (Original):     ${JSON.stringify(wide)}`);

  console.log('\n===== 1. Tab im HINTERGRUND (der Popup-Tab ist vorn) =====');
  await poll('strip', 'H1) gedraengter Streifen, Tab im Hintergrund', { x: strip.x, y: strip.y }, 150);

  console.log('\n===== 2. Tab im VORDERGRUND =====');
  await activate(pageTarget.id);
  console.log(`  visibilityState jetzt: ${await visibility()}`);
  await poll('strip', 'V1) gedraengter Streifen, Tab im Vordergrund', { x: strip.x, y: strip.y }, 150);
  await poll('wide',  'V2) Original-#wide, Tab im Vordergrund',       { x: wide.x, y: wide.y }, 150);

  console.log('\n===== 3. Danebengezielt, Tab im Vordergrund =====');
  const notes = await centreOf('notes');
  const slog  = await centreOf('statuslog');
  const bait  = await centreOf('hoverbait');
  console.log(`  notes=${JSON.stringify(notes)} statuslog=${JSON.stringify(slog)} hoverbait=${JSON.stringify(bait)}`);
  await poll('strip', 'V3) auf das textarea gezielt',        { x: notes.x, y: notes.y }, 150);
  await poll('statuslog', 'V4) auf das Protokoll-<pre> gezielt', { x: slog.x, y: slog.y }, 150);
  await poll('strip', 'V5) auf das Hover-Overlay gezielt',    { x: bait.x, y: bait.y }, 150);
  await poll('strip', 'V6) Streifen unter dem Overlay',       { x: strip.left + strip.w - 20, y: strip.y }, 150);

  const shotFile = process.env.COS_DIAG_SHOT;
  if (shotFile) {
    const shot = await run(`(async () => {
      try { const o = await globalThis.__driver.browserDriver.observe({ includeScreenshot: true });
        return JSON.stringify({ data: o.screenshot?.data ?? null }); }
      catch (e) { return JSON.stringify({ error: String(e.message) }); }
    })()`);
    const q = JSON.parse(String(shot.value ?? '{}'));
    if (q.data) { _wfs(shotFile, Buffer.from(q.data, 'base64')); console.log(`\nBildschirmfoto: ${shotFile}`); }
    else console.log(`\nkein Bildschirmfoto: ${q.error}`);
  }

  // ============ Pruefung 45 ============
  console.log('\n===== Pruefung 45: _blank-Klick, fuenfmal, mit vollstaendiger Tab-Liste =====');
  const view2 = JSON.parse(String((await run(`(async () => JSON.stringify(
    await globalThis.__driver.browserDriver.observe({})))()`)).value ?? '{}'));
  const blankRef = (view2.elements ?? []).find((e) => e.name === 'Open in a new tab')?.ref;
  const tabState = async () => JSON.parse(String((await run(`(async () => {
    const me = (await globalThis.__driver.browserDriver.status()).tabId;
    const tabs = await chrome.tabs.query({});
    return JSON.stringify({ me, tabs: tabs.map((t) => ({ id: t.id, opener: t.openerTabId ?? null,
      active: t.active, url: (t.url || t.pendingUrl || '').slice(-28) })) });
  })()`)).value ?? '{}'));
  const first = await tabState();
  console.log(`  getriebener Tab (status().tabId): ${first.me}`);
  console.log(`  Tabs vor dem ersten Klick:`);
  for (const t of first.tabs) console.log(`    id=${t.id} opener=${t.opener} active=${t.active} url=…${t.url}`);
  const blankRuns = async (label, n) => {
   let seen = 0;
   console.log(`\n  --- ${label} ---`);
   for (let i = 1; i <= n; i++) {
    const pre = await tabState();
    const r = await run(`(async () => {
      try { return JSON.stringify(await globalThis.__driver.browserDriver.act(
        { type: 'click_ref', ref: ${JSON.stringify(blankRef)} })); }
      catch (e) { return JSON.stringify({ error: (e.code||'')+': '+e.message }); }
    })()`);
    const q = JSON.parse(String(r.value ?? '{}'));
    await sleep(1200);
    const post = await tabState();
    const opened = post.tabs.filter((x) => !pre.tabs.some((y) => y.id === x.id));
    if (q.createdTab) seen++;
    console.log(`  Lauf ${i}: createdTab=${q.createdTab ? 'JA ' + JSON.stringify(q.createdTab) : 'nein'}` +
      ` | hit=${q.hit ?? '-'} | Tabs ${pre.tabs.length}->${post.tabs.length}` +
      ` | neu: ${opened.map((x) => `id=${x.id} opener=${x.opener}`).join(', ') || 'keiner'}` +
      ` | getrieben=${post.me}`);
    for (const x of opened) await run(`(async () => { try { await chrome.tabs.remove(${x.id}); } catch {} })()`);
    await sleep(400);
   }
   console.log(`  -> ${label}: createdTab in ${seen} von ${n} Laeufen`);
   return seen;
  };
  await activate(pageTarget.id);
  const fg = await blankRuns('Tab im VORDERGRUND', 5);
  await fetch(`http://127.0.0.1:${port}/json/activate/${popupTarget.id}`, { method: 'PUT' }).catch(() => {});
  await sleep(500);
  console.log(`  visibilityState der Seite jetzt: ${await visibility()}`);
  const bg = await blankRuns('Tab im HINTERGRUND', 5);
  console.log(`\n  ZUSAMMEN: Vordergrund ${fg}/5, Hintergrund ${bg}/5`);
  check('createdTab im Vordergrund bei allen fuenf', fg === 5, `${fg}/5`);
  check('createdTab im Hintergrund bei allen fuenf', bg === 5, `${bg}/5`);

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
