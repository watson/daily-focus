/**
 * The page's half of telling the menu bar app the dashboard is in use: once a
 * minute at most, and only from a tab someone can see.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRESENCE_EVERY_MS, watchPresence } from '../client/presence.ts';

/** A page whose clock and visibility the test moves, and what it sent. */
function setup(visible = true) {
  const world = { visible, now: 1_000_000, sent: 0, fail: false };
  const watch = watchPresence({
    visible: () => world.visible,
    now: () => world.now,
    send: async () => {
      world.sent += 1;
      if (world.fail) throw new Error('offline');
    },
  });
  return { world, watch };
}

test('a visible page says it is in use, at most once a minute', () => {
  const { world, watch } = setup();
  watch.noticed();
  watch.noticed();
  assert.equal(world.sent, 1, 'two clicks at once are one report');
  world.now += PRESENCE_EVERY_MS - 1;
  watch.noticed();
  assert.equal(world.sent, 1, 'not again within the minute');
  world.now += 1;
  watch.noticed();
  assert.equal(world.sent, 2, 'again once it has passed');
});

test('a tab out of sight says nothing', () => {
  const { world, watch } = setup(false);
  watch.noticed();
  assert.equal(world.sent, 0);
  world.visible = true;
  watch.noticed();
  assert.equal(world.sent, 1, 'until it comes into view');
});

test('a report that fails is only a report missed', async () => {
  const { world, watch } = setup();
  world.fail = true;
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    watch.noticed();
    await new Promise((done) => setImmediate(done));
  } finally {
    console.warn = warn;
  }
  assert.equal(world.sent, 1);
  assert.equal(warned.length, 1, 'it says so in the console, and nothing throws');
});
