import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NUDGE_AFTER_MS, STALE_DRAFT_AFTER_MS, countBoard, deriveDecision, judge, resolveBoard } from '../src/prs.ts';
import type { Action, PullRequest } from '../src/types.ts';

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

/** An invented PR with sensible defaults; every test overrides what it's about. */
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'github:pr:acme/webapp#3421',
    account: 'alice',
    repo: 'acme/webapp',
    number: 3421,
    title: 'Fix session replay memory leak',
    url: 'https://github.com/acme/webapp/pull/3421',
    isDraft: false,
    createdAt: daysAgo(3),
    readyAt: daysAgo(3),
    updatedAt: daysAgo(1),
    headRef: 'alice/fix-leak',
    baseRef: 'main',
    reviewDecision: null,
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    lastActivityByYou: daysAgo(2),
    lastActivityByOthers: null,
    ...overrides,
  };
}

test('a draft is a draft, and goes stale after a fortnight untouched', () => {
  const fresh = judge(pr({ isDraft: true, lastActivityByYou: daysAgo(3) }), NOW, null);
  assert.equal(fresh.court, 'draft');
  assert.equal(fresh.stale, false);

  const old = judge(pr({ isDraft: true, lastActivityByYou: new Date(NOW.getTime() - STALE_DRAFT_AFTER_MS).toISOString() }), NOW, null);
  assert.equal(old.court, 'draft');
  assert.equal(old.stale, true);
});

test('nobody has acted yet: waiting on reviewers, nudge after a day', () => {
  const young = judge(pr({ readyAt: hoursAgo(2), lastActivityByYou: hoursAgo(2) }), NOW, null);
  assert.equal(young.court, 'reviewers');
  assert.equal(young.nudge, false);

  const old = judge(pr({ readyAt: daysAgo(2), lastActivityByYou: daysAgo(2) }), NOW, null);
  assert.equal(old.court, 'reviewers');
  assert.equal(old.nudge, true);
  assert.equal(old.since, daysAgo(2));
});

test('a note resets the nudge timer without moving the PR', () => {
  const base = pr({ readyAt: daysAgo(3), lastActivityByYou: daysAgo(3) });
  const before = judge(base, NOW, null);
  assert.equal(before.nudge, true);

  const nudged = judge(base, NOW, hoursAgo(3));
  assert.equal(nudged.court, 'reviewers');
  assert.equal(nudged.nudge, false);
  assert.equal(nudged.since, daysAgo(3), 'the wait itself is unchanged');

  const longAgo = judge(base, NOW, new Date(NOW.getTime() - NUDGE_AFTER_MS).toISOString());
  assert.equal(longAgo.nudge, true, 'a day after the note it asks again');
});

test('someone acting after you puts it in your court', () => {
  const verdict = judge(
    pr({
      lastActivityByYou: daysAgo(2),
      lastActivityByOthers: { at: hoursAgo(5), login: 'bob', kind: 'comment' },
    }),
    NOW,
    null,
  );
  assert.equal(verdict.court, 'you');
  assert.deepEqual(verdict.reasons, [{ kind: 'activity', login: 'bob', at: hoursAgo(5), activity: 'comment' }]);
  assert.equal(verdict.since, hoursAgo(5));
});

test('you acting after them puts it back with the reviewers', () => {
  const verdict = judge(
    pr({
      lastActivityByYou: hoursAgo(1),
      lastActivityByOthers: { at: hoursAgo(5), login: 'bob', kind: 'review' },
      reviews: [{ login: 'bob', state: 'COMMENTED', at: hoursAgo(5) }],
    }),
    NOW,
    null,
  );
  assert.equal(verdict.court, 'reviewers');
  assert.equal(verdict.since, hoursAgo(1));
});

