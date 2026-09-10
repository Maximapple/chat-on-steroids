import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkMacOSHelperReplies(stdout, file) {
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, 'expected one warm reply and one capture reply');
  const [warm, capture] = lines.map((line) => JSON.parse(line));
  assert.equal(warm.ok, true, 'helper warm-up failed');
  assert.equal(warm.ready, true, 'helper did not become ready');
  assert.equal(typeof warm.screenPermission, 'boolean');
  assert.equal(typeof warm.accessibilityPermission, 'boolean');
  if (capture.ok === false) {
    assert.equal(warm.screenPermission, false, 'capture failed despite a Screen Recording grant');
    assert.equal(capture.error_code, 'SCREEN_PERMISSION_REQUIRED', 'unexpected capture failure');
    return 'screen-permission-required';
  }
  assert.equal(capture.ok, true, 'malformed capture reply');
  assert.ok(capture.image?.width > 0 && capture.image?.height > 0, 'missing capture dimensions');
  const png = readFileSync(file);
  assert.ok(png.length > 8 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'capture did not write a PNG');
  return 'captured-png';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.platform, 'darwin', 'run this probe on a Mac');
  const arch = process.argv[2] ?? process.arch;
  assert.ok(arch === 'arm64' || arch === 'x64', 'expected arm64 or x64');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const binary = path.join(root, 'resources', 'packaging', 'desktop', 'darwin', arch, 'macos-desktop-helper');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cos-helper-probe-'));
  try {
    const file = path.join(dir, 'screen.png');
    // No activation or input. Headless CI must reach the named permission refusal, not
    // silently pass on a crash, missing executable, malformed reply or arbitrary error.
    const stdout = execFileSync(binary, [], {
      input: `${JSON.stringify({ op: 'warm' })}\n${JSON.stringify({ op: 'capture', file, maxWidth: 320 })}\n`,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024
    });
    console.log(`macOS ${arch} helper runtime probe passed: ${checkMacOSHelperReplies(stdout, file)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
