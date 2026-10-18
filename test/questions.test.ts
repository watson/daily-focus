/**
 * The setup screen's questions: what each card ticks from what the dashboard
 * knows and what a CLI proposed, and what each answer writes. All invented
 * people and calendars.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CliFound, CliReport } from '../src/clis.ts';
import { calendarEntries, composeSources, machineName, questionById, type Chosen, type QuestionContext } from '../src/questions.ts';
import { placeholdersIn } from '../src/setup.ts';

const READY = (path: string, onPath = true): CliFound => ({ path, version: '1.0.0', onPath, ready: true, problem: null, fix: null });
const MISSING = (name: string): CliFound => ({ path: null, version: null, onPath: false, ready: false, problem: `${name} isn't installed`, fix: null });
const report = (claude: CliFound, codex: CliFound): CliReport => ({ claude, codex });

function ctx(overrides: Partial<QuestionContext> = {}): QuestionContext {
  return {
    machine: 'Mac',
    profile: 'work',
    profileSet: false,
    cli: 'claude',
    clis: report(READY('/usr/local/bin/claude'), MISSING('Codex')),
    identity: { name: 'Robin Lark', login: 'rlark', logins: ['rlark'], email: 'robin@example.com' },
    calendars: [
      { title: 'Robin Lark', source: 'robin@northwind.example', eventsToday: 4 },
      { title: 'Platform team', source: 'robin@northwind.example', eventsToday: 2 },
      { title: 'Family', source: 'iCloud', eventsToday: 1 },
      { title: 'Holidays in Denmark', source: 'Other', eventsToday: 0 },
    ],
    calendar: { supported: true, built: true, buildCommand: 'daily-focus build-calendar' },
    boards: {
      github: { enabled: true, fetchedAt: '2026-10-16T08:00:00Z', reason: null },
      jira: { enabled: true, fetchedAt: null, reason: 'could not run acli' },
    },
    current: {},
    proposals: {},
    ...overrides,
  };
}

const question = (id: string) => questionById(id)!;
const chosen = (choices: Record<string, string[]>, fields: Record<string, string> = {}): Chosen => ({ choices, fields });

test('the CLI card offers the ready ones, Codex first, and says what is wrong with the rest', () => {
  const one = question('cli').card(ctx());
  assert.deepEqual(one.choices[0]!.options.map((o) => o.value), ['claude']);
  assert.deepEqual(one.choices[0]!.selected, ['claude']);

  const both = question('cli').card(ctx({ clis: report(READY('/a/claude'), READY('/a/codex')) }));
  assert.deepEqual(both.choices[0]!.options.map((o) => o.value), ['codex', 'claude']);
  assert.deepEqual(both.choices[0]!.selected, ['codex']);
  const set = question('cli').card(ctx({ clis: report(READY('/a/claude'), READY('/a/codex')), current: { DAILY_FOCUS_AGENT: 'claude' } }));
  assert.deepEqual(set.choices[0]!.selected, ['claude'], 'the one already set wins');

  const loggedOut: CliFound = { path: '/a/codex', version: '0.162.1', onPath: true, ready: false, problem: 'Codex is installed but not logged in', fix: 'codex login' };
  const none = question('cli').card(ctx({ clis: report(MISSING('Claude Code'), loggedOut) }));
  assert.equal(none.choices.length, 0);
  assert.equal(none.problem?.blocking, true);
  assert.equal(none.problem?.command, 'codex login');
  assert.equal(none.problem!.message, "Codex is installed but not logged in. Claude Code isn't installed. Claude Code needs a paid Claude plan. Run this in a terminal, then check again.");
  assert.deepEqual(none.problem!.links!.map((l) => l.label), ['Install Claude Code'], 'only for the one missing');
  assert.deepEqual(none.fields.map((f) => f.id), ['path']);

  const missing = question('cli').card(ctx({ clis: report(MISSING('Claude Code'), MISSING('Codex')) }));
  assert.equal(
    missing.problem!.message,
    'Neither Codex nor Claude Code is installed. Codex needs ChatGPT Plus or higher; Claude Code needs a paid Claude plan. Install one, log in once in a terminal, then check again.',
  );
  assert.deepEqual(missing.problem!.links!.map((l) => l.label), ['Install Codex', 'Install Claude Code']);
  const claudeOut: CliFound = { path: '/a/claude', version: '2.1.0', onPath: true, ready: false, problem: 'Claude Code is installed but not logged in', fix: 'claude auth login' };
  const out = question('cli').card(ctx({ clis: report(claudeOut, loggedOut) }));
  assert.equal(out.problem!.message, 'Codex and Claude Code are installed, but neither is logged in. Run this in a terminal, then check again.');
  assert.equal(out.problem!.command, 'codex login');

  assert.deepEqual(question('cli').card(ctx({ clis: null })), question('cli').card(ctx({ clis: null })), 'nothing to show until it has looked');
  assert.equal(question('cli').summary(chosen({ cli: ['claude'] }), ctx()), 'Claude Code writes your brief.');
  assert.equal(question('cli').summary(chosen({ cli: ['off'] }), ctx()), 'No agent writes your brief yet.');
});

test('the chosen CLI brings the assistant with it, and a path off PATH is saved for both', () => {
  const c = ctx({ clis: report(MISSING('Claude Code'), READY('/home/robin/.codex/bin/codex', false)) });
  assert.deepEqual(question('cli').settings!(chosen({ cli: ['codex'] }), c), {
    DAILY_FOCUS_AGENT: 'codex',
    DAILY_FOCUS_AGENT_BIN: '/home/robin/.codex/bin/codex',
    DAILY_FOCUS_ASSISTANT: 'codex',
    DAILY_FOCUS_ASSISTANT_BIN: '/home/robin/.codex/bin/codex',
  });
  assert.deepEqual(
    question('cli').settings!(chosen({ cli: ['claude'] }), ctx()),
    { DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_ASSISTANT: 'claude' },
    'on PATH, no path to save',
  );
  assert.deepEqual(
    question('cli').settings!(chosen({ cli: ['claude'] }), ctx({ current: { DAILY_FOCUS_ASSISTANT: 'off' } })),
    { DAILY_FOCUS_AGENT: 'claude' },
    'an assistant already set is left as it is',
  );
});

test('a question can be left only where Continue cannot say "nothing", by a button named for what it does', () => {
  const offered = (id: string) => questionById(id)!.later?.label ?? null;
  assert.deepEqual(
    ['cli', 'profile', 'schedule', 'identity', 'boards', 'calendars', 'objective'].map((id) => [id, offered(id)]),
    [
      ['cli', 'Decide later'],
      ['profile', null],
      ['schedule', null],
      ['identity', 'Leave this out'],
      ['boards', null],
      ['calendars', null],
      ['objective', null],
    ],
  );
  assert.equal(question('objective').card(ctx()).empty, 'Continue without one');
  assert.equal(questionById('assistant'), undefined, 'the assistant comes with the CLI, unasked');
});

test('the schedule writes the time and the days, and a time of its own is offered back', () => {
  const card = question('schedule').card(ctx({ current: { DAILY_FOCUS_AGENT_AT: '05:45' } }));
  const at = card.choices.find((c) => c.id === 'at')!;
  assert.ok(at.options.some((o) => o.value === '05:45'), 'a time set earlier is one of the options');
  assert.deepEqual(at.selected, ['05:45']);
  const answer = chosen({ at: ['07:30'], days: ['0-6'] });
  assert.deepEqual(question('schedule').settings!(answer, ctx()), { DAILY_FOCUS_AGENT_AT: '07:30', DAILY_FOCUS_AGENT_DAYS: '0-6' });
  assert.equal(question('schedule').summary(answer, ctx()), 'It runs at 07:30 every day.');
  assert.equal(question('schedule').summary(chosen({ at: ['off'], days: ['1-5'] }), ctx()), 'It runs only when you ask.');
  assert.equal(question('schedule').applies!(ctx({ cli: null })), false, 'nothing to schedule without an agent');
});

test("identity starts from gh and git, takes the CLI's proposal over them, and writes no placeholder", () => {
  const plain = question('identity').card(ctx());
  assert.deepEqual(plain.fields.map((f) => f.value), ['Robin Lark', 'robin@example.com']);
  assert.deepEqual(plain.choices[0]!.selected, ['rlark']);

  const proposed = question('identity').card(
    ctx({ proposals: { identity: { why: 'Your sent mail says so.', names: ['Robin Lark', 'Robin L.'], email: 'robin@northwind.example', githubAccounts: [] } } }),
  );
  assert.equal(proposed.why, 'Your sent mail says so.');
  assert.deepEqual(proposed.fields.map((f) => f.value), ['Robin Lark, Robin L.', 'robin@northwind.example']);

  const answer = chosen({ github: ['rlark'] }, { name: 'Robin Lark, Robin L.', email: 'robin@northwind.example' });
  assert.equal(question('identity').summary(answer, ctx()), "You're Robin Lark, robin@northwind.example, rlark on GitHub.");
  assert.deepEqual(question('identity').settings!(answer, ctx()), { DAILY_FOCUS_CALENDAR_ADDRESSES: 'robin@northwind.example' });
  const [section] = question('identity').sources!(answer, ctx());
  assert.equal(section!.heading, 'Identity');
  assert.match(section!.body, /`Robin Lark`, also `Robin L\.`/);
  assert.deepEqual(question('identity').sources!(chosen({}, { name: '', email: '' }), ctx()), [], 'nothing known, nothing written');
});

test('every GitHub account gh holds is offered, with what the proposal says each is for, and more than one is read as', () => {
  const c = ctx({
    identity: { name: 'Robin Lark', login: 'rlark', logins: ['rlark', 'rlark-acme'], email: null },
    proposals: {
      identity: {
        why: 'gh holds two accounts.',
        names: ['Robin Lark'],
        email: '',
        githubAccounts: [
          { login: 'rlark-acme', note: 'for the acme organisation' },
          { login: 'rlark', note: 'your own projects' },
        ],
      },
    },
  });
  const accounts = question('identity').card(c).choices[0]!;
  assert.deepEqual(accounts.options.map((o) => [o.value, o.detail]), [
    ['rlark', 'your own projects'],
    ['rlark-acme', 'for the acme organisation'],
  ]);
  assert.deepEqual(accounts.selected, ['rlark', 'rlark-acme']);

  const both = chosen({ github: ['rlark', 'rlark-acme'] }, { name: 'Robin Lark', email: '' });
  assert.deepEqual(question('identity').settings!(both, c), { DAILY_FOCUS_GITHUB_ACCOUNTS: 'rlark, rlark-acme' });
  assert.match(question('identity').sources!(both, c)[0]!.body, /- GitHub logins, [^\n]*\n  - `rlark` — your own projects\n  - `rlark-acme` — for the acme organisation/);
  assert.deepEqual(
    question('identity').settings!(chosen({ github: ['rlark-acme'] }, { name: '', email: '' }), c),
    { DAILY_FOCUS_GITHUB_ACCOUNTS: 'rlark-acme' },
    'one that is not the active one is said',
  );
});

test('the boards are ticked when they work, and Jira only for work', () => {
  const card = question('boards').card(ctx());
  assert.deepEqual(card.choices[0]!.selected, ['github'], 'a Jira that cannot be read is not ticked');
  assert.match(card.choices[0]!.options.find((o) => o.value === 'jira')!.detail!, /acli/);
  const personal = question('boards').card(ctx({ profile: 'personal', boards: { ...ctx().boards, jira: { enabled: true, fetchedAt: 'x', reason: null } } }));
  assert.deepEqual(personal.choices[0]!.selected, ['github']);
  assert.deepEqual(question('boards').settings!(chosen({ boards: ['jira'] }), ctx()), { DAILY_FOCUS_GITHUB: 'off', DAILY_FOCUS_JIRA: 'on' });
});

test("calendars are Calendar.app's, ticked by the proposal, plus what only the connector has", () => {
  const proposals = {
    calendars: {
      why: 'These are on your work account.',
      calendars: [
        { title: 'Robin Lark', account: 'robin@northwind.example', include: true, holiday: false, briefName: 'robin@northwind.example', note: 'Your primary calendar' },
        { title: 'Platform team', account: 'robin@northwind.example', include: true, holiday: false, briefName: '', note: '' },
        { title: 'Family', account: 'iCloud', include: false, holiday: false, briefName: '', note: '' },
        { title: 'Holidays in Denmark', account: 'Other', include: true, holiday: true, briefName: '', note: 'Where you are' },
        { title: 'On-call', account: 'robin@northwind.example', include: true, holiday: false, briefName: '', note: 'Only on the connector' },
      ],
    },
  };
  const c = ctx({ proposals });
  const entries = calendarEntries(c);
  assert.deepEqual(
    entries.map((e) => [e.title, e.group, e.live, e.include]),
    [
      ['Robin Lark', 'robin@northwind.example', true, true],
      ['Platform team', 'robin@northwind.example', true, true],
      ['Family', 'iCloud', true, false],
      ['On-call', 'robin@northwind.example', false, true],
      ['Holidays in Denmark', 'Holidays', true, true],
    ],
    'holidays last, then the connector-only ones before them',
  );

  const card = question('calendars').card(c);
  const values = card.choices[0]!.selected;
  const answer = chosen({ calendars: [...values, 'Typed by hand'] });
  assert.deepEqual(question('calendars').settings!(answer, c), {
    DAILY_FOCUS_CALENDARS: 'Robin Lark, Platform team, Holidays in Denmark, Typed by hand',
  });
  const sources = question('calendars').sources!(answer, c);
  assert.deepEqual(sources.map((s) => s.heading), ['Calendars', 'Holiday calendars']);
  assert.match(sources[0]!.body, /`robin@northwind\.example` \(robin@northwind\.example\)/, "the connector's name for it");
  assert.match(sources[0]!.body, /`On-call`/);
  assert.match(sources[0]!.body, /`Typed by hand`/);
  assert.match(sources[1]!.body, /`Holidays in Denmark`/);
  assert.equal(question('calendars').summary(answer, c), 'It reads Robin Lark, Platform team and 3 more calendars.');
});

test('without a proposal, the calendars already set stay ticked; an unbuilt helper is said, not blocking', () => {
  const c = ctx({ current: { DAILY_FOCUS_CALENDARS: 'platform team' } });
  assert.deepEqual(
    calendarEntries(c).filter((e) => e.include).map((e) => e.title),
    ['Platform team'],
  );
  const unbuilt = question('calendars').card(ctx({ calendars: null, calendar: { supported: true, built: false, buildCommand: 'daily-focus build-calendar' } }));
  assert.equal(unbuilt.problem?.blocking, false);
  assert.equal(unbuilt.problem?.command, 'daily-focus build-calendar');
});

test('the source list is only what was chosen, and never a placeholder', () => {
  const text = composeSources('work', [{ heading: 'Identity', body: '- Work email: `robin@example.com`' }], '2026-10-16');
  assert.match(text, /^# Sources\n/);
  assert.match(text, /## Identity\n\n- Work email/);
  assert.equal(placeholdersIn(text), 0);
});

test('the objective goes to focus.md with its blocker, and an empty one is no objective', () => {
  assert.deepEqual(question('objective').objective!(chosen({}, { objective: ' Ship the reliability fix ', blocker: ' Staging is down ' })), {
    objective: 'Ship the reliability fix',
    blocker: 'Staging is down',
  });
  assert.deepEqual(question('objective').objective!(chosen({}, { objective: 'Ship it', blocker: '' })), { objective: 'Ship it', blocker: null });
  assert.equal(question('objective').objective!(chosen({}, { objective: '', blocker: 'Staging is down' })), null);
  assert.equal(
    question('objective').summary(chosen({}, { objective: 'Ship the reliability fix', blocker: 'Staging is down' }), ctx()),
    'Your objective: Ship the reliability fix. In the way: Staging is down',
  );
});

test('suggested objectives are offered under the field, never filled in, and a written-up one is', () => {
  const suggested = question('objective').card(
    ctx({
      proposals: {
        objective: {
          why: 'Your open pull requests are all on checkout.',
          objective: '',
          blocker: '',
          suggestions: [{ objective: 'Get checkout retries merged', evidence: 'your 4 open pull requests on checkout' }],
        },
      },
    }),
  );
  const field = suggested.fields.find((f) => f.id === 'objective')!;
  assert.equal(field.value, '');
  assert.deepEqual(field.suggestions, [{ text: 'Get checkout retries merged', detail: 'your 4 open pull requests on checkout' }]);

  const written = question('objective').card(
    ctx({ proposals: { objective: { why: 'Written up from what you said.', objective: 'Get staging deploys working', blocker: 'No access to the cluster', suggestions: [] } } }),
  );
  assert.deepEqual(written.fields.map((f) => [f.id, f.value]), [
    ['objective', 'Get staging deploys working'],
    ['blocker', 'No access to the cluster'],
  ]);
});

test('the screen names the machine it runs on, and the calendars question asks for a list only where there is one', () => {
  assert.deepEqual([machineName('darwin'), machineName('win32'), machineName('linux')], ['Mac', 'PC', 'computer']);
  assert.match(question('schedule').card(ctx({ machine: 'PC' })).why!, /If the PC is asleep or the dashboard isn't running then/);
  assert.match(question('cli').card(ctx({ machine: 'computer' })).why!, /ready on this computer/);

  const withList = question('calendars').agent!;
  assert.match(withList.brief(ctx()), /Below is every calendar Calendar\.app on this Mac has/);
  const without = ctx({ calendars: null, calendar: { supported: false, built: false, buildCommand: '' } });
  assert.doesNotMatch(withList.brief(without), /Below is every calendar/);
  assert.match(withList.brief(without), /List the calendars their calendar connector reaches/);
  assert.match(withList.facts!(without)!, /no list from Calendar\.app here/);
});

test('the profile is asked only when nothing has settled it', () => {
  const profile = questionById('profile')!;
  assert.equal(profile.applies?.(ctx()), true);
  assert.equal(profile.applies?.(ctx({ profileSet: true })), false, 'given at launch, or the other store is already beside it');
});
