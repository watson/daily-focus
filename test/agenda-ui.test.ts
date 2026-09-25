/**
 * What one agenda row actually renders.
 *
 * The rule worth holding here is the one `agenda.ts` cannot express: an event
 * marked free in the calendar takes none of the day, and the row has to say so
 * without reading as an event that is already over. Both halves are only in
 * `client/agenda.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { byClass, mountOne } from './dom.ts';
import { eventRow, nextEventStat } from '../client/agenda.ts';
import type { ResolvedItem } from '../src/types.ts';

/* ---------- the fixtures ---------- */

const NOW = new Date(2026, 8, 10, 10, 0, 0); // 10 Sep 2026, local

/** Local ISO on the agenda's day, so nothing here depends on the runner's timezone. */
const at = (hour: number, minute = 0) => new Date(2026, 8, 10, hour, minute).toISOString();

function event(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id: 'calendar:event:abc',
    source: 'calendar',
    kind: 'event',
    title: 'Delivery window',
    start: at(14, 30),
    end: at(16, 30),
    status: 'open',
    notes: [],
    ageDays: 0,
    ...overrides,
  };
}

const render = (overrides: Partial<ResolvedItem> = {}) => mountOne(eventRow(event(overrides), NOW, []));

/** The row's sub-lines, in order — where "until", the clash and "marked free" land. */
const subs = (node: HTMLElement) => byClass(node, 'agenda__sub').map((sub) => sub.textContent ?? '');

/* ---------- tests ---------- */

test('a blocking event says only when it ends', () => {
  const node = render();

  assert.equal(node.dataset.blocking, 'true');
  assert.equal(subs(node).length, 1);
  assert.match(subs(node)[0]!, /^until /);
  assert.doesNotMatch(subs(node)[0]!, /free/);
});

test('an event marked free says so, in words and not only in ink', () => {
  const node = render({ blocking: false });

  assert.equal(node.dataset.blocking, 'false');
  assert.match(subs(node)[0]!, /marked free$/);
});

// The row is one step down in emphasis, not two: the whole reason a delivery is on
// the agenda is that it needs someone home for it.
test('being marked free is not the same as being over', () => {
  const node = render({ blocking: false });

  assert.equal(node.dataset.past, 'false');
  assert.equal(node.dataset.blocking, 'false');
});

// A row that grew a third line to announce it wants less attention has taken more.
test('the free note folds into the "until" line rather than adding one', () => {
  const node = render({ blocking: false });

  assert.equal(subs(node).length, 1);
  assert.match(subs(node)[0]!, /^until .* · marked free$/);
});

test('an all-day event marked free has no "until" to fold into', () => {
  const node = render({ start: '2026-09-10', end: undefined, blocking: false });

  assert.deepEqual(subs(node), ['marked free']);
});

// `blocking` is the agent's field too, and only an explicit false frees the slot —
// the same reading `validate.ts` and `agenda.ts` give it.
test('an absent or truthy blocking still reads as blocking', () => {
  assert.equal(render({ blocking: undefined }).dataset.blocking, 'true');
  assert.equal(render({ blocking: true }).dataset.blocking, 'true');
});

test('a clash is still called out on an event marked free', () => {
  const node = mountOne(eventRow(event({ blocking: false }), NOW, ['calendar:event:abc']));

  assert.equal(subs(node).length, 2);
  assert.match(subs(node)[0]!, /clashes with another event/);
  assert.match(subs(node)[1]!, /marked free$/);
});

/* ---------- the next-event stat, shown when free time isn't tracked ---------- */

const statOf = (events: ResolvedItem[]) => mountOne(nextEventStat({ events }, NOW));
const statValue = (node: HTMLElement) => byClass(node, 'stat__value')[0]?.textContent;
const statNote = (node: HTMLElement) => byClass(node, 'stat__footnote')[0]?.textContent;

test('the next event is the first timed one still ahead', () => {
  const node = statOf([event({ start: at(8), end: at(9), title: 'Gone' }), event({ start: at(12, 15), end: at(13), title: 'Lunch' })]);
  assert.equal(statValue(node), 'in 2 h 15 min');
  assert.equal(statNote(node), 'Lunch');
});

test('an event under way reads as now', () => {
  const node = statOf([event({ start: at(9, 30), end: at(10, 30), title: 'Standup' })]);
  assert.equal(statValue(node), 'Now');
  assert.equal(statNote(node), 'Standup');
});

test('all-day events are not something to be somewhere for', () => {
  const node = statOf([event({ start: '2026-09-10', end: undefined, title: 'Holiday' })]);
  assert.equal(statValue(node), 'None today');
});

test('an open-ended event is assumed to last half an hour', () => {
  const node = statOf([event({ start: at(9, 40), end: undefined, title: 'Call' })]);
  assert.equal(statValue(node), 'Now');
  const over = statOf([event({ start: at(9, 20), end: undefined, title: 'Call' })]);
  assert.equal(statValue(over), 'None today');
});
