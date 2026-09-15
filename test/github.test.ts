import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildSearchQuery,
  isBot,
  isSamlError,
  mergeStatesFromNodes,
  normalizePullRequest,
  summarizeChecks,
  toMergeState,
  type RawPullRequest,
} from '../src/github.ts';

test('the search names the author and appends the scope verbatim', () => {
  assert.equal(buildSearchQuery([]), 'is:pr is:open archived:false author:@me');
  assert.equal(
    buildSearchQuery(['org:acme', 'repo:acme-labs/webapp']),
    'is:pr is:open archived:false author:@me org:acme repo:acme-labs/webapp',
  );
});

test('bots are recognised by type and by suffix, and a missing author counts as one', () => {
  assert.equal(isBot({ __typename: 'Bot', login: 'coverage' }), true);
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
        { author: { __typename: 'Bot', login: 'review-summary[bot]' }, state: 'COMMENTED', submittedAt: '2026-09-14T14:00:00Z' },
        { author: { __typename: 'User', login: 'bob' }, state: 'APPROVED', submittedAt: '2026-09-13T12:00:00Z' },
      ],
    },
    comments: {
      nodes: [
        { author: { __typename: 'User', login: 'Alice' }, createdAt: '2026-09-13T13:00:00Z' },
        { author: { __typename: 'Bot', login: 'coverage[bot]' }, createdAt: '2026-09-14T15:00:00Z' },
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
  // The search doesn't carry the merge state: it arrives from a second request
  // and is stitched on in `fetchPulls`. See `mergeStatesFromNodes`.
  assert.equal(pull.mergeStateStatus, null);
  assert.deepEqual(pull.pendingChecks, []);
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
  assert.deepEqual(lying, { checks: 'failure', failing: ['all-tests-green'], pending: [] });

  const running = summarizeChecks({
    state: 'SUCCESS',
    contexts: { nodes: [{ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null }] },
  });
  assert.deepEqual(running, {
    checks: 'pending',
    failing: [],
    pending: [{ name: 'e2e', kind: 'check-run', detailsUrl: null }],
  });

  const statusRed = summarizeChecks({
    state: 'PENDING',
    contexts: { nodes: [{ __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR' }] },
  });
  assert.deepEqual(statusRed, { checks: 'failure', failing: ['ci/deploy'], pending: [] });

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
  assert.deepEqual(mixed, { checks: 'failure', failing: ['flaky'], pending: [] });

  // Truncated contexts: the summary is still a floor.
  assert.deepEqual(summarizeChecks({ state: 'FAILURE', contexts: { nodes: [] } }), { checks: 'failure', failing: [], pending: [] });
  assert.deepEqual(summarizeChecks({ state: 'SUCCESS', contexts: { nodes: [] } }), { checks: 'success', failing: [], pending: [] });
  assert.deepEqual(summarizeChecks(null), { checks: null, failing: [], pending: [] });
});

test('the unfinished checks keep their names, kinds and links', () => {
  const { pending } = summarizeChecks({
    state: 'PENDING',
    contexts: {
      nodes: [
        {
          __typename: 'CheckRun',
          databaseId: 4821,
          name: 'policy/merge-gate',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: 'https://github.com/acme/webapp/runs/4821',
        },
        // STALE is neither a pass nor a fail, so it is still outstanding.
        { __typename: 'CheckRun', name: 'flaky-suite', status: 'COMPLETED', conclusion: 'STALE' },
        { __typename: 'StatusContext', context: 'ci/deploy', state: 'PENDING', targetUrl: 'https://ci.example.com/42' },
        { __typename: 'StatusContext', context: 'ci/queued', state: 'EXPECTED' },
        // Neither of these is waiting on anything, so neither is listed.
        { __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/lint', state: 'FAILURE' },
      ],
    },
  });
  assert.deepEqual(pending, [
    { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/4821', checkRunId: 4821 },
    { name: 'flaky-suite', kind: 'check-run', detailsUrl: null },
    { name: 'ci/deploy', kind: 'status-context', detailsUrl: 'https://ci.example.com/42' },
    { name: 'ci/queued', kind: 'status-context', detailsUrl: null },
  ]);
});

test('a details link that is not http(s) is dropped rather than rendered', () => {
  const { pending } = summarizeChecks({
    state: 'PENDING',
    contexts: {
      nodes: [{ __typename: 'CheckRun', name: 'policy/merge-gate', status: 'QUEUED', detailsUrl: 'javascript:alert(1)' }],
    },
  });
  assert.equal(pending[0]?.detailsUrl, null);
});

test('the merge state is normalised, and missing is not the same as unknown', () => {
  for (const state of ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'] as const) {
    assert.equal(toMergeState(state), state);
  }
  // Anything GitHub adds later must not be mistaken for a clean merge.
  assert.equal(toMergeState('MERGE_QUEUED'), 'UNKNOWN');
  assert.equal(toMergeState('clean'), 'UNKNOWN', 'GitHub shouts its enums; a lowercase one is not one we know');
  // Nobody said, which is a different answer from "GitHub hasn't worked it out".
  assert.equal(toMergeState(null), null);
  assert.equal(toMergeState(undefined), null);
  assert.equal(toMergeState(''), null);

});

test('the merge-state reply is read by node id, and one odd node costs only itself', () => {
  const states = mergeStatesFromNodes([
    { id: 'PR_kwaaa', mergeStateStatus: 'BLOCKED' },
    { id: 'PR_kwbbb', mergeStateStatus: 'CLEAN' },
    // GitHub adding to the enum must not read as a clean merge.
    { id: 'PR_kwccc', mergeStateStatus: 'MERGE_QUEUED' },
    // A node it declined to answer for: null, which falls back to the older reading.
    { id: 'PR_kwddd', mergeStateStatus: null },
    { id: 'PR_kweee' },
    // Junk, each entry paying for itself.
    { mergeStateStatus: 'CLEAN' },
    { id: '', mergeStateStatus: 'CLEAN' },
    null,
    undefined,
  ]);
  assert.deepEqual(
    [...states.entries()],
    [
      ['PR_kwaaa', 'BLOCKED'],
      ['PR_kwbbb', 'CLEAN'],
      ['PR_kwccc', 'UNKNOWN'],
      ['PR_kwddd', null],
      ['PR_kweee', null],
    ],
  );
  assert.deepEqual([...mergeStatesFromNodes([]).entries()], []);
});

test('the search asks for a page it can be answered in, and names the node id', async () => {
  // A page of fifty of these pull requests has been measured past the gateway's
  // ten-second patience, and `mergeStateStatus` in the same request pushes it over
  // for certain. Both are load-bearing, so both are asserted rather than trusted.
  const source = await readFile(resolve(import.meta.dirname, '../src/github.ts'), 'utf8');
  const pageSize = /const PAGE_SIZE = (\d+);/.exec(source);
  assert.ok(pageSize && Number(pageSize[1]) <= 25, 'the search page must stay small enough to be answered');

  const search = /const SEARCH_QUERY = `([^`]+)`/.exec(source);
  assert.ok(search, 'SEARCH_QUERY is no longer declared where this test looks');
  assert.ok(search[1]!.includes('statusCheckRollup'), 'the search still carries the check rollup');
  assert.ok(!search[1]!.includes('mergeStateStatus'), 'mergeStateStatus must not rejoin the search request');
  assert.ok(/^\s+id$/m.test(search[1]!), 'the search needs the node id to join the merge states on');

  const mergeState = /const MERGE_STATE_QUERY = `([^`]+)`/.exec(source);
  assert.ok(mergeState, 'MERGE_STATE_QUERY is no longer declared where this test looks');
  assert.ok(mergeState[1]!.includes('mergeStateStatus'), 'the second request is what asks for the merge state');
  assert.ok(!mergeState[1]!.includes('statusCheckRollup'), 'and it asks for nothing else');
});

test('the pending checks reach the pull request the board keeps', () => {
  const pull = normalizePullRequest(
    node({
      commits: {
        nodes: [
          {
            commit: {
              committedDate: '2026-09-12T10:00:00Z',
              statusCheckRollup: {
                state: 'PENDING',
                contexts: {
                  nodes: [
                    { __typename: 'CheckRun', name: 'policy/merge-gate', status: 'QUEUED', conclusion: null },
                    { __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
                  ],
                },
              },
            },
          },
        ],
      },
    }),
    'alice',
  );
  assert.equal(pull?.checks, 'pending');
  assert.deepEqual(pull?.pendingChecks, [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }]);
  assert.deepEqual(pull?.failingChecks, []);
});

test('a comment never withdraws a verdict; a dismissal does', () => {
  const pull = normalizePullRequest(
    node({
      reviewDecision: null,
      reviews: {
        nodes: [
          { author: { __typename: 'User', login: 'bob' }, state: 'APPROVED', submittedAt: '2026-09-12T10:00:00Z' },
          { author: { __typename: 'User', login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-09-12T11:00:00Z' },
          { author: { __typename: 'User', login: 'carol' }, state: 'COMMENTED', submittedAt: '2026-09-12T12:00:00Z' },
          { author: { __typename: 'User', login: 'dave' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-12T13:00:00Z' },
          { author: { __typename: 'User', login: 'dave' }, state: 'DISMISSED', submittedAt: '2026-09-12T14:00:00Z' },
        ],
      },
      comments: { nodes: [] },
    }),
    'alice',
  );
  assert.deepEqual(pull?.reviews, [
    { login: 'bob', state: 'APPROVED', at: '2026-09-12T10:00:00Z' },
    { login: 'carol', state: 'COMMENTED', at: '2026-09-12T12:00:00Z' },
  ]);
  assert.deepEqual(pull?.lastActivityByOthers, { at: '2026-09-12T14:00:00Z', login: 'dave', kind: 'review' }, 'every review is still activity');
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
  assert.deepEqual(none?.pendingChecks, []);
});

test('a node that is not a pull request is dropped rather than thrown on', () => {
  assert.equal(normalizePullRequest({}, 'alice'), null);
  assert.equal(normalizePullRequest({ number: 1, title: 'x' }, 'alice'), null);
});
