import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  act,
  activeWindow,
  findUi,
  listWindows,
  screenshot,
  stopComputerHelper
} from '../src/main/computer/index.js';

const LIVE = process.platform === 'darwin' && process.env['COS_LIVE_MACOS_DESKTOP'] === '1';
const SEMANTIC_PROCESS = process.env['COS_LIVE_MACOS_SEMANTIC_PROCESS'];
const SEMANTIC_WINDOW = process.env['COS_LIVE_MACOS_SEMANTIC_WINDOW'];
const SEMANTIC_QUERY = process.env['COS_LIVE_MACOS_SEMANTIC_QUERY'];
const INPUT_PROCESS = process.env['COS_LIVE_MACOS_INPUT_PROCESS'];
const INPUT_WINDOW = process.env['COS_LIVE_MACOS_INPUT_WINDOW'];
const SOAK_ITERATIONS = Math.min(100, Math.max(0, Number.parseInt(process.env['COS_LIVE_MACOS_SOAK_ITERATIONS'] ?? '0', 10) || 0));

describe.runIf(LIVE)('live macOS Desktop backend', () => {
  afterAll(async () => {
    await stopComputerHelper();
  });

  it('lists native windows and captures a bounded PNG frame', async () => {
    const { windows, screen } = await listWindows();
    expect(screen.width).toBeGreaterThan(0);
    expect(screen.height).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(0);

    const shot = await screenshot({ maxWidth: 800 });
    expect(shot.width).toBeLessThanOrEqual(800);
    expect(shot.height).toBeGreaterThan(0);
    expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('returns snapshot-scoped AX controls for a visible window', async (context) => {
    const target = (await listWindows()).windows[0];
    if (!target) return context.skip('No visible macOS window is available.');
    const found = await findUi({ window: target.id, maxResults: 8 });
    expect(found.window).toBe(target.id);
    expect(found.snapshotId).toBeGreaterThan(0);
    expect(found.elements.length).toBeGreaterThan(0);
    expect(found.elements[0]?.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('sets and clears an explicitly selected semantic text control', async (context) => {
    if (!SEMANTIC_PROCESS || !SEMANTIC_QUERY) {
      return context.skip('Set COS_LIVE_MACOS_SEMANTIC_PROCESS and COS_LIVE_MACOS_SEMANTIC_QUERY to opt in.');
    }
    const target = (await listWindows()).windows.find(
      (window) => window.process === SEMANTIC_PROCESS && (!SEMANTIC_WINDOW || window.title === SEMANTIC_WINDOW)
    );
    if (!target) return context.skip('The selected semantic-probe window is not visible.');
    const field = (await findUi({ window: target.id, query: SEMANTIC_QUERY, maxResults: 3 })).elements[0];
    if (!field) return context.skip('The selected control is not exposed through AX.');

    const marker = 'COS_MAC_DESKTOP_SEMANTIC_PROBE';
    try {
      const set = await act([{ type: 'set_value', ref: field.ref, text: marker }]);
      expect(set.completedCount).toBe(1);
      expect(set.routes).toEqual(['uia']);
      expect((await findUi({ window: target.id, query: marker, maxResults: 1 })).elements).toHaveLength(1);
    } finally {
      await act([{ type: 'set_value', ref: field.ref, text: '' }]);
    }
  });

  it('posts harmless keyboard and pointer events through CGEvent', async (context) => {
    const target = (await activeWindow()).window;
    if (!target) return context.skip('No foreground window is available for target-bound keyboard input.');
    const key = await act([{ type: 'keypress', keys: ['shift'] }], { targetWindow: target.id });
    expect(key.completedCount).toBe(1);
    expect(key.routes).toEqual(['sendinput']);
    if (!key.cursor) return context.skip('The current pointer position is unavailable.');

    const frame = await screenshot({ full: true, maxWidth: 800 });
    const x = Math.round((key.cursor.screen.x - frame.region.x) * frame.scale);
    const y = Math.round((key.cursor.screen.y - frame.region.y) * frame.scale);
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      return context.skip('The pointer is outside the retained full-desktop frame.');
    }
    const move = await act([{ type: 'move', x, y }], { frameId: frame.frameId, targetWindow: target.id });
    expect(move.completedCount).toBe(1);
    expect(move.routes).toEqual(['sendinput']);
  });

  it('fails closed when another app steals a pinned keyboard target', async (context) => {
    if (!INPUT_PROCESS) return context.skip('Set COS_LIVE_MACOS_INPUT_PROCESS to opt in.');
    const target = (await listWindows()).windows.find(
      (window) => window.process === INPUT_PROCESS && (!INPUT_WINDOW || window.title === INPUT_WINDOW)
    );
    if (!target) return context.skip('The selected input-routing window is not visible.');
    await act([{ type: 'focus', window: target.id }], { targetWindow: target.id });

    execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
    const deadline = Date.now() + 2_000;
    for (;;) {
      const current = (await activeWindow()).window;
      if (current?.id !== target.id) break;
      if (Date.now() >= deadline) return context.skip('Finder did not become foreground in time.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await expect(
      act([{ type: 'type', text: 'COS_INPUT_TARGET_LOST_PROBE' }], { targetWindow: target.id })
    ).rejects.toThrow(/INPUT_TARGET_LOST|TARGET_APP_NOT_FRONTMOST/);
    await act([{ type: 'focus', window: target.id }], { targetWindow: target.id });
  });

  it('soaks exact focus plus Command+B modifier routing on an explicitly selected app', async (context) => {
    if (!INPUT_PROCESS || SOAK_ITERATIONS < 1) {
      return context.skip('Set COS_LIVE_MACOS_INPUT_PROCESS and COS_LIVE_MACOS_SOAK_ITERATIONS=50..100 to opt in.');
    }
    const target = (await listWindows()).windows.find(
      (window) => window.process === INPUT_PROCESS && (!INPUT_WINDOW || window.title === INPUT_WINDOW)
    );
    if (!target) return context.skip('The selected soak window is not visible.');

    for (let index = 0; index < SOAK_ITERATIONS; index++) {
      const result = await act(
        [
          { type: 'focus', window: target.id },
          { type: 'keypress', keys: ['command', 'b'] },
          { type: 'keypress', keys: ['command', 'b'] }
        ],
        { targetWindow: target.id }
      );
      expect(result.completedCount).toBe(3);
      expect((await activeWindow()).window?.id).toBe(target.id);
    }
  });
});
