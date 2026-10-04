import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { EnvSources } from '../src/env.ts';
import { applySettingsChange, describeSettings, saveSettings, SETTINGS, SETTING_GROUPS } from '../src/settings.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function sources(layers: Partial<Pick<EnvSources, 'dotenv' | 'settings' | 'process'>> = {}): EnvSources {
  return {
    dotenv: layers.dotenv ?? {},
    settings: layers.settings ?? {},
    process: { DAILY_FOCUS_DATA: '/tmp/daily-focus-settings-test', ...layers.process },
    settingsPath: '/tmp/daily-focus-settings-test/settings.json',
    settingsError: null,
  };
}

const view = (all: ReturnType<typeof describeSettings>, key: string) => all.settings.find((setting) => setting.key === key)!;

test('every setting belongs to a group the page shows, once', () => {
  const groups = new Set(SETTING_GROUPS.map((group) => group.id));
  const keys = new Set<string>();
  for (const setting of SETTINGS) {
    assert.ok(groups.has(setting.group), `${setting.key} is in an unknown group`);
    assert.ok(!keys.has(setting.key), `${setting.key} is listed twice`);
    keys.add(setting.key);
    if (setting.kind === 'choice') assert.ok(setting.choices && setting.choices.length > 1, `${setting.key} has no choices`);
  }
});

test('each value says where it came from', () => {
  const all = describeSettings(
    sources({
      dotenv: { DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_WORK_END: '18' },
      settings: { DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_WORK_START: '8' },
      process: { DAILY_FOCUS_WORK_START: '10' },
    }),
  );
  assert.deepEqual([view(all, 'DAILY_FOCUS_AGENT').value, view(all, 'DAILY_FOCUS_AGENT').source], ['claude', 'settings']);
  assert.deepEqual([view(all, 'DAILY_FOCUS_WORK_START').value, view(all, 'DAILY_FOCUS_WORK_START').source], ['10', 'environment']);
  assert.deepEqual([view(all, 'DAILY_FOCUS_WORK_END').value, view(all, 'DAILY_FOCUS_WORK_END').source], ['18', 'dotenv']);
  assert.deepEqual([view(all, 'DAILY_FOCUS_SESSION_MINUTES').value, view(all, 'DAILY_FOCUS_SESSION_MINUTES').source], [null, 'default']);
});

test('defaults that depend on the profile follow the profile in effect', () => {
  assert.equal(view(describeSettings(sources()), 'DAILY_FOCUS_JIRA').fallback, 'On');
  const personal = describeSettings(sources({ settings: { DAILY_FOCUS_PROFILE: 'personal' } }));
  assert.equal(view(personal, 'DAILY_FOCUS_JIRA').fallback, 'Off');
  assert.equal(view(personal, 'DAILY_FOCUS_FREE_WINDOWS').fallback, 'Off');
});

test('a change is applied to the saved settings, and null goes back to the default', () => {
  const applied = applySettingsChange(sources({ settings: { DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_WORK_START: '8' } }), {
    DAILY_FOCUS_AGENT: 'claude',
    DAILY_FOCUS_WORK_START: null,
    DAILY_FOCUS_AGENT_AT: ' 06:30 ',
    DAILY_FOCUS_AGENT_MODEL: '   ',
  });
  assert.deepEqual(applied, { settings: { DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_AGENT_AT: '06:30' } });
});

test('a value the dashboard would refuse to start with is refused before it is saved', () => {
  for (const [key, value] of [
    ['DAILY_FOCUS_AGENT', 'gpt'],
    ['DAILY_FOCUS_SESSION_MINUTES', 'lots'],
    ['DAILY_FOCUS_AGENT_DAYS', 'weekdays'],
    ['DAILY_FOCUS_PROFILE', 'holiday'],
  ] as const) {
    const applied = applySettingsChange(sources({ settings: { DAILY_FOCUS_AGENT: 'codex' } }), { [key]: value });
    assert.ok('error' in applied, `${key}=${value} should be refused`);
    assert.match(applied.error, new RegExp(key), `the refusal names ${key}`);
  }
  // A time with no agent to run would be a schedule that never fires.
  assert.ok('error' in applySettingsChange(sources(), { DAILY_FOCUS_AGENT_AT: '06:30' }));
});

test('what the page cannot change is refused by name', () => {
  for (const [change, pattern] of [
    [{ DAILY_FOCUS_DATA: '/elsewhere' }, /where the store is/],
    [{ DAILY_FOCUS_PORT: '1' }, /how the server listens/],
    [{ DAILY_FOCUS_NOT_A_THING: 'x' }, /not a setting/],
    [{ PATH: '/tmp' }, /not a setting/],
  ] as const) {
    const applied = applySettingsChange(sources(), change);
    assert.ok('error' in applied && pattern.test(applied.error), JSON.stringify(change));
  }
  const fromEnv = applySettingsChange(sources({ process: { DAILY_FOCUS_AGENT: 'codex' } }), { DAILY_FOCUS_AGENT: 'claude' });
  assert.ok('error' in fromEnv && /set in the environment/.test(fromEnv.error));
});

test('saved settings are sorted, so the file reads the way the page does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-settings-'));
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  await saveSettings(path, { DAILY_FOCUS_WORK_START: '8', DAILY_FOCUS_AGENT: 'claude' });
  assert.equal(await readFile(path, 'utf8'), '{\n  "DAILY_FOCUS_AGENT": "claude",\n  "DAILY_FOCUS_WORK_START": "8"\n}\n');
});
