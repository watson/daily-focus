import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSearchQuery, isBot, isSamlError, normalizePullRequest, type RawPullRequest } from '../src/github.ts';

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
    commits: { nodes: [{ commit: { committedDate: '2026-09-12T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] },
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
});

test('a node that is not a pull request is dropped rather than thrown on', () => {
  assert.equal(normalizePullRequest({}, 'alice'), null);
  assert.equal(normalizePullRequest({ number: 1, title: 'x' }, 'alice'), null);
});
