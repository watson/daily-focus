import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildRemainingChecksQuery,
  buildSearchQuery,
  isBot,
  isSamlError,
  mergeStatesFromNodes,
  normalizePullRequest,
  rollupTruncated,
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
  assert.deepEqual(lying, { checks: 'failure', failing: ['all-tests-green'], pending: [], cancelled: [] });

  const running = summarizeChecks({
    state: 'SUCCESS',
    contexts: { nodes: [{ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null }] },
  });
  assert.deepEqual(running, {
    checks: 'pending',
    failing: [],
    pending: [{ name: 'e2e', kind: 'check-run', detailsUrl: null }],
    cancelled: [],
  });

  const statusRed = summarizeChecks({
    state: 'PENDING',
    contexts: { nodes: [{ __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR' }] },
  });
  assert.deepEqual(statusRed, { checks: 'failure', failing: ['ci/deploy'], pending: [], cancelled: [] });

  // Timed out is red; skipped and neutral are not. Cancelled is none of the three.
  const mixed = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      totalCount: 4,
      nodes: [
        { __typename: 'CheckRun', name: 'slow', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        { __typename: 'CheckRun', name: 'flaky', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', name: 'advice', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ],
    },
  });
  assert.deepEqual(mixed, {
    checks: 'failure',
    failing: ['slow'],
    pending: [],
    cancelled: [{ name: 'flaky', kind: 'check-run', detailsUrl: null }],
  });

  // No contexts at all: the summary is all there is, in either direction.
  assert.deepEqual(summarizeChecks({ state: 'FAILURE', contexts: { nodes: [] } }), { checks: 'failure', failing: [], pending: [], cancelled: [] });
  assert.deepEqual(summarizeChecks({ state: 'SUCCESS', contexts: { nodes: [] } }), { checks: 'success', failing: [], pending: [], cancelled: [] });
  assert.deepEqual(summarizeChecks(null), { checks: null, failing: [], pending: [], cancelled: [] });
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

test('the three requests stay split, and each asks for only its own half', async () => {
  // A page of fifty of these pull requests has been measured past the gateway's
  // ten-second patience; `mergeStateStatus` in the same request pushes it over for
  // certain, and so does a hundred check contexts per pull — 380 KB and eight to
  // ten seconds, against 28 KB and under four without them. All three are
  // load-bearing, so the split is asserted rather than trusted.
  const source = await readFile(resolve(import.meta.dirname, '../src/github.ts'), 'utf8');
  const pageSize = /const PAGE_SIZE = (\d+);/.exec(source);
  assert.ok(pageSize && Number(pageSize[1]) <= 25, 'the search page must stay small enough to be answered');
  const batch = /const CHECKS_BATCH_SIZE = (\d+);/.exec(source);
  assert.ok(batch && Number(batch[1]) <= 12, 'a checks batch past twelve is the payload the search just shed');

  const search = /const SEARCH_QUERY = `([^`]+)`/.exec(source);
  assert.ok(search, 'SEARCH_QUERY is no longer declared where this test looks');
  assert.ok(!search[1]!.includes('statusCheckRollup'), 'the check rollup must not rejoin the search request');
  assert.ok(!search[1]!.includes('mergeStateStatus'), 'mergeStateStatus must not rejoin the search request');
  assert.ok(/^\s+id$/m.test(search[1]!), 'the search needs the node id to join the other two requests on');

  const mergeState = /const MERGE_STATE_QUERY = `([^`]+)`/.exec(source);
  assert.ok(mergeState, 'MERGE_STATE_QUERY is no longer declared where this test looks');
  assert.ok(mergeState[1]!.includes('mergeStateStatus'), 'the second request is what asks for the merge state');
  assert.ok(!mergeState[1]!.includes('statusCheckRollup'), 'and it asks for nothing else');

  const checks = /const CHECKS_QUERY = `([^`]+)`/.exec(source);
  assert.ok(checks, 'CHECKS_QUERY is no longer declared where this test looks');
  assert.ok(checks[1]!.includes('statusCheckRollup'), 'the third request is what asks for the checks');
  assert.ok(!checks[1]!.includes('mergeStateStatus'), 'and it asks for nothing else');
  assert.ok(/^\s+id$/m.test(checks[1]!), 'the checks have to be joined back to the pulls by node id');

  // The walk past the first page needs a cursor, and the reading needs the
  // provenance: trim `workflowRun` out of the selection and `latestChecks` stops
  // telling a re-run from a live check without anything failing to say so.
  const contexts = /const CHECK_CONTEXTS = `([^`]+)`/.exec(source);
  assert.ok(contexts, 'CHECK_CONTEXTS is no longer declared where this test looks');
  for (const field of ['pageInfo', 'endCursor', 'totalCount', 'runNumber', 'runAttempt', 'workflow']) {
    assert.ok(contexts[1]!.includes(field), `the checks selection must keep asking for ${field}`);
  }
  // The walk builds its own request, since each pull request resumes from its own
  // cursor and `nodes(ids: [...])` takes one argument list for all of them.
  const walk = buildRemainingChecksQuery([
    { id: 'PR_kwaaa', cursor: 'Y3Vyc29yOjEwMA==' },
    { id: 'PR_kwbbb', cursor: null },
  ]);
  assert.match(walk, /w0: node\(id: "PR_kwaaa"\)/, 'each pull request is asked for under its own alias');
  assert.match(walk, /w1: node\(id: "PR_kwbbb"\)/);
  assert.match(walk, /after: "Y3Vyc29yOjEwMA=="/, 'and resumes from its own cursor rather than starting over');
  assert.match(walk, /after: null/, 'a pull request with no cursor yet starts at the beginning');
  assert.ok(walk.includes('statusCheckRollup'), 'the walk reads checks and nothing else');
  assert.ok(!walk.includes('reviews'), 'the walk reads checks and nothing else');
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

test('a cancelled check is neither red nor running, and the summary cannot overrule it', () => {
  // The shape a merge queue leaves behind: the queue dropped the entry because its
  // gate never cleared, which GitHub reports as a cancelled check run alongside the
  // gate still in progress — and summarises as FAILURE. Treating that summary, or
  // the cancellation, as red is what put such a pull request in the author's court.
  const unqueued = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      totalCount: 3,
      nodes: [
        { __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'policy/merge', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/acme/webapp/runs/1' },
        { __typename: 'CheckRun', name: 'policy/merge-gate', status: 'IN_PROGRESS', conclusion: null },
      ],
    },
  });
  assert.deepEqual(unqueued, {
    checks: 'pending',
    failing: [],
    pending: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }],
    cancelled: [{ name: 'policy/merge', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/1' }],
  });

  // Truncated past the hundred asked for: the contexts can't answer, so the
  // summary is a floor again and the same cancellation reads as red.
  const truncated = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      totalCount: 140,
      nodes: [{ __typename: 'CheckRun', name: 'policy/merge', status: 'COMPLETED', conclusion: 'CANCELLED' }],
    },
  });
  assert.equal(truncated.checks, 'failure');
  assert.deepEqual(truncated.failing, [], 'nothing invents a name for what was never read');

  // A caller that gave no totalCount is telling us nothing, not telling us there
  // is more, so the checks in hand still have the last word.
  const untold = summarizeChecks({
    state: 'FAILURE',
    contexts: { nodes: [{ __typename: 'CheckRun', name: 'policy/merge', status: 'COMPLETED', conclusion: 'CANCELLED' }] },
  });
  assert.equal(untold.checks, null, 'a lone cancellation says nothing either way');
});

