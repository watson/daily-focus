/**
 * What the board offers once a merge helper is set: its button in place of
 * GitHub's merge where it said so, nothing while it hasn't, and Merge stack on
 * the top of a stack it can merge whole, under the same rules as GitHub's merge
 * and a few of its own. Pure: the helper's answers are handed in.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findStack, resolveBoard, type MergeContext } from '../src/prs.ts';
import type { BoardRow, MergeHelperView, PullRequest } from '../src/types.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

/** One of alice's pull requests in acme/payments-api: approved by one, green, clean, and read in full. */
function pull(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `github:pr:acme/payments-api#${number}`,
    account: 'alice',
    repo: 'acme/payments-api',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/payments-api/pull/${number}`,
    isDraft: false,
    createdAt: '2026-10-28T09:00:00Z',
    readyAt: '2026-10-28T09:00:00Z',
    updatedAt: '2026-11-02T09:00:00Z',
    headRef: `alice/change-${number}`,
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
    reviews: [{ login: 'bob', state: 'APPROVED', at: '2026-11-02T10:00:00Z' }],
    headSha: `${HEAD.slice(0, -3)}${number}`,
    lastActivityByYou: '2026-11-02T09:00:00Z',
    lastActivityByOthers: null,
    nodeId: `PR_kwDOAcme${number}`,
    defaultBranch: 'main',
    mergeMethod: 'SQUASH',
    mergeQueue: false,
    inMergeQueue: false,
    stacked: false,
    ...overrides,
  };
}

/** On another's branch: what a pull request above the bottom of a stack is based on. GitHub reports no review decision there. */
function above(number: number, on: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return pull(number, { baseRef: `alice/change-${on}`, reviewDecision: null, ...overrides });
}

const QUEUE: MergeHelperView = { kind: 'queue', label: 'Add to merge queue', stacks: true };

function context(overrides: { helper?: MergeHelperView | null; queued?: string[]; approvals?: number | null } = {}): MergeContext {
  const helper = 'helper' in overrides ? overrides.helper! : QUEUE;
  return {
    helper: () => helper,
    queued: (id) => (overrides.queued ?? []).includes(id),
    approvals: () => ('approvals' in overrides ? overrides.approvals! : 1),
  };
}

function board(pulls: PullRequest[], merging: MergeContext | null = context()): Map<number, BoardRow> {
  return new Map(resolveBoard(pulls, [], NOW, [], null, merging).map((row) => [row.number, row]));
}

// Merges only: turning a pull request back into a draft is offered on every open one, and is not what this file is about.
const merges = (row: BoardRow | undefined) => row?.offers?.filter((offer) => offer !== 'draft');
const offers = (rows: Map<number, BoardRow>) => Object.fromEntries([...rows].map(([number, row]) => [number, merges(row)]));

test("the helper's button takes the place of GitHub's merge only where it said the branch merges through it", () => {
  const pulls = [pull(411), pull(412, { mergeQueue: true }), pull(410, { isDraft: true })];
  assert.deepEqual(offers(board(pulls, null)), { 411: ['merge'], 412: ['queue'], 410: ['ready'] }, 'no helper set');
  assert.deepEqual(offers(board(pulls)), { 411: ['helper'], 412: ['helper'], 410: ['ready'] }, 'queue: true');
  assert.deepEqual(offers(board(pulls, context({ helper: null }))), { 411: ['merge'], 412: ['queue'], 410: ['ready'] }, "queue: false, or a check that failed");
  assert.deepEqual(offers(board(pulls, context({ helper: { kind: 'asking' } }))), { 411: [], 412: [], 410: ['ready'] }, 'nothing to merge with until it says');

  const row = board([pull(411)]).get(411)!;
  assert.deepEqual(row.mergeHelper, QUEUE);
});

test('GitHub’s rules for a merge still decide whether the helper is offered', () => {
  const rows = board([
    pull(414, { baseRef: 'release/2026.11' }),
    pull(415, { stacked: true }),
    pull(416, { checks: 'failure', failingChecks: ['unit-tests'], mergeStateStatus: 'UNSTABLE' }),
    pull(417, { mergeStateStatus: null }),
    pull(418, { mergeQueue: true, inMergeQueue: true }),
    pull(419, { headSha: null }),
    pull(420),
  ], context({ queued: ['github:pr:acme/payments-api#420'] }));
  for (const number of [414, 415, 416, 417, 418, 419, 420]) assert.deepEqual(merges(rows.get(number)), [], `#${number}`);
  assert.equal(rows.get(420)?.helperQueued, true, 'the helper says it is in its queue');
  assert.equal(rows.get(414)?.mergeHelper, undefined, 'the helper is asked about default branches only');
});

/* ---------- stacks ---------- */

/** 410 on main, 411 on 410, 412 on 411. */
const STACK = () => [pull(410), above(411, 410), above(412, 411)];

