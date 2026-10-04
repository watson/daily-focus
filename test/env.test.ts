import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, parseScope } from '../src/config.ts';
import { envSources, layerEnv, mergeEnv, readDotEnv, readSettingsFile } from '../src/env.ts';

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

test('the live agenda is on by default but reads nothing until calendars are named', () => {
  const { calendar } = loadConfig({});

  assert.equal(calendar.enabled, true);
  assert.deepEqual(calendar.names, [], 'no names means no calendar is read');
  assert.deepEqual(calendar.addresses, []);
  assert.equal(calendar.pollMinutes, 5);
});

test('calendar names split on commas only, since they contain spaces', () => {
  const { calendar } = loadConfig({
    DAILY_FOCUS_CALENDARS: 'Work Calendar, Family ❤️ ,, Work Calendar ',
    DAILY_FOCUS_CALENDAR_ADDRESSES: 'a@example.com, b@example.com',
  });

  // Trimmed, empties dropped, duplicates dropped — and a two-word name stays one name.
  assert.deepEqual(calendar.names, ['Work Calendar', 'Family ❤️']);
  assert.deepEqual(calendar.addresses, ['a@example.com', 'b@example.com']);
});

test('DAILY_FOCUS_CALENDAR=off disables the live agenda', () => {
  for (const off of ['off', 'OFF', 'false', '0', 'no']) {
    assert.equal(loadConfig({ DAILY_FOCUS_CALENDAR: off }).calendar.enabled, false, off);
  }
  assert.equal(loadConfig({ DAILY_FOCUS_CALENDAR: 'on' }).calendar.enabled, true);
});

test('a calendar poll interval under a minute is refused at startup', () => {
  assert.throws(() => loadConfig({ DAILY_FOCUS_CALENDAR_POLL_MINUTES: '0' }), /at least 1/);
});

async function store(settings: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-settings-'));
  dirs.push(dir);
  if (settings !== undefined) {
    await writeFile(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings), 'utf8');
  }
  return dir;
}

test("the store's settings sit between .env and the environment", async () => {
  const dir = await store({ DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_WORK_START: '8' });
  const sources = envSources(
    { DAILY_FOCUS_DATA: dir, DAILY_FOCUS_WORK_START: '10' },
    { DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_WORK_END: '18' },
  );
  const env = layerEnv(sources);
  assert.equal(env.DAILY_FOCUS_AGENT, 'claude', 'a saved setting beats .env');
  assert.equal(env.DAILY_FOCUS_WORK_START, '10', 'the environment beats a saved setting');
  assert.equal(env.DAILY_FOCUS_WORK_END, '18', '.env still fills in what nothing else sets');
  assert.equal(sources.settingsError, null);
});

test('the store is found from .env when the environment does not say', async () => {
  const dir = await store({ DAILY_FOCUS_SESSION_MINUTES: '50' });
  const sources = envSources({}, { DAILY_FOCUS_DATA: dir });
  assert.equal(layerEnv(sources).DAILY_FOCUS_SESSION_MINUTES, '50');
});

test('a settings file cannot move the store or the server', async () => {
  const dir = await store({ DAILY_FOCUS_DATA: '/elsewhere', DAILY_FOCUS_PORT: '1', DAILY_FOCUS_HOST: '0.0.0.0', PATH: '/tmp', DAILY_FOCUS_GH: '/opt/gh' });
  assert.deepEqual(readSettingsFile(join(dir, 'settings.json')).values, { DAILY_FOCUS_GH: '/opt/gh' });
});

test('a settings file that cannot be used is reported, not thrown', async () => {
  assert.deepEqual(readSettingsFile('/definitely/not/here/settings.json'), { values: {}, error: null });
  for (const contents of ['{not json', '["DAILY_FOCUS_AGENT"]', '"claude"']) {
    const dir = await store(contents);
    const read = readSettingsFile(join(dir, 'settings.json'));
    assert.deepEqual(read.values, {}, contents);
    assert.ok(read.error, contents);
  }
});
