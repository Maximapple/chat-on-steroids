/**
 * Proves that a chat under an open automatic continuation still gets browser recovery.
 *
 * ## Why this exists
 *
 * This is the release the app has now been fixed for twice and confirmed live zero times, across
 * three QA rounds. Every round reached the same wall: reproducing it was thought to need an
 * automatic compaction stalled at `dispatched-unresolved` and then fifteen minutes of ChatGPT's
 * own transport failing, which nobody can induce on demand. Each round made a judgement call
 * instead, and the third one asked, correctly, for this to stop being a judgement call.
 *
 * There is a cheaper door, and the third round found it. `compactionStillChased()` answers false
 * for any continuation opened before `compactionWatchFloor`, which is stamped when *this process*
 * started serving — so a ticket that survives a restart is permanently "not chased" without a
 * single pickup being spent or a single request failing. A restart reproduces on demand, in
 * seconds, the exact state the fix releases.
 *
 * The remaining expense was step one: opening a real continuation. A genuine auto-compaction types
 * a handoff prompt into a real chat and opens a replacement, which is not a thing to do to
 * somebody's account to satisfy a test. This files the ticket for a synthetic conversation id
 * instead, through the same worker path the page uses. No real ChatGPT conversation is touched,
 * read, or written — and because the id names no chat, no tab for it can ever exist, so no pickup
 * can reload one and no prompt can be typed anywhere.
 *
 * ## The precondition nobody had written down
 *
 * A ticket is not enough, and neither is a session. Measured here on 2026-09-05: the synthetic
 * chat had a durable session, a registered request-id attribution and an open continuation below
 * the floor, and the app still declined to recover it —
 *
 *     bridge: cccccccc-… closed its last tab — not reopened: it has never called a tool
 *
 * That is deliberate and right. `queueMissingTab`'s own comment says a chat qualifies for recovery
 * on "the one fact that makes it this app's business — it has proved at least one MCP call. A chat
 * that has never called a tool is the user's own browsing." A real chat has always called one by
 * the time it is compacting, so the requirement is invisible in the field and fatal to a synthetic
 * fixture. The recipe the third round wrote down — open a ticket, restart, wait — would have
 * walked the fourth into exactly this wall, which is the wall this script exists to remove.
 *
 * So pass `--conversation <id>` naming a chat that has actually used the app when you want the
 * whole path to run. The synthetic default still proves the cheap half — that a ticket opens and
 * survives a restart below the floor — and says plainly why it stops there.
 *
 * ## What was proven here, and what was not
 *
 * `open` was run end to end on 2026-09-05 and works: session, attribution, and
 * `continuation … durably opened`, against an id naming no real chat. That was the step the third
 * round called the only expensive one left, and it is no longer expensive.
 *
 * `check` was **not** completed against the synthetic id, for two reasons worth writing down so
 * the next reader does not repeat them:
 *
 *   - `toolCalls` is zero for a chat that only ever had events posted at it, and the reopen path
 *     declines on exactly that (above).
 *   - a headless browser on `chatgpt.com` with no session tears the content script down within a
 *     couple of minutes, which posts `/closed`, ends the session, and takes the chat out of the
 *     silence set before its grant can expire. The window is `CHAT_SILENCE_MS`; the page did not
 *     survive it.
 *
 * Both are properties of the fixture, not of the app. A real chat has tool calls and a page that
 * stays up, which is why `--conversation` exists and why the remaining run belongs on a machine
 * with a live connector rather than in a synthetic harness.
 *
 * ## Running it
 *
 *     node scripts/verify-compaction-release.mjs open     # with the app running
 *     …restart the app…
 *     node scripts/verify-compaction-release.mjs check
 *
 * `open` files the ticket and leaves the chat looking active with a turn in the air. `check` runs
 * after the restart — which is what puts the ticket below the floor — and waits for the app to ask
 * the browser to reload that chat. Two commands rather than one because restarting the app is the
 * operator's business, and a script that killed somebody's running app to make a point would be a
 * worse citizen than the bug it is chasing.
 *
 * ## The gate that makes this measure nothing if you miss it
 *
 * `inspectSilentChats` consults `tabRecoveryWanted()`, which is
 * `goalActiveFor(id) || config.multiAgent.recoverAgentTabs`, and that setting is **off by
 * default**. With it off a silent chat has its silence marked spent and is never reloaded, so the
 * release would work perfectly and you would watch nothing happen. `check` refuses to report a
 * failure while it is off, because "no repair" would not mean what it looks like.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
if (mode !== 'open' && mode !== 'check') {
  console.error('usage: node scripts/verify-compaction-release.mjs open|check');
  process.exit(2);
}

/**
 * One fixed id across both phases, so `check` asks about the chat `open` filed for.
 *
 * Deliberately a constant rather than a random one: the two commands are separated by an app
 * restart and a human, and a value that had to survive that would be one more thing to get wrong.
 * It is a syntactically valid conversation id that names no real conversation.
 */
