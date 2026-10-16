/**
 * The setup screen's engine, against a script standing in for the CLI.
 *
 * The rules worth holding: nothing is asked of a CLI until the CLI and the
 * profile are answered; each question's session answers in JSON the card then
 * shows; a revision resumes that session; a new profile throws away what was
 * proposed for the old one; nothing is saved until the finish, which writes the
 * settings, the source list and the objective, and asks for the first brief; a
 * hand-written source list is never replaced; a setting the environment sets is
 * shown and never saved.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import type { CliFound, CliReport } from '../src/clis.ts';
import type { EnvSources } from '../src/env.ts';
import { Onboarding, type OnboardingDeps } from '../src/onboarding.ts';
import { applySettingsChange } from '../src/settings.ts';
import type { OnboardingState, SetupState } from '../src/types.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** What the fake CLI answers with: one object both questions can read their own part of. */
const PROPOSAL = {
  why: 'From your sent mail.',
  names: ['Robin Lark', 'Robin L.'],
  email: 'robin@northwind.example',
  githubAccounts: [{ login: 'rlark', note: '' }],
  calendars: [
    { title: 'Robin Lark', account: 'robin@northwind.example', include: true, holiday: false, briefName: '', note: 'Your primary calendar' },
    { title: 'Family', account: 'iCloud', include: false, holiday: false, briefName: '', note: '' },
  ],
};

interface Harness {
  dataDir: string;
  onboarding: Onboarding;
  settings: Record<string, string>;
  env: NodeJS.ProcessEnv;
  calls(): Promise<string[][]>;
  deps: OnboardingDeps;
  /** How many times it has looked for the CLIs. */
  detections: number;
  /** What looking finds; Claude Code ready at the fake, Codex missing, unless a test says otherwise. */
  report: CliReport;
}

const MISSING_CODEX: CliFound = { path: null, version: null, onPath: false, ready: false, problem: "Codex isn't installed", fix: null };

/**
 * A store, and a fake `claude` that records its argv and prints a session id
 * named for the question it was asked, then the proposal as its result.
 */
async function harness(env: NodeJS.ProcessEnv = {}, reply: unknown = PROPOSAL, raw = false): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-onboarding-'));
  dirs.push(dataDir);
  const bin = join(dataDir, 'fake-claude');
  // The lines a real Claude Code prints, with the session id left for the script to fill in.
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'SESSION' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh api user', description: 'Look up the GitHub login' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'SESSION', result: raw ? String(reply) : JSON.stringify(reply) },
  ];
  await writeFile(join(dataDir, 'lines.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${dataDir}/argv-$$"`,
    'case "$*" in *"Is this you"*|*sess-identity*) id=sess-identity;; *) id=sess-calendars;; esac',
    `sed "s/SESSION/$id/g" "${dataDir}/lines.jsonl"`,
  ].join('\n');
  await writeFile(bin, `${script}\n`, 'utf8');
  await chmod(bin, 0o755);

  const fullEnv: NodeJS.ProcessEnv = { DAILY_FOCUS_DATA: dataDir, ...env };
  const config = loadConfig(fullEnv);
  const h = { dataDir, settings: {} as Record<string, string>, env: fullEnv } as Harness;
  const sources = (): EnvSources => ({ dotenv: {}, settings: h.settings, process: fullEnv, settingsPath: join(dataDir, 'settings.json'), settingsError: null });
  const setup: SetupState = {
    needed: true,
    profile: 'work',
    sources: { exists: false, placeholders: 0 },
    clis: { claude: bin, codex: null },
    calendar: { supported: true, built: true, chosen: 0, buildCommand: 'daily-focus build-calendar' },
  };
  h.detections = 0;
  h.report = { claude: { path: bin, version: '2.1.300', onPath: true, ready: true, problem: null, fix: null }, codex: MISSING_CODEX };
  h.deps = {
    onChange: () => {},
    detectClis: async () => (h.detections++, h.report),
    probeCli: async (path) =>
      path === bin
        ? { cli: 'claude', found: { path, version: '2.1.300', onPath: false, ready: true, problem: null, fix: null } }
        : { cli: null, found: { path, version: null, onPath: false, ready: false, problem: `Nothing runs at ${path}`, fix: null } },
    readSources: sources,
    setup: async () => setup,
    identity: async () => ({ name: 'Robin Lark', login: 'rlark', logins: ['rlark'], email: 'robin@example.com' }),
    boards: async () => ({
      github: { enabled: true, fetchedAt: '2026-10-16T08:00:00Z', reason: null },
      jira: { enabled: true, fetchedAt: '2026-10-16T08:00:00Z', reason: null },
    }),
    listCalendars: async () => [
      { title: 'Robin Lark', source: 'robin@northwind.example', eventsToday: 3 },
      { title: 'Family', source: 'iCloud', eventsToday: 1 },
    ],
    checkSettings: (values) => {
      const applied = applySettingsChange(sources(), values);
      return 'error' in applied ? applied.error : null;
    },
    saveSettings: async (values) => {
      const applied = applySettingsChange(sources(), values);
      if ('error' in applied) return applied.error;
      h.settings = applied.settings;
      return null;
    },
  };
  h.onboarding = new Onboarding(config, h.deps);
  h.calls = async () => {
    const names = (await readdir(dataDir)).filter((name) => name.startsWith('argv-'));
    return Promise.all(names.map(async (name) => (await readFile(join(dataDir, name), 'utf8')).split('\n')));
  };
  return h;
}

