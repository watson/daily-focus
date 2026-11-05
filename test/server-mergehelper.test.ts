/**
 * The merge helper over HTTP, end to end: a stand-in helper written with
 * `fakeCli` and started by the dashboard's own launch, a stand-in GitHub, and
 * the routes that hand a pull request or a stack to the helper. What the routes
 * accept and refuse before the helper hears of anything, and how its answers
 * reach the page.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BoardDeps } from '../src/board.ts';
import { runMergeHelper } from '../src/mergehelper.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import type { DashboardState, PullRequest } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

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
    headSha: `head-${number}`,
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

const above = (number: number, on: number) => pull(number, { baseRef: `alice/change-${on}`, reviewDecision: null });

const pulls = [pull(410), above(411, 410), above(412, 411), pull(420), pull(421)];

const deps: BoardDeps = {
  listAccounts: async () => [{ login: 'alice', active: true }],
  token: async (_gh, login) => `token-${login ?? 'active'}`,
  fetch: async () => ({ login: 'alice', pulls: pulls.map((each) => ({ ...each })), warnings: [], orgs: {}, rateLimitRemaining: 4000 }),
  markReady: async () => assert.fail('nothing should be marked ready'),
  markDraft: async () => assert.fail('nothing should be turned into a draft'),
  merge: async () => assert.fail("GitHub's merge is not the way here"),
  enqueue: async () => assert.fail("GitHub's queue is not the way here"),
  requiredApprovals: async () => 1,
  liveHeads: async (_token, ids) =>
    new Map(pulls.filter((each) => ids.includes(each.nodeId!)).map((each) => [each.nodeId!, { state: 'OPEN', head: each.headSha!, base: each.baseRef }])),
  runHelper: runMergeHelper,
};

let server: StartedServer;
let root: string;
let log: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-focus-server-helper-'));
  log = join(root, 'helper.log');
  const helper = await fakeCli(
    join(root, 'merge-helper'),
    `
fs.appendFileSync(${quoted(log)}, args.join(' ') + '\\n');
if (args[0] === 'check') say('{"queue": true, "label": "Queue it", "stacks": true}');
else if (args[0] === 'status') say('{"queued": true}');
else if (args[0] === 'merge' && args[1].endsWith('/421')) fail('the queue is closed for acme/payments-api#421');
else if (args[0] === 'merge' && args[1] === '--stack') say('Stack queued from #' + args[2].split('/').pop());
else if (args[0] === 'merge') say('Queued ' + args[1]);
else fail('unknown command', 2);
`,
  );
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
      DAILY_FOCUS_GH: join(root, 'no-gh'),
      DAILY_FOCUS_MERGE_HELPER: helper,
    }),
  );
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

const getState = async () => (await (await fetch(`${server.url}/api/state`)).json()) as DashboardState;
const row = (state: DashboardState, number: number) => state.board.rows.find((candidate) => candidate.number === number);
const helperLog = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);

const HEADS = { 'github:pr:acme/payments-api#410': 'head-410', 'github:pr:acme/payments-api#411': 'head-411', 'github:pr:acme/payments-api#412': 'head-412' };

/** The state once the helper has answered the first poll's check. */
async function answered(): Promise<DashboardState> {
  for (let i = 0; i < 200; i++) {
    const state = await getState();
    if (row(state, 412)?.offers?.includes('stack')) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('the merge helper never answered');
}

test("once the helper has answered, its button and Merge stack are on the rows it said, and nothing else's", async () => {
  const state = await answered();
  assert.deepEqual(
    state.board.rows.map((each) => [each.number, each.offers?.filter((offer) => offer !== 'draft')]),
    [
      [410, ['helper', 'merge']],
      [411, []],
      [412, ['stack']],
      [420, ['helper', 'merge']],
      [421, ['helper', 'merge']],
    ],
  );
  assert.deepEqual(row(state, 420)?.mergeHelper, { kind: 'queue', label: 'Queue it', stacks: true });
  assert.deepEqual(row(state, 412)?.stack, Object.keys(HEADS));
  assert.deepEqual(await helperLog(), ['check https://github.com/acme/payments-api/pull/410 main'], 'one check for the branch');
});

test('merge-stack takes the top row and the heads the page showed, behind the same guard as every POST', async () => {
  await answered();
  const bad = [
    {},
    { id: 412, heads: HEADS },
    { id: 'https://github.com/acme/payments-api/pull/412', heads: HEADS },
    { id: 'github:pr:acme/payments-api#412' },
    { id: 'github:pr:acme/payments-api#412', heads: Object.entries(HEADS) },
    { id: 'github:pr:acme/payments-api#412', heads: { 'github:pr:acme/payments-api#412': 'head-412' } },
    { id: 'github:pr:acme/payments-api#412', heads: { ...HEADS, 'github:pr:acme/payments-api#411': '' } },
    { id: 'github:pr:acme/payments-api#412', heads: { ...HEADS, 'github:pr:acme/payments-api#411': 411 } },
    { id: 'github:pr:acme/payments-api#412', heads: { 'acme/payments-api#410': 'head-410', 'github:pr:acme/payments-api#412': 'head-412' } },
  ];
  for (const body of bad) assert.equal((await post('/api/board/merge-stack', body)).status, 400, JSON.stringify(body));
  assert.equal((await post('/api/board/merge-stack', { id: 'github:pr:acme/payments-api#412', heads: HEADS }, 'text/plain')).status, 415);

  const unknown = await post('/api/board/merge-stack', { id: 'github:pr:acme/payments-api#999', heads: HEADS });
  assert.equal(unknown.status, 404);

  const notTop = await post('/api/board/merge-stack', { id: 'github:pr:acme/payments-api#411', heads: HEADS });
  assert.equal(notTop.status, 409);
  assert.deepEqual(await notTop.json(), { error: 'acme/payments-api#411: #412 is stacked on it; merge the stack from its top' });

  const moved = await post('/api/board/merge-stack', { id: 'github:pr:acme/payments-api#412', heads: { ...HEADS, 'github:pr:acme/payments-api#410': 'head-older' } });
  assert.equal(moved.status, 409);
  assert.deepEqual(await moved.json(), { error: 'acme/payments-api#410: it has new commits since you looked; check them and try again' });

  assert.ok(!(await helperLog()).some((line) => line.startsWith('merge')), 'the helper heard of none of it');
});

test("the helper's refusal is a 409 in its own words", async () => {
  await answered();
  const res = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#421', head: 'head-421' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'the queue is closed for acme/payments-api#421' });
  assert.deepEqual(row(await getState(), 421)?.offers?.filter((offer) => offer !== 'draft'), ['helper', 'merge'], 'nothing is queued');
});

test('merge takes the way the click asked for, among those the row offers', async () => {
  await answered();
  const before = (await helperLog()).length;
  for (const route of ['squash', 7, null]) {
    const res = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#420', head: 'head-420', route });
    assert.equal(res.status, 400, String(route));
  }
  const queue = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#420', head: 'head-420', route: 'queue' });
  assert.equal(queue.status, 409);
  assert.deepEqual(await queue.json(), {
    error: "acme/payments-api#420: it merges through the merge helper or with GitHub's merge, not through GitHub's merge queue",
  });
  assert.equal((await helperLog()).length, before, 'the helper heard of none of it');
});

test('merge and merge-stack hand over through the helper and answer with what it said, the board read back', async () => {
  await answered();
  const merged = await post('/api/board/merge', { id: 'github:pr:acme/payments-api#420', head: 'head-420' });
  assert.equal(merged.status, 200);
  const one = (await merged.json()) as DashboardState & { notice?: string };
  assert.equal(one.notice, 'Queued https://github.com/acme/payments-api/pull/420');
  assert.equal(row(one, 420)?.helperQueued, true);
  assert.deepEqual(row(one, 420)?.offers?.filter((offer) => offer !== 'draft'), []);

  const stacked = await post('/api/board/merge-stack', { id: 'github:pr:acme/payments-api#412', heads: HEADS });
  assert.equal(stacked.status, 200);
  const all = (await stacked.json()) as DashboardState & { notice?: string };
  assert.equal(all.notice, 'Stack queued from #412');
  for (const number of [410, 411, 412]) assert.equal(row(all, number)?.helperQueued, true, `#${number}`);

  // The notice is for the page that asked; every other tab gets the state alone.
  assert.equal('notice' in (await getState()), false);
  const merges = (await helperLog()).filter((line) => line.startsWith('merge'));
  const pr = (number: number) => `https://github.com/acme/payments-api/pull/${number}`;
  assert.deepEqual(merges, [
    `merge ${pr(421)} --head ${pr(421)}=head-421`,
    `merge ${pr(420)} --head ${pr(420)}=head-420`,
    `merge --stack ${pr(412)} --head ${pr(410)}=head-410 --head ${pr(411)}=head-411 --head ${pr(412)}=head-412`,
  ]);
});
