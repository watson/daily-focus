/**
 * The board's two writes over HTTP: what the routes accept, what they refuse
 * before GitHub hears of it, and how GitHub's own refusal reaches the page.
 * GitHub is a stand-in throughout, and gh a path to nothing.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BoardDeps } from '../src/board.ts';
import { GitHubRefusedError } from '../src/github.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import type { DashboardState, PullRequest } from '../src/types.ts';

const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

function payments(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
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
    reviews: [],
    headSha: HEAD,
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

/** What GitHub holds, which the writes change, and what was asked of it. */
const github = {
  pulls: [] as PullRequest[],
  calls: [] as string[],
  /** GitHub's words for the next write, when it is to refuse it. */
  refuse: null as string | null,
};

function write(call: string, change: () => void): Promise<void> {
  github.calls.push(call);
  if (github.refuse) return Promise.reject(new GitHubRefusedError(github.refuse));
  change();
  return Promise.resolve();
}

const deps: BoardDeps = {
  listAccounts: async () => [{ login: 'alice', active: true }],
  token: async (_gh, login) => `token-${login ?? 'active'}`,
  fetch: async () => ({ login: 'alice', pulls: github.pulls.map((pull) => ({ ...pull })), warnings: [], orgs: {}, rateLimitRemaining: 4000 }),
  markReady: (token, nodeId) =>
    write(`ready ${token} ${nodeId}`, () => {
      for (const pull of github.pulls) if (pull.nodeId === nodeId) pull.isDraft = false;
    }),
  merge: (token, nodeId, method, headSha) =>
    write(`merge ${token} ${nodeId} ${method} ${headSha}`, () => {
      github.pulls = github.pulls.filter((pull) => pull.nodeId !== nodeId);
    }),
  enqueue: (token, nodeId, headSha) =>
    write(`enqueue ${token} ${nodeId} ${headSha}`, () => {
      for (const pull of github.pulls) if (pull.nodeId === nodeId) pull.inMergeQueue = true;
    }),
  requiredApprovals: async () => assert.fail('no merge helper is set'),
  liveHeads: async () => assert.fail('no merge helper is set'),
  runHelper: async () => assert.fail('no merge helper is set'),
};

let server: StartedServer;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-focus-server-board-'));
  const store = join(root, 'work');
  await mkdir(store);
  await writeFile(
    join(store, 'settings.json'),
    JSON.stringify({
      DAILY_FOCUS_PROFILE: 'work',
      DAILY_FOCUS_AGENT: 'off',
      DAILY_FOCUS_CALENDAR: 'off',
      DAILY_FOCUS_JIRA: 'off',
      DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice',
      // Nothing here may reach a real gh, even by accident.
      DAILY_FOCUS_GH: join(root, 'no-gh'),
    }),
  );
  github.pulls = [payments(410, { isDraft: true }), payments(411, { baseRef: 'alice/refactor-ledger' }), payments(412), payments(413, { mergeQueue: true })];
  server = await startServer(
    { PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' },
    { integrations: { github: deps } },
  );
});

after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown, contentType = 'application/json') =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });

const row = (state: DashboardState, number: number) => state.board.rows.find((candidate) => candidate.number === number);

test('the board offers each row only what the server would do', async () => {
  const state = (await (await fetch(`${server.url}/api/state`)).json()) as DashboardState;
  assert.deepEqual(row(state, 410)?.offers, ['ready']);
  assert.deepEqual(row(state, 411)?.offers, [], 'not into a branch other than main');
  assert.deepEqual(row(state, 412)?.offers, ['merge']);
  assert.deepEqual(row(state, 413)?.offers, ['queue']);
});

test('the routes take a row id and nothing else, behind the same guard as every POST', async () => {
  github.calls = [];
  for (const path of ['/api/board/ready', '/api/board/merge']) {
    for (const body of [{}, { id: 412 }, { url: 'https://github.com/acme/payments-api/pull/412' }, { id: 'https://github.com/acme/payments-api/pull/412' }]) {
      const res = await post(path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal((await post(path, ['github:pr:acme/payments-api#412'])).status, 400, 'an array is not a body');
    // A form on another site can send text/plain without asking first.
    assert.equal((await post(path, { id: 'github:pr:acme/payments-api#412' }, 'text/plain')).status, 415, path);
    const unknown = await post(path, { id: 'github:pr:acme/payments-api#999', head: HEAD });
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { error: string }).error, /not on the board/);
  }
  // A merge says which head commit the user saw, so it can't land a newer one.
  assert.equal((await post('/api/board/merge', { id: 'github:pr:acme/payments-api#412' })).status, 400);
  assert.deepEqual(github.calls, [], 'GitHub heard of none of it');
});

test('ready and merge are refused for a row that does not offer them', async () => {
  github.calls = [];
  const notDraft = await post('/api/board/ready', { id: 'github:pr:acme/payments-api#412' });
  assert.equal(notDraft.status, 409);
  assert.deepEqual(await notDraft.json(), { error: 'acme/payments-api#412: it is not a draft' });

  const otherBase = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#411', head: HEAD });
  assert.equal(otherBase.status, 409);
  assert.deepEqual(await otherBase.json(), { error: 'acme/payments-api#411: it targets alice/refactor-ledger, not main' });
  assert.deepEqual(github.calls, []);
});

test("GitHub's refusal is a 409 in GitHub's words", async () => {
  github.calls = [];
  github.refuse = 'Head branch was modified. Review and try the merge again.';
  try {
    const res = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#412', head: HEAD });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'Head branch was modified. Review and try the merge again.' });
  } finally {
    github.refuse = null;
  }
  assert.deepEqual(github.calls, [`merge token-alice PR_kwDOAcme412 SQUASH ${HEAD}`]);
});

test('ready, merge and queue each change GitHub once, then answer with the board read back', async () => {
  github.calls = [];
  const ready = await post('/api/board/ready', { id: 'github:pr:acme/payments-api#410' });
  assert.equal(ready.status, 200);
  assert.equal(row((await ready.json()) as DashboardState, 410)?.isDraft, false);

  const merged = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#412', head: HEAD });
  assert.equal(merged.status, 200);
  assert.equal(row((await merged.json()) as DashboardState, 412), undefined, 'merged, it is off the board');

  const queued = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#413', head: HEAD });
  assert.equal(queued.status, 200);
  const state = (await queued.json()) as DashboardState;
  assert.equal(row(state, 413)?.inMergeQueue, true);
  assert.deepEqual(row(state, 413)?.offers, [], 'queued once, it offers nothing more');

  assert.deepEqual(github.calls, [
    'ready token-alice PR_kwDOAcme410',
    `merge token-alice PR_kwDOAcme412 SQUASH ${HEAD}`,
    `enqueue token-alice PR_kwDOAcme413 ${HEAD}`,
  ]);
});
