/**
 * The board with a merge helper set: it asks the helper after each poll, offers
 * its button where it said so, hands a pull request or a whole stack to it from
 * a click, and keeps what it took as queued. The helper and GitHub are
 * stand-ins; the helper's launch itself is tested in `mergehelper.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Board, BoardRefusal, type BoardDeps } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import type { LiveHead } from '../src/github.ts';
import type { HelperRun, RunOptions } from '../src/mergehelper.ts';
import type { PullRequest } from '../src/types.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const HELPER = '/opt/acme/merge-helper';

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

const above = (number: number, on: number, overrides: Partial<PullRequest> = {}) =>
  pull(number, { baseRef: `alice/change-${on}`, reviewDecision: null, ...overrides });

const ran = (stdout: string, code = 0, stderr = ''): HelperRun => ({ code, signal: null, stdout, stderr });

/**
 * A board polling alice, with a merge helper whose answers come from `helper`.
 * Every call to GitHub and the helper is written down in `calls`, but for
 * `status`: every approved pull request gets one after every poll, so its
 * answers come from `status`, not queued unless it says so, and the pull
 * requests asked about are written down in `statuses`.
 */
async function helpedBoard(opts: {
  pulls: () => PullRequest[];
  helper: (args: readonly string[]) => HelperRun | Promise<HelperRun>;
  status?: (url: string) => HelperRun;
  approvals?: () => Promise<number>;
  /** GitHub's answer just before a hand-over; by default, the pulls as the board read them. */
  live?: (ids: readonly string[]) => Map<string, LiveHead>;
  settings?: Record<string, string>;
  /** GitHub's own merge, which by default must not be reached. */
  merge?: BoardDeps['merge'];
  /** Whether to wait for the helper's answers to the first poll. */
  wait?: boolean;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-board-helper-'));
  dirs.push(dataDir);
  const config = loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice', DAILY_FOCUS_MERGE_HELPER: HELPER, ...opts.settings });
  const calls: string[] = [];
  const statuses: string[] = [];
  const envs: RunOptions[] = [];
  const deps: BoardDeps = {
    listAccounts: async () => assert.fail('the account is configured'),
    token: async (_gh, login) => {
      calls.push(`token:${login}`);
      return `t-${login}`;
    },
    fetch: async () => {
      calls.push('fetch');
      return { login: 'alice', pulls: opts.pulls(), warnings: [], orgs: {}, rateLimitRemaining: 4000 };
    },
    markReady: async () => assert.fail('nothing should be marked ready'),
    markDraft: async () => assert.fail('nothing should be turned into a draft'),
    merge: opts.merge ?? (async () => assert.fail("GitHub's merge is not the way here")),
    enqueue: async () => assert.fail("GitHub's queue is not the way here"),
    requiredApprovals: async (token, repo, branch) => {
      calls.push(`approvals:${token}:${repo}:${branch}`);
      return (opts.approvals ?? (async () => 1))();
    },
    liveHeads: async (token, ids) => {
      calls.push(`live:${token}:${ids.join(',')}`);
      if (opts.live) return opts.live(ids);
      return new Map(opts.pulls().map((each) => [each.nodeId!, { state: 'OPEN', head: each.headSha!, base: each.baseRef }]));
    },
    runHelper: async (helper, args, options) => {
      assert.equal(helper, HELPER);
      envs.push(options);
      if (args[0] === 'status') {
        statuses.push(args[1]!);
        return opts.status?.(args[1]!) ?? ran('{"queued": false}');
      }
      calls.push(`helper ${args.join(' ')}`);
      return opts.helper(args);
    },
  };
  const board = new Board(config, () => {}, deps);
  await board.start();
  if (opts.wait !== false) await board.answered();
  return { board, calls, statuses, envs, dataDir };
}

// Merges only: turning a pull request back into a draft is offered on every open one, and is not what this file is about.
const merges = (row: { offers?: string[] }) => row.offers?.filter((offer) => offer !== 'draft');
const offersOf = (board: Board) => Object.fromEntries(board.view([], new Date()).rows.map((row) => [row.number, merges(row)]));

async function refusal(action: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = await action.then(
    () => assert.fail('expected the board to refuse'),
    (error: unknown) => error,
  );
  assert.ok(err instanceof BoardRefusal, `expected a BoardRefusal, got ${String(err)}`);
  return { status: err.status, message: err.message };
}

test('after a poll the board asks the helper, then offers its button where it said so', async () => {
  const { board, calls, envs, dataDir } = await helpedBoard({
    pulls: () => [pull(412), pull(7, { id: 'github:pr:acme/webapp#7', repo: 'acme/webapp', url: 'https://github.com/acme/webapp/pull/7' })],
    helper: (args) => (args[1]!.includes('payments-api') ? ran('{"queue": true, "label": "Queue with the merge bot"}') : ran('{"queue": false}')),
  });
  assert.deepEqual(calls, [
    'token:alice',
    'fetch',
    'helper check https://github.com/acme/payments-api/pull/412 main',
    'helper check https://github.com/acme/webapp/pull/7 main',
  ]);
  assert.deepEqual(offersOf(board), { 412: ['helper', 'merge'], 7: ['merge'] });
  const row = board.view([], new Date()).rows.find((candidate) => candidate.number === 412)!;
  assert.deepEqual(row.mergeHelper, { kind: 'queue', label: 'Queue with the merge bot', stacks: false });
  // The CLIs' environment: the store as DAILY_FOCUS_DATA, as the agent gets it.
  assert.equal(envs[0]!.env.DAILY_FOCUS_DATA, dataDir);
  assert.equal(envs[0]!.timeoutMs, 30_000);
});

test('a pull request queued another way, by a comment say, is In merge queue once the helper says so, with no merge to offer', async () => {
  // The queue reports itself as a check on the pull request while it merges it.
  const merging = { name: 'queue/merge', kind: 'check-run' as const, detailsUrl: 'https://queue.example/412' };
  const queued = { mergeStateStatus: 'BLOCKED' as const, checks: 'pending' as const, pendingChecks: [merging] };
  const { board, statuses } = await helpedBoard({
    pulls: () => [pull(412, queued), pull(413, queued), pull(414, { reviewDecision: 'REVIEW_REQUIRED', reviews: [] })],
    helper: () => ran('{"queue": true}'),
    status: (url) => ran(url.endsWith('/412') ? '{"queued": true}' : '{"queued": false}'),
  });
  assert.deepEqual(statuses.sort(), ['https://github.com/acme/payments-api/pull/412', 'https://github.com/acme/payments-api/pull/413'], 'every approved one, never the one awaiting review');
  const rows = new Map(board.view([], new Date()).rows.map((row) => [row.number, row]));
  assert.equal(rows.get(412)?.court, 'queue');
  assert.equal(rows.get(412)?.helperQueued, true);
  assert.deepEqual(merges(rows.get(412)!), []);
  assert.equal(rows.get(413)?.court, 'checks', 'its check is just a check');
  assert.deepEqual(board.view([], new Date()).warnings, []);
});

test("a failed check is a warning naming the helper's error, GitHub's merge meanwhile, and asked again after the next poll", async () => {
  let answer = ran('', 1, 'queue-cli: token expired');
  const { board, calls } = await helpedBoard({ pulls: () => [pull(412)], helper: () => answer });
  const view = board.view([], new Date());
  assert.deepEqual(view.warnings, [
    "The merge helper couldn't say how acme/payments-api merges into main: it exited with code 1: queue-cli: token expired. Its pull requests offer GitHub's merge until it can.",
  ]);
  assert.deepEqual(offersOf(board), { 412: ['merge'] });

  answer = ran('{"queue": true}');
  calls.length = 0;
  await board.refresh();
  await board.answered();
  assert.deepEqual(calls, ['token:alice', 'fetch', 'helper check https://github.com/acme/payments-api/pull/412 main']);
  assert.deepEqual(board.view([], new Date()).warnings, []);
  assert.deepEqual(offersOf(board), { 412: ['helper', 'merge'] });
});

test('switched off, or with GitHub off, no helper is ever asked', async () => {
  const { board, calls } = await helpedBoard({
    pulls: () => [pull(412)],
    helper: () => assert.fail('no helper should run'),
    settings: { DAILY_FOCUS_MERGE_HELPER: '' },
  });
  assert.deepEqual(calls, ['token:alice', 'fetch']);
  assert.deepEqual(offersOf(board), { 412: ['merge'] });
  assert.equal(board.view([], new Date()).rows[0]?.mergeHelper, undefined);
});

test('merge hands the pull request to the helper, says what it said, and shows it queued', async () => {
  let open = true;
  const { board, calls } = await helpedBoard({
    pulls: () => (open ? [pull(412)] : []),
    helper: (args) => (args[0] === 'check' ? ran('{"queue": true}') : ran('Queued at position 3\nhttps://queue.example/412\n')),
  });
  calls.length = 0;
  assert.deepEqual(await board.merge('github:pr:acme/payments-api#412', [], 'head-412'), { route: 'helper', notice: 'Queued at position 3' });
  assert.deepEqual(
    calls,
    [
      'token:alice',
      'live:t-alice:PR_kwDOAcme412',
      'helper merge https://github.com/acme/payments-api/pull/412 --head https://github.com/acme/payments-api/pull/412=head-412',
      'token:alice',
      'fetch',
    ],
    'GitHub asked again, the helper told the commit, then the board read back',
  );
  const row = board.view([], new Date()).rows[0]!;
  assert.equal(row.helperQueued, true);
  assert.deepEqual(row.offers, [], 'queued once, it offers nothing more');
  assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#412', [], 'head-412')), {
    status: 409,
    message: 'acme/payments-api#412: it is in the merge queue already',
  });

  // Merged by the queue: GitHub stops listing it, and it is forgotten.
  open = false;
  await board.refresh();
  await board.answered();
  assert.deepEqual(board.view([], new Date()).rows, []);
});

