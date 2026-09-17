import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCalendarFacts, selectEvents, type CalendarFacts } from '../src/calendar.ts';

/** Local ISO, so these tests don't depend on the runner's timezone. */
function at(hour: number, minute = 0, day = 17): string {
  return new Date(2026, 8, day, hour, minute).toISOString();
}

const WORK = { id: 'cal-work', title: 'thomas@example.com', source: 'Work' };
/** The same shared calendar reached through two accounts — the delegation case. */
const SHARED_A = { id: 'cal-shared-a', title: 'Personal', source: 'Work' };
const SHARED_B = { id: 'cal-shared-b', title: 'personal', source: 'Private' };

function facts(events: CalendarFacts['events'], calendars = [WORK, SHARED_A, SHARED_B]): CalendarFacts {
  return { generatedAt: at(7), calendars, events };
}

test('keeps only the configured calendars, matching the title case-insensitively', () => {
  const { events, unmatched } = selectEvents(
    facts([
      { externalId: 'a', calendarId: 'cal-work', title: 'standup', start: at(9) },
      { externalId: 'b', calendarId: 'cal-other', title: 'not configured', start: at(10) },
    ]),
    ['THOMAS@EXAMPLE.COM'],
  );

  assert.deepEqual(events.map((e) => e.title), ['standup']);
  assert.deepEqual(unmatched, []);
});

test('reports a configured name that matches nothing, so a typo cannot read as a quiet day', () => {
  const { events, unmatched, matched } = selectEvents(facts([]), ['thomas@example.com', 'Holidays']);

  assert.deepEqual(events, []);
  assert.deepEqual(unmatched, ['holidays']);
  assert.equal(matched, 1, 'the name that did resolve still counts');
});

test('a name matching two calendars takes the union and folds the duplicate', () => {
  // The shared-calendar case: one event arrives through both accounts, and one
  // exists only on the native copy because Google made it from an email.
  const { events, matched } = selectEvents(
    facts([
      { externalId: 'shared', calendarId: 'cal-shared-a', title: 'dinner', start: at(19) },
      { externalId: 'shared', calendarId: 'cal-shared-b', title: 'dinner', start: at(19) },
      { externalId: 'native-only', calendarId: 'cal-shared-b', title: 'delivery', start: at(12) },
    ]),
    ['Personal'],
  );

  assert.equal(matched, 2, 'both copies resolve');
  assert.deepEqual(events.map((e) => e.title).sort(), ['delivery', 'dinner'], 'union, deduped');
});

test('drops an invitation the user declined', () => {
  const { events } = selectEvents(
    facts([
      { externalId: 'a', calendarId: 'cal-work', title: 'accepted', start: at(9), selfStatus: 2 },
      { externalId: 'b', calendarId: 'cal-work', title: 'declined', start: at(10), selfStatus: 3 },
      { externalId: 'c', calendarId: 'cal-work', title: 'no response recorded', start: at(11) },
    ]),
    ['thomas@example.com'],
  );

  assert.deepEqual(events.map((e) => e.title).sort(), ['accepted', 'no response recorded']);
});

test('only availability "free" clears blocking', () => {
  const { events } = selectEvents(
    facts([
      { externalId: 'free', calendarId: 'cal-work', title: 'delivery', start: at(12), availability: 1 },
      { externalId: 'busy', calendarId: 'cal-work', title: 'meeting', start: at(13), availability: 0 },
      { externalId: 'unsup', calendarId: 'cal-work', title: 'subscribed', start: at(14), availability: -1 },
      { externalId: 'tent', calendarId: 'cal-work', title: 'tentative', start: at(15), availability: 2 },
    ]),
    ['thomas@example.com'],
  );

  const blocking = Object.fromEntries(events.map((e) => [e.title, e.blocking]));
  assert.equal(blocking['delivery'], false);
  // Everything else stays blocking, including the two the calendar couldn't answer for.
  assert.equal(blocking['meeting'], undefined);
  assert.equal(blocking['subscribed'], undefined);
  assert.equal(blocking['tentative'], undefined);
});

test('an all-day event becomes a bare date, which is what agenda.ts reads as all-day', () => {
  const { events } = selectEvents(
    facts([{ externalId: 'hol', calendarId: 'cal-work', title: 'holiday', start: at(0), allDay: true, end: at(0, 0, 18) }]),
    ['thomas@example.com'],
  );

  assert.equal(events[0]?.start, '2026-09-17');
  assert.equal(events[0]?.end, undefined, 'an all-day end would re-introduce a span');
});

test('two occurrences of one recurring series get distinct ids', () => {
  // calendarItemExternalIdentifier is shared across occurrences, so the start has
  // to be part of the id or a weekly standup collapses into a single item.
  const { events } = selectEvents(
    facts([
      { externalId: 'series', calendarId: 'cal-work', title: 'standup', start: at(9) },
      { externalId: 'series', calendarId: 'cal-work', title: 'standup', start: at(16) },
    ]),
    ['thomas@example.com'],
  );

  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
});

test('salvages a malformed payload rather than losing the whole agenda', () => {
  const { events } = selectEvents(
    facts([
      { externalId: 'ok', calendarId: 'cal-work', title: 'good', start: at(9) },
      { calendarId: 'cal-work', title: 'no external id', start: at(10) },
      { externalId: 'x', calendarId: 'cal-work', title: 'unparseable start', start: 'not a date' },
      { externalId: 'y', calendarId: 'cal-work', title: 'no start at all' },
      'not an object' as never,
    ]),
    ['thomas@example.com'],
  );

  assert.deepEqual(events.map((e) => e.title), ['good']);
});

test('drops a non-http url so it can never reach the DOM', () => {
  const { events } = selectEvents(
    facts([
      { externalId: 'a', calendarId: 'cal-work', title: 'ok', start: at(9), url: 'https://example.com/x' },
      { externalId: 'b', calendarId: 'cal-work', title: 'bad', start: at(10), url: 'javascript:alert(1)' },
    ]),
    ['thomas@example.com'],
  );

  assert.equal(events.find((e) => e.title === 'ok')?.url, 'https://example.com/x');
  assert.equal(events.find((e) => e.title === 'bad')?.url, undefined);
});

test('a refusal is not facts', () => {
  assert.equal(parseCalendarFacts({ error: 'denied', detail: 'no' }), null);
  assert.equal(parseCalendarFacts(null), null);
  assert.equal(parseCalendarFacts('nope'), null);
  // ...but a payload with no events at all is a genuinely empty day, not a failure.
  const empty = parseCalendarFacts({ generatedAt: at(7), calendars: [], events: [] });
  assert.deepEqual(empty?.events, []);
});
