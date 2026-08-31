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

/**
 * The same drag requirement, on the other platform.
 *
 * QA found the macOS drag reporting success while the file never moved, and the Windows helper
 * had the identical shape: press, jump to the destination, release. Explorer's shell drag makes
 * the same demands AppKit does — the press has to settle, the pointer has to travel continuously
 * far enough to cross the system threshold, and the destination needs a moment before the drop.
 * Fixing one platform and leaving the other is how a defect comes back wearing a different hat.
 */
describe('the Windows drag is paced like a real one', () => {
  it('holds the press, interpolates the path, and dwells before releasing', () => {
    expect(HELPER_SCRIPT).toContain('const int DragPressHoldMs');
    expect(HELPER_SCRIPT).toContain('const int DragDropDwellMs');
    expect(HELPER_SCRIPT).toContain('const double DragMaxStep');
    expect(HELPER_SCRIPT).toMatch(
      /Mouse\(down[\s\S]*Sleep\(DragPressHoldMs\)[\s\S]*Sleep\(DragStepMs\)[\s\S]*Sleep\(DragDropDwellMs\)[\s\S]*Mouse\(up/
    );
    // Bounded for the whole path, not per hop, so the cost of a drag does not grow with the
    // number of waypoints it happens to name — and cannot outlast the deadline that would kill
    // the helper before it releases the button.
    expect(HELPER_SCRIPT).toContain('const int DragMaxTotalSteps = 180;');
    expect(HELPER_SCRIPT).toContain('steps = (int)System.Math.Round(DragMaxTotalSteps * distance / total);');
    expect(HELPER_SCRIPT).not.toContain('if (steps > 240) steps = 240;');
  });
});

/**
 * A coordinate that claims to be in an image has to be in that image.
 *
 * The conversion from desktop to image space is plain arithmetic and answers for any point on
 * the desktop, including points the captured frame does not contain. So a pointer sitting below
 * a captured window produced "Pointer image: 875,754" for an image 646 pixels tall — a position
 * that cannot exist, which a caller would nonetheless use to address a pixel. QA found it.
 *
 * Outside the frame there is no image coordinate to give, and saying so is the whole fix: the
 * desktop position is still reported, and it is the one that was never in doubt.
 */
describe('the pointer never reports a position outside the image', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');
  const tool = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools-desktop.ts'), 'utf8');

  it('bounds the image coordinate by the frame it names', () => {
    expect(source).toContain('const inFrame = current');
    // Every edge of the frame, and the frame having to exist at all.
    expect(source).toMatch(
      /inFrame && current && inFrame\.x >= 0 && inFrame\.y >= 0 && inFrame\.x < current\.width && inFrame\.y < current\.height/
    );
  });

  it('says the pointer is outside rather than printing an impossible point', () => {
    expect(tool).toContain('it has no position in that image');
    // And still distinguishes that from having no frame at all, which is a different answer.
    expect(tool).toContain('No screenshot frame is active.');
  });
});

/**
 * A failed startup step must not take the control plane with it.
 *
 * Startup is one long promise chain, and it had nothing to catch a throw: anything that rejected
 * before the end silently stopped the rest — no bridge, no connect, no message. QA restarted the
 * app with Accessibility switched off, found the UI did not return, and both tunnels answered
 * tunnel_client_not_connected. A control plane that never started, indistinguishable from one
 * that started and broke.
 *
 * A permission the user revoked in System Settings must not be able to take the app's own
 * connection down with it.
 */
describe('startup survives a step that throws', () => {
  const main = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  it('logs the failure and still brings up the bridge and connection', () => {
    expect(main).toContain('let startedControlPlane = false;');
    expect(main).toContain('startedControlPlane = true;');
    expect(main).toMatch(/\.catch\(\(error: unknown\) => \{[\s\S]{0,400}logError\(`startup did not finish/);
    // The recovery is skipped when the control plane is already up, and when the window was
    // deliberately disabled — a second instance must not start a bridge behind the primary.
    expect(main).toMatch(/if \(startedControlPlane \|\| windowActivation\.isDisabled\(\)\) return;/);
    expect(main).toMatch(/\.catch\(\(error: unknown\)[\s\S]*void startBridge\(\)[\s\S]*void connect\(\)/);
  });
});
