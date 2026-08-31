/**
 * Runs the freshly built macOS desktop helper on a real Mac and reports what it says.
 *
 * Until now "the macOS helper is fine" meant it compiled. Compiling proves the Swift parses; it
 * proves nothing about whether the binary starts, answers, or reaches its capture path — and the
 * pointer bug that started all of this was a runtime property, invisible to the compiler.
 *
 * A CI runner has no Screen Recording grant, so a capture here is expected to be refused. That
 * refusal is the useful part: a clean, named TCC refusal is a working code path, while a crash,
 * a hang, or a malformed reply is not. Anything that reaches the pointer compositor also prints
 * its verdict, which is the value a human QA pass would otherwise have to hunt for.
 *
 * Exits non-zero only for a helper that misbehaves: fails to start, stops answering, or returns
 * something that is not JSON. A permission refusal is information, not a failure — this probe
 * must never turn a green macOS build red for lacking a grant no CI runner has.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (process.platform !== 'darwin') {
  throw new Error(`probe-macos-helper.mjs must run on macOS, got ${process.platform}`);
}

const arch = process.argv[2] === 'x64' ? 'x64' : 'arm64';
const helper = path.resolve('resources', 'packaging', 'desktop', 'darwin', arch, 'macos-desktop-helper');
if (!existsSync(helper)) {
  throw new Error(`No built helper at ${helper}. Run prepare-macos-desktop-helper.mjs first.`);
}

// Only run a binary this machine can actually execute; a cross-built slice would fail in a way
// that says nothing about the code.
const native = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim() === 'arm64' ? 'arm64' : 'x64';
if (native !== arch) {
  console.log(`skipped: this runner is ${native}, the helper is ${arch}`);
  process.exit(0);
}

const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

const pending = [];
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const settle = pending.shift();
    if (settle) settle(line);
  }
});

let died = null;
child.once('exit', (code, signal) => { died = { code, signal }; });

/** One request, with a deadline: a helper that stops answering must not hang the build. */
function ask(request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    if (died) return reject(new Error(`helper already exited (${JSON.stringify(died)})`));
    const timer = setTimeout(() => reject(new Error(`no answer to ${request.op} within ${timeoutMs}ms`)), timeoutMs);
    pending.push((line) => { clearTimeout(timer); resolve(line); });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const results = [];
let failed = false;

async function probe(label, request) {
  let line;
  try {
    line = await ask(request);
  } catch (error) {
    console.log(`FAIL  ${label} — ${error.message}`);
    failed = true;
    return null;
  }
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    console.log(`FAIL  ${label} — reply was not JSON: ${line.slice(0, 200)}`);
    failed = true;
    return null;
  }
  const verdict = reply.ok === true ? 'ok' : `refused ${reply.error_code ?? '(no code)'}`;
  console.log(`ok    ${label} — ${verdict}`);
  results.push({ label, reply });
  return reply;
}

// Answering at all is the first thing worth knowing, and warm also states both TCC verdicts —
// which is what makes a later refusal interpretable rather than merely assumed.
const warm = await probe('the helper starts and answers', { op: 'warm' });
const screenGranted = warm?.['screenPermission'] === true;
if (warm?.ok === true) {
  console.log(`      screenPermission=${warm['screenPermission']} accessibilityPermission=${warm['accessibilityPermission']}`);
}

// The pointer, read through the main-queue hop because NSCursor is AppKit. This is the exact
// call the window compositor depends on, and the one whose nil case is the open question.
const cursor = await probe('it can be asked for the cursor', { op: 'cursor' });
if (cursor?.ok === true) {
  console.log(`      cursor=${JSON.stringify(cursor['cursor'])} foreground=${cursor['foreground']}`);
  // The compositor cannot place a pointer it was never given a position for.
  if (cursor['cursor'] === undefined || cursor['cursor'] === null) {
    console.log('FAIL  the cursor op answered without a cursor');
    failed = true;
  }
}

await probe('it can enumerate windows', { op: 'windows' });

// Expected to be refused on a runner with no Screen Recording grant. A named refusal is a
// working path; a crash or silence is not.
const shot = await probe('a capture either works or is refused by name', {
  op: 'capture',
  full: true,
  maxWidth: 640,
  file: path.join(process.env['TMPDIR'] ?? '/tmp', 'cos-probe-capture.png')
});
if (shot?.ok === true) {
  console.log(`      pointer=${shot['pointer'] ?? '(not reported)'} captureMode=${shot['captureMode'] ?? '?'}`);
  if (shot['pointer'] === undefined) {
    console.log('FAIL  a successful capture reported no pointer verdict');
    failed = true;
  }
} else if (shot) {
  console.log(`      refused: ${shot['error_code'] ?? '?'} — ${shot['message'] ?? ''}`);
  // Tolerant only where tolerance is earned. Without the grant a refusal is the correct
  // behaviour; with the grant, a refusal is a real failure and must not pass quietly.
  if (screenGranted) {
    console.log('FAIL  Screen Recording is granted here, so a refused capture is a defect');
    failed = true;
  }
}

child.stdin.end();
await new Promise((resolve) => setTimeout(resolve, 500));
child.kill();

if (stderr.trim()) console.log(`      helper stderr: ${stderr.trim().slice(0, 400)}`);
if (died && died.signal) {
  console.log(`FAIL  the helper died on ${died.signal}`);
  failed = true;
}

console.log(failed ? '\nmacOS helper probe FAILED' : `\nmacOS helper probe passed (${results.length} answers)`);
process.exit(failed ? 1 : 0);
