import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const maintainerLogin = 'totec448-spec';
const safeMaintainerEmail = /^(?:\d+\+)?totec448-spec@users\.noreply\.github\.com$/i;

// Keep the blocked values split so this guard does not contain the data it rejects.
//
// `totec` here is the upstream maintainer's own local account; the fork's own contributor
// carries the same exposure and gets the same treatment — a QA report reached this check with
// a real `/Users/<name>/…` path and a real machine hostname in it (a code review caught both;
// this check did not, because the blocklist did not yet know either value existed) and both are
// now fixed at the source and added here so the same leak cannot recur unnoticed.
const blockedText = [
  { label: 'private maintainer email', value: ['totec448', 'gmail.com'].join('@') },
  { label: 'Claude session trailer', value: ['Claude', 'Session:'].join('-') },
  { label: 'Claude session URL', value: ['https://claude.ai/code/', 'session_'].join('') },
  { label: 'private Windows user path', value: ['C:', 'Users', 'totec'].join('\\') },
  { label: 'private macOS user path', value: ['', 'Users', 'maxim', ''].join('/') },
  { label: 'private machine hostname', value: ['Maxims', 'MacBook', 'Pro'].join('-') },
];

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function repositoryOwner() {
  // Ownership belongs to the repository being checked, not to an outer CI process.
  // Vitest creates temporary Git repositories for this gate; those child repos inherit
  // GITHUB_REPOSITORY/GITHUB_WORKSPACE from Actions and must not be mistaken for the fork.
  const remote = runGit(['config', '--get', 'remote.origin.url'], { allowFailure: true });
  if (remote.status === 0) {
    const value = String(remote.stdout ?? '').trim();
    const match = /(?:github\.com[/:])([^/:\s]+)\/[^/\s]+(?:\.git)?$/i.exec(value);
    if (match?.[1]) return match[1];
  }

  const workspace = String(process.env.GITHUB_WORKSPACE ?? '').trim();
  const fromActions = String(process.env.GITHUB_REPOSITORY ?? '').split('/')[0]?.trim();
  if (!workspace || !fromActions) return null;

  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(process.cwd()) === normalize(workspace) ? fromActions : null;
}

function findBlockedText(text, location) {
  const normalized = text.toLowerCase();
  return blockedText
    .filter(({ value }) => normalized.includes(value.toLowerCase()))
    .map(({ label }) => `${location} contains ${label}`);
}

function checkMaintainerIdentity(name, email, location) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedEmail = email.trim().replace(/^<|>$/g, '').toLowerCase();
  const belongsToMaintainer =
    normalizedName === maintainerLogin || normalizedEmail.includes(maintainerLogin);
  if (belongsToMaintainer && !safeMaintainerEmail.test(normalizedEmail)) {
    return [`${location} uses a non-noreply maintainer email`];
  }
  return [];
}

function parseGitIdent(ident) {
  const match = ident.match(/^(.*) <([^>]+)> \d+ [+-]\d{4}$/);
  if (!match) throw new Error('Could not parse the Git author identity.');
  return { name: match[1] ?? '', email: match[2] ?? '' };
}

function checkIndexedOrCommittedFiles(treeish) {
  const failures = [];
  for (const { label, value } of blockedText) {
    const args = ['grep', '-q', '-I', '-i', '-F', '-e', value];
    if (treeish === '--cached') args.push('--cached');
    else args.push(treeish);
    args.push('--', '.');
    const result = runGit(args, { allowFailure: true });
    if (result.status === 0) failures.push(`${treeish} contains ${label}`);
    else if (result.status !== 1) throw new Error(`git grep failed while checking ${label}`);
  }
  return failures;
}

function checkCurrentAuthor() {
  const ident = String(runGit(['var', 'GIT_AUTHOR_IDENT']).stdout).trim();
  const { name, email } = parseGitIdent(ident);
  return checkMaintainerIdentity(name, email, 'current Git author');
}

function checkMessageFile(messagePath) {
  return [
    ...checkCurrentAuthor(),
    ...findBlockedText(readFileSync(messagePath, 'utf8'), 'commit message'),
  ];
}

function checkHistory() {
  const failures = [];
  const head = runGit(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const commits =
    head.status === 0
      ? String(runGit(['rev-list', 'HEAD']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  // The maintainer's already-public upstream identity is inherited by every fork. It remains
  // strict in the upstream repository, while fork CI still checks current author, messages,
  // tracked content, and fork-reachable history for blocked text.
  const owner = repositoryOwner();
  const enforceHistoricalMaintainerIdentity =
    owner === null || owner.toLowerCase() === maintainerLogin;
  // pull_request jobs default to a GitHub-generated merge object that can never enter
  // public history. Its identity belongs to GitHub's test ref, not to the proposed tree.
  const syntheticPullRequestCommit =
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_SHA?.trim() : '';

  for (const commit of commits) {
    if (syntheticPullRequestCommit && commit === syntheticPullRequestCommit) continue;
    const record = String(
      runGit(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit]).stdout,
    );
    const [authorName = '', authorEmail = '', committerName = '', committerEmail = '', ...body] =
      record.split('\0');
    const location = `commit ${commit}`;
    failures.push(
      ...(enforceHistoricalMaintainerIdentity
        ? checkMaintainerIdentity(authorName, authorEmail, `${location} author`)
        : []),
      ...(enforceHistoricalMaintainerIdentity
        ? checkMaintainerIdentity(committerName, committerEmail, `${location} committer`)
        : []),
      ...findBlockedText(body.join('\0'), `${location} message`),
    );
  }

  const tags =
    head.status === 0
      ? String(runGit(['tag', '--merged', 'HEAD', '--list']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  for (const tag of tags) {
    const type = String(runGit(['cat-file', '-t', tag]).stdout).trim();
    if (type !== 'tag') continue;
    const record = String(
      runGit([
        'for-each-ref',
        `refs/tags/${tag}`,
        '--format=%(taggername)%00%(taggeremail)%00%(contents)',
      ]).stdout,
    );
    const [taggerName = '', taggerEmail = '', ...body] = record.split('\0');
    failures.push(
      ...(enforceHistoricalMaintainerIdentity
        ? checkMaintainerIdentity(taggerName, taggerEmail, `tag ${tag} tagger`)
        : []),
      ...findBlockedText(body.join('\0'), `tag ${tag} message`),
    );
  }

  if (head.status === 0) failures.push(...checkIndexedOrCommittedFiles('HEAD'));
  return { failures, commits: commits.length, tags: tags.length };
}

function fail(failures) {
  console.error('Public-history privacy check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--message') {
  if (!argument) throw new Error('--message requires the commit-message file path.');
  const failures = checkMessageFile(argument);
  if (failures.length > 0) fail(failures);
} else if (mode === '--staged') {
  const failures = [...checkCurrentAuthor(), ...checkIndexedOrCommittedFiles('--cached')];
  if (failures.length > 0) fail(failures);
} else if (mode) {
  throw new Error(`Unknown argument: ${mode}`);
} else {
  const { failures, commits, tags } = checkHistory();
  if (failures.length > 0) fail(failures);
  else console.log(`Public-history privacy check passed (${commits} commits, ${tags} tags).`);
}
