import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

it.runIf(process.platform === 'win32')('enforces the window lease in the Windows dispatcher without native input', () => {
  const start = HELPER_SCRIPT.indexOf('function Handle-Request(');
  expect(start, 'missing PowerShell Handle-Request function').toBeGreaterThanOrEqual(0);
  const end = HELPER_SCRIPT.indexOf('\nwhile (($line', start);
  expect(end, 'missing stdin loop after Handle-Request').toBeGreaterThan(start);
  const dispatch = HELPER_SCRIPT.slice(start, end);
  // Run the actual PowerShell dispatcher with an inert Win32 boundary. No SendInput, focus
  // changes or desktop session are needed, including on headless Windows CI runners.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
public static class Clf {
  public static long Foreground = 77;
  public static int Sent = 0;
  public static bool LoseFocus = false;
  public static long ForegroundId() { return Foreground; }
  public static string Cursor() { return "0,0"; }
  public static void Type(string text) { Sent++; if (LoseFocus) Foreground = 88; }
  public static void Press(ushort[] keys) { Sent++; }
}
'@
function Assert-Focused([int64]$id) { [Clf]::Foreground = $id }
function Assert-CoordinateFrame($frame) { if ($frame.window) { [Clf]::Foreground = $frame.window } }
function Vk($key) { return 65 }
${dispatch}
$results = @()
foreach ($case in @('wrong', 'exact', 'focus', 'lost', 'keypress', 'conflict', 'frame-conflict')) {
  [Clf]::Foreground = if ($case -in @('wrong', 'focus', 'keypress')) { 88 } else { 77 }
  [Clf]::Sent = 0
  [Clf]::LoseFocus = $case -eq 'lost'
  $request = @{ op = 'act'; targetWindow = 77; actions = @(@{ type = 'type'; text = 'example' }) }
  if ($case -eq 'focus') { $request.actions = @(@{ type = 'focus'; window = 77 }) + $request.actions }
  if ($case -eq 'lost') { $request.actions += @{ type = 'type'; text = 'second' } }
  if ($case -eq 'keypress') { $request.actions = @(@{ type = 'keypress'; keys = @('a') }) }
  if ($case -eq 'conflict') { $request.actions = @(@{ type = 'focus'; window = 88 }) }
  if ($case -eq 'frame-conflict') { $request.frame = @{ window = 88 } }
  try { $reply = Handle-Request $request } catch { $reply = @{ ok = $false; message = $_.Exception.Message } }
  $results += @{ case = $case; sent = [Clf]::Sent; foreground = [Clf]::Foreground; reply = $reply }
}
ConvertTo-Json -InputObject $results -Depth 8 -Compress
`;
  const results = JSON.parse(execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', timeout: 25_000 }));
  expect(results).toMatchObject([
    { case: 'wrong', sent: 0, foreground: 88, reply: { ok: false, error_code: 'INPUT_TARGET_LOST', completed_count: 0, routes: [] } },
    { case: 'exact', sent: 1, reply: { ok: true, completed_count: 1, routes: ['sendinput'] } },
    { case: 'focus', sent: 1, foreground: 77, reply: { ok: true, completed_count: 2, routes: ['focus', 'sendinput'] } },
    { case: 'lost', sent: 1, reply: { ok: false, error_code: 'INPUT_TARGET_LOST', completed_count: 1, routes: ['sendinput'] } },
    { case: 'keypress', sent: 0, reply: { ok: false, error_code: 'INPUT_TARGET_LOST', completed_count: 0 } },
    { case: 'conflict', sent: 0, foreground: 77, reply: { ok: false, error_code: 'TARGET_WINDOW_CONFLICT' } },
    { case: 'frame-conflict', sent: 0, foreground: 77, reply: { ok: false, message: expect.stringContaining('TARGET_WINDOW_CONFLICT') } }
  ]);
});
