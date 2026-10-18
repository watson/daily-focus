import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { SettingSources } from '../src/env.ts';
import { applySettingsChange, describeSettings, saveSettings, SETTINGS, SETTING_GROUPS } from '../src/settings.ts';
import { asProfile, type Profile } from '../src/stores.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A store whose folder follows the profile its settings name, as it does after the restart a save asks for; `given` as `--profile` would. */
function sources(layers: Partial<Pick<SettingSources, 'settings' | 'fixed'>> & { given?: Profile } = {}): SettingSources {
  const settings = layers.settings ?? {};
  const profile = layers.given ?? asProfile(settings.DAILY_FOCUS_PROFILE) ?? 'work';
  const root = '/tmp/daily-focus-settings-test';
  return {
    launch: { DAILY_FOCUS_DATA: root },
    store: { root, profile, dir: `${root}/${profile}`, given: layers.given !== undefined, move: null, problem: null },
    settings,
    fixed: layers.fixed ?? {},
    settingsPath: `${root}/${profile}/settings.json`,
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
      settings: { DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_WORK_START: '8' },
      fixed: { DAILY_FOCUS_WORK_START: '10' },
    }),
  );
  assert.deepEqual([view(all, 'DAILY_FOCUS_AGENT').value, view(all, 'DAILY_FOCUS_AGENT').source], ['claude', 'settings']);
  assert.deepEqual([view(all, 'DAILY_FOCUS_WORK_START').value, view(all, 'DAILY_FOCUS_WORK_START').source], ['10', 'fixed']);
  assert.deepEqual([view(all, 'DAILY_FOCUS_MIN_FREE_WINDOW').value, view(all, 'DAILY_FOCUS_MIN_FREE_WINDOW').source], [null, 'default']);
  // The store's folder says it, so the page shows it and can't change it.
  assert.deepEqual([view(all, 'DAILY_FOCUS_PROFILE').value, view(all, 'DAILY_FOCUS_PROFILE').source], ['work', 'fixed']);
});

test('only the setup screen changes the profile, and not one given at launch', () => {
  const page = applySettingsChange(sources(), { DAILY_FOCUS_PROFILE: 'personal' });
  assert.ok('error' in page && /chosen at setup/.test(page.error), 'the page refuses it');
  assert.deepEqual(applySettingsChange(sources(), { DAILY_FOCUS_PROFILE: 'work' }), { settings: {} }, 'restating it changes nothing');
  assert.deepEqual(applySettingsChange(sources(), { DAILY_FOCUS_PROFILE: 'personal' }, { setup: true }), {
    settings: { DAILY_FOCUS_PROFILE: 'personal' },
  });
  const given = applySettingsChange(sources({ given: 'work' }), { DAILY_FOCUS_PROFILE: 'personal' }, { setup: true });
  assert.ok('error' in given && /given when the dashboard started/.test(given.error));
  assert.equal(view(describeSettings(sources({ given: 'personal' })), 'DAILY_FOCUS_PROFILE').value, 'personal');
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
    ['DAILY_FOCUS_MIN_FREE_WINDOW', 'lots'],
    ['DAILY_FOCUS_AGENT_DAYS', 'weekdays'],
    ['DAILY_FOCUS_PROFILE', 'holiday'],
  ] as const) {
    const applied = applySettingsChange(sources({ settings: { DAILY_FOCUS_AGENT: 'codex' } }), { [key]: value });
    assert.ok('error' in applied, `${key}=${value} should be refused`);
    assert.match(applied.error, new RegExp(key), `the refusal names ${key}`);
  }
  // Numbers the dashboard can't use, refused before they are saved rather than
  // failing later: a free window longer than a day, an hour that isn't one, a day
  // that ends before it begins.
  const unusable: Record<string, string>[] = [
    { DAILY_FOCUS_MIN_FREE_WINDOW: '2000' },
    { DAILY_FOCUS_WORK_START: '24' },
    { DAILY_FOCUS_WORK_START: '17', DAILY_FOCUS_WORK_END: '9' },
    { DAILY_FOCUS_MIN_FREE_WINDOW: '0' },
    { DAILY_FOCUS_STALE_AFTER_HOURS: '2.5' },
  ];
  for (const change of unusable) {
    assert.ok('error' in applySettingsChange(sources(), change), JSON.stringify(change));
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
  const fixed = applySettingsChange(sources({ fixed: { DAILY_FOCUS_AGENT: 'off' } }), { DAILY_FOCUS_AGENT: 'claude' });
  assert.ok('error' in fixed && /fixed/.test(fixed.error));
});

test('saved settings are sorted, so the file reads the way the page does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-settings-'));
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  await saveSettings(path, { DAILY_FOCUS_WORK_START: '8', DAILY_FOCUS_AGENT: 'claude' });
  assert.equal(await readFile(path, 'utf8'), '{\n  "DAILY_FOCUS_AGENT": "claude",\n  "DAILY_FOCUS_WORK_START": "8"\n}\n');
});