test('a re-run supersedes the run it replaced, so a fixed check stops reading red', () => {
  // The shape that put a green pull request in the author's court: a check that
  // fails, is fixed without a push — a title edit re-triggering the workflow —
  // and re-runs green. GitHub keeps both runs on the commit, in separate check
  // suites, so the dead one is still there to be read.
  const title = { id: 'W_title' };
  const refixed = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      totalCount: 3,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { app: { id: 'A_actions' }, workflowRun: { runNumber: 6020, runAttempt: 1, workflow: title } },
        },
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { app: { id: 'A_actions' }, workflowRun: { runNumber: 6022, runAttempt: 1, workflow: title } },
        },
        { __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    },
  });
  assert.deepEqual(refixed, { checks: 'success', failing: [], pending: [], cancelled: [] });

  // Order in the page is not the order of the runs, so the reading cannot depend
  // on the newest arriving last.
  const reversed = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { workflowRun: { runNumber: 6022, runAttempt: 1, workflow: title } },
        },
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { workflowRun: { runNumber: 6020, runAttempt: 1, workflow: title } },
        },
      ],
    },
  });
  assert.equal(reversed.checks, 'success');

  // A later attempt of one run supersedes the earlier attempt the same way.
  const retried = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'flaky-suite',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { workflowRun: { runNumber: 88, runAttempt: 1, workflow: { id: 'W_tests' } } },
        },
        {
          __typename: 'CheckRun',
          name: 'flaky-suite',
          status: 'IN_PROGRESS',
          conclusion: null,
          checkSuite: { workflowRun: { runNumber: 88, runAttempt: 2, workflow: { id: 'W_tests' } } },
        },
      ],
    },
  });
  assert.deepEqual(retried, {
    checks: 'pending',
    failing: [],
    pending: [{ name: 'flaky-suite', kind: 'check-run', detailsUrl: null }],
    cancelled: [],
  });
});

