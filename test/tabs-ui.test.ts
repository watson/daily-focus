/**
 * Which tabs an instance shows: a switched-off board takes its tab with it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { availableViews } from '../client/state.ts';
import type { DashboardState } from '../src/types.ts';

const of = (state: unknown) => availableViews(state as DashboardState | null);

test('every view is offered when both boards are on', () => {
  assert.deepEqual(of({ board: { enabled: true }, tickets: { enabled: true } }), ['today', 'board', 'tickets']);
});

test('a switched-off board has no view', () => {
  assert.deepEqual(of({ board: { enabled: true }, tickets: { enabled: false } }), ['today', 'board']);
  assert.deepEqual(of({ board: { enabled: false }, tickets: { enabled: true } }), ['today', 'tickets']);
});

test('Today is always offered, even before the first state', () => {
  assert.deepEqual(of(null), ['today']);
  assert.deepEqual(of({}), ['today']);
});
