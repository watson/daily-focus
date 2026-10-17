/**
 * The morning agent's run panel and its way in.
 *
 * The rules worth holding: the header's readout opens the newest run once
 * there is one and stays plain text before; the panel shows the report, the
 * questions asked of the run and a field for the next, but no field for a run
 * that can't be continued; and the other runs are there, folded away.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, mountOne, uiWith } from './dom.ts';
import { Header } from '../client/chrome.ts';
import { Flyout } from '../client/flyout.ts';
import type { Handlers, UiValues } from '../client/types.ts';
import type { AgentRun, AgentStep, DashboardState } from '../src/types.ts';

const NOW = '2026-09-24T12:00:00Z';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'r1',
    cli: 'codex',
    trigger: 'schedule',
    sessionId: 't1',
    startedAt: '2026-09-24T04:30:00Z',
    endedAt: '2026-09-24T04:41:00Z',
    status: 'done',
    report: 'Wrote **6** items.\n\nCalendar was unreachable.',
    messages: ['Reading the prompt.', 'Querying the calendar.', 'Wrote **6** items.\n\nCalendar was unreachable.'],
    steps: [],
    error: null,
    turns: [],
    resumable: true,
    ...overrides,
  };
}

const calls: string[] = [];
const HANDLERS = new Proxy(
  {},
  { get: (_, name: string) => (...args: unknown[]) => calls.push(`${name} ${args.join(' ')}`.trim()) },
) as Handlers;

function panel(
  current: AgentRun,
  runs: AgentRun[] = [current],
  schedule: unknown = null,
  uiOverrides: Partial<UiValues> = {},
  brief: { generatedAt: string | null } = { generatedAt: null },
): HTMLElement {
  calls.length = 0;
  const state = { now: NOW, brief, agentRun: { enabled: true, cli: 'codex', schedule, last: runs[0], runs } } as unknown as DashboardState;
  const ui = uiWith({ detailFor: 'run:r1', ...uiOverrides });
  return mountOne(h(Flyout, { row: null, run: current, state, ui, handlers: HANDLERS }));
}

/** The message folds, in order, with whether each is open. */
const folds = (container: HTMLElement) =>
  byClass(container, 'agent-run__message').map((fold) => [
    byClass(fold, 'agent-run__message-line')[0]!.textContent,
    (fold as HTMLDetailsElement).open === true,
  ]);

test('the panel shows how the run went, its report, and a field to ask it', () => {
  const container = panel(run());
  assert.equal(container.hidden, false);
  assert.match(container.textContent!, /Morning agent.*scheduled.*finished/);
  assert.match(container.textContent!, /Run today at/);
  assert.match(container.textContent!, /Finished at .*, in 11 min\./);
  assert.match(container.textContent!, /Wrote 6 items\./);
  assert.match(container.textContent!, /Calendar was unreachable/);
  const input = byClass(container, 'assistant__input')[0] as HTMLTextAreaElement | undefined;
  assert.ok(input, 'a field to ask');
  assert.ok(!input.disabled);
  assert.ok(buttonLabels(container).includes('Send'));
  assert.match(container.textContent!, /This is the only run so far/);
  assert.match(container.textContent!, /DAILY_FOCUS_AGENT_AT/, 'says how to put it on a clock');
});

test('the questions asked of a run are shown under the report, newest last', () => {
  const container = panel(
    run({
      turns: [
        { id: 'q1', question: 'Why was Calendar unreachable?', startedAt: '2026-09-24T08:00:00Z', endedAt: '2026-09-24T08:01:00Z', status: 'done', reply: 'The connector timed out.', error: null },
        { id: 'q2', question: 'Try again?', startedAt: '2026-09-24T08:02:00Z', endedAt: null, status: 'running', reply: '', error: null },
      ],
    }),
  );
  const turns = byClass(container, 'assistant__turn');
  assert.equal(turns.length, 2);
  assert.match(turns[0]!.textContent!, /Why was Calendar unreachable\?.*The connector timed out\./);
  assert.match(turns[1]!.textContent!, /Try again\?.*Working…/);
  // While it answers, the field waits and Stop is offered instead of Send.
  assert.equal((byClass(container, 'assistant__input')[0] as HTMLTextAreaElement).disabled, true);
  assert.ok(buttonLabels(container).includes('Stop'));
  assert.ok(!buttonLabels(container).includes('Send'));
});

