import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');

describe('open upstream issue hardening bundle', () => {
  it('recognises normal and Project ChatGPT conversation routes', () => {
    const dom = source('extension/chatgpt-dom.js');
    const worker = source('extension/background.js');
    expect(dom).toContain("(?:^|\\/)c\\/([0-9a-f-]{8,64})(?:\\/|$)");
    expect(worker).toContain("(?:^|\\/)c\\/([0-9a-f-]{8,64})(?:\\/|$)");
  });

  it('ships one MV3 manifest that has Chrome and Firefox background fallbacks', () => {
    const manifest = JSON.parse(source('extension/manifest.json'));
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(121);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.scripts).toEqual(['background.js']);
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('128.0');
    expect(source('src/main/bridge.ts')).toContain("origin.startsWith('moz-extension://')");
  });

  it('keeps a browser-proven compaction capture out of recursive auto-compaction', () => {
    const content = source('extension/content.js');
    const continuation = source('src/main/session/continuation.ts');
    expect(content).toContain('if (compactCapture || nativeBusy || pressedAt > 0) return;');
    expect(content).toContain('compactToken: compactCapture.token');
    expect(continuation).toContain('export function touchContinuation');
    expect(continuation).toContain('Date.now() - entry.touchedAt < CONTINUATION_TTL_MS');
  });

  it('projects returned background exec lifecycle separately from pending MCP handlers', () => {
    const bridge = source('src/main/bridge.ts');
    const exec = source('src/main/codex/unified-exec.ts');
    const content = source('extension/content.js');
    expect(bridge).toContain('backgroundExec: backgroundExecForConversation');
    expect(exec).toContain('backgroundState(processId: number)');
    expect(content).toContain('exitedUnread');
    expect(content).toContain("entry.kind === 'agent_message'");
  });

  it('does not classify a bare local timeout as a control-plane outage', () => {
    const tunnel = source('src/main/tunnel/index.ts');
    expect(tunnel).toContain('CONTROL_PLANE_POLL');
    expect(tunnel).toContain('UNREACHABLE_NETWORK');
    expect(tunnel).toContain('supervisorStops');
    expect(tunnel).toContain('watcherEpoch');
    expect(tunnel).toContain('showWaiting');
  });

  it('scopes privacy history to the checked-out line and keeps fork inheritance buildable', () => {
    const verify = source('scripts/verify-public-history.mjs');
    expect(verify).not.toContain("runGit(['rev-list', '--all'])");
    expect(verify).toContain("runGit(['rev-list', 'HEAD'])");
    expect(verify).toContain("runGit(['tag', '--merged', 'HEAD', '--list'])");
    expect(verify).toContain('enforceHistoricalMaintainerIdentity');
  });
});
