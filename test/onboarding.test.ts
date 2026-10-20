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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import type { CliFound, CliReport } from '../src/clis.ts';
import type { SettingSources } from '../src/env.ts';
import { Onboarding, type OnboardingDeps } from '../src/onboarding.ts';
import { applySettingsChange } from '../src/settings.ts';
import { asProfile } from '../src/stores.ts';
import type { OnboardingAnswer, OnboardingState, SetupState } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];
after(async () => {
  // Retried: on Windows a folder is busy while a stopped session's process still lets go of it.
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
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
  /** What the config was built from: the store, and the settings it started with. */
  values: Record<string, string>;
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
async function harness(saved: Record<string, string> = {}, reply: unknown = PROPOSAL, raw = false): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-onboarding-'));
  dirs.push(dataDir);
  // The lines a real Claude Code prints, with the session id left for the script to fill in.
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'SESSION' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh api user', description: 'Look up the GitHub login' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'SESSION', result: raw ? String(reply) : JSON.stringify(reply) },
  ];
  await writeFile(join(dataDir, 'lines.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  const bin = await fakeCli(
    join(dataDir, 'fake-claude'),
    [
      `fs.writeFileSync(${quoted(join(dataDir, 'argv-'))} + String(Date.now()).padStart(15, '0') + '-' + process.pid, args.map((arg) => arg + '\\n').join(''));`,
      "const asked = args.join(' ');",
      "const id = asked.includes('Is this you') || asked.includes('sess-identity') ? 'sess-identity' : 'sess-calendars';",
      `process.stdout.write(fs.readFileSync(${quoted(join(dataDir, 'lines.jsonl'))}, 'utf8').replaceAll('SESSION', id));`,
    ].join('\n'),
  );

  const values: Record<string, string> = { DAILY_FOCUS_DATA: dataDir, ...saved };
  const config = loadConfig(values);
  const h = { dataDir, settings: { ...saved }, values } as Harness;
  // The store's folder follows the profile its settings name, as it does after
  // the restart the finish asks for.
  const sources = (): SettingSources => ({
    launch: { DAILY_FOCUS_DATA: dataDir },
    store: { root: dataDir, profile: asProfile(h.settings.DAILY_FOCUS_PROFILE) ?? 'work', dir: dataDir, given: false, move: null, problem: null },
    settings: h.settings,
    settingsPath: join(dataDir, 'settings.json'),
    settingsError: null,
  });
  const setup: SetupState = {
    needed: true,
    profile: 'work',
    sources: { exists: false, placeholders: 0 },
    clis: { claude: bin, codex: null },
    calendar: { supported: true, built: true, chosen: 0, buildCommand: 'daily-focus build-calendar', macApp: null, source: 'calendar-app' },
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
    services: async () => ({
      github: { enabled: true, connected: true, account: 'rlark' },
      jira: { enabled: true, connected: false, account: null },
    }),
    listCalendars: async () => [
      { title: 'Robin Lark', source: 'robin@northwind.example', eventsToday: 3 },
      { title: 'Family', source: 'iCloud', eventsToday: 1 },
    ],
    checkSettings: (values) => {
      const applied = applySettingsChange(sources(), values, { setup: true });
      return 'error' in applied ? applied.error : null;
    },
    saveSettings: async (values) => {
      const applied = applySettingsChange(sources(), values, { setup: true });
      if ('error' in applied) return applied.error;
      h.settings = applied.settings;
      return null;
    },
  };
  h.onboarding = new Onboarding(config, h.deps);
  // In the order they were made: each file is named for the time it was written.
  h.calls = async () => {
    const names = (await readdir(dataDir)).filter((name) => name.startsWith('argv-')).sort();
    return Promise.all(names.map(async (name) => (await readFile(join(dataDir, name), 'utf8')).split('\n')));
  };
  return h;
}

const NEW: SetupState = {
  needed: true,
  profile: 'work',
  sources: { exists: false, placeholders: 0 },
  clis: { claude: null, codex: null },
  calendar: { supported: true, built: true, chosen: 0, buildCommand: '', macApp: null, source: 'calendar-app' },
};

async function view(h: Harness): Promise<OnboardingState> {
  const state = await h.onboarding.view({ ...NEW, clis: (await h.deps.setup()).clis });
  assert.ok(state, 'the screen is showing');
  return state;
}

/** Wait until no question has a session going. */
async function settled(h: Harness): Promise<OnboardingState> {
  await h.onboarding.started();
  for (let i = 0; i < 300; i++) {
    const state = await view(h);
    if (!h.onboarding.busy && state.steps.every((step) => step.proposal?.status !== 'working')) return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('a session never finished');
}

const pick = (choices: Record<string, string[]>, fields: Record<string, string> = {}) => ({ choices, fields });

/** What each question is answered with when a test only needs to get past it. */
const PLAIN: Record<string, OnboardingAnswer> = {
  cli: pick({ cli: ['claude'] }),
  schedule: pick({ at: ['07:00'], days: ['1-5'] }),
  identity: { later: true },
  services: pick({ services: [] }),
  calendars: pick({ calendars: [] }),
  objective: pick({}, { objective: '', blocker: '' }),
};

/**
 * Answer whatever the screen asks next until only the finish is left. Bounded,
 * so an answer refused fails the test instead of asking the same question forever.
 */
async function answerTheRest(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const next = (await view(h)).current;
    if (!next) return;
    const refused = await h.onboarding.answer(next, PLAIN[next] ?? { later: true });
    assert.equal(refused, null, `${next} refused: ${refused}`);
  }
  throw new Error('the questions never ran out');
}

test('a new store opens looking for the CLIs, and runs nothing until the screen asks', async () => {
  const h = await harness();
  const state = await view(h);
  assert.equal(state.detected, false);
  assert.equal(state.current, 'cli');
  assert.deepEqual(
    state.steps.map((step) => step.id),
    ['cli', 'profile', 'services', 'identity', 'calendars', 'objective'],
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
  await answerTheRest(h);
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
  await h.onboarding.answer('services', pick({ services: ['github'] }));
  await h.onboarding.answer('identity', pick({ github: ['rlark'] }, { name: 'Robin Lark', email: 'robin@northwind.example' }));
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
  const again = new Onboarding(loadConfig(h.values), h.deps);
  assert.equal(await again.view(NEW), null);
});

test('a source list the user wrote is kept, and a setting already saved is still asked about', async () => {
  const h = await harness({ DAILY_FOCUS_PROFILE: 'personal' });
  await writeFile(join(h.dataDir, 'sources.md'), '# My own list\n', 'utf8');
  const state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'profile')!.status, 'open');

  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  // Choosing the CLI brings the schedule in: follow the screen, not the list it started with.
  await answerTheRest(h);
  await settled(h);
  assert.equal((await h.onboarding.previewSources()).kept, true);
  assert.ok(!('error' in (await h.onboarding.finish())));
  assert.equal(await readFile(join(h.dataDir, 'sources.md'), 'utf8'), '# My own list\n');
  assert.equal(h.settings.DAILY_FOCUS_PROFILE, 'work', 'the answer is saved over it');
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

/**
 * A fake `codex` beside the fake `claude`, made the ready one. It answers on
 * the model `accepts`, and refuses any other the way the server does.
 */
async function withCodex(h: Harness, accepts: string | null): Promise<void> {
  const refusal = JSON.stringify({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', message: "The 'MODEL' model is not supported when using Codex with a ChatGPT account." },
  });
  const lines = (events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await writeFile(
    join(h.dataDir, 'codex-ok.jsonl'),
    lines([
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(PROPOSAL) } },
      { type: 'turn.completed' },
    ]),
  );
  await writeFile(
    join(h.dataDir, 'codex-refused.jsonl'),
    lines([{ type: 'thread.started', thread_id: 'th-1' }, { type: 'error', message: refusal }, { type: 'turn.failed', error: { message: refusal } }]),
  );
  const bin = await fakeCli(
    join(h.dataDir, 'fake-codex'),
    [
      `fs.writeFileSync(${quoted(join(h.dataDir, 'argv-'))} + String(Date.now()).padStart(15, '0') + '-' + process.pid, args.map((arg) => arg + '\\n').join(''));`,
      "const model = (args.map((arg) => /^model=\"(.*)\"$/.exec(arg)).find(Boolean) ?? [])[1] ?? '';",
      `if (model === ${quoted(accepts ?? '')}) { process.stdout.write(fs.readFileSync(${quoted(join(h.dataDir, 'codex-ok.jsonl'))}, 'utf8')); process.exit(0); }`,
      `process.stdout.write(fs.readFileSync(${quoted(join(h.dataDir, 'codex-refused.jsonl'))}, 'utf8').replaceAll('MODEL', model));`,
      'process.exit(1);',
    ].join('\n'),
  );
  h.report = { claude: h.report.claude, codex: { path: bin, version: '0.162.1', onPath: true, ready: true, problem: null, fix: null } };
  h.deps.execFn = async (_file, args) => {
    if (args[0] === '--version') return 'codex-cli 0.162.1';
    if (args[0] === 'mcp') return '[]';
    if (args[0] === 'debug') {
      return JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', priority: 1, visibility: 'list' }, { slug: 'gpt-6-sol', priority: 3, visibility: 'list' }] });
    }
    throw new Error(`the fake codex was not asked for ${args.join(' ')}`);
  };
}

const modelOf = (argv: string[]) => argv.find((arg) => arg.startsWith('model='));

test("a Codex model the account can't use is asked again on GPT-6 Sol, once, and every session after keeps to it", async () => {
  const h = await harness();
  await withCodex(h, 'gpt-6-sol');
  assert.equal(await h.onboarding.answer('cli', pick({ cli: ['codex'] })), null);
  assert.equal(await h.onboarding.answer('profile', pick({ profile: ['work'] })), null);
  const state = await settled(h);
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.proposal?.status, 'ready');
  assert.equal(identity.card.why, 'From your sent mail.');

  const models = (await h.calls()).map(modelOf);
  assert.equal(models.filter((model) => model === 'model="gpt-6-sol"').length, 3, 'each question answered on the fallback');
  assert.ok(models.every((model) => model === 'model="gpt-6.1-sol"' || model === 'model="gpt-6-sol"'), 'nothing lighter');

  assert.equal(await h.onboarding.revise('identity', 'Leave out the short form', null), null);
  await settled(h);
  assert.equal(modelOf((await h.calls()).at(-1)!), 'model="gpt-6-sol"', 'the catalog is not asked again');
});

