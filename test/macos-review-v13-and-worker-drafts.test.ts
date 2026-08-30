import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const computer = source('src/main/computer/index.ts');
const prep = source('scripts/prepare-macos-desktop-helper.mjs');
const content = source('extension/content.js');
const dom = source('extension/chatgpt-dom.js');
const popup = source('extension/popup.js');
const popupHtml = source('extension/popup.html');
const packageJson = source('package.json');

describe('macOS review v13 and worker draft hardening', () => {
  it('serializes the lazy Electron binary install before parallel verify workers', () => {
    expect(packageJson).toContain('\"verify:ci\": \"install-electron --no && npm run rg');
  });

  it('rejects ambiguous AX focus geometry across every focus authority path', () => {
    expect(swift).toContain('private func uniqueGeometryWindowID');
    expect(swift).toContain('AX_WINDOW_AMBIGUITY_DISTANCE');
    expect(swift).toContain('multiple accessibility windows ambiguously match');
    expect(swift).toMatch(/focusedAXWindowID[\s\S]*uniqueGeometryWindowID/);
    expect(swift).toMatch(/focusedAXElementWindowID[\s\S]*uniqueGeometryWindowID/);
    expect(swift).toMatch(/inputTargetMatches[\s\S]*windowServerFrontWindowID[\s\S]*focusedAXWindowID/);
  });

  it('bounds AX work while enqueuing and refuses disabled semantic actions', () => {
    expect(swift).toContain('AXUIElementGetAttributeValueCount');
    expect(swift).toContain('AXUIElementCopyAttributeValues');
    expect(swift).toContain('remainingVisitBudget');
    expect(swift).toContain('queueTruncated');
    expect(swift).toContain('UI_ACTION_DISABLED');
    expect(swift).toContain('MAX_AX_STRING_CHARACTERS = 4_096');
  });

  it('rejects monitor-union holes before physical pointer events', () => {
    expect(swift).toContain('private func activeDisplayRects');
    expect(swift).toContain('private func requirePointOnActiveDisplay');
    expect(swift).toContain('OUTSIDE_ACTIVE_DISPLAY');
    expect(swift).toContain('for point in points { try requirePointOnActiveDisplay(point, displays: displays) }');
  });

  it('uses the active keyboard layout and globally routes system-owned keys', () => {
    expect(swift).toContain('import Carbon.HIToolbox');
    expect(prep).toMatch(/'-framework',\s*'Carbon'/);
    expect(swift).toContain('TISCopyCurrentKeyboardLayoutInputSource');
    expect(swift).toContain('UCKeyTranslate');
    expect(swift).toContain('globallyRoutedSystemKeys');
    expect(swift).toContain('"volumeup", "volumedown", "mute"');
    expect(swift).toContain('"\\\\": 42');
    expect(swift).toContain('if globalShortcut { event.post(tap: .cghidEventTap) }');
    expect(swift).toContain('else { event.postToPid(target.pid) }');
  });

  it('keeps capture source buffers bounded on the full macOS 12.3 floor despite SDK annotation drift', () => {
    expect(swift).toContain('NSSelectorFromString("setWidth:")');
    expect(swift).toContain('NSSelectorFromString("setHeight:")');
    expect(swift).toContain('configuration.setValue(NSNumber(value: width), forKey: "width")');
    expect(swift).not.toContain('if #available(macOS 13.0, *)');
    expect(swift).toContain('WINDOW_CAPTURE_FALLBACK_REQUIRED');
    expect(swift).toContain('configuration.ignoreShadowsSingleWindow = true');
    expect(swift).toContain('MAX_CAPTURE_PIXELS = 8_000_000');
  });

  it('sizes parent deadlines for native capture and the real v12 focus budget', () => {
    expect(computer).toContain("return platform === 'darwin' ? 120_000 : 10_000");
    expect(computer).toContain("* 3_000");
    expect(computer).toContain('export function helperTimeoutMs');
  });

  it('offers a persistent opt-in Replace worker drafts setting that defaults off', () => {
    expect(popupHtml).toContain('id="replaceDraftToggle"');
    expect(popupHtml).toContain('Replace worker drafts');
    expect(popupHtml).not.toContain('id="replaceDraftToggle" type="checkbox" checked');
    expect(popup).toContain("const REPLACE_WORKER_DRAFTS_KEY = 'replaceWorkerDrafts'");
    expect(popup).toContain('stored[REPLACE_WORKER_DRAFTS_KEY] === true');
    expect(popup).toContain('webext.storage.local.set({ [REPLACE_WORKER_DRAFTS_KEY]: replaceWorkerDrafts })');
  });

  it('only replaces a draft on a redeemed fresh bootstrap and still verifies exact text before Send', () => {
    expect(content).toContain('const RECORDER_VERSION = 11');
    expect(content).toContain("(boot.type === 'worker' || boot.type === 'resume')");
    expect(content).toContain('replaceExistingDraft = await replaceWorkerDraftsEnabled()');
    expect(content).toContain("if (!CLF_DOM.insertPrompt(boot.text, replaceExistingDraft))");
    expect(content).toContain('waitForRevivalSubmitReady(openedConversation, attempt)');
    expect(content).toContain("the composer changed before bootstrap send; the draft was preserved");
    expect(dom).toContain('function insertPrompt(value, replaceExisting = false)');
    expect(dom).toContain('range.selectNodeContents(box)');
  });
});
