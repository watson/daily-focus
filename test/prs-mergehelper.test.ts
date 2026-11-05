/**
 * What the board offers once a merge helper is set: its button where it said
 * so, with GitHub's merge beside it, nothing while it hasn't, and Merge stack on
 * the top of a stack it can merge whole, under the same rules as GitHub's merge
 * and a few of its own. Pure: the helper's answers are handed in.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findStack, refuseMergeBy, resolveBoard, type MergeContext } from '../src/prs.ts';
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

test("the helper's button is offered only where it said the branch merges through it", () => {
  const pulls = [pull(411), pull(412, { mergeQueue: true }), pull(410, { isDraft: true })];
  assert.deepEqual(offers(board(pulls, null)), { 411: ['merge'], 412: ['queue'], 410: ['ready'] }, 'no helper set');
  assert.deepEqual(offers(board(pulls)), { 411: ['helper', 'merge'], 412: ['helper'], 410: ['ready'] }, 'queue: true, and GitHub\'s merge beside it but where GitHub queues');
  assert.deepEqual(offers(board(pulls, context({ helper: null }))), { 411: ['merge'], 412: ['queue'], 410: ['ready'] }, "queue: false, or a check that failed");
  assert.deepEqual(offers(board(pulls, context({ helper: { kind: 'asking' } }))), { 411: [], 412: [], 410: ['ready'] }, 'nothing to merge with until it says');

  const row = board([pull(411)]).get(411)!;
  assert.deepEqual(row.mergeHelper, QUEUE);
});

test("GitHub's merge is offered beside the helper's only where it would go straight in, by the method its button would use", () => {
  const rows = board([pull(411), pull(412, { mergeQueue: true }), pull(413, { mergeMethod: null }), pull(415, { basePushable: false })]);
  assert.deepEqual(offers(rows), { 411: ['helper', 'merge'], 412: ['helper'], 413: ['helper'], 415: ['helper'] });
  // Ready only because the queue alone may merge there: GitHub would refuse its own merge.
  const queuedOnly = board([pull(421, { mergeStateStatus: 'BLOCKED', basePushable: false })]).get(421)!;
  assert.deepEqual(merges(queuedOnly), ['helper']);
  assert.equal(refuseMergeBy(queuedOnly, 'merge'), "it merges through the merge helper, not with GitHub's merge");
  assert.equal(refuseMergeBy(rows.get(411)!, 'helper'), null);
  assert.equal(refuseMergeBy(rows.get(411)!, 'merge'), null);
  assert.equal(refuseMergeBy(rows.get(411)!, 'queue'), "it merges through the merge helper or with GitHub's merge, not through GitHub's merge queue");
  assert.equal(refuseMergeBy(rows.get(412)!, 'merge'), "it merges through the merge helper, not with GitHub's merge");
  assert.match(refuseMergeBy(rows.get(413)!, 'merge')!, /hasn't read what that needs from GitHub yet/);

  // Without a helper, one way each, as before.
  const plain = board([pull(411), pull(412, { mergeQueue: true })], null);
  assert.equal(refuseMergeBy(plain.get(411)!, 'helper'), "it merges with GitHub's merge, not through the merge helper");
  assert.equal(refuseMergeBy(plain.get(412)!, 'merge'), "it merges through GitHub's merge queue, not with GitHub's merge");
  // And what refuses every way still comes first.
  assert.equal(refuseMergeBy(board([pull(414, { baseRef: 'release/2026.11' })]).get(414)!, 'merge'), 'it targets release/2026.11, not main');
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

test('where only the helper’s queue may merge, a merge GitHub calls blocked with nothing left to wait on is ready, and offers it', () => {
  // A branch only a queue's bot may push to reads blocked to the user: approved and green, there is nothing else to wait on.
  const blocked = { mergeStateStatus: 'BLOCKED' as const, basePushable: false };
  const queued = board([pull(421, blocked)]).get(421)!;
  assert.equal(queued.court, 'ready');
  assert.deepEqual(queued.reasons, []);
  assert.deepEqual(merges(queued), ['helper']);
  assert.equal(queued.since, '2026-11-02T10:00:00Z', 'ready since the approval, as any ready row is');

  // GitHub's own merge would be refused, so without the helper's word it stays blocked.
  for (const [what, merging] of [
    ['no helper set', null],
    ["the helper doesn't merge it", context({ helper: null })],
    ['the helper is still being asked', context({ helper: { kind: 'asking' } })],
  ] as const) {
    const row = board([pull(421, blocked)], merging).get(421)!;
    assert.equal(row.court, 'blocked', what);
    assert.deepEqual(merges(row), [], what);
  }

  // Blocked for something else: the user may push there, or GitHub didn't say, as an older cache doesn't.
  for (const [what, basePushable] of [
    ['the user may push to the base branch', true],
    ['GitHub showed no rule for it', null],
    ['a cache from before it was read', undefined],
  ] as const) {
    const row = board([pull(421, { ...blocked, basePushable })]).get(421)!;
    assert.equal(row.court, 'blocked', what);
    assert.deepEqual(merges(row), [], what);
  }

  // Everything else still holds it up.
  const rows = board([
    pull(422, { ...blocked, pendingChecks: [{ name: 'integration-tests', kind: 'check-run', detailsUrl: null }] }),
    pull(423, { ...blocked, reviewDecision: 'REVIEW_REQUIRED', reviews: [] }),
    pull(424, { ...blocked, reviewDecision: null, reviews: [] }),
    pull(425, { ...blocked, lastActivityByOthers: { login: 'bob', at: '2026-11-02T11:00:00Z', kind: 'comment' } }),
    pull(426, { ...blocked, baseRef: 'release/2026.11' }),
  ]);
  assert.deepEqual(
    Object.fromEntries([...rows].map(([number, row]) => [number, row.court])),
    { 422: 'checks', 423: 'reviewers', 424: 'blocked', 425: 'you', 426: 'blocked' },
  );
  for (const row of rows.values()) assert.deepEqual(merges(row), [], `#${row.number}`);
});

/* ---------- stacks ---------- */

/** 410 on main, 411 on 410, 412 on 411. */
const STACK = () => [pull(410), above(411, 410), above(412, 411)];

test('a stack offers Merge stack on its top, naming every pull request in it, bottom first', () => {
  const rows = board(STACK());
  assert.deepEqual(offers(rows), { 410: ['helper', 'merge'], 411: [], 412: ['stack'] });
  assert.deepEqual(rows.get(412)?.stack, ['github:pr:acme/payments-api#410', 'github:pr:acme/payments-api#411', 'github:pr:acme/payments-api#412']);
  assert.equal(rows.get(411)?.stack, undefined);
  // Two is a stack too.
  assert.deepEqual(offers(board([pull(410), above(411, 410)])), { 410: ['helper', 'merge'], 411: ['stack'] });
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