test('when the fallback is refused too, the card says which model the plan lacks', async () => {
  const h = await harness();
  await withCodex(h, null);
  await h.onboarding.answer('cli', pick({ cli: ['codex'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  const state = await settled(h);
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.proposal?.status, 'failed');
  assert.equal(identity.proposal?.error, "your ChatGPT plan or workspace doesn't include the model “gpt-6-sol”");
  // A question whose session starts after another's has failed goes straight to
  // the fallback, so how many tried the first model first depends on timing.
  const models = (await h.calls()).map(modelOf);
  assert.equal(models.filter((model) => model === 'model="gpt-6-sol"').length, 3, 'each question tried the fallback once, and no more');
  const first = models.filter((model) => model === 'model="gpt-6.1-sol"').length;
  assert.ok(first >= 1 && first <= 3, 'the first model, at most once a question');
  assert.equal(models.length, 3 + first);
});

test('nothing reaches outside the dashboard until the user answers something, even with the CLI and profile saved', async () => {
  const h = await harness({ DAILY_FOCUS_PROFILE: 'work', DAILY_FOCUS_AGENT: 'claude' });
  let identities = 0;
  let listings = 0;
  const identity = h.deps.identity;
  h.deps.identity = async () => (identities++, identity());
  const list = h.deps.listCalendars;
  h.deps.listCalendars = async () => (listings++, list());
  await h.onboarding.start(true);
  // What the screen asks for when it opens: looking for the CLIs reaches nothing outside.
  await h.onboarding.detect();
  const state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'cli')!.summary, 'Claude Code writes your brief.', 'the saved CLI is the one picked');
  assert.equal(state.current, 'profile');
  assert.deepEqual([identities, listings, (await h.calls()).length], [0, 0, 0]);

  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await settled(h);
  assert.equal((await h.calls()).length, 3, 'the first answer starts every question');
  assert.ok(identities > 0 && listings === 1);
});

test('a question is left only where it offers to be, and the thread says what leaving it means', async () => {
  const h = await harness();
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  assert.match((await h.onboarding.answer('profile', { later: true })) ?? '', /needs an answer/);
  assert.match((await h.onboarding.answer('objective', { later: true })) ?? '', /needs an answer/, 'left empty, Continue says so');
  assert.equal(await h.onboarding.answer('identity', { later: true }), null);
  const state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'profile')!.card.later, null);
  const identity = state.steps.find((step) => step.id === 'identity')!;
  assert.equal(identity.card.later, 'Leave this out');
  assert.equal(identity.status, 'later');
  assert.match(identity.summary ?? '', /left out, so the brief can’t tell your to-dos/);
});

