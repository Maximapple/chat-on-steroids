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

  /**
   * Back and forward, the two buttons a browser actually navigates with.
   *
   * They are one event pair told apart by a data word rather than by their own flags, which
   * is why the flags helper had to start carrying it. Posted as real side-button events on
   * both platforms rather than as synthetic Alt+Arrow shortcuts: a shortcut goes to whatever
   * happens to be focused, a button goes to the window under the pointer.
   *
   * Verified against the compiled helper on Windows: left 0x0002/0x0004, right 0x0008/0x0010
   * and middle 0x0020/0x0040 all still carry data 0, back and forward both post XDOWN 0x0080
   * and XUP 0x0100 with XBUTTON1 and XBUTTON2, and an unknown name still falls back to left.
   */
  it('posts the back and forward side buttons as real button events', () => {
    expect(HELPER_SCRIPT).toContain('const uint MOUSEEVENTF_XDOWN = 0x0080, MOUSEEVENTF_XUP = 0x0100;');
    expect(HELPER_SCRIPT).toContain('const uint XBUTTON1 = 0x0001, XBUTTON2 = 0x0002;');
    expect(HELPER_SCRIPT).toContain('case "back": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = XBUTTON1; break;');
    expect(HELPER_SCRIPT).toContain('case "forward": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = XBUTTON2; break;');
    // The data word has to reach the event, or both side buttons would post as button 0.
    expect(HELPER_SCRIPT).toContain('ButtonFlags(button, out down, out up, out data);');
    expect(HELPER_SCRIPT).toMatch(/public static void Click[\s\S]*Mouse\(down, 0, 0, data\)[\s\S]*Mouse\(up, 0, 0, data\)/);
    expect(HELPER_SCRIPT).toMatch(/public static void Drag[\s\S]*Mouse\(down, 0, 0, data\)[\s\S]*Mouse\(up, 0, 0, data\)/);
  });

  /** And the same two buttons on macOS, by button number on an other-mouse event. */
  it('numbers the macOS side buttons instead of inventing shortcuts', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift).toContain('case "back": return CGMouseButton(rawValue: 3) ?? .center');
    expect(swift).toContain('case "forward": return CGMouseButton(rawValue: 4) ?? .center');
    // Left and right stay on their own event types; everything else is an other-mouse event.
    expect(swift).toMatch(/private func mouseTypes[\s\S]*case \.left: return \(\.leftMouseDown/);
    expect(swift).toMatch(/private func mouseTypes[\s\S]*case \.right: return \(\.rightMouseDown/);
    expect(swift).toMatch(/private func mouseTypes[\s\S]*default: return \(\.otherMouseDown/);
  });

  /**
   * The vocabulary a computer-use model actually emits.
   *
   * Two names were refused before they ever reached code that knew what to do with them:
   * `wheel` for the middle button, which both native layers have always accepted while the
   * schema rejected it, and the DOM arrow names, which are what browser key vocabulary uses.
   *
   * Checked against the shipped `Vk` on this machine: ArrowLeft/Right/Up/Down resolve to
   * 0x25/0x27/0x26/0x28, Enter, Return, Escape, Backspace, Delete, Tab, Space, Home, End,
   * PageUp, PageDown, ctrl, alt, shift, cmd, meta, super, win, option, F5 and plain
   * letters/digits all resolve, and an unknown name is still refused.
   */
  it('accepts the button and key names computer use emits', () => {
    expect(HELPER_SCRIPT).toContain("'ARROWUP'=0x26; 'ARROWDOWN'=0x28; 'ARROWLEFT'=0x25; 'ARROWRIGHT'=0x27;");
    expect(HELPER_SCRIPT).toContain("'WIN'=0x5B; 'SUPER'=0x5B; 'CMD'=0x5B; 'META'=0x5B;");
    expect(HELPER_SCRIPT).toContain("'CTRL'=0x11; 'CONTROL'=0x11; 'ALT'=0x12; 'OPTION'=0x12; 'SHIFT'=0x10;");
    // An unrecognised name must still fail rather than resolving to something arbitrary.
    expect(HELPER_SCRIPT).toContain('throw "BAD_KEY: Unknown key: $name"');

    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift).toContain('case "arrowleft": return "left"');
    expect(swift).toContain('case "arrowright": return "right"');
    expect(swift).toContain('case "arrowup": return "up"');
    expect(swift).toContain('case "arrowdown": return "down"');
    expect(swift).toContain('case "cmd", "meta", "super", "win": return "command"');

    const kernel = readFileSync(path.join(process.cwd(), 'src/main/mcp/kernel.ts'), 'utf8');
    expect(kernel).toContain("z.enum(['left', 'right', 'middle', 'wheel', 'back', 'forward'])");
    // Both native layers already routed wheel to the middle button; only the schema refused.
    expect(HELPER_SCRIPT).toContain('case "middle": case "wheel":');
    expect(swift).toContain('case "middle", "wheel": return .center');
  });

  /** And the same guarantee on the macOS side, where the capture API does it for us. */
  it('keeps the pointer in every macOS capture path', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift.match(/configuration\.showsCursor = true/g)).toHaveLength(2);
    expect(swift).toMatch(/private func captureWindow[\s\S]*configuration\.showsCursor = true/);
    expect(swift).toMatch(/private func captureDisplay[\s\S]*configuration\.showsCursor = true/);
  });
});
