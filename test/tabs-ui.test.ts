/**
 * Which tabs an instance shows: a switched-off board takes its tab with it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported for its side effect before `render.js` is pulled in below.
import './dom-stub.ts';

const { availableViews } = (await import('../public/render.js')) as {
  availableViews: (state: unknown) => string[];
};

test('every view is offered when both boards are on', () => {
  assert.deepEqual(availableViews({ board: { enabled: true }, tickets: { enabled: true } }), [
    'today',
    'board',
    'tickets',
  ]);
});

test('a switched-off board has no view', () => {
  assert.deepEqual(availableViews({ board: { enabled: true }, tickets: { enabled: false } }), ['today', 'board']);
  assert.deepEqual(availableViews({ board: { enabled: false }, tickets: { enabled: true } }), ['today', 'tickets']);
});

test('Today is always offered, even before the first state', () => {
  assert.deepEqual(availableViews(null), ['today']);
  assert.deepEqual(availableViews({}), ['today']);
});
