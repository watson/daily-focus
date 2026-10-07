/**
 * Which day it is, in the browser, is the server's answer.
 *
 * The server judges a snooze on its own calendar, and the browser can be in
 * another zone: a laptop in New York reaching the dashboard on a Mac mini in
 * Copenhagen. Every case here sets the server's zone with `setCalendarZone` and
 * checks both a zone east and a zone west of the moment it uses, so a test run
 * in any zone fails if the browser's own calendar leaks back in.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { byClass, byTag, handlersWith, mountOne, uiWith } from './dom.ts';
import { dayKey, daysFromToday, relativeDay, setCalendarZone } from '../client/format.ts';
import { renderItem } from '../client/items.ts';
import type { DashboardState, ResolvedItem } from '../src/types.ts';

/** 22:30 on 7 October in New York, which is already 04:30 on the 8th in Copenhagen. */
const EVENING_IN_NEW_YORK = '2026-10-08T02:30:00Z';

afterEach(() => setCalendarZone(undefined));

function item(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id: 'email:invented-thread-1',
    source: 'email',
    kind: 'task',
    title: 'Reply to the venue about the deposit',
    status: 'open',
    notes: [],
    ageDays: 0,
    ...overrides,
  };
}

function stateAt(now: string, timeZone: string): DashboardState {
  return { now, timeZone, session: { active: null }, agenda: { conflictIds: [] } } as unknown as DashboardState;
}

/** The date the snooze menu's `label` entry sends, with the server in `timeZone`. */
function snooze(label: string, timeZone: string, now = EVENING_IN_NEW_YORK): string | undefined {
  setCalendarZone(timeZone);
  const row = item();
  let sent: { until?: string } | undefined;
  const node = mountOne(
    renderItem(
      row,
      stateAt(now, timeZone),
      uiWith({ menuFor: row.id }),
      handlersWith({ onAction: (_id, _action, extra) => void (sent = extra) }),
    ),
  );
  const button = byTag(byClass(node, 'menu')[0]!, 'button').find((b) => b.textContent!.startsWith(label));
  assert.ok(button, `no "${label}" entry in the snooze menu`);
  button.click();
  return sent?.until;
}

test("a snooze is worked out on the server's calendar, so Tomorrow is the server's tomorrow", () => {
  // The bug this pins: the browser sent the 8th, the server's today, and the
  // item came straight back.
  assert.equal(snooze('Tomorrow', 'Europe/Copenhagen'), '2026-10-09');
  assert.equal(snooze('Tomorrow', 'America/New_York'), '2026-10-08');
});

test('every preset counts from the same server day', () => {
  assert.equal(snooze('In 3 days', 'Europe/Copenhagen'), '2026-10-11');
  assert.equal(snooze('Next week', 'Europe/Copenhagen'), '2026-10-15');
  assert.equal(snooze('In 3 days', 'America/New_York'), '2026-10-10');
  assert.equal(snooze('Next week', 'America/New_York'), '2026-10-14');
});

test("a snoozed row's label counts from the server's today", () => {
  for (const [timeZone, until] of [
    ['Europe/Copenhagen', '2026-10-09'],
    ['America/New_York', '2026-10-08'],
  ] as const) {
    setCalendarZone(timeZone);
    const node = mountOne(
      renderItem(item({ status: 'snoozed', snoozedUntil: until }), stateAt(EVENING_IN_NEW_YORK, timeZone), uiWith(), handlersWith()),
    );
    assert.match(node.textContent ?? '', /snoozed until tomorrow/, timeZone);
  }
});

test("a bare date is counted from the server's today", () => {
  const now = new Date(EVENING_IN_NEW_YORK);
  setCalendarZone('Europe/Copenhagen');
  assert.equal(dayKey(now), '2026-10-08');
  assert.equal(daysFromToday('2026-10-08', now), 0);
  assert.equal(relativeDay('2026-10-07', now), 'yesterday');

  setCalendarZone('America/New_York');
  assert.equal(dayKey(now), '2026-10-07');
  assert.equal(daysFromToday('2026-10-08', now), 1);
  assert.equal(relativeDay('2026-10-07', now), 'today');
});

/**
 * A timestamp is shown with its time of day in the browser's zone, so its day
 * word is counted there too, whatever the server's zone. Built with the local
 * constructor, so this holds in whatever zone the tests run in.
 */
test("a timestamp's day stays on the browser's calendar, beside its time", () => {
  const now = new Date(2026, 9, 7, 23, 0);
  const earlier = new Date(2026, 9, 7, 0, 30).toISOString();
  for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    setCalendarZone(timeZone);
    assert.equal(daysFromToday(earlier, now), 0, timeZone);
  }
});

test("a zone the browser doesn't know falls back to its own calendar", () => {
  const now = new Date(2026, 9, 7, 23, 0);
  setCalendarZone('Not/A_Zone');
  assert.equal(dayKey(now), '2026-10-07');
});
