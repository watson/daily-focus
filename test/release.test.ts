import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { bumpFor, lastRelease, nextVersion, parseCommit, renderNotes, repositoryUrl, titleProblem } from '../scripts/release.ts';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/release.ts');
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('a title must be a Conventional Commit with a known type', () => {
  for (const title of ['feat: show draft pull requests', 'fix(board): keep the last read', 'feat!: drop the old store layout', 'refactor(jira)!: rename a field', 'ci: run on macOS (#45)']) {
    assert.equal(titleProblem(title), null, title);
  }
  for (const title of ['Show draft pull requests', 'feature: show drafts', 'feat:no space', 'feat: ', 'Feat: capitalised type', 'feat(): empty scope']) {
    assert.ok(titleProblem(title), title);
  }
  assert.match(titleProblem('wip: half done') ?? '', /"wip" is not one of the types/);
});

test('a commit is breaking by its "!" or its footer, and keeps what the footer says', () => {
  const bang = parseCommit('a'.repeat(40), 'feat(board)!: hide merged pull requests (#50)');
  assert.deepEqual([bang.type, bang.scope, bang.breaking, bang.description], ['feat', 'board', true, 'hide merged pull requests (#50)']);

  const footer = parseCommit('b'.repeat(40), 'fix: read settings from the store\n\nMore words.\n\nBREAKING CHANGE: .env is no longer read.');
  assert.equal(footer.breaking, true);
  assert.equal(footer.breakingNote, '.env is no longer read.');

  const old = parseCommit('c'.repeat(40), 'A Mac menu bar app that keeps the dashboard running (#44)\n\nBody.');
  assert.equal(old.conventional, false);
  assert.equal(old.description, 'A Mac menu bar app that keeps the dashboard running (#44)');
});

test('the largest change sets the bump, and below 1.0.0 a breaking change moves the minor', () => {
  const commit = (message: string) => parseCommit('0'.repeat(40), message);
  assert.equal(bumpFor([commit('docs: typo'), commit('chore: tidy')]), 'patch');
  assert.equal(bumpFor([]), 'patch');
  assert.equal(bumpFor([commit('fix: x'), commit('feat: y')]), 'minor');
  assert.equal(bumpFor([commit('feat: y'), commit('fix!: z')]), 'major');

  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.3', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.1.3', 'major'), '0.2.0');
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
});

test('the last release is the highest stable tag, below a ceiling when given', () => {
  const tags = ['v0.1.0', 'v0.2.0-dev.3', 'v0.10.0', 'v0.9.1', 'nightly', '0.11.0'];
  assert.equal(lastRelease(tags), '0.10.0');
  assert.equal(lastRelease(tags, '0.10.0'), '0.9.1');
  assert.equal(lastRelease(['v0.2.0-dev.1']), null);
});

test('the repository address comes from package.json', () => {
  assert.equal(repositoryUrl({ repository: { url: 'git+https://github.com/example/focus.git' } }), 'https://github.com/example/focus');
});

test('release notes put breaking changes first and leave housekeeping out', () => {
  const commits = [
    parseCommit('1'.repeat(40), 'fix(jira): keep the last good read (#3)'),
    parseCommit('2'.repeat(40), 'chore: bump esbuild (#4)'),
    parseCommit('3'.repeat(40), 'feat(board): show draft pull requests (#5)'),
    parseCommit('4'.repeat(40), 'feat!: move the store (#6)\n\nBREAKING CHANGE: the store moves to ~/.focus.'),
    parseCommit('5'.repeat(40), 'An old subject from before the convention'),
  ];
  const notes = renderNotes({ version: '0.2.0', previous: '0.1.0', date: '2026-10-06', repository: 'https://github.com/example/focus', commits });

  assert.ok(notes.startsWith('## [0.2.0](https://github.com/example/focus/compare/v0.1.0...v0.2.0) (2026-10-06)\n'));
  const order = ['### ⚠ BREAKING CHANGES', '### Features', '### Bug Fixes', '### Other Changes', 'npx daily-focus@0.2.0'].map((text) => notes.indexOf(text));
  assert.ok(order.every((index) => index > 0), notes);
  assert.deepEqual([...order].sort((a, b) => a - b), order, notes);
  assert.match(notes, /\* the store moves to ~\/\.focus\. \(\[4444444\]\(https:\/\/github\.com\/example\/focus\/commit\/4{40}\)\)/);
  assert.match(notes, /\* \*\*board:\*\* show draft pull requests \(#5\)/);
  assert.doesNotMatch(notes, /esbuild/);

  const quiet = renderNotes({ version: '0.2.1', previous: '0.2.0', date: '2026-10-07', repository: 'https://github.com/example/focus', commits: [commits[1]!] });
  assert.match(quiet, /No user-facing changes\./);
});

/** A repository with `messages` as its commits, each tagged when a tag follows it: `['fix: a', 'v0.1.0', 'feat: b']`. */
async function repository(entries: string[]): Promise<(...args: string[]) => Promise<string>> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-release-'));
  dirs.push(dir);
  const git = async (...args: string[]) =>
    (await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: dir })).stdout;
  await git('init', '--quiet', '--initial-branch=main');
  for (const entry of entries) {
    if (/^v\d/.test(entry)) await git('tag', entry);
    else await git('commit', '--quiet', '--allow-empty', '-m', entry);
  }
  return async (...args: string[]) => (await run(process.execPath, [script, ...args], { cwd: dir })).stdout.trim();
}

test('a development build counts the commits since the last release', async () => {
  const release = await repository(['feat: start', 'v0.1.0', 'fix: one', 'docs: two']);
  assert.equal(await release('version', '--dev'), '0.1.1-dev.2');

  const featured = await repository(['feat: start', 'v0.1.0', 'fix: one', 'feat(board): two', 'chore: three']);
  assert.equal(await release('version', '--dev'), '0.1.1-dev.2');
  assert.equal(await featured('version', '--dev'), '0.2.0-dev.3');
  assert.equal(await featured('version'), '0.2.0');
});

test('a stable release can be set, must move forward, and a rerun finishes the same one', async () => {
  const release = await repository(['feat: start', 'v0.1.0', 'fix: one']);
  assert.equal(await release('version', '--set', 'v1.0.0'), '1.0.0');
  await assert.rejects(release('version', '--set', '0.1.0'), /not after the last release, v0\.1\.0/);
  await assert.rejects(release('version', '--set', 'one'), /is not a version/);

  const tagged = await repository(['feat: start', 'v0.1.0', 'fix: one', 'v0.1.1']);
  assert.equal(await tagged('version'), '0.1.1');
  assert.equal(await tagged('version', '--set', '0.1.1'), '0.1.1');
  await assert.rejects(tagged('version', '--set', '0.2.0'), /already released, as v0\.1\.1/);
});

test('notes cover the commits since the release before, tagged or not', async () => {
  const release = await repository(['feat: start', 'v0.1.0', 'fix: mend the board', 'v0.1.1']);
  const notes = await release('notes', '0.1.1');
  assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.1\.1/);
  assert.match(notes, /mend the board/);
  assert.doesNotMatch(notes, /start/);

  assert.match(await release('notes', '0.1.2-dev.1'), /compare\/v0\.1\.1\.\.\.v0\.1\.2-dev\.1/);
});

test('check-title refuses a title that is not a Conventional Commit', async () => {
  const release = await repository(['feat: start']);
  assert.match(await release('check-title', 'feat: fine'), /is a Conventional Commit/);
  await assert.rejects(release('check-title', 'Fine'), /must be a Conventional Commit/);
});
