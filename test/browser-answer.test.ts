import { describe, expect, it } from 'vitest';
import { renderBrowserAction } from '../src/main/mcp/tools-desktop';

/**
 * The layer that lost three fixes.
 *
 * The driver had a suite proving it returns `hit`, `covered` and its own build; the macOS helper
 * had one too. Between them sat the rendering, reachable only through a live extension and a real
 * browser, and it replaced every reply but observe and status with the word `ok`. Two QA runs
 * reported working fixes as missing, and one of them I answered by blaming their browser — which
 * was wrong, and cost them a round.
 *
 * These tests call the rendering directly. Each one fails against the code as it was.
 */
describe('a browser answer carries what the driver answered', () => {
  it('keeps the fields that say where a click actually landed', () => {
    const { lines } = renderBrowserAction('click_ref', {
      clicked: { x: 12, y: 34 },
      hit: 'a#result',
      covered: true
    });
    expect(lines[0]).toContain('hit=a#result');
    expect(lines[0]).toContain('covered=true');
  });

  it('keeps them for a hover too, which is a different action and the same question', () => {
    const { lines } = renderBrowserAction('move_ref', { moved: { x: 5, y: 6 }, hit: 'button#menu', covered: false });
    expect(lines[0]).toContain('hit=button#menu');
    expect(lines[0]).toContain('covered=false');
  });

  it('carries a field nobody has thought of yet', () => {
    // The point of reading the answer rather than listing its fields: this test passes without
    // anyone editing the renderer, which is exactly what did not happen for hit and covered.
    const { lines } = renderBrowserAction('navigate', { navigated: 'https://example.com', somethingNew: 7 });
    expect(lines[0]).toContain('somethingNew=7');
  });

  it('names the running driver on the answer a run reads before it starts', () => {
    const held = renderBrowserAction('status', {
      attached: true, tabId: 42, title: 'Example', url: 'https://example.com', groupId: 9, build: 'a40c45c0ba34'
    });
    expect(held.lines[0]).toContain('driver build a40c45c0ba34');
    // Including the branch that holds nothing, which is the one a run reads first.
    const idle = renderBrowserAction('status', { attached: false, build: 'a40c45c0ba34' });
    expect(idle.lines[0]).toContain('no tab is under control');
    expect(idle.lines[0]).toContain('driver build a40c45c0ba34');
  });

  it('says so plainly when the driver did not name itself', () => {
    // Silence here is what made a stale extension indistinguishable from a fresh one.
    const { lines } = renderBrowserAction('status', { attached: false });
    expect(lines[0]).toContain('driver build unreported');
  });

  it('still answers ok when the driver genuinely said nothing', () => {
    expect(renderBrowserAction('reload', {}).lines[0]).toBe('reload: ok');
  });

  it('hands back the observation screenshot, and only a real one', () => {
    const withShot = renderBrowserAction('observe', {
      url: 'https://example.com', title: 'Example', elements: [],
      screenshot: { data: 'AAAA', width: 800, height: 600 }
    });
    expect(withShot.observed).toBe(true);
    expect(withShot.screenshot).toEqual({ data: 'AAAA', width: 800, height: 600 });
    expect(renderBrowserAction('observe', { url: '', title: '', elements: [], screenshot: null }).screenshot).toBeUndefined();
  });
});
