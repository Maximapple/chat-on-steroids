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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Where a Chromium build usually lives, in the order worth trying. */
const BROWSERS = [
  process.env['COS_BROWSER'],
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
<div id="log">nothing yet</div>
<iframe id="frame" src="/frame" style="width:320px;height:80px;border:1px solid #ccc"></iframe>
<script>
document.getElementById('go').addEventListener('click', (e) => {
  document.getElementById('log').textContent = 'clicked trusted=' + e.isTrusted;
});
document.getElementById('name').addEventListener('input', () => {
  document.getElementById('log').textContent = 'typed:' + document.getElementById('name').value;
});
</script>`;

const FRAME = `<!doctype html><meta charset="utf-8"><title>inner</title>
<button id="inner">Inside the frame</button><span id="innerlog">idle</span>
<script>
document.getElementById('inner').addEventListener('click', (e) => {
  document.getElementById('innerlog').textContent = 'inner clicked trusted=' + e.isTrusted;
});
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/frame' ? FRAME : PAGE);
});
await new Promise((resolve) => server.listen(pagePort, '127.0.0.1', resolve));

/** Chromium's id for an unpacked extension: sha-256 of the load path, nibbles mapped a..p. */
const digest = createHash('sha256')
  .update(Buffer.from(path.resolve(copy), process.platform === 'win32' ? 'utf16le' : 'utf8'))
  .digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join('');

const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', `--user-data-dir=${profile}`,
  `--load-extension=${copy}`, `--remote-debugging-port=${port}`,
  '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
  '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${pagePort}/`
], { stdio: 'ignore' });
await sleep(6000);

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
  check('the extension loads and its popup resolves', Boolean(popupTarget), popupTarget?.url ?? '');
  check('the fixture page is open', Boolean(pageTarget), pageTarget?.url ?? '');
  if (!popupTarget || !pageTarget) throw new Error('missing targets');

  popup = await attachTarget(popupTarget.webSocketDebuggerUrl);
  pageCdp = await attachTarget(pageTarget.webSocketDebuggerUrl);
  const run = (expression) => popup.evaluate(expression);
  const readPage = async (expression) => (await pageCdp.evaluate(expression)).value;

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
  const act = (action) =>
    run(`(async () => JSON.stringify(await globalThis.__driver.browserDriver.act(${JSON.stringify(action)})))()`);

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

  const innerRef = refFor('Inside the frame');
  if (innerRef) await act({ type: 'click_ref', ref: innerRef });
  await sleep(500);
  const innerLog = await readPage(
    `document.getElementById('frame').contentDocument.getElementById('innerlog').textContent`
  );
  check('the iframe received a TRUSTED click', innerLog === 'inner clicked trusted=true', innerLog);

  check('the pointer overlay is drawn in the page',
    (await readPage(`Boolean(document.getElementById('__cos_pointer__'))`)) === true);

  const refused = await run(`(async () => {
    try { await globalThis.__driver.browserDriver.act({ type: 'click_ref', ref: 'e999' }); return 'NOT REFUSED'; }
    catch (e) { return (e.code || '') + ': ' + e.message; }
  })()`);
  check('an unknown ref is refused rather than guessed',
    String(refused.value ?? '').startsWith('BROWSER_BAD_REF'), refused.value ?? refused.error);

  const detached = await run(`(async () => JSON.stringify(await globalThis.__driver.browserDriver.detach()))()`);
  check('detach gives the tab back',
    String(detached.value ?? '').includes('"attached":false'), detached.value ?? detached.error);
  check('detach removes the overlay',
    (await readPage(`Boolean(document.getElementById('__cos_pointer__'))`)) === false);
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