test('a run that cannot be continued says why instead of offering a field', () => {
  const other = panel(run({ cli: 'claude', resumable: false }));
  assert.equal(byClass(other, 'assistant__input').length, 0);
  assert.match(other.textContent!, /made by another CLI/);
  const none = panel(run({ sessionId: null, resumable: false, status: 'failed', error: 'codex exited with code 2', report: '' }));
  assert.equal(byClass(none, 'assistant__input').length, 0);
  assert.match(none.textContent!, /left no session/);
  assert.match(none.textContent!, /Failed at .*, after 11 min: codex exited with code 2/);
  assert.match(none.textContent!, /It said nothing\./);
  assert.match(panel(run({ endedAt: '2026-09-24T04:30:40Z' })).textContent!, /in 40 s\./);
  assert.match(panel(run({ endedAt: '2026-09-24T05:42:00Z' })).textContent!, /in 1 h 12 min\./);
});

test('with the agent off, a run is still read back, and the panel blames the setting rather than the run', () => {
  const current = run({ resumable: false });
  const state = { now: NOW, agentRun: { enabled: false, cli: null, schedule: null, last: current, runs: [current] } } as unknown as DashboardState;
  const node = mountOne(h(Flyout, { row: null, run: current, state, ui: uiWith({ detailFor: 'run:r1' }), handlers: HANDLERS }));

  assert.match(node.textContent!, /Wrote 6 items\./, 'the report is there to read');
  assert.equal(byClass(node, 'assistant__input').length, 0);
  assert.match(node.textContent!, /switched off \(DAILY_FOCUS_AGENT\), so this run cannot be asked/);
  assert.match(node.textContent!, /starts no runs now/);
  assert.doesNotMatch(node.textContent!, /made by another CLI|DAILY_FOCUS_AGENT_AT is off/);
});

test('a run still going offers Stop, shows its latest message open and the earlier ones folded, and no questions yet', () => {
  const going = run({
    status: 'running',
    endedAt: null,
    report: 'Querying the calendar.',
    messages: ['Reading the prompt.', 'Querying the calendar.'],
    sessionId: null,
    resumable: false,
  });
  const container = panel(going);
  assert.match(container.textContent!, /Writing a new brief, started/);
  assert.ok(byClass(container, 'assistant__status--working').length > 0, 'the status line spins');
  assert.ok(buttonLabels(container).includes('Stop'));
  assert.equal(byClass(container, 'assistant__input').length, 0);
  assert.match(container.textContent!, /What it is doing/);
  // All of it folds under one line that says what it is on, closed until opened.
  const work = byClass(container, 'agent-run__list--working')[0] as HTMLDetailsElement;
  assert.equal(work.open, false);
  assert.equal(byTag(work, 'summary')[0]!.textContent, 'Querying the calendar. · 2 messages');
  assert.match(work.textContent!, /Thinking…/, 'between its words it is composing, and says so');
  assert.deepEqual(folds(container), [
    ['Reading the prompt.', false],
    ['Querying the calendar.', true],
  ]);
  // Opened by the reader, it stays open through the next push; closed again, that is forgotten.
  const opened = panel(going, [going], null, { messageOpen: new Map([['r1:work', true]]) });
  assert.equal((byClass(opened, 'agent-run__list--working')[0] as HTMLDetailsElement).open, true);
  (byClass(opened, 'agent-run__list--working')[0] as HTMLDetailsElement).open = false;
  assert.deepEqual(calls, ['toggleMessage r1:work']);
  // Open, the label stands in for the first line so the message reads once.
  assert.deepEqual(
    byClass(container, 'agent-run__message-index').map((label) => label.textContent),
    ['Message 1 of 2', 'Message 2 of 2'],
  );
  // The reader's own folding wins over the default.
  const folded = panel(going, [going], null, {
    messageOpen: new Map([
      ['r1:1', false],
      ['r1:0', true],
    ]),
  });
  assert.deepEqual(folds(folded), [
    ['Reading the prompt.', true],
    ['Querying the calendar.', false],
  ]);
  const fresh = panel(run({ ...going, messages: [], report: '' }));
  assert.match(fresh.textContent!, /Starting…/);
  assert.doesNotMatch(fresh.textContent!, /Nothing yet/, 'a run under way has not got nothing: it has not started');
  // Once the brief has landed, the run is checking it, and the line says so.
  const landed = panel(going, [going], null, {}, { generatedAt: '2026-09-24T04:40:00Z' });
  assert.match(landed.textContent!, /The brief is in; checking it and writing its report, started/);
  assert.doesNotMatch(panel(going, [going], null, {}, { generatedAt: '2026-09-23T06:30:00Z' }).textContent!, /brief is in/, "yesterday's brief is not this run's");
});

