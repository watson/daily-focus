/**
 * What one board row actually renders.
 *
 * The DOM stub lives in `./dom-stub.ts`, shared with the other client render
 * test. What is worth asking of a board row is whether the reason appears, the
 * check's link is clickable, and the *Nudged* button is offered — rules that live
 * only in `render.js` and would otherwise never be held to anything.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported for its side effect before `render.js` is pulled in below: it installs
// the `document` and `Node` globals that `el()` reaches for.
import { byClass, byTag, buttonLabels, type StubElement, type StubNode } from './dom-stub.ts';
import { resolveBoard } from '../src/prs.ts';
import type { BoardRow, PullRequest } from '../src/types.ts';

const { renderPullRow } = (await import('../public/render.js')) as {
  renderPullRow: (row: BoardRow, state: unknown, ui: unknown, handlers: unknown) => StubElement;
};

/* ---------- the fixtures ---------- */

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const GATES = ['policy/merge-gate'];

const UI = { selectedId: null, pending: new Set<string>(), noteFor: null, menuFor: null, noteDraft: '' };
const HANDLERS = {
  onSelect: () => {},
  onAction: () => {},
  nudge: () => {},
  toggleMenu: () => {},
  toggleNote: () => {},
  unpark: () => {},
};

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'github:pr:acme/webapp#3421',
    account: 'alice',
    repo: 'acme/webapp',
    number: 3421,
    title: 'Fix session replay memory leak',
    url: 'https://github.com/acme/webapp/pull/3421',
    isDraft: false,
    createdAt: hoursAgo(72),
    readyAt: hoursAgo(72),
    updatedAt: hoursAgo(24),
    headRef: 'alice/fix-leak',
    baseRef: 'main',
    reviewDecision: 'APPROVED',
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
    lastActivityByYou: hoursAgo(48),
    lastActivityByOthers: { at: hoursAgo(6), login: 'bob', kind: 'review' },
    ...overrides,
  };
}

/** One rendered row, judged the way the server would judge it. */
function render(overrides: Partial<PullRequest>): { row: BoardRow; node: StubElement } {
  const [row] = resolveBoard([pr(overrides)], [], NOW, GATES);
  assert.ok(row);
  return { row, node: renderPullRow(row, { now: NOW.toISOString() }, UI, HANDLERS) };
}

test('a gate row names the check, links GitHub\'s details page, and offers no nudge', () => {
  const { row, node } = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [
      { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/4821', checkRunId: 4821 },
    ],
  });
  assert.equal(row.court, 'gate');
  assert.equal(node.dataset.court, 'gate');

  const reason = byClass(node, 'item__reason')[0];
  assert.ok(reason, 'a gate row explains itself');
  assert.equal(reason.textContent, 'merge policy pending: policy/merge-gate');
  // Not red: nothing has gone wrong, it just isn't finished.
  assert.ok(reason.className.includes('item__reason--waiting'));

  const link = byTag(reason, 'A')[0];
  assert.equal(link?.href, 'https://github.com/acme/webapp/runs/4821');
  assert.equal(link?.textContent, 'policy/merge-gate');

  // How long the merge has been refused, as a span rather than a point in time:
  // the row's last push was 48 hours ago, which is where the wait starts.
  assert.ok(
    byClass(node, 'pill').some((pill) => pill.textContent === 'waiting 2 days'),
    byClass(node, 'pill').map((pill) => pill.textContent).join(' | '),
  );

  // The board has no idea whose action the gate needs, so it suggests nobody.
  assert.deepEqual(buttonLabels(node), ['Park', 'Note']);
});