const NEW: SetupState = {
  needed: true,
  profile: 'work',
  sources: { exists: false, placeholders: 0 },
  clis: { claude: null, codex: null },
  calendar: { supported: true, built: true, chosen: 0, buildCommand: '' },
};

async function view(h: Harness): Promise<OnboardingState> {
  const state = await h.onboarding.view({ ...NEW, clis: (await h.deps.setup()).clis });
  assert.ok(state, 'the screen is showing');
  return state;
}

/** Wait until no question has a session going. */
async function settled(h: Harness): Promise<OnboardingState> {
  for (let i = 0; i < 300; i++) {
    const state = await view(h);
    if (!h.onboarding.busy && state.steps.every((step) => step.proposal?.status !== 'working')) return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('a session never finished');
}

const pick = (choices: Record<string, string[]>, fields: Record<string, string> = {}) => ({ choices, fields });

test('a new store opens looking for the CLIs, and runs nothing until the screen asks', async () => {
  const h = await harness();
  const state = await view(h);
  assert.equal(state.detected, false);
  assert.equal(state.current, 'cli');
  assert.deepEqual(
    state.steps.map((step) => step.id),
    ['cli', 'profile', 'identity', 'boards', 'calendars', 'objective'],
    'no schedule until there is an agent',
  );
  const cli = state.steps[0]!;
  assert.equal(cli.proposal?.status, 'working');
  assert.deepEqual(cli.proposal?.steps.map((step) => step.text), ['Look for Codex and Claude Code']);
  assert.ok(state.steps.slice(1).every((step) => step.status === 'open' && step.proposal === null));
  assert.deepEqual([h.detections, (await h.calls()).length], [0, 0]);
  // Who the user is waits for them to start: gh is not asked on a state read.
  assert.equal(state.steps.find((step) => step.id === 'identity')!.card.fields[0]!.value, '');
});

test('with a CLI ready, the first question answers itself, and the profile is the first one asked', async () => {
  const h = await harness();
  await h.onboarding.detect();
  const state = await view(h);
  assert.equal(state.detected, true);
  const cli = state.steps[0]!;
  assert.deepEqual([cli.status, cli.summary, cli.proposal], ['answered', 'Claude Code writes your brief.', null]);
  assert.equal(state.current, 'profile');
  assert.ok(state.steps.some((step) => step.id === 'schedule'));
  assert.deepEqual(await h.calls(), [], 'nothing asked of it until the profile is answered');
});

test('with none ready, the card says why, and a path that runs is taken for the CLI it is', async () => {
  const h = await harness();
  const loggedOut: CliFound = { path: '/usr/local/bin/claude', version: '2.1.300', onPath: true, ready: false, problem: 'Claude Code is installed but not logged in', fix: 'claude auth login' };
  h.report = { claude: loggedOut, codex: MISSING_CODEX };
  await h.onboarding.detect();
  let state = await view(h);
  const cli = state.steps[0]!;
  assert.equal(cli.status, 'open');
  assert.equal(cli.card.problem?.command, 'claude auth login');

  assert.match((await h.onboarding.answer('cli', pick({}, { path: '/nowhere/claude' }))) ?? '', /Nothing runs at \/nowhere\/claude\./);
  assert.match((await h.onboarding.answer('cli', pick({}, { path: '' }))) ?? '', /Enter the path/);
  const fake = (await h.deps.setup()).clis.claude!;
  assert.equal(await h.onboarding.answer('cli', pick({}, { path: fake })), null);
  state = await view(h);
  assert.equal(state.steps[0]!.summary, 'Claude Code writes your brief.');

  // Its sessions run the path given, and the finish saves it for the agent.
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  assert.equal((await h.calls()).length, 3, 'who you are, the calendars and the objective');
  let next: string | null;
  while ((next = (await view(h)).current)) {
    const fixed: Record<string, ReturnType<typeof pick>> = {
      schedule: pick({ at: ['07:00'], days: ['1-5'] }),
      boards: pick({ boards: [] }),
      calendars: pick({ calendars: [] }),
    };
    await h.onboarding.answer(next, fixed[next] ?? { later: true });
  }
  assert.ok(!('error' in (await h.onboarding.finish())));
  assert.equal(h.settings.DAILY_FOCUS_AGENT, 'claude');
  assert.equal(h.settings.DAILY_FOCUS_AGENT_BIN, fake);
});

test('once the CLI and the profile are answered, each question is looked into, and its card shows what came back', async () => {
  const h = await harness();
  assert.equal(await h.onboarding.answer('cli', pick({ cli: ['claude'] })), null);
  assert.deepEqual(await h.calls(), [], 'the profile is still to come');
  assert.equal(await h.onboarding.answer('profile', pick({ profile: ['work'] })), null);

  const state = await settled(h);
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.proposal?.status, 'ready');
  assert.equal(identity.card.why, 'From your sent mail.');
  assert.deepEqual(identity.card.fields.map((f) => f.value), ['Robin Lark, Robin L.', 'robin@northwind.example']);
  assert.deepEqual(identity.proposal?.conversation, [{ from: 'it', text: 'From your sent mail.' }]);
  assert.equal(identity.card.version, 1);
  assert.equal(identity.card.revisable, true);
  assert.deepEqual(identity.proposal?.steps.map((s) => [s.text, s.state]), [['Look up the GitHub login', 'done']]);

  const calendars = state.steps.find((step) => step.id === 'calendars')!;
  assert.deepEqual(calendars.card.choices[0]!.selected, ['live:robin@northwind.example:Robin Lark']);

  const calls = await h.calls();
  assert.equal(calls.length, 3, 'one session per question');
  for (const argv of calls) {
    assert.ok(argv.includes('--json-schema'), 'the answer is held to a schema');
    assert.equal(argv[argv.indexOf('--model') + 1], 'opus', 'the newest flagship');
    assert.equal(argv[argv.indexOf('--effort') + 1], 'low', 'at low effort');
    assert.ok(argv.includes('--disallowedTools'), 'nothing to edit');
    assert.ok(!argv.includes('mcp__claude_ai_Gmail'), 'read tools by name, not the whole connector');
    assert.ok(argv.includes('mcp__claude_ai_Gmail__search_threads'));
  }
  const calendarCall = calls.find((argv) => argv.join('\n').includes('Which calendars'))!;
  assert.ok(calendarCall.join('\n').includes('- Robin Lark (robin@northwind.example): 3'), "Calendar.app's list goes along");
});

