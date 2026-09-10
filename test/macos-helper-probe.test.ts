import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { checkMacOSHelperReplies } from '../scripts/probe-macos-helper.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cos-helper-probe-'));
const file = path.join(dir, 'screen.png');
afterEach(() => rmSync(file, { force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const warm = { ok: true, ready: true, screenPermission: false, accessibilityPermission: false };
const refusal = { ok: false, error_code: 'SCREEN_PERMISSION_REQUIRED' };
const replies = (first: unknown, second: unknown) => `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;

it('accepts the named permission refusal on a runner without Screen Recording', () => {
  expect(checkMacOSHelperReplies(replies(warm, refusal), file)).toBe('screen-permission-required');
});

it('checks the dimensions and PNG signature of a successful capture', () => {
  const output = replies({ ...warm, screenPermission: true }, { ok: true, image: { width: 320, height: 200 } });
  expect(() => checkMacOSHelperReplies(output, file)).toThrow();
  writeFileSync(file, Buffer.from('not a PNG'));
  expect(() => checkMacOSHelperReplies(output, file)).toThrow();
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
  expect(checkMacOSHelperReplies(output, file)).toBe('captured-png');
});

it.each([
  '', 'not JSON', replies({ ok: false }, refusal),
  replies(warm, { ok: false, error_code: 'CAPTURE_FAILED' }),
  replies({ ...warm, screenPermission: true }, refusal),
  replies(warm, { ok: true }),
  replies(warm, refusal) + '{}\n'
])('rejects malformed, incomplete or unexpected helper output: %s', (output) => {
  expect(() => checkMacOSHelperReplies(output, file)).toThrow();
});