test("the helper's refusal comes back in its own words, and nothing is queued", async () => {
  const { board } = await helpedBoard({
    pulls: () => [pull(412)],
    helper: (args) => (args[0] === 'check' ? ran('{"queue": true}') : ran('', 1, 'acme/payments-api is frozen for the release\ntrace…')),
  });
  await assert.rejects(board.merge('github:pr:acme/payments-api#412', [], 'head-412'), {
    name: 'HelperRefusal',
    message: 'acme/payments-api is frozen for the release',
  });
  assert.equal(board.view([], new Date()).rows[0]?.helperQueued, undefined);
  assert.deepEqual(offersOf(board), { 412: ['helper', 'merge'] });
});

test("GitHub's merge beside the helper's goes to GitHub, with the method its button would use, and the helper hears nothing", async () => {
  let open = true;
  const merged: string[] = [];
  const { board, calls } = await helpedBoard({
    pulls: () => (open ? [pull(412)] : []),
    helper: (args) => (args[0] === 'check' ? ran('{"queue": true}') : assert.fail('the helper should not be asked to merge')),
    merge: async (token, nodeId, method, head) => {
      merged.push(`${token} ${nodeId} ${method} ${head}`);
      open = false;
    },
  });
  calls.length = 0;
  assert.deepEqual(await board.merge('github:pr:acme/payments-api#412', [], 'head-412', 'merge'), { route: 'merge', notice: null });
  assert.deepEqual(merged, ['t-alice PR_kwDOAcme412 SQUASH head-412']);
  assert.ok(!calls.some((call) => call.startsWith('helper') || call.startsWith('live')), `the helper heard nothing: ${calls.join(', ')}`);
  assert.deepEqual(board.view([], new Date()).rows, [], 'and the board read back');
});

