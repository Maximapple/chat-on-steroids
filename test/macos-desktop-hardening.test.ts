import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const computer = source('src/main/computer/index.ts');
const connection = source('src/main/connection.ts');

describe('macOS Desktop PR #28 hardening', () => {
  it('fails closed unless the exact requested native window is foreground', () => {
    expect(swift).toContain('FOCUS_POLL_TIMEOUT_SECONDS');
    expect(swift).toContain('if inputTargetMatches(row) { return true }');
    expect(swift).toContain('focusedAXWindowID(for: row.pid)');
    expect(swift).not.toContain('foregroundWindowID() == id ||');
    expect(swift).toContain('no accessible window convincingly matches window');
    expect(swift).toContain('AX_WINDOW_GEOMETRY_TOLERANCE');
  });

  it('revalidates semantic physical-click fallbacks against their snapshot window', () => {
    expect(swift).toContain('guard try focusWindow(snapshot.window) else');
    expect(swift).toContain('live.bounds.integral == snapshot.windowBounds.integral');
    expect(swift).toContain('STALE_UI_SNAPSHOT');
  });

  it('keeps minimized windows discoverable and restorable', () => {
    expect(swift).toContain('guard layer == 0, alpha > 0 else { return nil }');
    expect(swift).not.toContain('guard layer == 0, onScreen, alpha > 0 else { return nil }');
    expect(swift).toContain('kAXMinimizedAttribute');
    expect(swift).toContain('kCFBooleanFalse');
  });

  it('preserves capture geometry and has an honest visible-screen fallback', () => {
    expect(swift).toContain('configuration.width = width');
    expect(swift).toContain('configuration.height = height');
    expect(swift).toContain('captureMode = "screen_fallback"');
    expect(swift).toContain('moved or resized during capture');
    expect(swift).toContain('MAX_CAPTURE_PIXELS = 8_000_000');
    expect(swift).toContain('fitPixelBudget(width: requestedWidth, height: requestedHeight)');
  });

  it('keeps screen-only observation usable without the stronger Accessibility grant', () => {
    expect(swift).toContain('screenshot returned without semantic controls');
    expect(swift).toContain('AXIsProcessTrusted()');
    expect(computer).toContain("const accessibilityNote =");
    expect(computer).toContain('omitted the requested UI snapshot without an explanation');
  });

  it('gives ScreenCaptureKit enough bounded parent time to finish its own budgets', () => {
    expect(computer).toContain("return process.platform === 'darwin' ? 60_000 : 10_000;");
    expect(computer).toContain("return process.platform === 'darwin' ? 70_000 : 10_000;");
  });

  it('explains the macOS 12.3 Desktop floor instead of calling old Monterey unsupported', () => {
    expect(connection).toContain('Desktop automation requires macOS 12.3 or newer');
    expect(connection).toContain('macOS 12.0-12.2');
  });
});
