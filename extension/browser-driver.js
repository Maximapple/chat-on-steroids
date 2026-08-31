/**
 * Browser control through the DevTools protocol.
 *
 * The Desktop driver already controls a browser: it moves the real pointer and posts real
 * keystrokes at the operating-system level. What it cannot do is *see* a web page. Chromium
 * keeps its renderer accessibility tree switched off until a real assistive client asks for
 * it, so a UIA/AX walk of a browser window returns the toolbar, the tabs and one opaque pane
 * where the page is. Measured against a full traversal of a live Chromium window: sixty-three
 * elements, every one of them browser chrome, not a single node of page content.
 *
 * Inside a web page the Desktop driver is therefore reduced to pixels and guesswork, which is
 * exactly where `click_ref` and `set_value` — the two things that make this product better
 * than coordinate-poking — stop being available. This file closes that gap, and it is
 * browser-level rather than OS-level, so it works the same on every platform and on a window
 * that is not even in the foreground.
 *
 * ## Why the debugger permission
 *
 * Events a content script dispatches carry `isTrusted: false`. Real pages reject them for
 * anything that matters: file pickers, drag and drop, and any framework that guards against
 * synthetic input. A driver built that way works on simple pages and fails silently on the
 * hard ones, which is worse than not having it at all.
 *
 * `chrome.debugger` is the only route to `isTrusted: true` from an extension. It costs a
 * permanent, unmissable "…is debugging this browser" banner on every driven tab. That banner
 * is not a wart to be minimised — it is the honest signal that something other than the
 * person at the keyboard is driving. This module deliberately adds two more: driven tabs are
 * collected into a visibly named tab group, and a pointer overlay shows where the model acts.
 *
 * ## The coordinate invariant
 *
 * One rule, chosen so that a whole class of bugs cannot exist: **one screenshot pixel is one
 * CSS pixel is one input unit.** Screenshots are taken with an explicit clip at `scale: 1`
 * over the CSS visual viewport, so a coordinate read off the returned image is already the
 * coordinate `Input.dispatchMouseEvent` wants. There is no device-pixel-ratio arithmetic
 * anywhere in this file, on any display, at any zoom level.
 */

/** Tab group title. Deliberately the product name: the user must recognise it instantly. */
export const DRIVEN_GROUP_TITLE = 'Chat On Steroids';

/**
 * Pages this driver refuses to attach to, whatever it is asked.
 *
 * ChatGPT itself is first, for a reason worth stating plainly: the model asking for browser
 * control is *in* a ChatGPT tab, and a driver able to attach there could drive its own
 * conversation — send messages as the user, answer its own confirmations, or read another
 * conversation the person has open in a second tab. That is the single most dangerous thing
 * this capability could do, so it is refused at the lowest level rather than anywhere it
 * could later be forgotten.
 *
 * The browser's own surfaces are refused because a debugger session there reaches settings,
 * stored credentials and other extensions. `file:` is refused because a page that can be
 * driven should not also be a filesystem reader.
 */
export const REFUSED_URLS = [
  /^https:\/\/chatgpt\.com/i,
  /^https:\/\/chat\.openai\.com/i,
  /^chrome:/i,
  /^edge:/i,
  /^about:/i,
  /^devtools:/i,
  /^chrome-extension:/i,
  /^moz-extension:/i,
  /^view-source:/i,
  /^file:/i
];

/** How long any single protocol command may take before the driver gives up on it. */
const COMMAND_TIMEOUT_MS = 15_000;
/** Navigation gets longer, but never unbounded. */
const NAVIGATE_TIMEOUT_MS = 30_000;
/**
 * Two operations answer only once the renderer has composited, and get longer for it.
 *
 * `Page.captureScreenshot` replies when a frame is produced, and a wheel event is acknowledged
 * after the compositor's input pipeline has taken it. Neither is a fixed cost: a tab that is
 * not compositing — backgrounded, occluded, or simply idle with nothing animating — can take
 * seconds, and both were measured taking longer than ten in a real browser run. Holding them
 * to the ordinary command deadline turns "the page was quiet" into a failure, which is the
 * opposite of what the caller asked about. Clicks and keystrokes are acknowledged directly and
 * keep the ordinary deadline.
 */