test("a way the row doesn't offer is refused before anything is asked", async () => {
  const { board, calls } = await helpedBoard({
    pulls: () => [pull(412), pull(413, { mergeQueue: true })],
    helper: (args) => (args[0] === 'check' ? ran('{"queue": true}') : assert.fail('the helper should not be asked to merge')),
  });
  calls.length = 0;
  assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#412', [], 'head-412', 'queue')), {
    status: 409,
    message: "acme/payments-api#412: it merges through the merge helper or with GitHub's merge, not through GitHub's merge queue",
  });
  assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#413', [], 'head-413', 'merge')), {
    status: 409,
    message: "acme/payments-api#413: it merges through the merge helper, not with GitHub's merge",
  });
  assert.deepEqual(calls, []);
});

test('the helper is not handed a pull request GitHub has moved on since the last poll', async () => {
  const moved = (change: Partial<LiveHead>) => () =>
    new Map([['PR_kwDOAcme412', { state: 'OPEN', head: 'head-412', base: 'main', ...change }]]);
  for (const [change, message] of [
    [{ head: 'head-412-pushed' }, 'acme/payments-api#412: it has new commits on GitHub since you looked; check them and try again'],
    [{ base: 'release' }, 'acme/payments-api#412: its base branch is now release; check it and try again'],
    [{ state: 'MERGED' }, 'acme/payments-api#412: it is no longer open'],
  ] as const) {
    const { board, calls } = await helpedBoard({ pulls: () => [pull(412)], helper: () => ran('{"queue": true}'), live: moved(change) });
    calls.length = 0;
    assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#412', [], 'head-412')), { status: 409, message });
    assert.ok(!calls.some((call) => call.startsWith('helper merge')), 'the helper never heard of it');
  }
});