test('telling it what to change resumes the same session, with what the card holds now', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  const before = (await h.calls()).length;
  assert.equal(await h.onboarding.revise('identity', 'Use my short name too', pick({}, { name: 'Robin Lark' })), null);
  const state = await settled(h);
  const calls = await h.calls();
  assert.equal(calls.length, before + 1);
  const revision = calls.find((argv) => argv.includes('--resume'))!;
  assert.equal(revision[revision.indexOf('--resume') + 1], 'sess-identity');
  assert.ok(revision.join('\n').includes('The user says: Use my short name too'));
  assert.ok(revision.join('\n').includes('"name":"Robin Lark"'));
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.card.version, 2);
  assert.deepEqual(identity.proposal?.conversation.map((line) => [line.from, line.text]), [
    ['it', 'From your sent mail.'],
    ['you', 'Use my short name too'],
    ['it', 'From your sent mail.'],
  ]);
});

test('a new profile throws away what was proposed and answered for the old one', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  await h.onboarding.answer('identity', pick({ github: ['rlark'] }, { name: 'Robin Lark', email: 'robin@northwind.example' }));
  await h.onboarding.answer('profile', pick({ profile: ['personal'] }));
  const state = await settled(h);
  assert.equal(state.steps.find((step) => step.id === 'identity')!.status, 'open', 'the work identity is asked again');
  const calls = await h.calls();
  assert.equal(calls.length, 6, 'every question asked again');
  assert.equal(calls.filter((argv) => argv.join('\n').includes('- Profile: personal')).length, 3, 'for the personal profile');
});

