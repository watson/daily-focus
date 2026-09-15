import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSearchQuery, isBot, isSamlError, normalizePullRequest, summarizeChecks, type RawPullRequest } from '../src/github.ts';

test('the search names the author and appends the scope verbatim', () => {
  assert.equal(buildSearchQuery([]), 'is:pr is:open archived:false author:@me');
  assert.equal(
    buildSearchQuery(['org:acme', 'repo:acme-labs/webapp']),
    'is:pr is:open archived:false author:@me org:acme repo:acme-labs/webapp',
  );
});

test('bots are recognised by type and by suffix, and a missing author counts as one', () => {
  assert.equal(isBot({ __typename: 'Bot', login: 'codecov' }), true);
  assert.equal(isBot({ __typename: 'User', login: 'pr-commenter[bot]' }), true);
  assert.equal(isBot({ __typename: 'User', login: 'alice' }), false);
  assert.equal(isBot(null), true);
});

test('SAML refusals are recognised by extension or by message', () => {
  assert.equal(isSamlError({ message: 'x', extensions: { saml_failure: true } }), true);
  assert.equal(isSamlError({ message: 'Resource protected by organization SAML enforcement.' }), true);
  assert.equal(isSamlError({ message: 'Could not resolve to an Organization', type: 'NOT_FOUND' }), false);
});

/** A search node the way GitHub returns one, for an invented repo. */
function node(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 3421,
    title: 'Fix session replay memory leak',
    url: 'https://github.com/acme/webapp/pull/3421',
    isDraft: false,
    createdAt: '2026-09-10T09:00:00Z',
    updatedAt: '2026-09-14T15:00:00Z',
    headRefName: 'alice/fix-leak',
    baseRefName: 'main',
    repository: { nameWithOwner: 'acme/webapp' },
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    autoMergeRequest: null,
    commits: {
      nodes: [
        {
          commit: {
            committedDate: '2026-09-12T10:00:00Z',
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: { nodes: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
            },
          },
        },
      ],
    },
    readyEvents: { nodes: [{ createdAt: '2026-09-11T08:00:00Z' }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob' } }, { requestedReviewer: { __typename: 'Team', slug: 'webapp-owners' } }] },
    reviews: {
      nodes: [
        { author: { __typename: 'User', login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-12T12:00:00Z' },
        { author: { __typename: 'Bot', login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', submittedAt: '2026-09-14T14:00:00Z' },
        { author: { __typename: 'User', login: 'bob' }, state: 'APPROVED', submittedAt: '2026-09-13T12:00:00Z' },
      ],
    },
    comments: {
      nodes: [
        { author: { __typename: 'User', login: 'Alice' }, createdAt: '2026-09-13T13:00:00Z' },
        { author: { __typename: 'Bot', login: 'codecov[bot]' }, createdAt: '2026-09-14T15:00:00Z' },
      ],
    },
    ...overrides,
  };
}

test('a search node becomes the facts the board keeps', () => {
  const pull = normalizePullRequest(node(), 'alice');
  assert.ok(pull);
  assert.equal(pull.id, 'github:pr:acme/webapp#3421');
  assert.equal(pull.repo, 'acme/webapp');
  assert.equal(pull.readyAt, '2026-09-11T08:00:00Z', 'the ready-for-review event, not creation');
  assert.equal(pull.checks, 'success');
  assert.equal(pull.mergeable, 'MERGEABLE');
  assert.equal(pull.autoMerge, false);
  assert.deepEqual(pull.requestedReviewers, ['bob', 'webapp-owners']);
  assert.deepEqual(pull.reviews, [{ login: 'bob', state: 'APPROVED', at: '2026-09-13T12:00:00Z' }], 'latest review per person');
  assert.equal(pull.lastActivityByYou, '2026-09-13T13:00:00Z', 'your own comment, matched case-insensitively');
  assert.deepEqual(pull.lastActivityByOthers, { at: '2026-09-13T12:00:00Z', login: 'bob', kind: 'review' }, 'bots ignored');
});

test('the individual checks outrank the rollup summary, and the failing ones are named', () => {
  // Seen in the wild: the summary said SUCCESS while a required check was FAILURE.
  const lying = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      nodes: [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'all-tests-green', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' },
      ],
    },
  });
  assert.deepEqual(lying, { checks: 'failure', failing: ['all-tests-green'] });

  const running = summarizeChecks({
    state: 'SUCCESS',
    contexts: { nodes: [{ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null }] },
  });
  assert.deepEqual(running, { checks: 'pending', failing: [] });

  const statusRed = summarizeChecks({
    state: 'PENDING',
    contexts: { nodes: [{ __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR' }] },
  });
  assert.deepEqual(statusRed, { checks: 'failure', failing: ['ci/deploy'] });

  // Cancelled and timed out are red, the way `gh pr checks` reads them; skipped and neutral are not.
  const mixed = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      nodes: [
        { __typename: 'CheckRun', name: 'flaky', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', name: 'advice', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ],
    },
  });
  assert.deepEqual(mixed, { checks: 'failure', failing: ['flaky'] });

  // Truncated contexts: the summary is still a floor.
  assert.deepEqual(summarizeChecks({ state: 'FAILURE', contexts: { nodes: [] } }), { checks: 'failure', failing: [] });
  assert.deepEqual(summarizeChecks({ state: 'SUCCESS', contexts: { nodes: [] } }), { checks: 'success', failing: [] });
  assert.deepEqual(summarizeChecks(null), { checks: null, failing: [] });
});

test('a draft is ready-at its creation, and the rollup collapses to three states', () => {
  const draft = normalizePullRequest(node({ isDraft: true, readyEvents: { nodes: [] } }), 'alice');
  assert.equal(draft?.isDraft, true);
  assert.equal(draft?.readyAt, '2026-09-10T09:00:00Z');

  for (const [state, expected] of [
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['SUCCESS', 'success'],
  ] as const) {
    const pull = normalizePullRequest(node({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } }), 'alice');
    assert.equal(pull?.checks, expected, state);
  }
  const none = normalizePullRequest(node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), 'alice');
  assert.equal(none?.checks, null);
  assert.deepEqual(none?.failingChecks, []);
});

test('a node that is not a pull request is dropped rather than thrown on', () => {
  assert.equal(normalizePullRequest({}, 'alice'), null);
  assert.equal(normalizePullRequest({ number: 1, title: 'x' }, 'alice'), null);
});