test('a stack is not handed over when one of its pull requests moved on GitHub', async () => {
  const { board, calls } = await helpedBoard({
    pulls: STACK,
    helper: STACKING,
    live: () =>
      new Map(STACK().map((each) => [each.nodeId!, { state: 'OPEN', head: each.number === 411 ? 'head-411-pushed' : each.headSha!, base: each.baseRef }])),
  });
  calls.length = 0;
  assert.deepEqual(await refusal(board.mergeStack('github:pr:acme/payments-api#412', [], HEADS)), {
    status: 409,
    message: 'acme/payments-api#411: it has new commits on GitHub since you looked; check them and try again',
  });
  assert.ok(!calls.some((call) => call.startsWith('helper merge')));
});

test('merge through the helper is refused when the head moved since the page showed it', async () => {
  const { board, calls } = await helpedBoard({ pulls: () => [pull(412)], helper: () => ran('{"queue": true}') });
  calls.length = 0;
  assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#412', [], 'head-older')), {
    status: 409,
    message: 'acme/payments-api#412: it has new commits since you looked; check them and try again',
  });
  assert.deepEqual(calls, [], 'the helper was not run');
});

test('until the helper has answered, the row offers no merge at all, and a click is refused', async () => {
  let answer: (run: HelperRun) => void = () => {};
  const { board, calls } = await helpedBoard({
    pulls: () => [pull(412)],
    helper: () => new Promise<HelperRun>((resolve) => (answer = resolve)),
    wait: false,
  });
  assert.deepEqual(offersOf(board), { 412: [] });
  assert.deepEqual(board.view([], new Date()).rows[0]?.mergeHelper, { kind: 'asking' });
  assert.deepEqual(await refusal(board.merge('github:pr:acme/payments-api#412', [], 'head-412')), {
    status: 409,
    message: "acme/payments-api#412: the merge helper hasn't said yet how this repository merges; try again in a moment",
  });

  answer(ran('{"queue": true}'));
  await board.answered();
  assert.deepEqual(offersOf(board), { 412: ['helper', 'merge'] });
  assert.deepEqual(calls, ['token:alice', 'fetch', 'helper check https://github.com/acme/payments-api/pull/412 main'], 'asked once, not again meanwhile');
});

test('a poll that ends while the helper is still answering gets a round of its own after', async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => (release = resolve));
  let list = [pull(412)];
  const webapp = pull(7, { id: 'github:pr:acme/webapp#7', repo: 'acme/webapp', url: 'https://github.com/acme/webapp/pull/7' });
  const { board, calls } = await helpedBoard({
    pulls: () => list,
    helper: async (args) => {
      if (args[1]!.includes('payments-api')) await slow;
      return ran('{"queue": true}');
    },
    wait: false,
  });
  list = [pull(412), webapp];
  await board.refresh();
  assert.ok(!calls.includes('helper check https://github.com/acme/webapp/pull/7 main'), 'not while the first round runs');
  release();
  await board.answered();
  assert.ok(calls.includes('helper check https://github.com/acme/webapp/pull/7 main'), 'but straight after it');
  assert.deepEqual(offersOf(board), { 412: ['helper', 'merge'], 7: ['helper', 'merge'] });
});

/* ---------- stacks ---------- */

const STACK = () => [pull(410), above(411, 410), above(412, 411)];
const HEADS = { 'github:pr:acme/payments-api#410': 'head-410', 'github:pr:acme/payments-api#411': 'head-411', 'github:pr:acme/payments-api#412': 'head-412' };
const STACKING = (args: readonly string[]) =>
  args[0] === 'check' ? ran('{"queue": true, "stacks": true}') : args[0] === 'merge' ? ran('Stack of 3 queued') : ran('{"queued": true}');

test("the stack merge reads the default branch's approvals as the pull requests' account, once", async () => {
  const { board, calls } = await helpedBoard({ pulls: STACK, helper: STACKING, approvals: async () => 1 });
  assert.deepEqual(calls, [
    'token:alice',
    'fetch',
    'helper check https://github.com/acme/payments-api/pull/410 main',
    'token:alice',
    'approvals:t-alice:acme/payments-api:main',
  ]);
  assert.deepEqual(offersOf(board), { 410: ['helper', 'merge'], 411: [], 412: ['stack'] });

  calls.length = 0;
  await board.refresh();
  await board.answered();
  assert.deepEqual(calls, ['token:alice', 'fetch'], 'both answers are kept');
});