test('an answer whose settings would be refused is refused, with the reason', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  const refused = await h.onboarding.answer('schedule', pick({ at: ['25:99'], days: ['1-5'] }));
  assert.match(refused ?? '', /DAILY_FOCUS_AGENT_AT/);
  assert.equal((await view(h)).steps.find((step) => step.id === 'schedule')!.status, 'open');
  // Beside the CLI already answered, a time is fine.
  assert.equal(await h.onboarding.answer('schedule', pick({ at: ['06:30'], days: ['1-5'] })), null);
});

test('the finish saves everything at once, writes the two files, and asks for the first brief', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  assert.deepEqual(h.settings, {}, 'nothing saved yet');
  assert.match((await h.onboarding.finish() as { error: string }).error, /answer/, 'not before every question is answered');

  await h.onboarding.answer('schedule', pick({ at: ['06:30'], days: ['1-5'] }));
  await h.onboarding.answer('identity', pick({ github: ['rlark'] }, { name: 'Robin Lark', email: 'robin@northwind.example' }));
  await h.onboarding.answer('boards', pick({ boards: ['github'] }));
  await h.onboarding.answer('calendars', pick({ calendars: ['live:robin@northwind.example:Robin Lark'] }));
  await h.onboarding.answer('objective', pick({}, { objective: 'Ship the reliability fix' }));
  assert.equal((await view(h)).current, null, 'only the finish is left');

  const preview = await h.onboarding.previewSources();
  assert.equal(preview.kept, false);
  assert.match(preview.text ?? '', /## Calendars/);

  assert.deepEqual(await h.onboarding.finish(), { restart: true });
  assert.deepEqual(h.settings, {
    DAILY_FOCUS_AGENT: 'claude',
    // Not asked: it comes with the CLI.
    DAILY_FOCUS_ASSISTANT: 'claude',
    DAILY_FOCUS_AGENT_AT: '06:30',
    DAILY_FOCUS_AGENT_DAYS: '1-5',
    DAILY_FOCUS_CALENDARS: 'Robin Lark',
    DAILY_FOCUS_CALENDAR_ADDRESSES: 'robin@northwind.example',
    DAILY_FOCUS_GITHUB: 'on',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_PROFILE: 'work',
  });
  const sources = await readFile(join(h.dataDir, 'sources.md'), 'utf8');
  assert.match(sources, /- Work email: `robin@northwind\.example`/);
  assert.match(sources, /- `Robin Lark` \(robin@northwind\.example\)/);
  assert.match(await readFile(join(h.dataDir, 'focus.md'), 'utf8'), /^---\nobjective: Ship the reliability fix\n/);

  assert.equal(await h.onboarding.view(NEW), null, 'setup is over');
  assert.equal(await h.onboarding.takeBriefRequest(), true);
  assert.equal(await h.onboarding.takeBriefRequest(), false, 'asked once');

  // The record survives the restart the save asks for.
  const again = new Onboarding(loadConfig(h.env), h.deps);
  assert.equal(await again.view(NEW), null);
});

