import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, parseScope } from '../src/config.ts';
import { mergeEnv, readDotEnv } from '../src/env.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dotenv(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-env-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  await writeFile(path, contents, 'utf8');
  return path;
}

test('a missing .env reads as empty rather than failing', () => {
  assert.deepEqual(readDotEnv('/definitely/not/here/.env'), {});
});

test('comments, blank lines and quotes are handled', async () => {
  const path = await dotenv(
    [
      '# a comment',
      '',
      'DAILY_FOCUS_PORT=4322',
      'DAILY_FOCUS_GITHUB_SCOPE="acme, acme-labs/webapp"',
      "DAILY_FOCUS_GH='/opt/homebrew/bin/gh'",
    ].join('\n'),
  );
  assert.deepEqual(readDotEnv(path), {
    DAILY_FOCUS_PORT: '4322',
    DAILY_FOCUS_GITHUB_SCOPE: 'acme, acme-labs/webapp',
    DAILY_FOCUS_GH: '/opt/homebrew/bin/gh',
  });
});

test('an empty value means the default, and a byte-order mark is ignored', async () => {
  const path = await dotenv('\uFEFFDAILY_FOCUS_HOST=\nDAILY_FOCUS_DATA=\nDAILY_FOCUS_GH=~/bin/gh\n');
  const config = loadConfig(mergeEnv(readDotEnv(path), {}));
  assert.equal(config.host, '127.0.0.1', 'an empty host must not become "listen everywhere"');
  assert.match(config.dataDir, /\.daily-focus$/, 'an empty store path must not become the working directory');
  assert.match(config.github.ghPath, /^\/.*\/bin\/gh$/, 'a tilde in the gh path is expanded');
});

test('the real environment wins over the file', () => {
  const merged = mergeEnv(
    { DAILY_FOCUS_PORT: '1111', DAILY_FOCUS_HOST: '0.0.0.0' },
    { DAILY_FOCUS_PORT: '2222' },
  );
  assert.equal(merged.DAILY_FOCUS_PORT, '2222');
  assert.equal(merged.DAILY_FOCUS_HOST, '0.0.0.0');
});

test('only project variables are taken from the file', () => {
  const merged = mergeEnv({ PATH: '/tmp', DAILY_FOCUS_PORT: '1111' }, {});
  assert.equal(merged.PATH, undefined);
  assert.equal(merged.DAILY_FOCUS_PORT, '1111');
});

test('the board is on by default and off on request', () => {
  const on = loadConfig({ DAILY_FOCUS_DATA: '/tmp/x' });
  assert.equal(on.github.enabled, true);
  assert.deepEqual(on.github.accounts, []);
  assert.deepEqual(on.github.scope, []);
  assert.equal(on.github.pollMinutes, 5);
  assert.equal(on.github.ghPath, 'gh');

  for (const value of ['off', 'OFF', 'false', '0', 'no']) {
    assert.equal(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_GITHUB: value }).github.enabled, false, value);
  }
});

test('no check is a merge gate until one is named', () => {
  assert.deepEqual(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x' }).github.mergeGateChecks, []);
  assert.deepEqual(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS: '' }).github.mergeGateChecks, []);
  assert.deepEqual(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS: ' , ,' }).github.mergeGateChecks, []);
});

test('merge gate names are split on commas only, trimmed and deduplicated', () => {
  const gates = (raw: string) =>
    loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS: raw }).github.mergeGateChecks;

  assert.deepEqual(gates(' policy/merge-gate , repository-policy '), ['policy/merge-gate', 'repository-policy']);
  assert.deepEqual(gates('policy/merge-gate,policy/merge-gate'), ['policy/merge-gate'], 'the same name twice is one gate');
  // Commas only: GitHub check names contain spaces, and splitting on whitespace
  // would turn one real name into three that match nothing.
  assert.deepEqual(gates('merge policy decision'), ['merge policy decision']);
  assert.deepEqual(gates('merge policy decision, ownership review'), ['merge policy decision', 'ownership review']);
  // Matching happens in prs.ts, but the case has to survive the config to get there.
  assert.deepEqual(gates('Policy/Merge-Gate'), ['Policy/Merge-Gate']);
});

test('accounts and scope are lists, and the scope becomes search qualifiers', () => {
  const config = loadConfig({
    DAILY_FOCUS_DATA: '/tmp/x',
    DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice, alice_corp',
    DAILY_FOCUS_GITHUB_SCOPE: 'acme acme-labs/webapp, org:acme',
  });
  assert.deepEqual(config.github.accounts, ['alice', 'alice_corp']);
  assert.deepEqual(config.github.scope, ['org:acme', 'repo:acme-labs/webapp']);
});

test('parseScope understands bare names and written-out qualifiers', () => {
  assert.deepEqual(parseScope(['acme', 'repo:acme/webapp', 'user:bob', 'acme/tools']), [
    'org:acme',
    'repo:acme/webapp',
    'org:bob',
    'repo:acme/tools',
  ]);
  assert.deepEqual(parseScope([]), []);
});

test('a poll interval under a minute is refused', () => {
  assert.throws(() => loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_GITHUB_POLL_MINUTES: '0' }), /at least 1/);
});