const COMPOSITOR_TIMEOUT_MS = 30_000;
/** Upper bound on elements one observation returns, so a huge page cannot flood the model. */
const MAX_ELEMENTS = 200;

export class BrowserDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserDriverError';
    this.code = code;
  }
}

const fail = (code, message) => new BrowserDriverError(code, message);

export function refusedUrl(url) {
  const value = String(url || '');
  return REFUSED_URLS.some((pattern) => pattern.test(value));
}

/**
 * The one tab this driver is attached to, or null.
 *
 * Deliberately one at a time. A driver holding several debugger sessions is a driver whose
 * "stop" is ambiguous and whose banner no longer tells the user which tab is live.
 */
let session = null;

/** Promise wrapper over the callback API, turning `lastError` into a typed failure. */
function rawSend(tabId, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(fail('BROWSER_TIMEOUT', `${method} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        const error = chrome.runtime.lastError;
        if (error) return finish(reject, fail('BROWSER_PROTOCOL_FAILED', `${method}: ${error.message}`));
        finish(resolve, result ?? {});
      });
    } catch (error) {
      finish(reject, fail('BROWSER_PROTOCOL_FAILED', `${method}: ${error?.message ?? String(error)}`));
    }
  });
}

function send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!session) throw fail('BROWSER_NOT_ATTACHED', 'no tab is under browser control');
  return rawSend(session.tabId, method, params, timeoutMs);
}

/**
 * Collects a driven tab into one visibly named group.
 *
 * Purely an affordance for the person watching: the banner says *this tab* is being driven,
 * the group says *these* are the tabs this session has touched. Failure is never fatal —
 * losing the grouping must not cost the ability to stop — so it is attempted and forgotten.
 */
async function groupDrivenTab(tabId) {
  try {
    if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: DRIVEN_GROUP_TITLE, color: 'blue' });
    return groupId;
  } catch {
    return null;
  }
}

/**
 * A pointer the person can actually see.
 *
 * CDP input moves no real cursor, so without this the page reacts and nothing visibly causes
 * it — the most unnerving way to watch a machine use your browser. The overlay lives in the
 * page, so it also lands in screenshots for free and the model sees the same pointer the user
 * does. It is `pointer-events: none` and must stay that way: an overlay that can swallow a
 * click is an overlay that breaks the thing it illustrates.
 */
const POINTER_SOURCE = `(() => {
  const ID = '__cos_pointer__';
  let node = document.getElementById(ID);
  if (!node) {
    node = document.createElement('div');
    node.id = ID;
    node.setAttribute('aria-hidden', 'true');
    node.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
      'pointer-events:none', 'z-index:2147483647', 'margin:0', 'padding:0', 'border:0',
      'transition:transform 90ms linear', 'will-change:transform'
    ].join(';');
    node.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2 L4 16 L8 12.5 L10.5 18 L13 17 L10.5 11.5 L16 11.5 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(node);
  }
  return node;
})()`;

async function movePointer(x, y, pressed = false) {
  try {
    await send('Runtime.evaluate', {
      expression:
        `${POINTER_SOURCE}.style.transform = ` +
        `'translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${pressed ? 0.82 : 1})';`,
      returnByValue: true
    });
  } catch {
    // A page mid-navigation has no document to draw into. The action still stands; only its
    // illustration is missing, and that is never a reason to fail the action.
  }
}

async function removePointer() {
  try {
    await send('Runtime.evaluate', {
      expression: "document.getElementById('__cos_pointer__')?.remove();",
      returnByValue: true
    });
  } catch {
    // Detaching anyway, and the overlay dies with the next navigation regardless.
  }
}

/** The CSS visual viewport, which is the coordinate space every action in this file uses. */
async function viewport() {
  const metrics = await send('Page.getLayoutMetrics');
  const visual = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
  const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const width = Math.max(1, Math.round(visual.clientWidth ?? layout.clientWidth ?? 0));
  const height = Math.max(1, Math.round(visual.clientHeight ?? layout.clientHeight ?? 0));
  return { width, height };
}

/** CDP's mouse-button vocabulary, from the one this product uses everywhere else. */
export function cdpButton(name) {
  switch (String(name || 'left').toLowerCase()) {
    case 'right': return 'right';
    case 'middle': case 'wheel': return 'middle';
    case 'back': return 'back';
    case 'forward': return 'forward';
    default: return 'left';
  }
}

/** The bitmask CDP wants for "which buttons are currently held" during a drag. */
export function buttonMask(name) {
  switch (cdpButton(name)) {
    case 'right': return 2;
    case 'middle': return 4;
    case 'back': return 8;
    case 'forward': return 16;
    default: return 1;
  }
}

/**
 * Key identity for `Input.dispatchKeyEvent`.
 *
 * A page listens for `key`, `code` and `keyCode`, and different pages listen for different
 * ones, so all three are supplied. The names accepted here are the same names the Desktop
 * driver accepts, including the DOM `Arrow*` spellings — one vocabulary across both drivers
 * is worth more than either driver's private preference.
 */
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }
};

/** Modifier bits CDP expects: Alt 1, Control 2, Meta 4, Shift 8. */
export const MODIFIERS = {
  alt: 1, option: 1,
  control: 2, ctrl: 2,
  meta: 4, cmd: 4, command: 4, super: 4, win: 4,
  shift: 8
};

export function keyDescriptor(name) {
  const lower = String(name || '').toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    const number = Number(lower.slice(1));
    return { key: `F${number}`, code: `F${number}`, vk: 111 + number };
  }
  if ([...name].length === 1) {
    const character = name;
    const upper = character.toUpperCase();
    const code = /[a-z]/i.test(character)
      ? `Key${upper}`
      : /[0-9]/.test(character)
        ? `Digit${character}`
        : undefined;
    return { key: character, code, vk: upper.charCodeAt(0), text: character };
  }
  throw fail('BAD_KEY', `unknown key ${name}`);
}

/**
 * Reads the page's interactive elements, in an isolated world.
 *
 * Deliberately not `Accessibility.getFullAXTree`: that returns nodes without geometry, so
 * every one of them would need a second round trip to become clickable, and a page of any
 * size turns into hundreds of protocol calls. One evaluation returns role, accessible name,
 * state and rectangle together — and the rectangle is already in the coordinate space the
 * input methods use.
 *
 * The isolated world matters. Evaluated in the page's own world, a hostile or merely
 * over-clever page could shadow `querySelectorAll` or `getBoundingClientRect` and hand back a
 * description of a page that does not exist, which the model would then act on.
 */
export const COLLECT_SOURCE = `(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=textbox]',
    '[role=combobox]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]'
  ].join(',');
  const seen = [];
  /**
   * A path that finds this element again later.
   *
   * Coordinates go stale the moment the page scrolls or reflows, and a click on a stale
   * coordinate does not fail — it hits whatever moved into that spot, which is the worst
   * possible outcome. Re-resolving from the document at action time turns that into an honest
   * refusal instead. An id is used when the page provides one; otherwise a child-index chain,
   * which is stable enough for the moments between an observation and the action on it.
   */
  const pathOf = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 24) {
      const parent = node.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
      node = parent;
    }
    return parts.length > 0 ? 'html > body ' + parts.slice(1).map((p) => '> ' + p).join(' ') : '';
  };
  const name = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (parts) return parts;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const own = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      const text = (own || el.placeholder || el.getAttribute('title') || el.name || '').trim();
      if (text) return text;
    }
    if (el.tagName === 'IMG') return (el.alt || '').trim();
    const alt = el.querySelector('img[alt]')?.alt;
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return (text || alt || el.getAttribute('title') || '').trim();
  };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  };
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (seen.length >= ${MAX_ELEMENTS}) break;
    const rect = el.getBoundingClientRect();
    // Off-screen and zero-area elements are not things a pointer can reach, and reporting
    // them invites a click at a coordinate that addresses something else entirely.
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom <= 0 || rect.right <= 0) continue;
    if (rect.top >= innerHeight || rect.left >= innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    seen.push({
      path: pathOf(el),
      role: role(el),
      name: name(el).slice(0, 160),
      value: 'value' in el && typeof el.value === 'string' ? String(el.value).slice(0, 160) : '',
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      checked: el.getAttribute('aria-checked') ?? (typeof el.checked === 'boolean' ? String(el.checked) : ''),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    elements: seen
  });
})()`;

/** Frames one observation will look into, and how deep. A frame bomb is a real page shape. */
const MAX_FRAMES = 12;
const MAX_FRAME_DEPTH = 4;

async function isolatedContext(frameId) {
  const { executionContextId } = await send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'chat-on-steroids',
    grantUniveralAccess: false
  });
  return executionContextId;
}

async function mainFrameId() {
  const { frameTree } = await send('Page.getFrameTree');
  const frameId = frameTree?.frame?.id;
  if (!frameId) throw fail('BROWSER_PROTOCOL_FAILED', 'the page reported no main frame');
  return frameId;
}

/** Evaluates the collector inside one frame, in a world the page cannot see or shadow. */
async function readFrame(frameId) {
  const contextId = await isolatedContext(frameId);
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: COLLECT_SOURCE,
    contextId,
    returnByValue: true,
    awaitPromise: false
  });
  if (exceptionDetails) return null;
  try {
    return JSON.parse(String(result?.value ?? '{}'));
  } catch {
    return null;
  }
}

/**
 * Where a child frame sits in the page above it.
 *
 * An element's rectangle is relative to its own frame, so without this every coordinate
 * inside an iframe would be wrong by the iframe's position — and wrong coordinates do not
 * fail, they click somewhere else.
 */
async function frameOffset(frameId) {
  try {
    const { backendNodeId } = await send('DOM.getFrameOwner', { frameId });
    if (!backendNodeId) return null;
    const { model } = await send('DOM.getBoxModel', { backendNodeId });
    const quad = model?.content;
    if (!Array.isArray(quad) || quad.length < 2) return null;
    return { x: quad[0], y: quad[1] };
  } catch {
    // A frame that closed between the tree walk and this call. Its elements are dropped
    // rather than reported at an offset nobody can vouch for.
    return null;
  }
}

/**
 * Every element on the page, including the ones inside iframes.
 *
 * Consent dialogs, payment forms, embedded editors and most login widgets are iframes. Reading
 * only the main frame reported those pages as having nothing to interact with, which the model
 * cannot tell apart from a page that genuinely has nothing.
 *
 * Each element keeps the frame it came from, because a ref has to be re-resolved in the frame
 * that owns it, and carries coordinates already translated into the top-level page's space so
 * that clicking one needs no further arithmetic.
 */
async function collectElements() {
  const root = await mainFrameId();
  const { frameTree } = await send('Page.getFrameTree');

  const frames = [];
  const walk = (node, depth, offset) => {
    if (!node?.frame?.id || frames.length >= MAX_FRAMES) return;
    frames.push({ id: node.frame.id, depth, offset });
    if (depth >= MAX_FRAME_DEPTH) return;
    for (const child of node.childFrames ?? []) walk(child, depth + 1, null);
  };
  walk(frameTree, 0, { x: 0, y: 0 });

  const page = (await readFrame(root)) ?? { elements: [] };
  const elements = [];
  let index = 0;
  const take = (list, frameId, offset) => {
    for (const element of list ?? []) {
      if (elements.length >= MAX_ELEMENTS) return;
      elements.push({
        ...element,
        ref: 'e' + index++,
        frameId,
        x: Math.round(element.x + offset.x),
        y: Math.round(element.y + offset.y)
      });
    }
  };
  take(page.elements, root, { x: 0, y: 0 });

  for (const frame of frames) {
    if (frame.id === root) continue;
    if (elements.length >= MAX_ELEMENTS) break;
    const offset = await frameOffset(frame.id);
    if (!offset) continue;
    const inner = await readFrame(frame.id);
    if (!inner) continue;
    take(inner.elements, frame.id, offset);
  }

  return { ...page, elements };
}

/**
 * A screenshot in which one pixel is one CSS pixel.
 *
 * The explicit clip at `scale: 1` is the whole point: without it the image comes back in
 * device pixels and every coordinate the model reads off it is wrong by the display's scale
 * factor, on exactly the high-DPI machines people actually use.
 */
async function screenshot() {
  const { width, height } = await viewport();
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 }
  }, COMPOSITOR_TIMEOUT_MS);
  return { data, width, height };
}

async function currentTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw fail('BROWSER_TAB_GONE', `tab ${tabId} no longer exists`);
  return tab;
}

/**
 * The permissions browser control needs, which the extension deliberately does not ship with.
 *
 * `debugger` and `<all_urls>` together are the most far-reaching pair an extension can hold —
 * read and write on every page, plus trusted input. Requiring them at install time would mean
 * every existing user is re-prompted on update and left disabled until they accept a
 * capability most of them will never switch on. As optional permissions they are requested
 * once, from a real click in the popup, by the person who actually wants the feature.
 */
/**
 * What is actually requested and revoked at runtime.
 *
 * `debugger` is not here, and cannot be: Chrome refuses it in optional_permissions, dropping the
 * entry at manifest load so a later request answers "Only permissions specified in the manifest
 * may be requested" — measured against Chrome 152. One unavailable entry failed the whole
 * request, which is why the popup switch could never stay on. It is a required permission now.
 *
 * Site and tab access remain optional, and they are what decides whether this extension can
 * read a page at all, so the opt-in still means something.
 */
export const BROWSER_PERMISSIONS = { permissions: ['tabs', 'tabGroups'], origins: ['<all_urls>'] };

/** Held from install, not requestable. Checked, never requested and never removed. */
const REQUIRED_BROWSER_PERMISSIONS = { permissions: ['debugger'] };

/**
 * One call shape, whichever the browser answers with.
 *
 * `permissions.*` answers a callback in the classic API and returns a promise in the MV3 one,
 * and which you get depends on the browser build rather than on anything visible here. Waiting
 * only for the callback hangs forever against the promise form, and a permission check that
 * hangs is indistinguishable from one that denied. Accepting either costs three lines.
 */
function askPermissions(method) {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.[method]) return resolve(false);
    try {
      const returned = api[method](BROWSER_PERMISSIONS, (granted) => {
        void runtime?.runtime?.lastError;
        resolve(Boolean(granted));
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((granted) => resolve(Boolean(granted)), () => resolve(false));
      }
    } catch {
      resolve(false);
    }
  });
}

/**
 * Whether this browser can do any of this at all.
 *
 * Browser control needs the DevTools protocol. Where an extension cannot reach it — a browser
 * that never implemented it, or a build where policy has taken it away — this is not a missing
 * permission but a missing capability, and saying so plainly is the difference between a
 * feature someone can decide not to use and a switch that silently does nothing.
 *
 * Deliberately not a `chrome.debugger` presence check. That object does not exist until the
 * optional permission is granted, so testing for it would hide the very switch that grants
 * it — the feature would be permanently unreachable on exactly the browsers that support it.
 * Proven in a real Edge run, where the popup reported no debugger API at all.
 */
export function browserControlSupported() {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.contains) return resolve(false);
    // Asking whether the permission is *held* is not the question — it will not be, before it
    // is granted. Asking whether the browser recognises the name is: one that has never heard
    // of it rejects the call outright, while one that simply has not granted it answers false.
    const done = (value) => resolve(value === true || value === false);
    try {
      const returned = api.contains({ permissions: ['debugger'] }, (held) => {
        // A browser that does not know the permission reports it here rather than throwing.
        if (runtime?.runtime?.lastError) return resolve(false);
        done(held);
      });
      if (returned && typeof returned.then === 'function') returned.then(done, () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export async function hasBrowserPermissions() {
  if (!(await browserControlSupported())) return false;
  // Both halves, because they are granted by different mechanisms: debugger at install, the
  // rest from the popup. Holding only one is not browser control.
  if (!(await containsRequired())) return false;
  return askPermissions('contains');
}

/** Whether the install-time debugger permission is actually present. */
function containsRequired() {
  return new Promise((resolve) => {
    const runtime = globalThis.browser ?? globalThis.chrome;
    const api = runtime?.permissions;
    if (!api?.contains) return resolve(false);
    try {
      const returned = api.contains(REQUIRED_BROWSER_PERMISSIONS, (held) => {
        if (runtime?.runtime?.lastError) return resolve(false);
        resolve(held === true);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((held) => resolve(held === true), () => resolve(false));
      }
    } catch {
      resolve(false);
    }
  });
}

/** Must be called from a user gesture; the browser refuses the prompt otherwise. */
export function requestBrowserPermissions() {
  return askPermissions('request');
}

export const browserDriver = {
  /** What is under control right now, for the popup, the app and the stop button. */
  status() {
    return session
      ? { attached: true, tabId: session.tabId, url: session.url, title: session.title }
      : { attached: false, tabId: null, url: null, title: null };
  },

  async attach(tabId) {
    if (session && session.tabId === tabId) return this.status();
    if (session) await this.detach();

    if (!(await browserControlSupported())) {
      throw fail(
        'BROWSER_UNSUPPORTED',
        'this browser exposes no DevTools protocol to extensions, so a web page cannot be driven ' +
          'from it. Desktop control still works and can operate the browser window itself.'
      );
    }
    if (!(await hasBrowserPermissions())) {
      throw fail(
        'BROWSER_PERMISSION_REQUIRED',
        'browser control is off. Open the Chat On Steroids extension popup and turn it on; ' +
          'the browser asks for site and tab access there. If the switch will not stay on, the ' +
          'popup now says why underneath it.'
      );
    }

    const tab = await currentTab(tabId);
    if (refusedUrl(tab.url)) {
      throw fail('BROWSER_URL_REFUSED', `browser control refuses ${tab.url ?? 'this page'}`);
    }

    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const error = chrome.runtime.lastError;
        if (error) return reject(fail('BROWSER_ATTACH_FAILED', error.message));
        resolve();
      });
    });

    session = { tabId, url: tab.url ?? '', title: tab.title ?? '', groupId: null };
    try {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('DOM.enable');
      session.groupId = await groupDrivenTab(tabId);
      await movePointer(0, 0);
    } catch (error) {
      await this.detach();
      throw error;
    }
    return this.status();
  },

  /** Always safe to call, always leaves the tab as the user's own again. */
  async detach() {
    if (!session) return { attached: false, tabId: null, url: null, title: null };
    const { tabId } = session;
    await removePointer();
    try {
      await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      }));
    } catch {
      // The tab may already be gone, which is the state we were heading for anyway.
    }
    session = null;
    return { attached: false, tabId: null, url: null, title: null };
  },

  /** Called when the browser tears the session down underneath us. */
  forget(tabId) {
    if (session && session.tabId === tabId) session = null;
  },

  /**
   * Where a ref points *now*, not where it pointed when it was observed.
   *
   * A coordinate from an earlier observation does not fail when the page has scrolled or
   * reflowed — it hits whatever moved into that spot, which is worse than any error. So a ref
   * is re-resolved from the document immediately before it is used, and an element that is
   * gone, hidden or off-screen produces a refusal instead of a click somewhere else.
   */
  async resolveRef(ref) {
    const entry = session?.refs?.get(String(ref));
    if (!entry) {
      throw fail('BROWSER_BAD_REF', `${ref} is not from the most recent observation of this page`);
    }
    const { path, frameId } = entry;
    // Resolved in the frame that owns it. A path from inside an iframe means nothing in the
    // document above it, and could match something entirely different there.
    const contextId = await isolatedContext(frameId);
    const offset = (await frameOffset(frameId)) ?? { x: 0, y: 0 };
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(path)});
        if (!el) return JSON.stringify({ found: false });
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const usable = r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0 &&
          r.top < innerHeight && r.left < innerWidth &&
          s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
        return JSON.stringify({
          found: true, usable,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
        });
      })()`,
      contextId,
      returnByValue: true
    });
    if (exceptionDetails) throw fail('BROWSER_BAD_REF', `${ref} could not be resolved on this page`);
    const found = JSON.parse(String(result?.value ?? '{}'));
    if (!found.found) throw fail('BROWSER_BAD_REF', `${ref} is no longer on this page`);
    if (!found.usable) throw fail('BROWSER_BAD_REF', `${ref} is on the page but not visible or reachable`);
    // Back into the top-level page's coordinates, which is the space input events use.
    return { x: Math.round(found.x + offset.x), y: Math.round(found.y + offset.y) };
  },

  /**
   * Attaches to the tab a person would mean by "the browser", if nothing is attached yet.
   *
   * Making the model ask for this first was bookkeeping it should not have to carry, and one
   * more thing to get wrong. The newest ordinary tab is the one being worked in; ChatGPT's own
   * tabs and browser surfaces are skipped by the same refusal list that governs an explicit
   * attach, so this cannot reach anywhere an explicit attach could not.
   */
  async ensureAttached() {
    if (session) return;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      throw fail('BROWSER_PERMISSION_REQUIRED', 'browser control is off; turn it on in the extension popup');
    }
    const candidate = tabs
      .filter((tab) => Number.isSafeInteger(tab?.id) && !refusedUrl(tab.url))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
    if (!candidate) {
      throw fail(
        'BROWSER_NO_TAB',
        'no ordinary web page is open to drive. Open the page first; ChatGPT tabs are never driven.'
      );
    }
    await this.attach(candidate.id);
  },

  async act(action) {
    await this.ensureAttached();
    const type = String(action?.type ?? '');
    const button = cdpButton(action?.button);
    const modifiers = (action?.modifiers ?? []).reduce(
      (bits, name) => bits | (MODIFIERS[String(name).toLowerCase()] ?? 0),
      0
    );

    switch (type) {
      case 'navigate': {
        const url = String(action.url ?? '');
        if (refusedUrl(url)) throw fail('BROWSER_URL_REFUSED', `browser control refuses ${url}`);
        if (!/^https?:\/\//i.test(url)) throw fail('BAD_REQUEST', 'navigate needs an http(s) URL');
        await send('Page.navigate', { url }, NAVIGATE_TIMEOUT_MS);
        return { navigated: url };
      }
      case 'back':
      case 'forward': {
        const history = await send('Page.getNavigationHistory');
        const index = history.currentIndex + (type === 'back' ? -1 : 1);
        const entry = history.entries?.[index];
        if (!entry) throw fail('BROWSER_NO_HISTORY', `there is nothing to go ${type} to`);
        await send('Page.navigateToHistoryEntry', { entryId: entry.id }, NAVIGATE_TIMEOUT_MS);
        return { navigated: entry.url };
      }
      case 'reload':
        await send('Page.reload', {}, NAVIGATE_TIMEOUT_MS);
        return { reloaded: true };

      case 'click_ref': {
        const at = await this.resolveRef(action.ref);
        return this.act({ ...action, type: 'click', x: at.x, y: at.y });
      }
      case 'set_value': {
        const at = await this.resolveRef(action.ref);
        // Focus by clicking where the control actually is, select everything, then insert.
        // Writing `value` directly through the DOM skips the input events a page listens for,
        // so a framework-backed field would look changed and behave as if it never was.
        await this.act({ type: 'click', x: at.x, y: at.y });
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
        });
        const text = String(action.text ?? '');
        // insertText with empty text is a no-op, so an intentional clear needs a real delete.
        if (text) await send('Input.insertText', { text });
        else {
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        }
        return { set: action.ref, length: text.length };
      }

      case 'move':
        await movePointer(action.x, action.y);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: action.x, y: action.y, modifiers
        });
        return { moved: { x: action.x, y: action.y } };

      case 'click':
      case 'double_click': {
        const clickCount = type === 'double_click' ? 2 : 1;
        await movePointer(action.x, action.y);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: action.x, y: action.y, modifiers });
        for (let press = 1; press <= clickCount; press++) {
          await movePointer(action.x, action.y, true);
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: action.x, y: action.y, button, buttons: buttonMask(action.button),
            clickCount: press, modifiers
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: action.x, y: action.y, button, buttons: 0,
            clickCount: press, modifiers
          });
          await movePointer(action.x, action.y);
        }
        return { clicked: { x: action.x, y: action.y, button, clickCount } };
      }

      case 'drag': {
        const path = Array.isArray(action.path) ? action.path : [];
        if (path.length < 2) throw fail('BAD_REQUEST', 'drag needs at least two points');
        const mask = buttonMask(action.button);
        await movePointer(path[0].x, path[0].y, true);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: path[0].x, y: path[0].y, modifiers });
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: path[0].x, y: path[0].y, button, buttons: mask, clickCount: 1, modifiers
        });
        for (const point of path.slice(1)) {
          await movePointer(point.x, point.y, true);
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: point.x, y: point.y, button, buttons: mask, modifiers
          });
        }
        const last = path[path.length - 1];
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: last.x, y: last.y, button, buttons: 0, clickCount: 1, modifiers
        });
        await movePointer(last.x, last.y);
        return { dragged: path.length };
      }

      case 'scroll': {
        const x = Number(action.x ?? 0);
        const y = Number(action.y ?? 0);
        await movePointer(x, y);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, modifiers,
          // Positive scroll_y means "scroll down" for the caller, which is the direction the
          // page content moves up; CDP's deltaY is the opposite sign.
          deltaX: -Number(action.scroll_x ?? 0),
          deltaY: -Number(action.scroll_y ?? 0)
        }, COMPOSITOR_TIMEOUT_MS);
        return { scrolled: { x, y } };
      }

      case 'type': {
        // insertText rather than a keystroke per character: it is one round trip instead of
        // hundreds, it does not depend on the layout, and it is what a paste looks like to
        // the page. Composition-sensitive editors still see a real input event.
        const text = String(action.text ?? '');
        if (!text) return { typed: 0 };
        await send('Input.insertText', { text });
        return { typed: text.length };
      }

      case 'keypress': {
        const names = Array.isArray(action.keys) ? action.keys : [];
        if (names.length === 0) throw fail('BAD_REQUEST', 'keypress needs at least one key');
        const held = names.filter((name) => MODIFIERS[String(name).toLowerCase()] !== undefined);
        const plain = names.filter((name) => MODIFIERS[String(name).toLowerCase()] === undefined);
        const bits = held.reduce((all, name) => all | MODIFIERS[String(name).toLowerCase()], modifiers);
        // A chord of modifiers alone is a real thing to send; a chord with keys sends those
        // keys while the modifier bits are set, which is what every page listens for.
        const targets = plain.length > 0 ? plain : held;
        for (const name of targets) {
          const key = keyDescriptor(name);
          const base = {
            modifiers: bits,
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.vk,
            nativeVirtualKeyCode: key.vk
          };
          // A modifier held down must not also insert text, and neither must a chord:
          // Ctrl+A types nothing, it selects.
          const text = bits === 0 && key.text ? key.text : undefined;
          await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
          await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        }
        return { pressed: names.length };
      }

      case 'wait': {
        const ms = Math.min(10_000, Math.max(0, Number(action.ms ?? 250)));
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { waited: ms };
      }

      default:
        throw fail('BAD_REQUEST', `unknown browser action ${type || '(none)'}`);
    }
  },

  /** One look: what the page is, what can be acted on, and a picture of it. */
  async observe({ includeScreenshot = true } = {}) {
    await this.ensureAttached();
    const tab = await currentTab(session.tabId);
    session.url = tab.url ?? session.url;
    session.title = tab.title ?? session.title;
    const page = await collectElements();
    // Only the newest observation's refs are addressable. Keeping older ones alive would let
    // a ref from three pages ago resolve against whatever happens to match now.
    session.refs = new Map(
      (page.elements ?? []).map((element) => [
        element.ref,
        { path: element.path, frameId: element.frameId, offset: { x: element.frameX ?? 0, y: element.frameY ?? 0 } }
      ])
    );
    const view = await viewport();
    const shot = includeScreenshot ? await screenshot() : null;
    return {
      tabId: session.tabId,
      url: page.url || session.url,
      title: page.title || session.title,
      viewport: view,
      scrollY: page.scrollY,
      scrollHeight: page.scrollHeight,
      // The path and the frame are how a ref is resolved, not something the model should
      // reason about: it names a ref and gets coordinates already in the page's own space.
      elements: (page.elements ?? []).map(({ path, frameId, ...element }) => element),
      screenshot: shot
    };
  }
};

/**
 * The browser tearing a session down is not an error, it is news.
 *
 * A user closing the tab, hitting Chrome's own "Cancel" on the debugging banner, or opening
 * DevTools all end the session without asking us. Forgetting it here is what keeps `status()`
 * honest and stops the next action from addressing a tab that is not ours any more.
 */
let lifecycleInstalled = false;

export function installBrowserDriverLifecycle() {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  chrome.debugger.onDetach.addListener((source) => {
    if (source?.tabId !== undefined) browserDriver.forget(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => browserDriver.forget(tabId));
}