test('finished, the report stands alone and the way there folds away beneath it', () => {
  const container = panel(run());
  assert.match(container.textContent!, /Its report/);
  assert.match(container.textContent!, /How it got there, in 2 messages/);
  // The last message was the report, so it is not listed twice.
  assert.deepEqual(folds(container), [
    ['Reading the prompt.', false],
    ['Querying the calendar.', false],
  ]);
  // A run logged before the commentary was kept has only its report.
  const bare = panel(run({ messages: ['Wrote **6** items.\n\nCalendar was unreachable.'] }));
  assert.equal(byClass(bare, 'agent-run__message').length, 0);
  assert.doesNotMatch(bare.textContent!, /How it got there/);
});

/** A step, the agent's own unless `by` names a subagent. */
const step = (text: string, fields: Partial<AgentStep> = {}): AgentStep => ({ kind: 'tool', text, detail: null, state: 'done', by: null, ...fields });

/** The handoffs on the panel: what each summary says, and whether it is open. */
const handoffs = (container: HTMLElement) =>
  byClass(container, 'agent-run__handoff').map((item) => [
    byTag(item, 'summary')[0]!.textContent,
    (byTag(item, 'details')[0] as HTMLDetailsElement).open === true,
  ]);

const WORKING: AgentStep[] = [
  step('Reading the prompt.', { kind: 'message' }),
  step('Run a command', { detail: 'cat prompt.md' }),
  step('Hand part of it to a subagent', { detail: 'inbox', subagent: 'a1' }),
  step('Hand part of it to a subagent', { detail: 'calendar', subagent: 'a2', state: 'running' }),
  step('Gmail: search threads', { by: 'a1', detail: '{"q":"newer_than:2d"}' }),
  step('Three threads need you.', { kind: 'message', by: 'a1' }),
  step('Calendar: list events', { by: 'a2', state: 'running' }),
  step('Wait for its subagents', { state: 'running' }),
];

test('a run that keeps its steps shows them as it works, with each subagent under the step that handed it work', () => {
  const going = run({ status: 'running', endedAt: null, report: 'Reading the prompt.', messages: ['Reading the prompt.'], steps: WORKING, resumable: false });
  const container = panel(going);
  assert.match(container.textContent!, /What it is doing/);
  assert.equal(byClass(container, 'agent-run__message').length, 0, 'the steps take the place of the message folds');
  const work = byClass(container, 'agent-run__list--working')[0] as HTMLDetailsElement;
  assert.equal(work.open, false, 'folded by default, as a coding agent folds its own transcript');
  assert.equal(byTag(work, 'summary')[0]!.textContent, 'Wait for its subagents · 8 steps, 1 subagent at work');

  // The agent's own steps, in order, with its words between the calls.
  const top = byClass(container, 'agent-run__steps')[0]!;
  const own = [...top.children].map((item) => item.textContent);
  assert.equal(own.length, 5);
  assert.equal(own[0], 'Reading the prompt.');
  assert.match(own[1]!, /Run a command.*cat prompt\.md/);
  assert.match(own[4]!, /Wait for its subagents/);

  // A subagent at work is open on what it is doing; one that is done is folded, on what it did.
  assert.deepEqual(handoffs(container), [
    ['Subagent: inbox1 step', false],
    ['Subagent: calendarCalendar: list events', true],
  ]);
  const inbox = byClass(container, 'agent-run__handoff')[0]!;
  assert.match(inbox.textContent!, /Gmail: search threads.*Three threads need you\./);
  assert.doesNotMatch(byClass(container, 'agent-run__handoff')[1]!.textContent!, /Gmail/);

  // The reader's own folding wins, and is kept by the same map as the messages'.
  const folded = panel(going, [going], null, { messageOpen: new Map([['r1:a1', true], ['r1:a2', false]]) });
  assert.deepEqual(handoffs(folded).map(([, open]) => open), [true, false]);
  (byTag(byClass(folded, 'agent-run__handoff')[0]!, 'details')[0] as HTMLDetailsElement).open = false;
  assert.deepEqual(calls, ['toggleMessage r1:a1'], 'a toggle back to the default is forgotten');

  const empty = panel(run({ ...going, steps: [step('Hand part of it to a subagent', { detail: 'inbox', subagent: 'a1', state: 'running' })] }));
  assert.deepEqual(handoffs(empty), [['Subagent: inboxstarting', true]]);
  assert.match(empty.textContent!, /Starting…/);
  assert.doesNotMatch(empty.textContent!, /Nothing yet/);
});