test('changes requested, red CI and conflicts are each your move, whatever else is true', () => {
  const changes = judge(
    pr({
      reviewDecision: 'CHANGES_REQUESTED',
      reviews: [{ login: 'bob', state: 'CHANGES_REQUESTED', at: daysAgo(1) }],
      lastActivityByYou: hoursAgo(1),
    }),
    NOW,
    null,
  );
  assert.equal(changes.court, 'you');
  assert.deepEqual(changes.reasons, [{ kind: 'changes-requested', login: 'bob', at: daysAgo(1) }]);

  const red = judge(pr({ checks: 'failure', failingChecks: ['all-tests-green'], lastActivityByYou: hoursAgo(1) }), NOW, null);
  assert.equal(red.court, 'you');
  assert.equal(red.ciFailing, true);
  assert.deepEqual(red.reasons, [{ kind: 'ci-failing', checks: ['all-tests-green'] }]);

  const conflicting = judge(pr({ mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' }), NOW, null);
  assert.equal(conflicting.court, 'you', 'approved but conflicting is still yours to fix');
  assert.equal(conflicting.conflicts, true);
});

test('approved, green and mergeable is ready to merge', () => {
  const verdict = judge(
    pr({
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
      lastActivityByOthers: { at: hoursAgo(6), login: 'bob', kind: 'review' },
    }),
    NOW,
    null,
  );
  assert.equal(verdict.court, 'ready', 'the approval is their activity, and it means ready, not your move');
  assert.equal(verdict.since, hoursAgo(6));
});

test('a comment after the approval puts it back in your court', () => {
  const verdict = judge(
    pr({
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
      lastActivityByOthers: { at: hoursAgo(1), login: 'bob', kind: 'comment' },
    }),
    NOW,
    null,
  );
  assert.equal(verdict.court, 'you');
  assert.deepEqual(verdict.reasons, [{ kind: 'activity', login: 'bob', at: hoursAgo(1), activity: 'comment' }]);
});

test('a red draft still shows its CI flag, but stays a draft', () => {
  const verdict = judge(pr({ isDraft: true, checks: 'failure', mergeable: 'CONFLICTING' }), NOW, null);
  assert.equal(verdict.court, 'draft');
  assert.equal(verdict.ciFailing, true);
  assert.equal(verdict.conflicts, true);
});

test('without branch protection the decision comes from the reviews themselves', () => {
  assert.equal(deriveDecision(pr()), null);
  assert.equal(deriveDecision(pr({ reviews: [{ login: 'bob', state: 'APPROVED', at: daysAgo(1) }] })), 'APPROVED');
  assert.equal(
    deriveDecision(
      pr({
        reviews: [
          { login: 'bob', state: 'APPROVED', at: daysAgo(1) },
          { login: 'carol', state: 'CHANGES_REQUESTED', at: daysAgo(1) },
        ],
      }),
    ),
    'CHANGES_REQUESTED',
  );
  assert.equal(deriveDecision(pr({ reviewDecision: 'REVIEW_REQUIRED', reviews: [{ login: 'bob', state: 'APPROVED', at: daysAgo(1) }] })), 'REVIEW_REQUIRED', 'GitHub\'s own answer wins when it gives one');
});

test('the board honours snooze and notes from the log, and ignores done and dismiss', () => {
  const pulls = [
    pr({ id: 'github:pr:acme/webapp#1', number: 1 }),
    pr({ id: 'github:pr:acme/webapp#2', number: 2 }),
    pr({ id: 'github:pr:acme/webapp#3', number: 3 }),
    pr({ id: 'github:pr:acme/webapp#4', number: 4, isDraft: true }),
  ];
  const actions: Action[] = [
    { id: 'github:pr:acme/webapp#1', action: 'done', at: hoursAgo(1) },
    { id: 'github:pr:acme/webapp#2', action: 'dismiss', at: hoursAgo(1) },
    { id: 'GitHub:PR:acme/webapp#3', action: 'note', at: hoursAgo(1), text: 'Nudged reviewers' },
    { id: 'github:pr:acme/webapp#4', action: 'snooze', at: hoursAgo(1), until: '2026-10-01' },
  ];

  const rows = resolveBoard(pulls, actions, NOW);
  const byNumber = new Map(rows.map((row) => [row.number, row]));

  assert.equal(byNumber.get(1)?.status, 'open', 'done does not close an open PR');
  assert.equal(byNumber.get(2)?.status, 'open', 'dismiss does not either');
  assert.equal(byNumber.get(3)?.notes[0]?.text, 'Nudged reviewers');
  assert.equal(byNumber.get(3)?.nudge, false, 'the note reset the timer');
  assert.equal(byNumber.get(4)?.status, 'snoozed');
  assert.equal(byNumber.get(4)?.snoozedUntil, '2026-10-01');

  assert.deepEqual(countBoard(rows), { you: 0, ready: 0, reviewers: 3, draft: 0, parked: 1 });
});

test('an expired snooze reopens, and a dateless one parks indefinitely', () => {
  const pulls = [pr({ id: 'github:pr:acme/webapp#1', number: 1 }), pr({ id: 'github:pr:acme/webapp#2', number: 2 })];
  const actions: Action[] = [
    { id: 'github:pr:acme/webapp#1', action: 'snooze', at: daysAgo(3), until: '2026-09-14' },
    { id: 'github:pr:acme/webapp#2', action: 'snooze', at: daysAgo(3) },
  ];
  const rows = resolveBoard(pulls, actions, NOW);
  assert.equal(rows.find((row) => row.number === 1)?.status, 'open');
  assert.equal(rows.find((row) => row.number === 2)?.status, 'snoozed');
  assert.equal(rows.find((row) => row.number === 2)?.snoozedUntil, undefined);
});

test('rows come out by court, and longest wait first within one', () => {
  const rows = resolveBoard(
    [
      pr({ id: 'github:pr:acme/webapp#1', number: 1, isDraft: true }),
      pr({ id: 'github:pr:acme/webapp#2', number: 2, readyAt: daysAgo(1), lastActivityByYou: daysAgo(1) }),
      pr({ id: 'github:pr:acme/webapp#3', number: 3, readyAt: daysAgo(4), lastActivityByYou: daysAgo(4) }),
      pr({
        id: 'github:pr:acme/webapp#4',
        number: 4,
        reviewDecision: 'APPROVED',
        reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(2) }],
      }),
      pr({ id: 'github:pr:acme/webapp#5', number: 5, checks: 'failure' }),
    ],
    [],
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [row.number, row.court]),
    [
      [5, 'you'],
      [4, 'ready'],
      [3, 'reviewers'],
      [2, 'reviewers'],
      [1, 'draft'],
    ],
  );
});
