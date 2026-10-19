import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, parseScope } from '../src/config.ts';
import { cliEnvironment, layerSettings, oldDotenvWarning, readSettingsFile, settingSources } from '../src/env.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('an empty value means the default', () => {
  const config = loadConfig({ DAILY_FOCUS_HOST: '', DAILY_FOCUS_DATA: '', DAILY_FOCUS_GH: '~/bin/gh' });
  assert.equal(config.host, '127.0.0.1', 'an empty host must not become "listen everywhere"');
  assert.match(config.dataDir, /\.daily-focus[\\/]work$/, 'an empty store path must not become the working directory');
  assert.match(config.github.ghPath, /^[^~].*[\\/]bin[\\/]gh$/, 'a tilde in the gh path is expanded');
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

test('only the store, port and host come from the environment; every other setting is the store\'s', async () => {
  const dir = await store({ DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_WORK_START: '8' });
  const sources = settingSources({ DAILY_FOCUS_DATA: dir, DAILY_FOCUS_PORT: '4322', DAILY_FOCUS_WORK_START: '10', DAILY_FOCUS_JIRA: 'off' });
  const values = layerSettings(sources);
  assert.equal(values.DAILY_FOCUS_DATA, dir);
  assert.equal(values.DAILY_FOCUS_PORT, '4322');
  assert.equal(values.DAILY_FOCUS_AGENT, 'claude');
  assert.equal(values.DAILY_FOCUS_WORK_START, '8', 'a variable left in the environment changes nothing saved');
  assert.equal(values.DAILY_FOCUS_JIRA, undefined, 'nor anything unsaved');
  assert.equal(sources.settingsError, null);
});

test('a blank launch variable means the default', async () => {
  const sources = settingSources({ DAILY_FOCUS_DATA: '  ', DAILY_FOCUS_HOST: '' });
  assert.deepEqual(sources.launch, {});
  assert.match(sources.settingsPath, /\.daily-focus[\\/]work[\\/]settings\.json$/);
});

test('a fixed setting wins over the saved one, and a blank saved one is the default', async () => {
  const dir = await store({ DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_WORK_END: ' ' });
  const values = layerSettings(settingSources({ DAILY_FOCUS_DATA: dir }, { DAILY_FOCUS_AGENT: 'off' }));
  assert.equal(values.DAILY_FOCUS_AGENT, 'off');
  assert.equal(values.DAILY_FOCUS_WORK_END, undefined);
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

test('a number or true/false written by hand is read as its text, and anything else is reported', async () => {
  const dir = await store({ DAILY_FOCUS_MIN_FREE_WINDOW: 50, DAILY_FOCUS_GITHUB: false, DAILY_FOCUS_CALENDARS: ['Work'] });
  const read = readSettingsFile(join(dir, 'settings.json'));
  assert.deepEqual(read.values, { DAILY_FOCUS_MIN_FREE_WINDOW: '50', DAILY_FOCUS_GITHUB: 'false' });
  assert.match(read.error ?? '', /DAILY_FOCUS_CALENDARS/);
});

test('a .env left in a checkout is named with what it held, since nothing reads it now', async () => {
  assert.equal(oldDotenvWarning('/definitely/not/here/.env'), null);

  const dir = await store(undefined);
  const path = join(dir, '.env');
  await writeFile(path, '# DAILY_FOCUS_AGENT=codex\nDAILY_FOCUS_HOST=\n', 'utf8');
  assert.equal(oldDotenvWarning(path), null, 'a copy of the old example sets nothing');

  await writeFile(path, '\uFEFFDAILY_FOCUS_GITHUB_SCOPE="acme, acme-labs"\nDAILY_FOCUS_PORT=4322\nPATH=/tmp\n', 'utf8');
  const warning = oldDotenvWarning(path) ?? '';
  assert.match(warning, /no longer read/);
  assert.match(warning, /Set DAILY_FOCUS_GITHUB_SCOPE on the settings page/);
  assert.match(warning, /Give --port when starting it, or set DAILY_FOCUS_PORT in the environment/);
  assert.doesNotMatch(warning, /PATH/);
});

test('the CLIs the dashboard runs get the gh and acli it fetched on PATH, last, once there are any', () => {
  const toolsDir = join('/data', 'tools');
  const fetched = join(toolsDir, 'bin');
  const path = ['/usr/bin', '/bin'].join(delimiter);
  const some = cliEnvironment({ dataDir: '/data/work', toolsDir }, { PATH: path, HOME: '/h' }, (dir) => dir === fetched);
  assert.equal(some.DAILY_FOCUS_DATA, '/data/work', 'the store itself');
  assert.equal(some.HOME, '/h');
  assert.equal(some.PATH, [path, fetched].join(delimiter), "last, so nothing of the user's is shadowed");

  const none = cliEnvironment({ dataDir: '/data/work', toolsDir }, { PATH: path }, () => false);
  assert.equal(none.PATH, path, 'nothing fetched, nothing added');

  // As Windows spells it, where a second key would leave the first in charge.
  const windows = cliEnvironment({ dataDir: '/data/work', toolsDir }, { Path: 'C:\\Windows' }, () => true);
  assert.deepEqual([windows.Path, windows.PATH], [['C:\\Windows', fetched].join(delimiter), undefined]);
});
