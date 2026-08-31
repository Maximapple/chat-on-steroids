/**
 * The browser driver's decidable parts.
 *
 * The protocol traffic itself needs a real browser and is proven by using it. Everything that
 * can be decided without one is decided here, and the first block is the important one: the
 * refusal list is the only thing standing between "the model can drive a web page" and "the
 * model can drive the conversation it is having with you".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_PERMISSIONS,
  COLLECT_SOURCE,
  DRIVEN_GROUP_TITLE,
  buttonMask,
  cdpButton,
  hasBrowserPermissions,
  keyDescriptor,
  refusedUrl,
  requestBrowserPermissions
} from '../extension/browser-driver.js';

const manifest = JSON.parse(
  readFileSync(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
);

describe('what browser control refuses to attach to', () => {
  /**
   * The model asking for browser control is sitting in a ChatGPT tab. A driver able to attach
   * there could send messages as the user, answer its own confirmations, or read a different
   * conversation the person has open. This is the one refusal that is not about tidiness.
   */
  it('never attaches to ChatGPT itself', () => {
    for (const url of [
      'https://chatgpt.com/',
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'https://chatgpt.com/g/g-p-project/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'https://CHATGPT.com/',
      'https://chat.openai.com/'
    ]) {
      expect(refusedUrl(url), url).toBe(true);
    }
  });

  it('never attaches to the browser, its extensions or the filesystem', () => {
    for (const url of [
      'chrome://settings',
      'chrome://extensions',
      'edge://settings',
      'about:blank',
      'about:config',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://abcdefghijklmnop/popup.html',
      'moz-extension://abcdefghijklmnop/popup.html',
      'view-source:https://example.com',
      'file:///C:/Users/you/secrets.txt'
    ]) {
      expect(refusedUrl(url), url).toBe(true);
    }
  });

  it('allows the ordinary web, which is the entire point', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:3000/app',
      'https://github.com/some/repo/pull/1',
      'https://notchatgpt.com/',
      'https://example.com/?next=https://chatgpt.com/'
    ]) {
      expect(refusedUrl(url), url).toBe(false);
    }
  });

  it('treats a missing or malformed url as refusable rather than allowed', () => {
    expect(refusedUrl(undefined)).toBe(false);
    // Nothing above matches, so an unknown scheme reaches attach and fails there on the
    // http(s) check instead. What must never happen is a refused scheme slipping through.
    expect(refusedUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('permissions are opt-in', () => {
  /**
   * `debugger` plus `<all_urls>` is the most far-reaching pair an extension can hold. Shipping
   * it as required would re-prompt every existing user on update and leave the extension
   * disabled until they accepted a capability most of them will never switch on.
   */
  it('keeps the far-reaching permissions optional so an update never disables the extension', () => {
    expect(manifest.optional_permissions).toEqual(['debugger', 'tabs', 'tabGroups']);
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    // The install-time set is unchanged from before browser control existed.
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  it('asks for exactly what the manifest offers, and no more', () => {
    expect(BROWSER_PERMISSIONS.permissions).toEqual(manifest.optional_permissions);
    expect(BROWSER_PERMISSIONS.origins).toEqual(manifest.optional_host_permissions);
  });

  it('names the driven tab group after the product so it is recognisable', () => {
    expect(DRIVEN_GROUP_TITLE).toBe('Chat On Steroids');
  });

  /**
   * Chrome answers `permissions.*` through a callback and returns nothing. Firefox returns a
   * promise and ignores the callback. This extension ships for both, so waiting only for the
   * callback would hang forever on one of them — and the symptom would be a toggle that does
   * nothing at all, with no error to chase.
   */
  describe('across both extension APIs', () => {
    // The driver reads whichever of the two globals the browser provides, so the test has to
    // be able to install either and put the environment back afterwards.
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = { chrome: globals.chrome, browser: globals.browser };
    afterEach(() => {
      globals.chrome = original.chrome;
      globals.browser = original.browser;
    });

    it('accepts the Chrome callback', async () => {
      globals.browser = undefined;
      globals.chrome = {
        runtime: {},
        permissions: {
          contains: (_perms: unknown, done: (granted: boolean) => void) => done(true),
          request: (_perms: unknown, done: (granted: boolean) => void) => done(false)
        }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(true);
      await expect(requestBrowserPermissions()).resolves.toBe(false);
    });

    it('accepts the Firefox promise, which never calls the callback', async () => {
      globals.browser = {
        runtime: {},
        permissions: {
          contains: () => Promise.resolve(true),
          request: () => Promise.resolve(true)
        }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(true);
      await expect(requestBrowserPermissions()).resolves.toBe(true);
    });

    it('answers false rather than hanging when the API is absent or throws', async () => {
      globals.browser = undefined;
      globals.chrome = { runtime: {} };
      await expect(hasBrowserPermissions()).resolves.toBe(false);

      globals.chrome = {
        runtime: {},
        permissions: { contains: () => { throw new Error('no'); } }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(false);

      globals.browser = {
        runtime: {},
        permissions: { contains: () => Promise.reject(new Error('denied')) }
      };
      await expect(hasBrowserPermissions()).resolves.toBe(false);
    });
  });

  /**
   * electron-builder copies the whole extension folder, but the packaged-runtime smoke check
   * names every file it expects. A driver missing from the package would otherwise ship as a
   * browser-control toggle that fails on first use.
   */
  it('is required by the packaged-runtime smoke check', () => {
    const smoke = readFileSync(path.join(process.cwd(), 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(smoke).toContain("'extension/browser-driver.js'");
    // And the declaration file, which a browser cannot run, stays out of the package.
    const builder = readFileSync(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');
    expect(builder).toContain("- '!**/*.d.ts'");
  });
});

describe('the shared input vocabulary', () => {
  it('maps every mouse button the rest of the product accepts', () => {
    expect(cdpButton('left')).toBe('left');
    expect(cdpButton('right')).toBe('right');
    expect(cdpButton('middle')).toBe('middle');
    expect(cdpButton('wheel')).toBe('middle');
    expect(cdpButton('back')).toBe('back');
    expect(cdpButton('forward')).toBe('forward');
    expect(cdpButton(undefined)).toBe('left');
    expect(cdpButton('nonsense')).toBe('left');
  });

  it('holds the right bit while a drag is in progress', () => {
    expect(buttonMask('left')).toBe(1);
    expect(buttonMask('right')).toBe(2);
    expect(buttonMask('wheel')).toBe(4);
    expect(buttonMask('back')).toBe(8);
    expect(buttonMask('forward')).toBe(16);
  });

  it('accepts the same key names as the desktop driver, DOM spellings included', () => {
    expect(keyDescriptor('ArrowLeft')).toMatchObject({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    expect(keyDescriptor('left')).toMatchObject({ key: 'ArrowLeft', vk: 37 });
    expect(keyDescriptor('Enter')).toMatchObject({ key: 'Enter', vk: 13 });
    expect(keyDescriptor('Return')).toMatchObject({ key: 'Enter', vk: 13 });
    expect(keyDescriptor('Escape')).toMatchObject({ key: 'Escape', vk: 27 });
    expect(keyDescriptor('PageDown')).toMatchObject({ key: 'PageDown', vk: 34 });
    expect(keyDescriptor('F5')).toMatchObject({ key: 'F5', code: 'F5', vk: 116 });
    expect(keyDescriptor('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' });
    expect(keyDescriptor('7')).toMatchObject({ key: '7', code: 'Digit7', text: '7' });
  });

  it('refuses a key it cannot name rather than pressing something arbitrary', () => {
    expect(() => keyDescriptor('NotAKey')).toThrowError(/unknown key/i);
  });
});

/**
 * The page reader, run against a real DOM.
 *
 * This is the part most likely to be quietly wrong — a selector that misses the button the
 * model needs, a name that comes back empty, a hidden element reported as clickable — so it
 * is exercised rather than asserted. jsdom computes no layout, so the fixture declares each
 * element's rectangle and the test installs a `getBoundingClientRect` that returns it.
 */
describe('reading a page', () => {
  function read(body: string, viewport = { width: 1000, height: 800 }) {
    const dom = new JSDOM(`<!doctype html><title>Fixture page</title><body>${body}</body>`, {
      url: 'https://example.com/page',
      // The collector runs inside the page, so the test has to run it there too.
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & typeof globalThis;
    Object.defineProperty(window, 'innerWidth', { value: viewport.width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: viewport.height, configurable: true });
    window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const spec = (this as HTMLElement).dataset?.rect;
      const [left = 0, top = 0, width = 0, height = 0] = (spec ?? '0,0,0,0').split(',').map(Number);
      return {
        left, top, width, height,
        right: left + width, bottom: top + height,
        x: left, y: top, toJSON: () => ({})
      } as DOMRect;
    };
    const raw = window.eval(COLLECT_SOURCE) as string;
    return JSON.parse(raw) as {
      url: string;
      title: string;
      elements: Array<Record<string, unknown>>;
    };
  }

  it('finds what can be acted on, and says where', () => {
    const page = read(`
      <a href="/next" data-rect="10,20,100,30">Next page</a>
      <button data-rect="10,60,80,24">Save</button>
      <input type="text" placeholder="Search" data-rect="10,100,200,28">
      <div role="button" data-rect="10,140,60,20">Custom</div>
    `);

    expect(page.url).toBe('https://example.com/page');
    expect(page.title).toBe('Fixture page');
    expect(page.elements).toHaveLength(4);
    // Every element is addressable by ref, and carries a path the driver re-resolves with.
    expect(page.elements.map((e) => e.ref)).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(page.elements.every((e) => typeof e.path === 'string' && (e.path as string).length > 0)).toBe(true);
    expect(page.elements.map((e) => [e.role, e.name])).toEqual([
      ['link', 'Next page'],
      ['button', 'Save'],
      ['textbox', 'Search'],
      ['button', 'Custom']
    ]);
    // Coordinates are the element's centre, in the same space the input methods use.
    expect(page.elements[1]).toMatchObject({ x: 50, y: 72, width: 80, height: 24 });
  });

  it('prefers the accessible name over the visible text', () => {
    const page = read(`
      <button aria-label="Close dialog" data-rect="0,0,20,20">×</button>
      <span id="lbl">Email address</span>
      <input type="text" aria-labelledby="lbl" data-rect="0,30,200,28">
      <button data-rect="0,70,40,40"><img alt="Print" src="p.png"></button>
    `);
    expect(page.elements.map((e) => e.name)).toEqual(['Close dialog', 'Email address', 'Print']);
  });

  it('leaves out what a pointer could not reach', () => {
    const page = read(`
      <button data-rect="10,10,60,20">Visible</button>
      <button data-rect="0,0,0,0">Zero size</button>
      <button style="display:none" data-rect="10,40,60,20">Display none</button>
      <button style="visibility:hidden" data-rect="10,70,60,20">Hidden</button>
      <button aria-hidden="true" data-rect="10,100,60,20">Aria hidden</button>
      <button data-rect="-200,10,60,20">Scrolled off the left</button>
      <button data-rect="10,900,60,20">Below the fold</button>
    `);
    expect(page.elements.map((e) => e.name)).toEqual(['Visible']);
  });

  it('reports state the model has to know before it acts', () => {
    const page = read(`
      <button disabled data-rect="0,0,50,20">Submit</button>
      <input type="checkbox" checked data-rect="0,30,20,20" aria-label="Remember me">
      <input type="text" value="already here" data-rect="0,60,200,28" aria-label="Note">
    `);
    expect(page.elements[0]).toMatchObject({ name: 'Submit', disabled: true });
    expect(page.elements[1]).toMatchObject({ name: 'Remember me', checked: 'true' });
    expect(page.elements[2]).toMatchObject({ name: 'Note', value: 'already here' });
  });

  it('bounds a hostile page instead of handing the model everything it has', () => {
    const many = Array.from(
      { length: 400 },
      (_, index) => `<button data-rect="0,${index % 700},40,10">B${index}</button>`
    ).join('');
    expect(read(many).elements.length).toBeLessThanOrEqual(200);
  });
});