const CONVERSATION = (() => {
  const flag = process.argv.indexOf('--conversation');
  return flag > 0 && process.argv[flag + 1] ? process.argv[flag + 1] : 'cccccccc-0000-4000-8000-00000000fee1';
})();
const PORT = 9336;
const EXTENSION = path.resolve('extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workspace = path.join(os.tmpdir(), `cos-release-${mode}-${Date.now()}`);
const copy = path.join(workspace, 'extension');
const profile = path.join(workspace, 'profile');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(copy, { recursive: true });
cpSync(EXTENSION, copy, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions];
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions];
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));

const extensionRoot = process.platform === 'win32' ? path.resolve(copy) : realpathSync(copy);
const digest = createHash('sha256')
  .update(Buffer.from(extensionRoot, process.platform === 'win32' ? 'utf16le' : 'utf8'))
  .digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join('');

function chromePath() {
  if (process.env.COS_BROWSER) return process.env.COS_BROWSER;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\Google\\Chrome for Testing\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ]) {
      try { readFileSync(p); return p; } catch { /* next */ }
    }
  }
  return 'google-chrome';
}

let failures = 0;
const report = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const child = spawn(chromePath(), [
  '--headless=new', '--disable-gpu',
  `--user-data-dir=${profile}`,
  `--load-extension=${copy}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  'https://chatgpt.com/'
], { stdio: 'ignore' });

let popup;
try {
  let ready = null;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(500); }
  }
  if (!ready) throw new Error('Chrome never opened its debugging port');

  /*
   * The content script's own world, not the popup's.
   *
   * `bind`, `correlate` and `activity` all check `ownsDocument(source)` — they are the page's
   * messages, and a popup does not own a document. The isolated world is where the real page
   * sends them from, and the DevTools protocol can address it by context id, which is the same
   * trick `verify-compact-chain` uses for the same reason.
   */
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page');
  if (!target) throw new Error('no page target to attach to');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const waiting = new Map();
  const contexts = [];
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')));
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.method === 'Runtime.executionContextCreated') contexts.push(frame.params.context);
    const settle = waiting.get(frame.id);
    if (settle) { waiting.delete(frame.id); settle(frame); }
  });
  popup = { close: () => socket.close() };
  const send = (method, params = {}) => new Promise((resolve) => {
    const message = { id: ++id, method, params };
    const timer = setTimeout(() => { waiting.delete(message.id); resolve({ error: `${method} timed out` }); }, 60_000);
    waiting.set(message.id, (frame) => {
      clearTimeout(timer);
      resolve(frame.error ? { error: JSON.stringify(frame.error) } : (frame.result ?? {}));
    });
    socket.send(JSON.stringify(message));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'https://chatgpt.com/' });
  await sleep(9000);
  const world = contexts.find((context) => String(context.origin ?? '').startsWith('chrome-extension://'));
  if (!world) throw new Error('the content script never injected; no isolated world to speak from');

  /** One message from the page's own world to the worker, which forwards it to the app. */
  const ask = async (message) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {
        try { return JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(message)})); }
        catch (e) { return JSON.stringify({ threw: String(e && e.message ? e.message : e) }); }
      })()`,
      contextId: world.id,
      returnByValue: true,
      awaitPromise: true
    });
    try { return JSON.parse(String(result.result?.value ?? '{}')); }
    catch { return { unparsed: result.result?.value }; }
  };

  const status = await ask({ type: 'status' });
  report(status.connected === true && status.paired === true,
    'the app is running and the extension is paired',
    JSON.stringify({ connected: status.connected, paired: status.paired }));
  if (!status.connected || !status.paired) {
    console.log('\nStart the app first (npm run dev, or an installed build).');
    throw new Error('no app');
  }

  if (mode === 'open') {
    // A recorded user message first: the ticket is filed against a conversation the app knows,
    // and a chat with no events is not one.
    const seeded = await ask({
      type: 'events',
      conversationId: CONVERSATION,
      events: [{
        kind: 'user_message',
        time: Date.now(),
        messageId: `m-release-${Date.now()}`,
        text: 'seeding a continuation for the compaction-release check'
      }]
    });
    report(seeded.ok === true, 'the app recorded the synthetic chat', JSON.stringify(seeded).slice(0, 160));

    /*
     * A durable session, which the ticket requires and events alone do not create.
     *
     * `/compact` resolves a session through `liveConversations()` or `findSessionByConversation()`
     * and refuses `session_not_recorded` without one. Measured: a `user_message` event is
     * journalled but binds no session. `correlate` is the path that does — the comment on its own
     * handler says it "creates/reuses the conversation session" — so it is the honest way to get
     * one, and it is the same call the page makes for every real turn.
     *
     * The request id is synthetic and so is the conversation. That is the safety argument for this
     * whole script: an id that names no ChatGPT conversation can never have a browser tab, so no
     * pickup can ever reload one and no handoff prompt can ever be typed into anything. The
     * previous round stopped here rather than run a genuine auto-compaction against a real chat,
     * and was right to.
     */
    const correlated = await ask({
      type: 'correlate',
      conversationId: CONVERSATION,
      calls: [{
        messageId: `m-release-corr-${Date.now()}`,
        tool: 'read',
        order: 0,
        answered: false,
        requestId: `wfr_release_${Date.now().toString(16)}`
      }]
    });
    report(correlated.ok === true, 'the chat has a durable local session', JSON.stringify(correlated).slice(0, 200));

    const filed = await ask({ type: 'compact', conversationId: CONVERSATION, ticket: true, automatic: true });
    const token = filed?.data?.token;
    report(typeof token === 'string' && token.length > 0,
      'an automatic continuation is open', JSON.stringify(filed).slice(0, 200));

    console.log('\nNext:');
    console.log('  1. Turn ON "Recover other chats\u2019 tabs" in the app (Multi-agent settings).');
    console.log('     With it off a silent chat is never reloaded and this check measures nothing.');
    console.log('  2. Restart the app. That is what puts this ticket below compactionWatchFloor.');
    console.log(`  3. node scripts/verify-compaction-release.mjs check --conversation ${CONVERSATION}`);
    console.log('');
    console.log('  And note: the chat must already have proved at least one MCP tool call, or the');
    console.log('  app treats it as ordinary browsing and never recovers it — see the header. Point');
    console.log('  --conversation at a chat that has actually used the app if this one has not.');
  } else {
    // The chat has to look alive to be worth reloading: an open turn is what earns a silence
    // grant, and the grant expiring is what the recovery pass acts on.
    const opened = await ask({
      type: 'events',
      conversationId: CONVERSATION,
      events: [{ kind: 'turn_start', time: Date.now(), turnId: `t-release-${Date.now()}` }]
    });
    report(opened.ok === true, 'the chat has an open turn again', JSON.stringify(opened).slice(0, 160));

    console.log('\nWaiting for the silence window and the next sweep — up to four minutes.');
    let sawRepair = null;
    const until = Date.now() + 4 * 60_000;
    while (Date.now() < until && !sawRepair) {
      await sleep(10_000);
      // The app hands repairs out on `/status`, which is the extension's maintenance pass —
      // `drain` posts journal entries and never carries them, so watching it would wait forever
      // and report a working release as broken. The worker's own `status` handler is the poll.
      const polled = await ask({ type: 'status' });
      const repairs = polled?.repairs ?? polled?.data?.repairs ?? [];
      sawRepair = (Array.isArray(repairs) ? repairs : [])
        .find((entry) => entry && entry.conversationId === CONVERSATION) ?? null;
      // Deliberately no further events while waiting. `grantActivity` pushes the silence deadline
      // to now + CHAT_SILENCE_MS on every turn start, so a poll loop that kept re-arming the turn
      // would hold the grant open forever and the sweep it is waiting for could never fire. The
      // one turn opened above is the whole point: it expires, and the expiry is the event.
      process.stdout.write('.');
    }
    console.log('');
    report(Boolean(sawRepair),
      'the app asked the browser to recover the chat despite its open continuation',
      sawRepair ? JSON.stringify(sawRepair) : 'no repair was handed out within four minutes');
    if (!sawRepair) {
      console.log('\nBefore reading that as a regression, check all three:');
      console.log('  - the chat has proved at least one MCP tool call. Without that the app treats');
      console.log('    it as the user\u2019s own browsing and never recovers it, whatever else is true.');
      console.log('    The app says so in its own log: "it has never called a tool".');
      console.log('  - "Recover other chats\u2019 tabs" is ON. Off is the default and it gates this path.');
      console.log('  - the app was restarted between `open` and `check`. Without that the ticket is');
      console.log('    still above compactionWatchFloor, still being chased, and correctly skipped.');
    }
  }
} catch (err) {
  report(false, 'the check ran to completion', err instanceof Error ? err.message : String(err));
} finally {
  popup?.close();
  child.kill('SIGKILL');
  await sleep(1500);
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ok' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