test('an agent with no call in flight is composing, and its list says so rather than end on a tick', () => {
  // The run's own last call is done and it has handed nothing off: it is thinking.
  const between = run({ status: 'running', endedAt: null, report: '', messages: [], steps: [step('Run a command', { detail: 'cat prompt.md' })], resumable: false });
  const container = panel(between);
  const waiting = byClass(container, 'assistant__step--waiting');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.textContent, 'Thinking…');
  assert.equal(waiting[0]!.getAttribute('data-state'), 'running', 'drawn with the spinner a call in flight gets');
  assert.equal(byTag(byClass(container, 'agent-run__list--working')[0]!, 'summary')[0]!.textContent, 'Run a command · 1 step');

  // A subagent still at work whose last call is done is composing too; a finished one is not.
  const inside = run({
    ...between,
    steps: [
      step('Hand part of it to a subagent', { detail: 'inbox', subagent: 'a1', state: 'running' }),
      step('Gmail: search threads', { by: 'a1' }),
      step('Hand part of it to a subagent', { detail: 'calendar', subagent: 'a2' }),
      step('Calendar: list events', { by: 'a2' }),
    ],
  });
  const nested = panel(inside, [inside], null, { messageOpen: new Map([['r1:work', true]]) });
  const lines = byClass(nested, 'agent-run__handoff').map((item) => byClass(item, 'assistant__step--waiting').length);
  assert.deepEqual(lines, [1, 0]);
  assert.equal(byClass(nested, 'assistant__step--waiting').length, 1, 'and the run itself is waiting on the handoff, not composing');
  assert.equal(byTag(byClass(nested, 'agent-run__list--working')[0]!, 'summary')[0]!.textContent, 'Waiting on inbox · 4 steps', 'named for the subagent it waits on, not the step that handed off');

  // Finished, nothing waits.
  assert.equal(byClass(panel(run({ steps: [step('Run a command')] })), 'assistant__step--waiting').length, 0);
});

test('finished, a run that kept its steps folds them under its report, less the report itself', () => {
  const steps = [
    ...WORKING.map((candidate) => ({ ...candidate, state: 'done' as const })),
    step('Wrote **6** items.\n\nCalendar was unreachable.', { kind: 'message' }),
  ];
  const container = panel(run({ steps }));
  assert.match(container.textContent!, /Its report/);
  const fold = byTag(container, 'details').find((candidate) => /How it got there/.test(byTag(candidate, 'summary')[0]!.textContent!))!;
  assert.equal(byTag(fold, 'summary')[0]!.textContent, 'How it got there, in 8 steps, with 2 subagents');
  assert.equal((fold as HTMLDetailsElement).open, false);
  assert.equal(fold.textContent!.match(/Calendar was unreachable/g), null, 'the report is not listed twice');
  assert.deepEqual(handoffs(container).map(([, open]) => open), [false, false]);
});

test('the other runs are folded away, and each opens its own panel', () => {
  const earlier = run({ id: 'r0', trigger: 'hand', startedAt: '2026-09-23T09:00:00Z', endedAt: '2026-09-23T09:12:00Z', report: 'Wrote 4 items.' });
  const failed = run({ id: 'r-1', startedAt: '2026-09-22T04:30:00Z', endedAt: '2026-09-22T04:31:00Z', status: 'failed', report: '', error: 'not logged in' });
  const container = panel(run(), [run(), earlier, failed], { at: '06:30', nextRunAt: '2026-09-25T04:30:00Z' });
  const list = byTag(container, 'details').find((fold) => /earlier runs/.test(byTag(fold, 'summary')[0]!.textContent!))!;
  assert.match(list.textContent!, /2 earlier runs/);
  const picks = byClass(list, 'agent-run__pick');
  assert.equal(picks.length, 2);
  assert.match(picks[0]!.textContent!, /yesterday at .*by hand.*finished in 12 min.*Wrote 4 items\./);
  assert.match(picks[1]!.textContent!, /scheduled.*failed.*not logged in/);
  picks[0]!.click();
  assert.deepEqual(calls, ['openRun r0']);
  assert.match(container.textContent!, /Runs on its own at 06:30; next tomorrow at/);
});

test("the header's readout opens the newest run once there is one", () => {
  const brief = { generatedAt: '2026-09-24T04:41:00Z', generatedBy: 'Codex', ageHours: 7, stale: false, date: '2026-09-24' };
  const header = (agentRun: unknown): HTMLElement => {
    calls.length = 0;
    const state = { now: NOW, brief, agentRun } as unknown as DashboardState;
    const node = mountOne(h(Header, { state, ui: uiWith(), handlers: HANDLERS }));
    return byClass(node, 'freshness')[0]!;
  };

  const plain = header({ enabled: false, cli: null, schedule: null, last: null, runs: [] });
  assert.equal(plain.textContent, 'updated 7 hours ago by Codex');
  assert.equal(byTag(plain, 'button').length, 0);

  const linked = header({ enabled: true, cli: 'codex', schedule: null, last: run(), runs: [run()] });
  const link = byTag(linked, 'button')[0]!;
  assert.equal(link.textContent, 'updated 7 hours ago by Codex');
  link.click();
  assert.deepEqual(calls, ['openRun']);
});
