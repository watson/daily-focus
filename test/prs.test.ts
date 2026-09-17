import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NUDGE_AFTER_MS, STALE_DRAFT_AFTER_MS, countBoard, deriveDecision, judge, resolveBoard } from '../src/prs.ts';
import type { Action, PendingCheck, PullRequest } from '../src/types.ts';

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
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    lastActivityByYou: daysAgo(2),
    lastActivityByOthers: null,
    ...overrides,
  };
}

/**
 * Invented check names throughout: `policy/merge-gate` stands in for whatever
 * aggregate merge-policy check a real repository uses, and nothing in this repo
 * may name a real one.
 */
function pending(name: string, extra: Partial<PendingCheck> = {}): PendingCheck {
  return { name, kind: 'check-run', detailsUrl: null, ...extra };
}

/** An approved PR, since most of the merge-state rules only bite once it is. */
function approved(overrides: Partial<PullRequest> = {}): PullRequest {
  return pr({
    reviewDecision: 'APPROVED',
    reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
    lastActivityByOthers: { at: hoursAgo(6), login: 'bob', kind: 'review' },
    ...overrides,
  });
}

const GATES = ['policy/merge-gate', 'repository-policy'];

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
  assert.deepEqual(red.reasons, [{ kind: 'ci-failing' }]);

  const conflicting = judge(pr({ mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' }), NOW, null);
  assert.equal(conflicting.court, 'you', 'approved but conflicting is still yours to fix');
  assert.equal(conflicting.decision, 'APPROVED', 'the decision is reported as GitHub gave it');
  assert.deepEqual(conflicting.reasons, [{ kind: 'conflicts' }]);
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

test('a red draft stays a draft, with no reasons', () => {
  const verdict = judge(pr({ isDraft: true, checks: 'failure', mergeable: 'CONFLICTING' }), NOW, null);
  assert.equal(verdict.court, 'draft');
  assert.deepEqual(verdict.reasons, []);
});

test('an inline review comment after the approval counts the same as a comment', () => {
  const verdict = judge(
    pr({
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
      lastActivityByOthers: { at: hoursAgo(1), login: 'carol', kind: 'review' },
    }),
    NOW,
    null,
  );
  assert.equal(verdict.court, 'you');
  assert.deepEqual(verdict.reasons, [{ kind: 'activity', login: 'carol', at: hoursAgo(1), activity: 'review' }]);
});

test('a pull read back without optional keys is judged, not thrown on', () => {
  const partial = { ...pr(), lastActivityByOthers: undefined, lastActivityByYou: undefined } as unknown as PullRequest;
  assert.equal(judge(partial, NOW, null).court, 'reviewers');
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
  assert.equal(byNumber.get(1)?.decision, null);
  assert.equal(byNumber.get(4)?.status, 'snoozed');
  assert.equal(byNumber.get(4)?.snoozedUntil, '2026-10-01');

  assert.deepEqual(countBoard(rows), { you: 0, ready: 0, reviewers: 3, gate: 0, blocked: 0, checks: 0, draft: 0, parked: 1 });
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
      approved({
        id: 'github:pr:acme/webapp#6',
        number: 6,
        mergeStateStatus: 'BLOCKED',
        checks: 'pending',
        pendingChecks: [pending('policy/merge-gate')],
      }),
      approved({
        id: 'github:pr:acme/webapp#7',
        number: 7,
        mergeStateStatus: 'UNSTABLE',
        checks: 'pending',
        pendingChecks: [pending('integration-tests')],
      }),
      approved({
        id: 'github:pr:acme/webapp#8',
        number: 8,
        mergeStateStatus: 'BLOCKED',
      }),
    ],
    [],
    NOW,
    GATES,
  );
  assert.deepEqual(
    rows.map((row) => [row.number, row.court]),
    [
      [5, 'you'],
      [4, 'ready'],
      [3, 'reviewers'],
      [2, 'reviewers'],
      [6, 'gate'],
      [8, 'blocked'],
      [7, 'checks'],
      [1, 'draft'],
    ],
  );
});

/* ---------- the merge gate, and GitHub's own merge state ---------- */

test('a configured pending gate is its own court, and never ready', () => {
  const gated = approved({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [pending('policy/merge-gate', { detailsUrl: 'https://github.com/acme/webapp/runs/9', checkRunId: 9 })],
  });

  const verdict = judge(gated, NOW, null, GATES);
  assert.equal(verdict.court, 'gate');
  assert.deepEqual(verdict.reasons, [
    {
      kind: 'merge-gate',
      checks: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/9', checkRunId: 9 }],
    },
  ]);
  assert.equal(verdict.nudge, false, 'nobody knows who to nudge about a gate');
  assert.equal(verdict.since, daysAgo(2), 'the wait runs from your last push, as for any check');

  // The same pull request with nothing configured: the gate is just a check.
  assert.equal(judge(gated, NOW, null).court, 'checks');
  assert.equal(judge(gated, NOW, null, []).court, 'checks');
});

test('a merge queue dropping an entry whose gate never cleared stays the gate\'s business', () => {
  // The whole shape as GitHub reports it, verified against a real pull request:
  // approved by branch protection, no conflict, BLOCKED, the gate still in
  // progress, and the queue's own check cancelled once it gave up waiting. The
  // cancellation is the *consequence* of the pending gate, so a court derived from
  // it would blame the author for the one thing they cannot act on.
  const unqueued = approved({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [pending('policy/merge-gate')],
    cancelledChecks: [pending('policy/merge')],
  });

  const verdict = judge(unqueued, NOW, null, GATES);
  assert.equal(verdict.court, 'gate');
  assert.deepEqual(verdict.reasons, [
    { kind: 'merge-gate', checks: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }] },
  ]);

  // Nothing configured: still a check wait rather than the author's move.
  assert.equal(judge(unqueued, NOW, null).court, 'checks');

  // `judge` reads the cancellations nowhere at all — they are shown on the row and
  // decide nothing, which is what makes them safe to carry. Adding one to an
  // otherwise ready pull request must not move it.
  const ready = approved({ cancelledChecks: [pending('policy/merge')] });
  assert.equal(judge(ready, NOW, null, GATES).court, 'ready');

  // And a real failure alongside one is still a real failure: the author's court
  // comes from the failing check, with no special case for what sits beside it.
  const red = approved({ checks: 'failure', failingChecks: ['unit-tests'], cancelledChecks: [pending('policy/merge')] });
  const verdictRed = judge(red, NOW, null, GATES);
  assert.equal(verdictRed.court, 'you');
  assert.deepEqual(verdictRed.reasons, [{ kind: 'ci-failing' }]);
});

