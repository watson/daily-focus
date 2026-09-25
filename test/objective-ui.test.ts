import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { mountOne } from './dom.ts';
import { renderObjective } from '../client/today.ts';
import type { PublicFocus } from '../src/focus.ts';

function render(focus: PublicFocus | null) {
  const node = mountOne(renderObjective({ focus }));
  return { node, empty: node.classList.contains('objective--empty') };
}

test('no focus.md turns the objective off entirely', () => {
  const { node } = render(null);
  assert.equal(node.hidden, true);
  assert.equal(node.textContent, '');
});

test('a blank objective is a quiet reminder, not a placeholder', () => {
  const { node, empty } = render({ objective: null, blocker: null, note: null });
  assert.equal(node.hidden, false);
  assert.equal(empty, true);
  assert.match(node.textContent!, /No current objective/);
});

test('a set objective renders with its blocker', () => {
  const { node, empty } = render({ objective: 'Ship it', blocker: 'Staging is down', note: null });
  assert.equal(empty, false);
  assert.match(node.textContent!, /Current objective/);
  assert.match(node.textContent!, /Ship it/);
  assert.match(node.textContent!, /Blocked on: Staging is down/);
});

test('a missing blocker or note leaves no stray text', () => {
  const { node } = render({ objective: 'Ship it', blocker: null, note: null });
  assert.equal(node.textContent, 'Current objectiveShip it');
});