test('a stack offers Merge stack on its top, naming every pull request in it, bottom first', () => {
  const rows = board(STACK());
  assert.deepEqual(offers(rows), { 410: ['helper'], 411: [], 412: ['stack'] });
  assert.deepEqual(rows.get(412)?.stack, ['github:pr:acme/payments-api#410', 'github:pr:acme/payments-api#411', 'github:pr:acme/payments-api#412']);
  assert.equal(rows.get(411)?.stack, undefined);
  // Two is a stack too.
  assert.deepEqual(offers(board([pull(410), above(411, 410)])), { 410: ['helper'], 411: ['stack'] });
});

test('no stack merge without a helper that merges stacks, or while it or the approvals are unknown', () => {
  const none = (merging: MergeContext | null) => assert.deepEqual(merges(board(STACK(), merging).get(412)), []);
  none(null);
  none(context({ helper: null }));
  none(context({ helper: { kind: 'asking' } }));
  none(context({ helper: { kind: 'queue', label: 'Add to merge queue', stacks: false } }));
  none(context({ approvals: null }));
});

/** Why the stack topped by `top` is refused, on a board of `pulls`. */
function refusal(pulls: PullRequest[], top: number, merging = context()): string {
  const rows = resolveBoard(pulls, [], NOW, [], null, merging);
  const row = rows.find((candidate) => candidate.number === top)!;
  assert.ok(!row.offers?.includes('stack'), `#${top} should not offer the stack`);
  const found = findStack(row, rows, merging.approvals);
  assert.equal(found.chain, null);
  return found.why!;
}

test('a broken chain is no stack: a base no open pull request of yours owns, someone else’s, or two on one branch', () => {
  assert.equal(
    refusal([pull(410), above(412, 411)], 412),
    "#412 is based on alice/change-411, which isn't the branch of another of your open pull requests",
  );
  // The pull request below is read as another account: not one of this stack's.
  assert.equal(
    refusal([pull(410), above(411, 410, { account: 'alice-corp' }), above(412, 411)], 412),
    "#412 is based on alice/change-411, which isn't the branch of another of your open pull requests",
  );
  assert.equal(refusal([pull(410), above(411, 410), above(412, 410)], 412), '#410 has more than one pull request stacked on it');
  assert.equal(refusal([pull(410), above(411, 410), above(412, 411)], 411), '#412 is stacked on it; merge the stack from its top');
  assert.equal(refusal([pull(410)], 410), 'it is not stacked on another of your pull requests');
});

test('every pull request above the bottom must be ready to go with it', () => {
  const stack = (overrides: Partial<PullRequest>) => [pull(410), above(411, 410, overrides), above(412, 411)];
  assert.equal(refusal(stack({ isDraft: true }), 412), '#411 is a draft');
  assert.equal(refusal(stack({ reviews: [{ login: 'bob', state: 'CHANGES_REQUESTED', at: '2026-11-02T10:00:00Z' }] }), 412), '#411 has changes requested');
  assert.equal(refusal(stack({ checks: 'failure', failingChecks: ['unit-tests'] }), 412), '#411 has failing checks');
  assert.equal(refusal(stack({ mergeable: 'CONFLICTING' }), 412), '#411 has conflicts');
  assert.equal(refusal(stack({ stacked: true }), 412), '#411 is part of a stack on GitHub, which merges there');
  assert.equal(refusal(stack({ headSha: null }), 412), "the board hasn't read what that needs from GitHub yet; refresh the board and try again");
  assert.equal(refusal(stack({}), 412, context({ queued: ['github:pr:acme/payments-api#411'] })), '#411 is in the merge queue already');
});

test("each needs as many approvals as the default branch's rules ask, and always one", () => {
  assert.equal(refusal(STACK(), 412, context({ approvals: 2 })), '#411 has 1 approval, and main needs 2');
  const twice = { reviews: [{ login: 'bob', state: 'APPROVED', at: '2026-11-02T10:00:00Z' }, { login: 'carol', state: 'APPROVED', at: '2026-11-02T11:00:00Z' }] };
  assert.deepEqual(merges(board([pull(410), above(411, 410, twice), above(412, 411, twice)], context({ approvals: 2 })).get(412)), ['stack']);
  // A branch whose rules ask for none still gets an approved stack only.
  assert.equal(refusal([pull(410), above(411, 410, { reviews: [] }), above(412, 411)], 412, context({ approvals: 0 })), '#411 has no approvals, and main needs 1');
});

test('the bottom must offer the helper’s own merge', () => {
  assert.equal(
    refusal([pull(410, { checks: 'failure', failingChecks: ['lint'], mergeStateStatus: 'UNSTABLE' }), above(411, 410), above(412, 411)], 412),
    '#410, at the bottom: it is not ready to merge',
  );
  assert.equal(refusal([pull(410, { stacked: true }), above(411, 410)], 411), '#410, at the bottom: it is part of a stack on GitHub, which merges there');
  assert.equal(refusal(STACK(), 412, context({ queued: ['github:pr:acme/payments-api#410'] })), '#410, at the bottom: it is in the merge queue already');
});