test('approvals that cannot be read stand at one, and are read again after the next poll', async () => {
  let fail = true;
  const twice = [{ login: 'bob', state: 'APPROVED', at: '2026-11-02T10:00:00Z' }];
  const { board, calls } = await helpedBoard({
    pulls: () => [pull(410), above(411, 410, { reviews: twice })],
    helper: STACKING,
    approvals: async () => {
      if (fail) throw new Error('GitHub answered 403');
      return 2;
    },
  });
  assert.deepEqual(offersOf(board), { 410: ['helper', 'merge'], 411: ['stack'] }, 'one approval is enough when unreadable');
  fail = false;
  calls.length = 0;
  await board.refresh();
  await board.answered();
  assert.ok(calls.includes('approvals:t-alice:acme/payments-api:main'));
  assert.deepEqual(offersOf(board), { 410: ['helper', 'merge'], 411: [] }, 'and two once main says so');
});

test('merge stack hands the top to the helper with --stack, and shows every pull request in it queued', async () => {
  const { board, calls } = await helpedBoard({ pulls: STACK, helper: STACKING });
  calls.length = 0;
  assert.deepEqual(await board.mergeStack('github:pr:acme/payments-api#412', [], HEADS), { route: 'helper', notice: 'Stack of 3 queued' });
  assert.deepEqual(calls, [
    'token:alice',
    'live:t-alice:PR_kwDOAcme410,PR_kwDOAcme411,PR_kwDOAcme412',
    'helper merge --stack https://github.com/acme/payments-api/pull/412' +
      ' --head https://github.com/acme/payments-api/pull/410=head-410' +
      ' --head https://github.com/acme/payments-api/pull/411=head-411' +
      ' --head https://github.com/acme/payments-api/pull/412=head-412',
    'token:alice',
    'fetch',
  ]);
  const rows = board.view([], new Date()).rows;
  assert.deepEqual(rows.map((row) => [row.number, row.helperQueued, merges(row)]), [
    [410, true, []],
    [411, true, []],
    [412, true, []],
  ]);
});

test('merge stack is refused unless the page asked about the same pull requests at the same commits', async () => {
  const { board, calls } = await helpedBoard({ pulls: STACK, helper: STACKING });
  calls.length = 0;
  const stack = (heads: Record<string, string>, id = 'github:pr:acme/payments-api#412') => refusal(board.mergeStack(id, [], heads));

  const { 'github:pr:acme/payments-api#411': _middle, ...missing } = HEADS;
  void _middle;
  assert.deepEqual(await stack(missing), { status: 409, message: 'acme/payments-api#412: the stack has changed since you looked; check it and try again' });
  assert.deepEqual(await stack({ ...HEADS, 'github:pr:acme/payments-api#409': 'head-409' }), {
    status: 409,
    message: 'acme/payments-api#412: the stack has changed since you looked; check it and try again',
  });
  assert.deepEqual(await stack({ ...HEADS, 'github:pr:acme/payments-api#411': 'head-older' }), {
    status: 409,
    message: 'acme/payments-api#411: it has new commits since you looked; check them and try again',
  });
  assert.deepEqual(await stack(HEADS, 'github:pr:acme/payments-api#411'), {
    status: 409,
    message: 'acme/payments-api#411: #412 is stacked on it; merge the stack from its top',
  });
  assert.deepEqual(await stack(HEADS, 'github:pr:acme/payments-api#999'), { status: 404, message: 'that pull request is not on the board' });
  assert.deepEqual(calls, [], 'the helper never heard of any of it');
});

test('merge stack is refused for a stack that can’t all go, and without a helper', async () => {
  const { board } = await helpedBoard({ pulls: () => [pull(410), above(411, 410, { isDraft: true }), above(412, 411)], helper: STACKING });
  assert.deepEqual(await refusal(board.mergeStack('github:pr:acme/payments-api#412', [], HEADS)), { status: 409, message: 'acme/payments-api#412: #411 is a draft' });

  const { board: unhelped } = await helpedBoard({ pulls: STACK, helper: () => assert.fail('no helper'), settings: { DAILY_FOCUS_MERGE_HELPER: '' } });
  assert.deepEqual(await refusal(unhelped.mergeStack('github:pr:acme/payments-api#412', [], HEADS)), {
    status: 409,
    message: 'acme/payments-api#412: no merge helper is set',
  });
});