test('a configured pending gate outranks a merge state GitHub briefly calls clean', () => {
  const racing = approved({ mergeStateStatus: 'CLEAN', pendingChecks: [pending('repository-policy')] });
  assert.equal(judge(racing, NOW, null, GATES).court, 'gate');
  assert.equal(judge(racing, NOW, null).court, 'ready', 'without the configuration, a clean state is still ready');
});

test('gate names are matched exactly and case-sensitively', () => {
  for (const name of ['Policy/Merge-Gate', 'policy/merge-gate ', 'policy/merge', 'merge-gate']) {
    const near = approved({ mergeStateStatus: 'BLOCKED', pendingChecks: [pending(name)] });
    assert.equal(judge(near, NOW, null, GATES).court, 'checks', name);
  }
  // A name with spaces is one name, and matches as one.
  const spaced = approved({ mergeStateStatus: 'BLOCKED', pendingChecks: [pending('merge policy decision')] });
  assert.equal(judge(spaced, NOW, null, ['merge policy decision']).court, 'gate');
});

test('an unconfigured pending check is an ordinary check wait, and names itself', () => {
  const verdict = judge(
    approved({ mergeStateStatus: 'BLOCKED', checks: 'pending', pendingChecks: [pending('integration-tests')] }),
    NOW,
    null,
    GATES,
  );
  assert.equal(verdict.court, 'checks');
  assert.deepEqual(verdict.reasons, [
    { kind: 'checks-pending', checks: [{ name: 'integration-tests', kind: 'check-run', detailsUrl: null }] },
  ]);
  assert.equal(verdict.nudge, false);
});

test('blocked with no pending context returned says only what GitHub said', () => {
  const verdict = judge(approved({ mergeStateStatus: 'BLOCKED' }), NOW, null, GATES);
  assert.equal(verdict.court, 'blocked');
  assert.deepEqual(verdict.reasons, [{ kind: 'merge-blocked' }]);
});

test('outstanding review requests never hold back a clean, approved pull request', () => {
  const verdict = judge(
    approved({ mergeStateStatus: 'CLEAN', requestedReviewers: ['carol', 'dave', 'webapp-owners'] }),
    NOW,
    null,
    GATES,
  );
  assert.equal(verdict.court, 'ready', 'GitHub keeps asking long after the required approvals land');
});

test('a review GitHub still requires outranks a gate and every other check', () => {
  const verdict = judge(
    pr({
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED',
      checks: 'pending',
      pendingChecks: [pending('policy/merge-gate')],
      requestedReviewers: ['carol', 'dave', 'webapp-owners'],
      readyAt: daysAgo(2),
      lastActivityByYou: daysAgo(2),
    }),
    NOW,
    null,
    GATES,
  );
  assert.equal(verdict.court, 'reviewers', 'an approval is the one thing a person can go and get');
  assert.equal(verdict.nudge, true);
});

