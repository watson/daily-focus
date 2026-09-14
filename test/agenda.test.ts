import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgenda } from '../src/agenda.ts';
import type { ResolvedItem } from '../src/types.ts';

const NOW = new Date(2026, 8, 10, 10, 0, 0); // 10 Sep 2026, local
const OPTS = { workStartHour: 9, workEndHour: 17, minFreeWindowMinutes: 45 };

/** Local ISO for a time on the agenda's day, so tests don't depend on the runner's timezone. */
function at(hour: number, minute = 0): string {
  return new Date(2026, 8, 10, hour, minute).toISOString();
}

function event(id: string, start: string, end?: string): ResolvedItem {
  return {
    id,
    source: 'calendar',
    kind: 'event',
    title: id,
    start,
    ...(end ? { end } : {}),
    status: 'open',
    notes: [],
    ageDays: 0,
  };
}

test('keeps only today\'s events, in clock order', () => {
  const agenda = buildAgenda(
    [
      event('late', at(15)),
      event('early', at(9, 30)),
      event('yesterday', new Date(2026, 8, 9, 11).toISOString()),
    ],
    NOW,
    OPTS,
  );

  assert.deepEqual(
    agenda.events.map((e) => e.id),
    ['early', 'late'],
  );
});

test('flags both sides of an overlap', () => {
  const agenda = buildAgenda(
    [event('a', at(11), at(11, 30)), event('b', at(11, 15), at(12)), event('c', at(14), at(15))],
    NOW,
    OPTS,
  );

  assert.deepEqual(agenda.conflictIds.sort(), ['a', 'b']);
});

test('back-to-back meetings do not count as a clash', () => {
  const agenda = buildAgenda([event('a', at(11), at(12)), event('b', at(12), at(13))], NOW, OPTS);
  assert.deepEqual(agenda.conflictIds, []);
});

test('finds the gaps between meetings inside working hours', () => {
  const agenda = buildAgenda([event('a', at(9, 30), at(10)), event('b', at(15), at(16))], NOW, OPTS);

  assert.deepEqual(
    agenda.freeWindows.map((w) => w.minutes),
    // 09:00-09:30 is only 30 min, so it is below the 45-minute floor and skipped.
    [300, 60],
  );
});

test('an all-day event does not blank out the day', () => {
  const agenda = buildAgenda([event('holiday', '2026-09-10')], NOW, OPTS);

  assert.deepEqual(
    agenda.events.map((e) => e.id),
    ['holiday'],
  );
  assert.deepEqual(
    agenda.freeWindows.map((w) => w.minutes),
    [480],
  );
});

test('an event with no end is assumed to be 30 minutes', () => {
  const agenda = buildAgenda([event('a', at(12))], NOW, OPTS);
  assert.deepEqual(
    agenda.freeWindows.map((w) => w.minutes),
    [180, 270],
  );
});

test('overlapping meetings are merged before measuring free time', () => {
  const agenda = buildAgenda([event('a', at(10), at(12)), event('b', at(11), at(13))], NOW, OPTS);
  assert.deepEqual(
    agenda.freeWindows.map((w) => w.minutes),
    [60, 240],
  );
});

test('a meeting running past the working day clips rather than reporting negative time', () => {
  const agenda = buildAgenda([event('a', at(16), at(19))], NOW, OPTS);
  assert.deepEqual(
    agenda.freeWindows.map((w) => w.minutes),
    [420],
  );
});

test('a dismissed event drops off the agenda', () => {
  const dismissed = { ...event('a', at(11), at(12)), status: 'dismissed' as const };
  const agenda = buildAgenda([dismissed], NOW, OPTS);
  assert.deepEqual(agenda.events, []);
});

test('a free day is one long window', () => {
  const agenda = buildAgenda([], NOW, OPTS);
  assert.deepEqual(agenda.freeWindows.map((w) => w.minutes), [480]);
  assert.deepEqual(agenda.events, []);
});

/* ---------- a working day that isn't 09:00–17:00 ---------- */

test("the brief's day bounds override the configured defaults", () => {
  // A short day that stops at 16:00 has an hour less, and the dashboard must
  // not keep promising a focus block that no longer exists.
  const agenda = buildAgenda([], NOW, { ...OPTS, dayEnd: '16:00' });

  assert.deepEqual(agenda.freeWindows.map((w) => w.minutes), [420]);
  assert.equal(agenda.dayEnd, '16:00');
  assert.equal(agenda.dayStart, '09:00');
});

test('a later start is honoured too', () => {
  const agenda = buildAgenda([], NOW, { ...OPTS, dayStart: '10:30' });
  assert.deepEqual(agenda.freeWindows.map((w) => w.minutes), [390]);
  assert.equal(agenda.dayStart, '10:30');
});

test('malformed bounds fall back to the configured hours', () => {
  const agenda = buildAgenda([], NOW, { ...OPTS, dayEnd: 'half four' });
  assert.equal(agenda.dayEnd, '17:00');
});

/* ---------- what's actually left ---------- */

test('remaining focus time counts from now, not from the start of the day', () => {
  // 10:00 now, free until 17:00.
  assert.equal(buildAgenda([], NOW, OPTS).remainingFocusMinutes, 420);
});

test('a window already half spent only offers the half that remains', () => {
  // Meeting 09:00-09:30, then free. At 10:00, 7h of that window is left.
  const agenda = buildAgenda([event('a', at(9), at(9, 30))], NOW, OPTS);
  assert.equal(agenda.remainingFocusMinutes, 420);
});

test('remaining focus time excludes meetings still to come', () => {
  const agenda = buildAgenda([event('a', at(14), at(16))], NOW, OPTS);
  // 10:00-14:00 and 16:00-17:00 = 240 + 60.
  assert.equal(agenda.remainingFocusMinutes, 300);
});

test('after the working day ends there is nothing left', () => {
  const evening = new Date(2026, 8, 10, 18, 0, 0);
  assert.equal(buildAgenda([], evening, OPTS).remainingFocusMinutes, 0);
});

test('a short day leaves correspondingly less', () => {
  const agenda = buildAgenda([event('a', at(13), at(15))], NOW, { ...OPTS, dayEnd: '16:00' });
  // 10:00-13:00 and 15:00-16:00 = 180 + 60.
  assert.equal(agenda.remainingFocusMinutes, 240);
});
