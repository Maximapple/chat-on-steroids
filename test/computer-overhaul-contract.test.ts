import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('desktop helper overhaul contract', () => {
  it('does not reintroduce the fixed focus and per-action sleeps', () => {
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 120');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 30');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 20');
    expect(HELPER_SCRIPT).toContain('Stopwatch]::StartNew()');
  });

  it('keeps observation coalesced and window capture background-first', () => {
    expect(HELPER_SCRIPT).toContain("'snapshot'");
    expect(HELPER_SCRIPT).toContain('CaptureWindow');
    expect(HELPER_SCRIPT).toContain("$mode = 'window'");
    expect(HELPER_SCRIPT).not.toContain('$root.FindAll(');
    expect(HELPER_SCRIPT).toContain('TreeWalker]::ControlViewWalker');
    expect(HELPER_SCRIPT).toContain('System.Windows.Automation.CacheRequest');
  });

  it('returns exact partial-batch evidence and snapshot-scopes UI handles', () => {
    expect(HELPER_SCRIPT).toContain('completed_count = $completed');
    expect(HELPER_SCRIPT).toContain('failed_index = $index');
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots');
    expect(HELPER_SCRIPT).toContain('STALE_UI_SNAPSHOT');
  });

  /**
   * The pointer belongs in the picture, on both platforms.
   *
   * ScreenCaptureKit composites it for us on macOS (`showsCursor`), but neither
   * `CopyFromScreen` nor `PrintWindow` does on Windows, so the model could not see where the
   * pointer was, read a hover state, or confirm from the image that a move landed.
   *
   * Verified for real on Windows rather than only asserted here: capturing a 64x64 region
   * centred on the reported pointer position through `Clf.Capture` differs from a plain
   * `CopyFromScreen` of the same region in 126 pixels, and the changed region's bounding box
   * begins exactly at the reported pointer pixel and extends right and down — an arrow drawn
   * at its hotspot rather than at the icon origin.
   */
  it('composites the live pointer into both Windows capture paths', () => {
    expect(HELPER_SCRIPT).toContain('static void PaintCursor(Graphics g, int originX, int originY, int w, int h)');
    expect(HELPER_SCRIPT).toContain('GetCursorInfo');
    expect(HELPER_SCRIPT).toContain('DrawIconEx');
    // Screen and window capture both paint, each against its own origin.
    expect(HELPER_SCRIPT).toMatch(/CopyFromScreen\([\s\S]{0,120}PaintCursor\(g, x, y, w, h\)/);
    expect(HELPER_SCRIPT).toMatch(/PrintWindow\(h, dc, 2\)[\s\S]{0,400}PaintCursor\(g, r\.Left, r\.Top, w, height\)/);
    // Drawn at the hotspot: the pixel the pointer actually addresses.
    expect(HELPER_SCRIPT).toContain('int x = ci.ptScreenPos.X - originX - info.xHotspot;');
    expect(HELPER_SCRIPT).toContain('int y = ci.ptScreenPos.Y - originY - info.yHotspot;');
    // A hidden pointer must never be invented into the picture.
    expect(HELPER_SCRIPT).toContain('if ((ci.flags & 0x00000001) == 0 || ci.hCursor == IntPtr.Zero) return;');
    // GetIconInfo hands over two bitmap copies; the cursor handle itself is shared.
    expect(HELPER_SCRIPT).toContain('if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);');
    expect(HELPER_SCRIPT).toContain('if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);');
  });

  /** And the same guarantee on the macOS side, where the capture API does it for us. */
  it('keeps the pointer in every macOS capture path', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift.match(/configuration\.showsCursor = true/g)).toHaveLength(2);
    expect(swift).toMatch(/private func captureWindow[\s\S]*configuration\.showsCursor = true/);
    expect(swift).toMatch(/private func captureDisplay[\s\S]*configuration\.showsCursor = true/);
  });
});