test('a cancelled check is shown on the row in every court, and moves none of them', () => {
  // The merge-queue shape: the gate decides the court, and the cancellation it
  // caused is stated underneath rather than counted as red.
  const gated = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }],
    cancelledChecks: [{ name: 'policy/merge', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/77' }],
  });
  assert.equal(gated.row.court, 'gate');
  const lines = byClass(gated.node, 'item__reason').map((line) => line.textContent);
  assert.deepEqual(lines, ['merge policy pending: policy/merge-gate', 'cancelled, no verdict: policy/merge']);

  // And on a row where nothing is outstanding at all: still ready, and the
  // cancellation is still said out loud, which is the point of saying it.
  const ready = render({ cancelledChecks: [{ name: 'policy/merge', kind: 'check-run', detailsUrl: null }] });
  assert.equal(ready.row.court, 'ready');
  assert.deepEqual(
    byClass(ready.node, 'item__reason').map((line) => line.textContent),
    ['cancelled, no verdict: policy/merge'],
  );
  assert.equal(
    byClass(ready.node, 'pill').some((pill) => pill.textContent === 'CI failing'),
    false,
    'a cancellation is not a red pill either',
  );
});

test('a check row lists what is still running, without inventing a link', () => {
  const { row, node } = render({
    mergeStateStatus: 'UNSTABLE',
    checks: 'pending',
    pendingChecks: [
      { name: 'integration-tests', kind: 'check-run', detailsUrl: null },
      { name: 'ci/deploy', kind: 'status-context', detailsUrl: null },
    ],
  });
  assert.equal(row.court, 'checks');

  const reason = byClass(node, 'item__reason')[0];
  assert.match(reason?.textContent ?? '', /still running: integration-tests, ci\/deploy/);
  assert.equal(byTag(reason!, 'A').length, 0, 'GitHub gave nowhere to look, so nothing is linked');
  assert.deepEqual(buttonLabels(node), ['Park', 'Note']);
});

test('a blocked merge with nothing pending says only that much', () => {
  const { row, node } = render({ mergeStateStatus: 'BLOCKED' });
  assert.equal(row.court, 'checks');
  assert.match(byClass(node, 'item__reason')[0]?.textContent ?? '', /merge blocked by GitHub/);
});

test('an undecided merge state is reported as undecided, not as fine', () => {
  const { node } = render({ mergeStateStatus: 'UNKNOWN' });
  assert.match(byClass(node, 'item__reason')[0]?.textContent ?? '', /still determining mergeability/);
});

test('a branch behind its base is your move, in red', () => {
  const { row, node } = render({ mergeStateStatus: 'BEHIND' });
  assert.equal(row.court, 'you');
  const reason = byClass(node, 'item__reason')[0];
  assert.match(reason?.textContent ?? '', /behind its base/);
  assert.ok(!reason?.className.includes('item__reason--waiting'), 'something is wrong here, and it looks it');
});

test('only a row waiting on reviewers is offered the nudge', () => {
  const { row, node } = render({
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [],
    lastActivityByOthers: null,
    requestedReviewers: ['carol'],
  });
  assert.equal(row.court, 'reviewers');
  assert.deepEqual(buttonLabels(node), ['Nudged', 'Park', 'Note']);
  assert.equal(byClass(node, 'item__reason').length, 0, 'waiting on a review needs no explaining');
});

test('a ready row is plain: no reason, no nudge', () => {
  const { row, node } = render({});
  assert.equal(row.court, 'ready');
  assert.equal(byClass(node, 'item__reason').length, 0);
  assert.deepEqual(buttonLabels(node), ['Park', 'Note']);
});

test('a reason kind this client has never heard of is skipped, not printed half', () => {
  const [row] = resolveBoard([pr({ mergeStateStatus: 'BLOCKED' })], [], NOW, GATES);
  assert.ok(row);
  // A server one version ahead: the row renders, minus the part nothing can word.
  const ahead = { ...row, reasons: [{ kind: 'merge-queue-position' }, ...row.reasons] } as unknown as BoardRow;
  const reason = byClass(renderPullRow(ahead, { now: NOW.toISOString() }, UI, HANDLERS), 'item__reason')[0];
  assert.equal(reason?.textContent, 'merge blocked by GitHub', 'no stray separator where the unknown reason was');
});

test('more than three pending checks are summarised rather than listed', () => {
  const { node } = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, kind: 'check-run' as const, detailsUrl: null })),
  });
  assert.match(byClass(node, 'item__reason')[0]?.textContent ?? '', /still running: a, b, c and 2 more/);
});
