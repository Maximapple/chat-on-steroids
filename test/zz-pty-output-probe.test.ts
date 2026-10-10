// TEMPORARY PROBE (draft PR, never merged): does node-pty lose a command's last output line at exit?
import { spawn } from 'node-pty';
import { expect, it } from 'vitest';
const WINDOWS = process.platform === 'win32';
function once(): Promise<boolean> {
  return new Promise(resolve => {
    let out = '';
    const pty = WINDOWS
      ? spawn('powershell.exe', ['-NoProfile', '-Command', "$line = [Console]::In.ReadLine(); Write-Output ('got=' + $line)"], { cols: 80, rows: 24, useConpty: true })
      : spawn('/bin/bash', ['-c', 'IFS= read -r line; printf "got=%s\\n" "$line"'], { cols: 80, rows: 24 });
    pty.onData(data => { out += data; });
    pty.onExit(() => resolve(out.includes('got=owner')));
    setTimeout(() => pty.write('owner\r'), WINDOWS ? 800 : 100);
  });
}
it.each([0, 250])('keeps the last output line through exit (event-loop stalls of %i ms)', async stall => {
  const busy = stall ? setInterval(() => { const until = Date.now() + stall; while (Date.now() < until) { /* stall */ } }, 10) : null;
  const runs = WINDOWS ? 30 : 200;
  let lost = 0;
  try { for (let i = 0; i < runs; i++) if (!(await once())) lost++; } finally { if (busy) clearInterval(busy); }
  console.log(`PTY-PROBE ${process.platform} stall=${stall} lost=${lost}/${runs}`);
  expect(lost).toBe(0);
}, 600_000);
