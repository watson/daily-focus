import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveItems } from '../src/store.ts';
import type { Action, Item } from '../src/types.ts';

const NOW = new Date(2026, 8, 10, 10, 0, 0); // 10 Sep 2026, local

function item(id: string, extra: Partial<Item> = {}): Item {
  return { id, source: 'github', kind: 'task', title: id, ...extra };
}

function action(id: string, act: Action['action'], extra: Partial<Action> = {}): Action {
  return { id, action: act, at: '2026-09-10T08:00:00Z', ...extra };
}

test('an item with no actions is open', () => {
  const [resolved] = resolveItems([item('a')], [], NOW);
  assert.equal(resolved?.status, 'open');
  assert.deepEqual(resolved?.notes, []);
});

test('the last action for an id wins', () => {
  const [resolved] = resolveItems(
    [item('a')],
    [action('a', 'done'), action('a', 'reopen'), action('a', 'dismiss')],
    NOW,
  );
  assert.equal(resolved?.status, 'dismissed');
});

test('reopen clears a snooze', () => {
  const [resolved] = resolveItems(
    [item('a')],
    [action('a', 'snooze', { until: '2026-12-01' }), action('a', 'reopen')],
    NOW,
  );
  assert.equal(resolved?.status, 'open');
  assert.equal(resolved?.snoozedUntil, undefined);
});

test('a snooze in the future stays snoozed', () => {
  const [resolved] = resolveItems([item('a')], [action('a', 'snooze', { until: '2026-09-12' })], NOW);
  assert.equal(resolved?.status, 'snoozed');
  assert.equal(resolved?.snoozedUntil, '2026-09-12');
});

test('a snooze whose date has arrived reverts to open', () => {
  for (const until of ['2026-09-10', '2026-09-09']) {
    const [resolved] = resolveItems([item('a')], [action('a', 'snooze', { until })], NOW);
    assert.equal(resolved?.status, 'open', `expected ${until} to have expired`);
    assert.equal(resolved?.snoozedUntil, undefined);
  }
});

test('a snooze with no date waits for the agent', () => {
  const [resolved] = resolveItems([item('a')], [action('a', 'snooze')], NOW);
  assert.equal(resolved?.status, 'snoozed');
  assert.equal(resolved?.snoozedUntil, undefined);
});

test('notes accumulate and do not change status', () => {
  const [resolved] = resolveItems(
    [item('a')],
    [
      action('a', 'note', { text: 'first', at: '2026-09-10T08:00:00Z' }),
      action('a', 'done', { at: '2026-09-10T08:01:00Z' }),
      action('a', 'note', { text: 'second', at: '2026-09-10T08:02:00Z' }),
    ],
    NOW,
  );

  assert.equal(resolved?.status, 'done');
  assert.deepEqual(
    resolved?.notes.map((n) => n.text),
    ['first', 'second'],
  );
});

test('actions only affect their own item', () => {
  const resolved = resolveItems([item('a'), item('b')], [action('a', 'done')], NOW);
  assert.equal(resolved[0]?.status, 'done');
  assert.equal(resolved[1]?.status, 'open');
});

test('an action for an unknown id is simply ignored', () => {
  const resolved = resolveItems([item('a')], [action('ghost', 'done')], NOW);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.status, 'open');
});

test('ageDays counts calendar days since firstSeen', () => {
  const [resolved] = resolveItems([item('a', { firstSeen: '2026-09-05' })], [], NOW);
  assert.equal(resolved?.ageDays, 5);
});

test('ageDays is 0 when firstSeen is missing or in the future', () => {
  assert.equal(resolveItems([item('a')], [], NOW)[0]?.ageDays, 0);
  assert.equal(resolveItems([item('a', { firstSeen: '2026-09-20' })], [], NOW)[0]?.ageDays, 0);
});