test('answering while it is still looking stops it, and keeps what the user answered', async () => {
  const h = await harness();
  // It starts a child that goes on holding the output once it is stopped itself,
  // as a CLI's own children can. Stopping must not wait for that. Each says when
  // it is asleep.
  const slow = await fakeCli(
    join(h.dataDir, 'slow-claude'),
    [
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
      `fs.writeFileSync(${quoted(join(h.dataDir, 'asleep-'))} + process.pid, '');`,
      'sleep(30000);',
      "say('never');",
    ].join('\n'),
  );
  h.report = { ...h.report, claude: { ...h.report.claude, path: slow } };
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  await h.onboarding.started();
  assert.equal((await view(h)).steps.find((step) => step.id === 'objective')!.proposal?.status, 'working');
  // Stopped once it is really asleep, not before its shell has got that far.
  const asleep = async () => (await readdir(h.dataDir)).filter((name) => name.startsWith('asleep-')).length;
  for (let i = 0; i < 200 && (await asleep()) < 3; i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(await asleep(), 3);
  assert.equal(await h.onboarding.answer('objective', pick({}, { objective: 'Ship the reliability fix', blocker: '' })), null);
  // Up to five seconds: on Windows a stop starts taskkill first.
  for (let i = 0; i < 250; i++) {
    if ((await view(h)).steps.find((step) => step.id === 'objective')!.proposal?.status !== 'working') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  const objective = (await view(h)).steps.find((step) => step.id === 'objective')!;
  assert.equal(objective.proposal?.status, 'failed');
  assert.match(objective.proposal?.error ?? '', /you continued before it finished/);
  assert.equal(objective.summary, 'Your objective: Ship the reliability fix');
  await h.onboarding.close();
});

test('an answer comes back before the sessions it starts have started, so the next question can be answered', async () => {
  const h = await harness();
  // Standing in for what makes a start slow for real: Codex's checks, the calendar helper.
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const list = h.deps.listCalendars;
  h.deps.listCalendars = async () => (await slow, list());
  await h.onboarding.answer('cli', pick({ cli: ['claude'] }));
  await h.onboarding.answer('profile', pick({ profile: ['work'] }));
  assert.deepEqual(await h.calls(), [], 'the reply did not wait for them');
  assert.equal(await h.onboarding.answer('schedule', pick({ at: ['07:00'], days: ['1-5'] })), null, 'and the next answer is taken meanwhile');
  release();
  await settled(h);
  assert.equal((await h.calls()).length, 3, 'each question started once, though two answers asked');
});

test('GitHub and Jira are asked about before who you are, and a ticked one has to be connected first', async () => {
  const h = await harness();
  let jira = { enabled: true, connected: false, account: null as string | null };
  h.deps.services = async () => ({ github: { enabled: true, connected: true, account: 'rlark' }, jira });
  await h.onboarding.detect();
  assert.equal(await h.onboarding.answer('profile', pick({ profile: ['work'] })), null);
  assert.equal(await h.onboarding.answer('schedule', PLAIN.schedule!), null);

  let state = await view(h);
  assert.deepEqual(
    state.steps.map((step) => step.id).slice(0, 5),
    ['cli', 'profile', 'schedule', 'services', 'identity'],
  );
  assert.equal(state.current, 'services');
  assert.deepEqual(state.steps.find((step) => step.id === 'services')!.card.connections, [
    { service: 'github', account: 'rlark' },
    { service: 'jira', account: null },
  ]);
  assert.equal(await h.onboarding.answer('services', pick({ services: ['github', 'jira'] })), 'Connect Jira first, or untick it');

  // Connecting it, from the card.
  jira = { enabled: true, connected: true, account: 'robin@northwind.example' };
  assert.equal(await h.onboarding.answer('services', pick({ services: ['github', 'jira'] })), null);
  state = await view(h);
  assert.equal(state.steps.find((step) => step.id === 'services')!.summary, 'You use GitHub (rlark) and Jira (robin@northwind.example).');
  assert.equal(state.current, 'identity');
  await settled(h);
  await h.onboarding.close();
});

test('leaving GitHub out leaves its accounts out of who you are', async () => {
  const h = await harness();
  await h.onboarding.detect();
  assert.equal(await h.onboarding.answer('profile', pick({ profile: ['work'] })), null);
  const identity = async () => (await view(h)).steps.find((step) => step.id === 'identity')!;
  assert.equal((await identity()).card.choices[0]?.label, 'Your GitHub accounts', 'on by default');
  assert.equal(await h.onboarding.answer('services', pick({ services: [] })), null);
  assert.deepEqual((await identity()).card.choices, []);
  await settled(h);
  await h.onboarding.close();
});