test('a failed check or a conflict still outranks the merge state', () => {
  const red = judge(approved({ mergeStateStatus: 'BLOCKED', checks: 'failure', failingChecks: ['unit-tests'], pendingChecks: [pending('policy/merge-gate')] }), NOW, null, GATES);
  assert.equal(red.court, 'you');
  assert.deepEqual(red.reasons, [{ kind: 'ci-failing' }]);

  const conflicting = judge(approved({ mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED', pendingChecks: [pending('policy/merge-gate')] }), NOW, null, GATES);
  assert.equal(conflicting.court, 'you');
  assert.deepEqual(conflicting.reasons, [{ kind: 'conflicts' }]);
});

test('behind, dirty and unknown merge states each land where they belong', () => {
  const behind = judge(approved({ mergeStateStatus: 'BEHIND' }), NOW, null, GATES);
  assert.equal(behind.court, 'you', 'nobody else can press update-branch for you');
  assert.deepEqual(behind.reasons, [{ kind: 'behind' }]);

  // DIRTY is GitHub's own word for the conflict `mergeable` reports: one reason, not two.
  const dirty = judge(approved({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), NOW, null, GATES);
  assert.equal(dirty.court, 'you');
  assert.deepEqual(dirty.reasons, [{ kind: 'conflicts' }]);
  const both = judge(approved({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), NOW, null, GATES);
  assert.deepEqual(both.reasons, [{ kind: 'conflicts' }]);

  const unsure = judge(approved({ mergeStateStatus: 'UNKNOWN' }), NOW, null, GATES);
  assert.equal(unsure.court, 'checks', 'not worked out is not the same as fine');
  assert.deepEqual(unsure.reasons, [{ kind: 'mergeability-unknown' }]);

  assert.equal(judge(approved({ mergeStateStatus: 'HAS_HOOKS' }), NOW, null, GATES).court, 'ready');
  assert.equal(judge(approved({ mergeStateStatus: 'UNSTABLE' }), NOW, null, GATES).court, 'checks');
});

test('a cache from before the merge state existed keeps the old reading, but only when quiet', () => {
  // `mergeStateStatus` and `pendingChecks` absent entirely, as an older prs.json has them.
  const legacy = (overrides: Partial<PullRequest> = {}) => {
    const { mergeStateStatus: _gone, pendingChecks: _also, ...rest } = approved(overrides);
    return rest as unknown as PullRequest;
  };

  assert.equal(judge(legacy(), NOW, null, GATES).court, 'ready', 'approved, green and quiet is still ready');

  const running = judge(legacy({ checks: 'pending' }), NOW, null, GATES);
  assert.equal(running.court, 'checks', 'a refresh will say whether that check blocks the merge');
  assert.deepEqual(running.reasons, [{ kind: 'checks-pending' }]);

  // A legacy file can still carry a gate if it was written after pendingChecks arrived.
  const gated = { ...legacy(), pendingChecks: [pending('policy/merge-gate')] } as PullRequest;
  assert.equal(judge(gated, NOW, null, GATES).court, 'gate');
  assert.equal(judge(legacy({ mergeable: 'CONFLICTING' }), NOW, null, GATES).court, 'you');
  assert.equal(judge(legacy({ reviewDecision: null, reviews: [], lastActivityByOthers: null }), NOW, null, GATES).court, 'reviewers');
});

test('the counts cover every court the board can render', () => {
  const rows = resolveBoard(
    [
      pr({ id: 'github:pr:acme/webapp#1', number: 1, checks: 'failure' }),
      approved({ id: 'github:pr:acme/webapp#2', number: 2 }),
      pr({ id: 'github:pr:acme/webapp#3', number: 3 }),
      approved({ id: 'github:pr:acme/webapp#4', number: 4, mergeStateStatus: 'BLOCKED', pendingChecks: [pending('policy/merge-gate')] }),
      approved({ id: 'github:pr:acme/webapp#5', number: 5, mergeStateStatus: 'UNSTABLE', pendingChecks: [pending('e2e')] }),
      pr({ id: 'github:pr:acme/webapp#6', number: 6, isDraft: true }),
      approved({ id: 'github:pr:acme/webapp#7', number: 7, mergeStateStatus: 'BLOCKED' }),
    ],
    [],
    NOW,
    GATES,
  );
  assert.deepEqual(countBoard(rows), { you: 1, ready: 1, reviewers: 1, gate: 1, blocked: 1, checks: 1, draft: 1, parked: 0 });
});