test('only a re-run of the same workflow supersedes: matrix twins and other workflows are live', () => {
  // A matrix can give two jobs of one workflow run the same display name, and
  // both are live. Collapsing them by name would hide the failing one behind the
  // pass — the opposite mistake to the one supersession fixes, and the worse of
  // the two.
  const integrations = { id: 'W_integrations' };
  const twins = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'store (node-22)',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { workflowRun: { runNumber: 4100, runAttempt: 1, workflow: integrations } },
        },
        {
          __typename: 'CheckRun',
          name: 'store (node-22)',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { workflowRun: { runNumber: 4100, runAttempt: 1, workflow: integrations } },
        },
      ],
    },
  });
  assert.deepEqual(twins, { checks: 'failure', failing: ['store (node-22)'], pending: [], cancelled: [] });

  // Two different workflows that happen to name a job the same thing are two
  // checks, not one superseding the other, however far apart their run numbers.
  const namesakes = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { workflowRun: { runNumber: 9000, runAttempt: 1, workflow: { id: 'W_release' } } },
        },
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'IN_PROGRESS',
          conclusion: null,
          checkSuite: { workflowRun: { runNumber: 12, runAttempt: 1, workflow: { id: 'W_nightly' } } },
        },
      ],
    },
  });
  assert.deepEqual(namesakes.pending, [{ name: 'build', kind: 'check-run', detailsUrl: null }]);
  assert.equal(namesakes.checks, 'pending', 'the older run number is a different workflow, not a superseded run');

  // Nothing said about where either came from is not evidence of supersession, so
  // both are kept and the fixtures that predate the field read as they did.
  const anonymous = summarizeChecks({
    state: 'SUCCESS',
    contexts: {
      nodes: [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    },
  });
  assert.deepEqual(anonymous.failing, ['lint']);
});

test('a re-posted commit status counts once, at its newest', () => {
  // Statuses have no run number; their own clock is all there is to order them by.
  const restated = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { __typename: 'StatusContext', context: 'ci/deploy', state: 'FAILURE', createdAt: '2026-09-16T16:10:09Z' },
        { __typename: 'StatusContext', context: 'ci/deploy', state: 'SUCCESS', createdAt: '2026-09-16T16:18:18Z' },
      ],
    },
  });
  assert.deepEqual(restated, { checks: 'success', failing: [], pending: [], cancelled: [] });

  // An app that re-posts a check run without Actions' numbering falls back to the
  // same clock, and a run that completed before it started cannot reorder it.
  const reposted = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'policy/licence',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          startedAt: '2026-09-16T16:09:57Z',
          completedAt: '2026-09-16T16:10:09Z',
          checkSuite: { app: { id: 'A_policy' } },
        },
        {
          __typename: 'CheckRun',
          name: 'policy/licence',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: '2026-09-16T16:18:19Z',
          completedAt: '2026-09-16T16:18:18Z',
          checkSuite: { app: { id: 'A_policy' } },
        },
      ],
    },
  });
  assert.equal(reposted.checks, 'success');
});

test('what GitHub withheld is told apart from what supersession dropped', () => {
  // `pageInfo` is the direct answer and outranks the count in both directions: a
  // count that moved while the pages were being read is not an unread check.
  assert.equal(rollupTruncated({ contexts: { totalCount: 641, pageInfo: { hasNextPage: false }, nodes: [{}] } }), false);
  assert.equal(rollupTruncated({ contexts: { totalCount: 1, pageInfo: { hasNextPage: true }, nodes: [{}] } }), true);
  // No cursor asked for: the count is the fallback, and its absence says nothing.
  assert.equal(rollupTruncated({ contexts: { totalCount: 140, nodes: [{}] } }), true);
  assert.equal(rollupTruncated({ contexts: { nodes: [{}] } }), false);

  // Truncation is measured against what GitHub handed back, not against what
  // survived the supersession reading: two runs collapsing to one must not make a
  // complete page look short and hand the summary back its veto.
  const complete = summarizeChecks({
    state: 'FAILURE',
    contexts: {
      totalCount: 2,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { workflowRun: { runNumber: 1, runAttempt: 1, workflow: { id: 'W_title' } } },
        },
        {
          __typename: 'CheckRun',
          name: 'commit-message',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { workflowRun: { runNumber: 2, runAttempt: 1, workflow: { id: 'W_title' } } },
        },
      ],
    },
  });
  assert.equal(complete.checks, 'success', 'the summary does not get a second vote');
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
  assert.deepEqual(none?.cancelledChecks, []);
});

test('a node that is not a pull request is dropped rather than thrown on', () => {
  assert.equal(normalizePullRequest({}, 'alice'), null);
  assert.equal(normalizePullRequest({ number: 1, title: 'x' }, 'alice'), null);
});
