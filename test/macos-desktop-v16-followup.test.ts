import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const computer = source('src/main/computer/index.ts');

describe('PR #28 v16 follow-up review fixes', () => {
  it('does not retarget an explicit find_ui request to the foreground window', () => {
    const start = swift.indexOf('private func findUI');
    const body = swift.slice(start, start + 6000);
    expect(body).toContain('else if request["id"] != nil');
    expect(body).toContain('WINDOW_NOT_FOUND');
    expect(body.indexOf('request["id"] != nil')).toBeLessThan(body.indexOf('foregroundWindowID()'));
  });

  it('treats asynchronous capture as one exact display-topology epoch', () => {
    expect(swift).toContain('let contentDisplayRects = content.displays.map(\\.frame)');
    expect(swift).toContain('display topology changed before capture began');
    expect(swift).toContain('let finalDisplayRects = try activeDisplayRects()');
    expect(swift).toContain('display topology changed while screenshot was captured');
    expect(swift).toContain('displayTopologyObject(finalDisplayRects)');
  });

  it('does not label a macOS visible-screen crop as a window frame', () => {
    expect(computer).toMatch(
      /opts\.crop[\s\S]*process\.platform === 'darwin'[\s\S]*\? null[\s\S]*cropSourceFrame\?\.windowId/
    );
    expect(computer).toContain("opts.crop && process.platform !== 'darwin'");
  });

  it('prevalidates cross-window batches before their first side effect', () => {
    expect(computer).toContain('if (targetCandidates.size > 1)');
    expect(computer).toContain('TARGET_WINDOW_CONFLICT: this batch spans windows');
  });
});
