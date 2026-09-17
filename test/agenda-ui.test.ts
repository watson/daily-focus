/**
 * What one agenda row actually renders.
 *
 * The DOM stub lives in `./dom-stub.ts`, shared with the board render test. The
 * rule worth holding here is the one `agenda.ts` cannot express: an event marked
 * free in the calendar takes none of the day, and the row has to say so without
 * reading as an event that is already over. Both halves are only in `render.js`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported for its side effect before `render.js` is pulled in below: it installs
// the `document` and `Node` globals that `el()` reaches for.
import { byClass, type StubElement } from './dom-stub.ts';
import type { ResolvedItem } from '../src/types.ts';

const { eventRow } = (await import('../public/render.js')) as {
  eventRow: (event: ResolvedItem, now: Date, conflictIds: string[]) => StubElement;
};

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

const render = (overrides: Partial<ResolvedItem> = {}) => eventRow(event(overrides), NOW, []);

/** The row's sub-lines, in order — where "until", the clash and "marked free" land. */
const subs = (node: StubElement) => byClass(node, 'agenda__sub').map((sub) => sub.textContent);

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
  const node = eventRow(event({ blocking: false }), NOW, ['calendar:event:abc']);

  assert.equal(subs(node).length, 2);
  assert.match(subs(node)[0]!, /clashes with another meeting/);
  assert.match(subs(node)[1]!, /marked free$/);
});
