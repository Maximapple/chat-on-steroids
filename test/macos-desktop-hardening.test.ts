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
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*frontWindowID\(rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard focusedAXElementWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    // frontWindowID is still WindowServer z-order; it only resolves which of one app's own
    // windows is front. All four clauses above still have to agree.
    expect(swift).toMatch(/private func frontWindowID[\s\S]*windowServerFrontWindowID\(rows: rows\)/);
  });

  /**
   * QA hit `No foreground window` while Chrome was plainly the active application, twice in a
   * row, with Chrome's link-preview bubble (`175x22` at the screen edge) and its omnibox popup
   * on top. Both are ordinary layer-0 windows of the browser, so WindowServer's topmost window
   * was the bubble while AX focus — and the user's typing — was the real window. The mismatch
   * was read as "an app transition is in flight" and everything was refused, which also made
   * `focusWindow` poll `inputTargetMatches` for a condition it could never satisfy.
   *
   * Only that intra-application case is resolved, and only in the frontmost application:
   * a covering window owned by *another* process must still refuse.
   */
  it('resolves one app\'s transient child windows without relaxing cross-app refusal', () => {
    expect(swift).toContain('private func frontWindowID(rows: [WindowRow]) -> CGWindowID?');
    // Another app on top: returned as-is, so the caller's frontmostPID check still refuses.
    expect(swift).toContain(
      'guard let topRow = rows.first(where: { $0.id == top }), frontmostPID() == topRow.pid else { return top }'
    );
    // AX only wins when it names a different window this same scan already saw and admitted.
    expect(swift).toContain(
      'guard let focused = focusedAXWindowID(for: topRow.pid, rows: rows), focused != top else { return top }'
    );
    expect(swift).toContain(
      'guard rows.contains(where: { $0.id == focused && $0.pid == topRow.pid }) else { return top }'
    );
    // Both readers go through it, so observation and input can never disagree about which
    // window is front.
    expect(swift).toMatch(/private func foregroundWindowID[\s\S]*guard let frontID = frontWindowID\(rows: rows\)/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard frontWindowID\(rows: rows\) == row\.id/);
    expect(swift).not.toMatch(/private func inputTargetMatches[\s\S]{0,200}windowServerFrontWindowID/);
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
    // An explicit AXEnabled=false refuses every action, and silence still refuses a click.
    expect(swift).toContain('let enabled = axOptionalBool(element, kAXEnabledAttribute as CFString)');
    expect(swift).toContain(': (enabled ?? false)');
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
      /private func currentKeyboardLayout\(\)[\s\S]*onMainQueue \{[\s\S]*TISCopyCurrentKeyboardLayoutInputSource[\s\S]*TISGetInputSourceProperty/
    );

    // The layout bytes are copied out: they belong to an input source released on return.
    expect(swift).toContain('Data(bytes: bytes, count: CFDataGetLength(data))');
    // UCKeyTranslate is pure over those bytes, so the 128-keycode search — the expensive
    // half — stays out of the main-queue section and off the UI thread entirely.
    expect(swift).toMatch(
      /private func currentLayoutKey\(for logicalName: String, in snapshot: KeyboardLayoutSnapshot\)[\s\S]*UCKeyTranslate/
    );
    const hop = swift.slice(
      swift.indexOf('private func onMainQueue'),
      swift.indexOf('private let keyCodes')
    );
    expect(hop).not.toContain('UCKeyTranslate');
  });

  /**
   * One marshal, used by everything that needs AppKit or Text Services from the addon's
   * worker thread. A bounded, deadlock-free hop is exactly the primitive that must not exist
   * in two slightly different copies.
   */
  it('marshals to the main queue once, inline when already there and never unbounded', () => {
    expect(swift.match(/private func onMainQueue<Value>/g)).toHaveLength(1);
    expect(swift).toContain('if Thread.isMainThread { return work() }');
    // The call, not the prose: the function's own comment names it as the thing to avoid.
    expect(swift).not.toMatch(/DispatchQueue\.main\.sync\s*[({]/);
    expect(swift).toContain('private let mainQueueTimeout: TimeInterval = 2.0');
    expect(swift).toContain('done.wait(timeout: .now() + mainQueueTimeout) == .success');
    expect(swift).toContain('"the active keyboard layout could not be read in time"');
    // Every AppKit/Text Services reader goes through it rather than dispatching its own.
    expect(swift.match(/DispatchQueue\.main\.async/g)).toHaveLength(1);
  });

  /**
   * The pointer has to be drawn into a window capture, because `showsCursor` cannot reach it.
   *
   * A desktop-independent window filter captures the window detached from the desktop, and the
   * pointer is a display compositing layer rather than part of any window's content — so the
   * flag is set and does nothing on exactly the path an ordinary `observe` on a window uses.
   * Display capture keeps the system's own pointer, which is why only windows are composited.
   */
  it('composites the pointer into a window capture, at its hotspot', () => {
    expect(swift).toContain('private func drawingPointer(on image: CGImage, region: CGRect) -> (CGImage, String)');
    expect(swift).toMatch(
      /private func captureWindow[\s\S]*SCContentFilter\(desktopIndependentWindow: window\)[\s\S]*drawingPointer\(on: resized, region: region\)/
    );
    // Read through the shared hop, because NSCursor is AppKit.
    expect(swift).toMatch(/private func currentPointerImage\(\)[\s\S]*onMainQueue \{[\s\S]*NSCursor\.currentSystem/);
    // At the hotspot — the pixel the pointer addresses — not the image origin.
    expect(swift).toContain('let x = (location.x - pointer.hotSpot.x - region.minX) * scale');
    expect(swift).toContain('let top = (location.y - pointer.hotSpot.y - region.minY) * scale');
    // A pointer that is not over this window is not drawn onto it.
    expect(swift).toContain('region.contains(location)');
    // Display capture still gets the system pointer, and must not be composited twice.
    expect(swift.match(/configuration\.showsCursor = true/g)).toHaveLength(2);
    expect(swift).not.toMatch(/private func captureDisplay[\s\S]{0,600}drawingPointer/);
  });

  /**
   * A pointer missing from a window screenshot looks the same whichever reason caused it, and
   * that ambiguity already cost one round of guessing at which. So each way of drawing nothing
   * names itself, and the reason reaches the response — the only place a person reading a QA
   * report can see it.
   */
  /**
   * A drag has to look like a drag to the system that decides what a drag means.
   *
   * QA dragged a file in Finder three times, was told "Done" three times, and the file never
   * moved. The events were posted; nothing read them as a drag. AppKit distinguishes a press
   * that begins a drag session from one that is merely a click by whether the press settles and
   * whether the pointer then travels continuously past a threshold — and the old code pressed,
   * jumped straight to the destination, and released. Two waypoints are a teleport.
   *
   * Reported success without effect is worse than a clean failure, because a caller builds its
   * next decision on a world state that never happened.
   */
  it('paces a drag so the system reads it as one, rather than as a click', () => {
    expect(swift).toContain('private let dragPressHoldMicroseconds');
    expect(swift).toContain('private let dragDropDwellMicroseconds');
    expect(swift).toContain('private func dragSteps(from start: CGPoint, to end: CGPoint)');
    // Hold after the press, travel, then dwell before releasing — in that order.
    expect(swift).toMatch(
      /postMouse\(down[\s\S]*usleep\(dragPressHoldMicroseconds\)[\s\S]*dragSteps\(from: current[\s\S]*usleep\(dragDropDwellMicroseconds\)[\s\S]*postMouse\(up/
    );
    // Every interpolated event still re-proves the target; pacing must not cost the fence.
    expect(swift).toMatch(/for step in dragSteps[\s\S]{0,200}try assertDragTarget\(\)/);
    // And the interpolation is bounded, so a long drag cannot post unbounded events.
    expect(swift).toMatch(/min\(count, 240\)/);
  });

  it('says why no pointer was drawn, instead of drawing nothing silently', () => {
    for (const reason of ['unavailable', 'outside_region', 'buffer_unavailable', 'drawn']) {
      expect(swift).toContain(`"${reason}"`);
    }
    // The system draws the pointer for a display filter, so those paths say so rather than
    // claiming this code drew it.
    expect(swift).toMatch(/pointerNote = "system"/);
    // And it is actually reported, not just computed.
    expect(swift).toContain('"pointer": pointerNote');
    expect(swift).toMatch(/captureWindow[\s\S]{0,200}throws -> \(CGImage, CGRect, String\)/);
  });

  /**
   * QA found a blank TextEdit document refused with UI_ACTION_DISABLED while physical typing
   * into the same control worked. TextEdit's document AXTextArea publishes no AXEnabled
   * attribute at all, and the gate read that silence as false.
   *
   * A value write has a stronger authority available — accessibility says directly whether
   * AXValue can be written — so silence defers to that. Silence still refuses a click, and an
   * explicit AXEnabled=false still refuses everything: a control that says it is disabled is
   * disabled whatever it reports about settability.
   */
  it('lets a settable value speak for a control that publishes no AXEnabled', () => {
    expect(swift).toContain('private func axOptionalBool');
    expect(swift).toContain('private func axValueIsSettable');
    expect(swift).toContain(
      'let permitted = action == "set_value" ? (enabled ?? axValueIsSettable(element)) : (enabled ?? false)'
    );
    // Read once, before the branch, so the refusal cannot disagree with the write below it.
    expect(swift).toMatch(
      /let enabled = axOptionalBool\(element, kAXEnabledAttribute as CFString\)[\s\S]*guard permitted else \{[\s\S]*UI_ACTION_DISABLED/
    );
    expect(swift).toMatch(/if action == "set_value" \{\s*\n\s*guard axValueIsSettable\(element\),/);
    // The generic helper keeps its old meaning for every other caller.
    expect(swift).toContain('axOptionalBool(element, attribute) ?? fallback');
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
