import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const computer = source('src/main/computer/index.ts');
const tools = source('src/main/mcp/tools-desktop.ts');
const instructions = source('src/main/mcp/instructions.ts');
const release = source('.github/workflows/release.yml');
const ci = source('.github/workflows/ci.yml');

describe('macOS Computer Use v12', () => {
  it('uses a Swift/Xcode-safe typed AXUIElement boundary', () => {
    expect(swift).toContain('private func axElementAttribute');
    expect(swift).toContain('CFGetTypeID(value) == AXUIElementGetTypeID()');
    expect(swift).not.toContain('as? AXUIElement');
  });

  it('uses live Workspace + AX focused-window authority instead of a cached foreground id', () => {
    expect(swift).toContain('private func focusedAXWindowID(for pid: pid_t');
    expect(swift).toContain('NSWorkspace.shared.frontmostApplication?.processIdentifier');
    expect(swift).toContain('kAXFocusedWindowAttribute');
    expect(swift).toContain('inputTargetMatches');
    expect(swift).toContain('windowServerFrontWindowID');
  });

  it('fails closed before keyboard input when no exact target is leased', () => {
    expect(swift).toContain('INPUT_TARGET_REQUIRED');
    expect(swift).toContain('click input requires a target window');
    expect(swift).toContain('scroll input requires a target window');
    expect(swift).toContain('drag input requires a target window');
    expect(swift).toContain('TARGET_APP_NOT_FRONTMOST');
    expect(swift).toContain('AX_FOCUS_FAILED');
    expect(swift).toContain('WINDOW_NOT_KEY_WINDOW');
    expect(swift).toContain('INPUT_TARGET_LOST');
    expect(swift).toContain('private func assertInputTarget');
    expect(swift).toContain('private func activateInputTarget');
    expect(swift).not.toContain('try activateInputTarget(windowID)');
    expect(swift).not.toContain('if type == "click_ui" { try activateInputTarget(actionWindow) }');
    expect(swift).toContain('_ = try assertInputTarget(snapshot.window)');
    expect(swift).toContain('typeText(string(action["text"]), targetWindow: leasedWindow)');
    expect(swift).toMatch(/case "keypress":[\s\S]*assertInputTarget\(leasedWindow\)[\s\S]*pressKeys/);
  });

  it('carries explicit modifier flags on the ordinary key events', () => {
    expect(swift).toContain('private let modifierFlags: [String: CGEventFlags]');
    expect(swift).toContain('event.flags = flags');
    expect(swift).toContain('event.postToPid(target.pid)');
    expect(swift).toContain('down.postToPid(target.pid)');
    expect(swift).toContain('previous >= 0xD800 && previous <= 0xDBFF');
    expect(swift).toContain('CGEventSource(stateID: .privateState)');
  });

  it('makes semantic and physical click intent visible at the pointer', () => {
    expect(swift).toContain('movePointerSmoothly');
    expect(swift).toContain('tryPressElement(at: point, target: row)');
    expect(swift).toContain('safeHitTestPressRoles');
    expect(swift).toContain('configuration.showsCursor = true');
    expect(swift).not.toContain('cachedShareableContent');
    expect(swift).toContain('setAXValueIfPossible(appElement, kAXFocusedWindowAttribute as CFString, window)');
  });

  it('exposes a targetWindow contract and automatically returns visual feedback', () => {
    expect(computer).toContain('targetWindow?: number');
    expect(computer).toContain('targetWindow: inferredTargetWindow');
    expect(tools).toContain('targetWindow: windowIdArg.optional()');
    expect(tools).toContain('const autoCapture = caps.screen && captureAfter !== false && mutatesDesktop');
    expect(tools).toContain('const willCapture = input.captureAfter === true || verifyCapture || autoCapture');
    expect(tools).toContain('window: captureWindow,');
    expect(tools).toContain('decisionActions.length > 1');
    expect(tools).toContain('captureMaxWidth ?? (autoCapture ? 1600 : undefined)');
    expect(computer).toContain('captureFallback');
    expect(instructions).toContain('pass the observed window id as targetWindow');
    expect(source('test/macos-computer-live.test.ts')).toContain('COS_INPUT_TARGET_LOST_PROBE');
    expect(source('test/macos-computer-live.test.ts')).toContain('COS_LIVE_MACOS_SOAK_ITERATIONS');
  });

  it('makes CI compile both real macOS helper architectures and keeps Windows verification deterministic', () => {
    expect(ci).toContain("node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch x64");
    expect(ci).toContain("node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64");
    expect(ci).toContain("VITEST_MAX_WORKERS=1");
  });

  it('keeps Linux smoke cleanup from turning successful GUI evidence into a red release', () => {
    expect(release).toContain('cleanup_path_with_retries');
  });
});