test('a source list the user wrote is kept, and a setting from the environment is shown and never saved', async () => {
  const h = await harness({ DAILY_FOCUS_PROFILE: 'personal' });
  await writeFile(join(h.dataDir, 'sources.md'), '# My own list\n', 'utf8');
  let state = await view(h);
  const profile = state.steps.find((step) => step.id === 'profile')!;
  assert.equal(profile.locked, true);
  assert.equal(profile.status, 'answered');
  assert.equal(profile.summary, 'It briefs your personal life.');

  // Choosing the CLI brings the schedule in: follow the screen, not the list it started with.
  const firsts: Record<string, ReturnType<typeof pick>> = {
    cli: pick({ cli: ['claude'] }),
    schedule: pick({ at: ['07:00'], days: ['1-5'] }),
    boards: pick({ boards: [] }),
    calendars: pick({ calendars: [] }),
  };
  while ((state = await view(h)).current) {
    await h.onboarding.answer(state.current, firsts[state.current] ?? { later: true });
  }
  await settled(h);
  assert.equal((await h.onboarding.previewSources()).kept, true);
  assert.ok(!('error' in (await h.onboarding.finish())));
  assert.equal(await readFile(join(h.dataDir, 'sources.md'), 'utf8'), '# My own list\n');
  assert.equal(h.settings.DAILY_FOCUS_PROFILE, undefined, 'the environment wins, so it is not saved');
  assert.equal(h.settings.DAILY_FOCUS_AGENT, 'claude');
});

test('an answer that is not JSON fails the question, which falls back and can be asked again', async () => {
  const h = await harness({}, 'Here is what I found: Robin Lark', true);
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  const state = await settled(h);
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.proposal?.status, 'failed');
  assert.match(identity.proposal?.error ?? '', /not in the shape asked for/);
  assert.equal(identity.card.fields[0]!.value, 'Robin Lark', 'the card falls back to what gh says');

  assert.equal(await h.onboarding.retry('identity'), null);
  await settled(h);
  assert.equal((await h.calls()).length, 4, 'one more, for the question asked again');
});

test('nothing reaches outside the dashboard until the user answers something, even with the CLI and profile set', async () => {
  const h = await harness({ DAILY_FOCUS_PROFILE: 'work', DAILY_FOCUS_AGENT: 'claude' });
  let identities = 0;
  let listings = 0;
  const identity = h.deps.identity;
  h.deps.identity = async () => (identities++, identity());
  const list = h.deps.listCalendars;
  h.deps.listCalendars = async () => (listings++, list());
  await h.onboarding.start(true);
  const state = await view(h);
  assert.deepEqual(state.steps.filter((step) => step.locked).map((step) => step.id), ['cli', 'profile']);
  assert.equal(state.current, 'schedule');
  assert.deepEqual([identities, listings, (await h.calls()).length], [0, 0, 0]);

  await h.onboarding.answer('schedule', pick({ at: ['07:00'], days: ['1-5'] }));
  await settled(h);
  assert.equal((await h.calls()).length, 3, 'the first answer starts every question');
  assert.ok(identities > 0 && listings === 1);
});

test('an agent the environment turns off is no agent: nothing to schedule, and nobody to ask', async () => {
  const h = await harness({ DAILY_FOCUS_AGENT: 'off' });
  const state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'cli')!.summary, 'No agent writes your brief yet.');
  assert.ok(!state.steps.some((step) => step.id === 'schedule'));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  assert.equal((await h.calls()).length, 0);
});

test('Decide later is refused where it is not offered', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  assert.match((await h.onboarding.answer('profile', { later: true })) ?? '', /needs an answer/);
  assert.equal(await h.onboarding.answer('objective', { later: true }), null);
  const state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'profile')!.card.deferrable, false);
  assert.equal(state.steps.find((step) => step.id === 'objective')!.card.deferrable, true);
});

test('answering while it is still looking stops it, and keeps what the user answered', async () => {
  const h = await harness();
  const slow = join(h.dataDir, 'slow-claude');
  await writeFile(slow, '#!/bin/sh\nsleep 30\n', 'utf8');
  await chmod(slow, 0o755);
  h.report = { ...h.report, claude: { ...h.report.claude, path: slow } };
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  assert.equal((await view(h)).steps.find((step) => step.id === 'objective')!.proposal?.status, 'working');
  assert.equal(await h.onboarding.answer('objective', pick({}, { objective: 'Ship the reliability fix', blocker: '' })), null);
  for (let i = 0; i < 100; i++) {
    if ((await view(h)).steps.find((step) => step.id === 'objective')!.proposal?.status !== 'working') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  const objective = (await view(h)).steps.find((step) => step.id === 'objective')!;
  assert.equal(objective.proposal?.status, 'failed');
  assert.match(objective.proposal?.error ?? '', /you continued before it finished/);
  assert.equal(objective.summary, 'Your objective: Ship the reliability fix');
  await h.onboarding.close();
});
