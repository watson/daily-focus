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
import type { AgentRun, DashboardState } from '../src/types.ts';

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

function panel(current: AgentRun, runs: AgentRun[] = [current], schedule: unknown = null, uiOverrides: Partial<UiValues> = {}): HTMLElement {
  calls.length = 0;
  const state = { now: NOW, agentRun: { enabled: true, cli: 'codex', schedule, last: runs[0], runs } } as unknown as DashboardState;
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
  assert.ok(buttonLabels(container).includes('Stop'));
  assert.equal(byClass(container, 'assistant__input').length, 0);
  assert.match(container.textContent!, /What it is doing/);
  assert.deepEqual(folds(container), [
    ['Reading the prompt.', false],
    ['Querying the calendar.', true],
  ]);
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
  assert.match(panel(run({ ...going, messages: [], report: '' })).textContent!, /Nothing yet\./);
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
