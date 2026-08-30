import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');
const computer = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');

describe('macOS desktop safety hardening', () => {
  it('requires exact Workspace, WindowServer and AX agreement for physical input', () => {
    expect(swift).toContain('private func windowServerFrontWindowID');
    expect(swift).toContain('private func focusedAXWindowID');
    expect(swift).toContain('private func focusedAXElementWindowID');
    expect(swift).toContain('private func assertInputTarget');
    expect(swift).toContain('private func assertFrameTarget');
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*frontmostPID\(\) == row\.pid/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard focusedAXElementWindowID\(for: row\.pid, rows: rows\) == row\.id/);
  });

  it('revalidates a window-bound frame at every physical mutation boundary', () => {
    expect(swift).toMatch(/case "move":[\s\S]*assertFrameTarget\(frame\)[\s\S]*movePointer/);
    expect(swift).toMatch(/case "click", "double_click":[\s\S]*assertFrameTarget\(frame\)[\s\S]*guard let target = leasedWindow[\s\S]*targetWindow: target/);
    expect(swift).toMatch(/case "scroll":[\s\S]*assertFrameTarget\(frame\)[\s\S]*event\.post/);
    expect(swift).toMatch(/case "drag":[\s\S]*assertFrameTarget\(frame\)[\s\S]*guard let target = leasedWindow[\s\S]*targetWindow: target/);
    expect(swift).toMatch(/private func click[\s\S]*assertInputTarget\(targetWindow\)/);
    expect(swift).toMatch(/private func drag[\s\S]*assertInputTarget\(targetWindow\)/);
  });

  it('bounds AX-derived strings and keeps surrogate pairs in one text event', () => {
    expect(swift).toContain('private let maxAXStringCharacters = 4_096');
    expect(swift).toContain('return boundedAXString(value)');
    expect(swift).toContain('boundedAXString(axString(element, kAXIdentifierAttribute');
    expect(swift).toContain('units[end - 1] >= 0xD800');
    expect(swift).toContain('units[end] >= 0xDC00');
    expect(swift).toContain('end -= 1');
  });

  it('carries explicit modifier flags on synthesized shortcut events', () => {
    expect(swift).toContain('private let modifierFlags: [String: CGEventFlags]');
    expect(swift).toContain('event.flags = flags');
    expect(swift).toContain('CGEventSource(stateID: .privateState)');
    expect(swift).toContain('TISCopyCurrentKeyboardLayoutInputSource');
    expect(swift).toContain('UCKeyTranslate');
    expect(swift).toContain('active keyboard layout does not expose logical key');
    expect(preparation).toMatch(/'-framework',\s*'Carbon'/);
  });

  it('routes system shortcuts globally and rejects disabled semantic controls', () => {
    expect(swift).toContain('private func isSystemShortcut');
    expect(swift).toContain('if globalShortcut { event.post(tap: .cghidEventTap) }');
    expect(swift).toContain('UI_ACTION_DISABLED');
    expect(swift).toContain('the referenced accessibility control is disabled');
    expect(swift).toContain('axBool(element, kAXEnabledAttribute as CFString, default: false)');
    expect(swift).toContain('["volumeup", "volumedown", "mute"]');
    expect(swift).toContain('(1...20).contains(value)');
  });

  it('rejects physical points that fall between active displays', () => {
    expect(swift).toContain('private func activeDisplayRects');
    expect(swift).toContain('private func requirePointOnActiveDisplay');
    expect(swift).toContain('OUTSIDE_ACTIVE_DISPLAY');
    expect(swift).toContain('for point in points { try requirePointOnActiveDisplay(point, displays: displays) }');
  });

  it('keeps old ScreenCaptureKit allocations bounded and window geometry honest', () => {
    expect(swift).toMatch(/if #available\(macOS 13\.0, \*\) \{\s*configuration\.width = width\s*configuration\.height = height/);
    expect(swift).toContain('CAPTURE_GEOMETRY_UNSAFE');
    expect(swift).toContain('configuration.ignoreShadowsSingleWindow = true');
    expect(swift).toContain('native display capture exceeds the decoded-pixel budget on macOS 12');
    expect(swift).toContain('private let maxEncodedScreenshotBytes = 6_242_304');
    expect(computer).toContain('export const MAX_SCREENSHOT_PNG_BYTES');
    expect(computer).toContain('SCREENSHOT_TOO_LARGE: encoded PNG');
  });

  it('bounds native AX messaging, traversal breadth and aggregate traversal time', () => {
    expect(swift).toContain('AXUIElementSetMessagingTimeout(system, 1.0)');
    expect(swift).toContain('private let maxAXTraversalSeconds = 6.0');
    expect(swift).toContain('accessibility traversal exceeded its bounded native deadline');
    expect(swift).toContain('AXUIElementCopyAttributeValues');
    expect(swift).toContain('axChildren(element, limit: remainingBudget)');
  });

  it('validates AX value types and the live owning window of every semantic ref', () => {
    expect(swift).toMatch(/private func axPoint[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toMatch(/private func axSize[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toContain('private func unambiguousWindowID');
    expect(swift).toContain('private func owningAXWindowID');
    expect(swift).toContain('axPID(element) == currentWindow.pid');
    expect(swift).toMatch(/private func actUI[\s\S]*owningAXWindowID\(element, pid: currentWindow\.pid\) == snapshot\.window/);
  });

  it('binds screen frames to the exact active-display topology', () => {
    expect(swift).toContain('private func sameDisplayTopology');
    expect(swift).toContain('"displays": displayTopologyObject(finalDisplayRects)');
    expect(swift).toContain('active display topology changed after the screenshot');
    expect(computer).toContain('displayTopology: Rect[] | null');
    expect(computer).toContain('displays: frame.displayTopology');
  });

  it('publishes only the newest overlapping macOS permission refresh', () => {
    expect(computer).toContain('macOSDesktopAccessRefreshGeneration');
    expect(computer).toContain('generation === macOSDesktopAccessRefreshGeneration');
  });

  it('keeps permission prompting in Electron and native execution fail-closed', () => {
    expect(swift).toContain('Swift code inside the Electron process on a Node Worker');
    expect(swift).toContain('Electron owns prompting through systemPreferences');
    expect(swift).not.toContain('AXIsProcessTrustedWithOptions');
    expect(swift).not.toContain('older unsigned/ad-hoc build');
  });

  it('keeps the fork targetWindow lease while preserving exact partial route evidence', () => {
    expect(swift).toContain('var leasedWindow = frameWindow ?? requestedTargetWindow');
    expect(swift).toContain('INPUT_TARGET_REQUIRED');
    expect(computer).toContain('targetWindow: number | null');
    expect(computer).toContain('readonly completedRoutes: ActionRoute[] | null');
    expect(computer).toContain('function completedHelperRoutes');
    expect(computer).toContain('const routeEvidence = exactRoutes');
  });

  it('bounds AX window copies and shares one native find_ui deadline', () => {
    expect(swift).toContain('private func axElementValues');
    expect(swift).toContain('axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)');
    expect(swift).not.toContain('windows.prefix(64)');
    expect(swift).toContain('matchingAXWindow(_ row: WindowRow, deadline suppliedDeadline: TimeInterval? = nil)');
    expect(swift).toContain('let root = try matchingAXWindow(row, deadline: deadline)');
  });

  it('keeps visible fallback pixels screen-bound and clamps edge coordinates', () => {
    expect(computer).toContain("const frameWindow = captureMode === 'window' ? requestedWindow : null");
    expect(computer).toContain("frame.captureMode !== 'screen_fallback'");
    expect(computer).toContain('const clampMappedCoordinate =');
    expect(computer).toContain('INPUT_TARGET_UNPROVEN: visible screen_fallback pixels cannot authorize window-bound coordinate input');
  });

  it('bounds WindowServer strings and revalidates screen topology throughout long drags', () => {
    expect(swift).toContain('let process = boundedAXString(string(item[kCGWindowOwnerName as String]');
    expect(swift).toContain('let displayTitle = boundedAXString(title.isEmpty ?');
    expect(swift).toContain('expectedDisplays: [CGRect]? = nil');
    expect(swift).toContain('active display topology changed during the drag');
    expect(swift).toContain('targetWindow: target,');
    expect(swift).toContain('expectedDisplays: frameWindow == nil ? displayTopology(frame?["displays"]) : nil');
    expect(swift).toMatch(/func assertDragTarget[\s\S]*assertInputTarget\(targetWindow\)[\s\S]*sameDisplayTopology\(expectedDisplays, currentDisplays\)/);
  });

  it('keeps valid screenshots when only AX semantic traversal is unavailable', () => {
    expect(swift).toContain('error.code == "ACCESSIBILITY_PERMISSION_REQUIRED" ||');
    expect(swift).toContain('error.code == "UIA_FAILED" ||');
    expect(swift).toContain('error.code == "UIA_TIMEOUT"');
    expect(swift).toContain('throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")');
  });

  it('retains the documented process-global AX timeout contract', () => {
    expect(swift).toContain('let system = AXUIElementCreateSystemWide()');
    expect(swift).toContain('AXUIElementSetMessagingTimeout(system, 1.0)');
  });

  /**
   * The 2.0.2 release blocker: `pressKeys` read the active input source from the Node worker
   * thread the addon is entered on. Text Services is main-queue-affine, so macOS did not
   * return an error — `dispatch_assert_queue` failed and EXC_BREAKPOINT took the whole host
   * process down, below anything Swift or JS could catch.
   *
   * This file cannot execute the addon, so it holds the shape of the fix: the Text Services
   * calls appear only inside the main-queue read, the wait is bounded rather than
   * `DispatchQueue.main.sync`, and the search that does not need main affinity stays off it.
   */
  it('reads the keyboard input source on the main queue, without sync or an unbounded wait', () => {
    expect(swift).toContain('private func currentKeyboardLayout() -> KeyboardLayoutSnapshot?');
    // Both Text Services calls live in that one function and nowhere else.
    expect(swift.match(/TISCopyCurrentKeyboardLayoutInputSource/g)).toHaveLength(1);
    expect(swift.match(/TISGetInputSourceProperty/g)).toHaveLength(1);
    expect(swift).toMatch(
      /private func currentKeyboardLayout\(\)[\s\S]*TISCopyCurrentKeyboardLayoutInputSource[\s\S]*TISGetInputSourceProperty[\s\S]*if Thread\.isMainThread \{ return read\(\) \}[\s\S]*DispatchQueue\.main\.async/
    );

    // Already on main runs inline, and a busy main thread refuses instead of hanging.
    expect(swift).toContain('if Thread.isMainThread { return read() }');
    // The call, not the prose: the function's own comment names it as the thing to avoid.
    expect(swift).not.toMatch(/DispatchQueue\.main\.sync\s*[({]/);
    expect(swift).toContain('private let keyboardLayoutMainQueueTimeout: TimeInterval = 2.0');
    expect(swift).toContain('done.wait(timeout: .now() + keyboardLayoutMainQueueTimeout) == .success');
    expect(swift).toContain('"the active keyboard layout could not be read in time"');

    // The layout bytes are copied out: they belong to an input source released on return.
    expect(swift).toContain('Data(bytes: bytes, count: CFDataGetLength(data))');
    // UCKeyTranslate is pure over those bytes, so the 128-keycode search — the expensive
    // half — stays out of the main-queue section and off the UI thread entirely.
    const mainQueueSection = swift.slice(
      swift.indexOf('private func currentKeyboardLayout()'),
      swift.indexOf('private func currentLayoutKey(')
    );
    expect(mainQueueSection).toContain('TISGetInputSourceProperty');
    expect(mainQueueSection).not.toContain('UCKeyTranslate');
    expect(swift).toMatch(
      /private func currentLayoutKey\(for logicalName: String, in snapshot: KeyboardLayoutSnapshot\)[\s\S]*UCKeyTranslate/
    );
  });

  /**
   * And the ordering the crash fix must not cost us: the layout is taken before any window
   * authority is resolved, so the existing revalidations still sit immediately before the
   * events they guard. Fixing a P1 crash must not open a wrong-window race.
   */
  it('takes the layout snapshot once, ahead of every target-window revalidation', () => {
    expect(swift).toMatch(
      /let layout = normalized\.contains \{ \$0\.count == 1 \} \? currentKeyboardLayout\(\) : nil\s*\n\s*let resolved = try normalized\.map \{ try resolveKey\(\$0, in: layout\) \}/
    );
    expect(swift).toMatch(
      /let resolved = try normalized\.map \{ try resolveKey\(\$0, in: layout\) \}[\s\S]*if let targetWindow \{ targetPID = try assertInputTarget\(targetWindow\)\.pid \}/
    );
    expect(swift).toMatch(
      /A window transition while modifiers are down must abort before the ordinary key\.\s*\n\s*if let targetWindow \{ targetPID = try assertInputTarget\(targetWindow\)\.pid \}/
    );
  });
});
