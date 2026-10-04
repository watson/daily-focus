import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Board, normalizeStoredPull, readPullsFile, type BoardDeps } from '../src/board.ts';
import { GhAuthError, GhMissingError, GitHubRequestError, type AccountFetch } from '../src/github.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { PullRequest } from '../src/types.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-board-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, ...env });
}

function pull(account: string, number: number): PullRequest {
  return {
    id: `github:pr:acme/webapp#${number}`,
    account,
    repo: 'acme/webapp',
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/webapp/pull/${number}`,
    isDraft: false,
    createdAt: '2026-09-10T09:00:00Z',
    readyAt: '2026-09-10T09:00:00Z',
    updatedAt: '2026-09-10T09:00:00Z',
    headRef: 'x',
    baseRef: 'main',
    reviewDecision: null,
    checks: null,
    failingChecks: [],
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    lastActivityByYou: '2026-09-10T09:00:00Z',
    lastActivityByOthers: null,
  };
}

/** Fake gh and GitHub. Each fetch is keyed by the token it was handed. */
function fakeDeps(opts: {
  accounts?: { login: string; active: boolean }[];
  tokens?: Record<string, string>;
  fetches?: Record<string, () => Promise<AccountFetch>>;
}): BoardDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listAccounts() {
      calls.push('list');
      return opts.accounts ?? [];
    },
    async token(_gh, login) {
      calls.push(`token:${login ?? 'active'}`);
      const key = login ?? 'active';
      const token = opts.tokens?.[key];
      if (!token) throw new GhAuthError(`no token for ${key}`);
      return token;
    },
    async fetch(token) {
      calls.push(`fetch:${token}`);
      const fetcher = opts.fetches?.[token];
      if (!fetcher) throw new Error(`nothing to fetch for ${token}`);
      return fetcher();
    },
  };
}

const ok =
  (login: string, pulls: PullRequest[], warnings: string[] = [], orgs: AccountFetch['orgs'] = {}) =>
  async (): Promise<AccountFetch> => ({
    login,
    pulls,
    warnings,
    orgs,
    rateLimitRemaining: 4000,
  });

test('with nothing configured it polls the active account, and warns when there are more', async () => {
  const cfg = await config();
  const deps = fakeDeps({
    accounts: [
      { login: 'alice', active: false },
      { login: 'alice_corp', active: true },
    ],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice_corp', [pull('alice_corp', 1)]) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const view = board.view([], new Date());
  assert.deepEqual(deps.calls, ['list', 'token:active', 'fetch:t1']);
  assert.equal(view.rows.length, 1);
  assert.deepEqual(view.accounts, [{ login: 'alice_corp', ok: true, error: null }]);
  assert.match(view.warnings[0] ?? '', /polling only the active one, alice_corp/);
  assert.equal(view.reason, null);
});

test('configured accounts are named to gh, and one gh lacks is a warning not a failure', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice,alice_corp' });
  const deps = fakeDeps({
    tokens: { alice: 't1' },
    fetches: { t1: ok('alice', [pull('alice', 1), pull('alice', 2)]) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const view = board.view([], new Date());
  assert.deepEqual(deps.calls, ['token:alice', 'token:alice_corp', 'fetch:t1']);
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.accounts, [
    { login: 'alice', ok: true, error: null },
    { login: 'alice_corp', ok: false, error: 'no token for alice_corp' },
  ]);
  assert.match(view.failures[0]?.message ?? '', /^alice_corp: no token/);
  assert.deepEqual(view.warnings, [], 'a failure is told once, as a failure');
  assert.ok(view.fetchedAt, 'a partial success still counts as a fetch');
});

test('an account that fails keeps what it had last time', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice,alice_corp' });
  let corpFails = false;
  const deps = fakeDeps({
    tokens: { alice: 't1', alice_corp: 't2' },
    fetches: {
      t1: ok('alice', [pull('alice', 1)]),
      t2: async () => {
        if (corpFails) throw new Error('GitHub answered 502');
        return { login: 'alice_corp', pulls: [pull('alice_corp', 9)], warnings: [], orgs: {}, rateLimitRemaining: 4000 };
      },
    },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  assert.equal(board.view([], new Date()).rows.length, 2);

  corpFails = true;
  await board.refresh();
  const view = board.view([], new Date());
  assert.deepEqual(
    view.rows.map((row) => row.number).sort(),
    [1, 9],
    'the failed account\'s PRs survive from the previous fetch',
  );
  assert.deepEqual(view.failures.map((failure) => failure.message), ['alice_corp: GitHub answered 502']);
});

test('two accounts cut off by the same outage are one failure naming both, counted until it ends', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice,alice_corp' });
  let offline = true;
  const answer = (login: string, number: number) => async (): Promise<AccountFetch> => {
    if (offline) {
      const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
      throw new GitHubRequestError("couldn't reach api.github.com (the DNS lookup failed)", null, {
        cause: new TypeError('fetch failed', { cause: lookup }),
      });
    }
    return { login, pulls: [pull(login, number)], warnings: [], orgs: {}, rateLimitRemaining: 4000 };
  };
  const deps = fakeDeps({ tokens: { alice: 't1', alice_corp: 't2' }, fetches: { t1: answer('alice', 1), t2: answer('alice_corp', 2) } });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  let view = board.view([], new Date());
  assert.equal(view.reason, null, 'gh answered, so the board can run; it is the accounts that failed');
  assert.equal(view.failures.length, 1, 'one outage, one banner');
  const first = view.failures[0]!;
  assert.equal(first.message, "alice and alice_corp: couldn't reach api.github.com (the DNS lookup failed)");
  assert.match(first.detail, /caused by Error: getaddrinfo ENOTFOUND api\.github\.com \(code ENOTFOUND\)/);
  assert.ok(!first.detail.includes('alice:'), 'the same detail for both is said once');
  assert.equal(first.attempts, 1);
  assert.ok(first.retryAt, 'it says when it will try again');
  assert.deepEqual(view.warnings, []);

  await board.refresh();
  view = board.view([], new Date());
  assert.equal(view.failures[0]?.attempts, 2);
  assert.equal(view.failures[0]?.since, first.since, 'still the same outage');

  offline = false;
  await board.refresh();
  view = board.view([], new Date());
  assert.deepEqual(view.failures, []);
  assert.equal(view.rows.length, 2);
});

test('a poll in flight keeps the last one\'s failures on screen, and says it is retrying', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice,alice_corp' });
  let release: (() => void) | null = null;
  let hold = false;
  const deps = fakeDeps({
    tokens: { alice: 't1', alice_corp: 't2' },
    fetches: {
      t1: ok('alice', [pull('alice', 1)]),
      t2: async () => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        throw new Error('GitHub answered 502');
      },
    },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  assert.equal(board.view([], new Date()).failures[0]?.retrying, false);

  hold = true;
  const poll = board.refresh();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  const during = board.view([], new Date());
  assert.equal(during.failures.length, 1, 'a banner somebody opened to press Retry must not vanish under them');
  assert.equal(during.failures[0]?.retrying, true);
  assert.equal(during.failures[0]?.retryAt, null);

  (release as () => void)();
  await poll;
  const after = board.view([], new Date()).failures[0];
  assert.equal(after?.retrying, false);
  assert.equal(after?.attempts, 2, 'counted per account, though the other answered');
});

test('when nothing can be polled the reason says so and the last file still shows', async () => {
  const cfg = await config();
  await writeFile(
    cfg.pullsFile,
    JSON.stringify({ version: 1, fetchedAt: '2026-09-14T06:00:00Z', accounts: [], scope: [], warnings: [], pulls: [pull('alice', 5)] }),
  );
  const deps = fakeDeps({ accounts: [] });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const view = board.view([], new Date());
  assert.match(view.reason?.message ?? '', /gh is not logged in/);
  assert.equal(view.rows.length, 1, 'yesterday\'s file is better than nothing');
  assert.equal(view.fetchedAt, '2026-09-14T06:00:00Z');
});

test('a missing gh is reported as the reason', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice' });
  const deps: BoardDeps = {
    listAccounts: async () => [],
    token: async () => {
      throw new GhMissingError('/nope/gh');
    },
    fetch: async () => {
      throw new Error('unreachable');
    },
  };
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  assert.match(board.view([], new Date()).reason?.message ?? '', /could not run `\/nope\/gh`/);
});

test('the file on disk is the last good fetch, written atomically', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_SCOPE: 'acme' });
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice', [pull('alice', 1)], ['alice can\'t see acme-labs']) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const file = await readPullsFile(cfg.pullsFile);
  assert.ok(file);
  assert.equal(file.version, 1);
  assert.deepEqual(file.scope, ['org:acme']);
  assert.deepEqual(file.warnings, ['alice can\'t see acme-labs']);
  assert.equal(file.pulls[0]?.id, 'github:pr:acme/webapp#1');
  assert.match(await readFile(cfg.pullsFile, 'utf8'), /\n$/);

  await writeFile(cfg.pullsFile, '{not json');
  assert.equal(await readPullsFile(cfg.pullsFile), null, 'garbage reads as no file');

  // A file from before a field existed still reads, with the field filled in, and
  // an entry missing what nothing can stand in for is dropped rather than thrown on.
  const { failingChecks: _dropped, lastActivityByOthers: _also, account: _too, ...older } = pull('alice', 2);
  await writeFile(
    cfg.pullsFile,
    JSON.stringify({
      version: 1,
      fetchedAt: '2026-09-14T06:00:00Z',
      accounts: [null, 'alice', { login: 'alice', ok: true }],
      pulls: [older, 'junk', { id: 'github:pr:acme/webapp#3' }],
    }),
  );
  const upgraded = await readPullsFile(cfg.pullsFile);
  assert.equal(upgraded?.pulls.length, 1);
  assert.deepEqual(upgraded?.pulls[0]?.failingChecks, []);
  assert.equal(upgraded?.pulls[0]?.lastActivityByOthers, null);
  assert.equal(upgraded?.pulls[0]?.account, '');
  assert.deepEqual(upgraded?.accounts, [{ login: 'alice', ok: true, error: null }]);
  assert.equal(normalizeStoredPull({ id: 'x' }), null);
});

test('a stored pull from before the merge state existed reads as "nobody said"', async () => {
  const { mergeStateStatus: _gone, pendingChecks: _also, ...older } = pull('alice', 7);
  const restored = normalizeStoredPull(older);
  assert.equal(restored?.mergeStateStatus, null, 'null, not UNKNOWN: a refresh will answer properly');
  assert.deepEqual(restored?.pendingChecks, []);

  // A merge state GitHub has added since must not be read as a clean merge.
  assert.equal(normalizeStoredPull({ ...pull('alice', 7), mergeStateStatus: 'MERGE_QUEUED' })?.mergeStateStatus, 'UNKNOWN');
  assert.equal(normalizeStoredPull({ ...pull('alice', 7), mergeStateStatus: 12 })?.mergeStateStatus, null);
});

test('malformed pending checks cost their own entry and nothing else', () => {
  const restored = normalizeStoredPull({
    ...pull('alice', 8),
    pendingChecks: [
      { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/9', checkRunId: 9 },
      { name: 'ci/deploy', kind: 'status-context' },
      { name: 'shouty', kind: 'nonsense', detailsUrl: 'javascript:alert(1)' },
      { kind: 'check-run' },
      { name: '' },
      'junk',
      null,
    ],
  });
  assert.deepEqual(restored?.pendingChecks, [
    { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/9', checkRunId: 9 },
    { name: 'ci/deploy', kind: 'status-context', detailsUrl: null },
    { name: 'shouty', kind: 'check-run', detailsUrl: null },
  ]);
  assert.deepEqual(normalizeStoredPull({ ...pull('alice', 8), pendingChecks: 'nope' })?.pendingChecks, []);
});

test('the configured merge gate decides the court, and is never written to the file', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS: 'policy/merge-gate' });
  const gated: PullRequest = {
    ...pull('alice', 3421),
    reviewDecision: 'APPROVED',
    reviews: [{ login: 'bob', state: 'APPROVED', at: '2026-09-10T10:00:00Z' }],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }],
  };
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice', [gated]) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const view = board.view([], new Date('2026-09-11T09:00:00Z'));
  assert.equal(view.rows[0]?.court, 'gate');
  assert.equal(view.counts.gate, 1);
  assert.equal(view.counts.ready, 0);

  // The match comes from private configuration, so the cache must not carry it.
  const raw = await readFile(cfg.pullsFile, 'utf8');
  assert.ok(!raw.includes('court'), 'prs.json holds facts, not verdicts');
  assert.ok(!raw.includes('isMergeGate'), 'and not which of them the configuration matched');
});

test('a broken file on disk never takes the view or the poll down', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice' });
  const { account: _gone, ...noAccount } = pull('alice', 1);
  await writeFile(cfg.pullsFile, JSON.stringify({ version: 1, fetchedAt: '2026-09-14T06:00:00Z', pulls: [noAccount] }));
  const deps = fakeDeps({
    tokens: { alice: 't1' },
    fetches: {
      t1: async () => {
        throw new Error('GitHub answered 502');
      },
    },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  await board.refresh();
  const view = board.view([], new Date());
  assert.equal(view.rows.length, 1, 'the stored pull still shows');
  assert.equal(view.reason, null);
});

test('an unexpected error inside a poll is reported, not thrown', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice' });
  const deps = fakeDeps({
    tokens: { alice: 't1' },
    fetches: { t1: async () => ({ login: 'alice', pulls: [], warnings: [], orgs: null as never, rateLimitRemaining: null }) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  const reason = board.view([], new Date()).reason;
  assert.match(reason?.message ?? '', /unexpected error/);
  assert.match(reason?.detail ?? '', /\n\s+at /, 'nobody planned for it, so the stack is the detail');
});

test('a tab opening on a stale board fetches at once; a fresh one waits', async () => {
  const cfg = await config();
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice', []) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  const fetches = () => deps.calls.filter((call) => call.startsWith('fetch:')).length;
  assert.equal(fetches(), 1);

  board.setAudience(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches(), 1, 'just fetched, so the next one is scheduled, not started');
  board.setAudience(0);
  board.stop();

  const stale = new Board(cfg, () => {}, deps);
  // Never polled in this process, so the last poll is at the epoch and long overdue.
  stale.setAudience(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches(), 2, 'a board with no poll behind it fetches as soon as someone looks');
  stale.stop();
});

test('stop cancels a fetch in flight so nothing lands afterwards', async () => {
  const cfg = await config();
  let release: (() => void) | null = null;
  let changes = 0;
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: {
      t1: () =>
        new Promise((resolve) => {
          release = () => resolve({ login: 'alice', pulls: [pull('alice', 1)], warnings: [], orgs: {}, rateLimitRemaining: null });
        }),
    },
  });
  const board = new Board(cfg, () => changes++, deps);
  const started = board.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  board.stop();
  release!();
  await started;
  assert.equal(board.view([], new Date()).rows.length, 1, 'the fake ignores the signal, so its answer still lands');
  assert.ok(changes >= 2);
});

test('a disabled board does nothing and says so', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB: 'off' });
  const deps = fakeDeps({ accounts: [{ login: 'alice', active: true }], tokens: { active: 't1' } });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  await board.refresh();
  assert.deepEqual(deps.calls, []);
  const view = board.view([], new Date());
  assert.equal(view.enabled, false);
  assert.deepEqual(view.rows, []);
});

test('change notifications fire when a fetch starts and when it lands', async () => {
  const cfg = await config();
  let changes = 0;
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice', []) },
  });
  const board = new Board(cfg, () => changes++, deps);
  await board.start();
  assert.equal(changes, 2);
});

test('an org only one account can see is normal; one nobody can see is a warning', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice,alice_corp', DAILY_FOCUS_GITHUB_SCOPE: 'acme,acme-corp,acme-typo' });
  const deps = fakeDeps({
    tokens: { alice: 't1', alice_corp: 't2' },
    fetches: {
      t1: ok('alice', [], [], { acme: 'ok', 'acme-corp': 'not-found', 'acme-typo': 'not-found' }),
      t2: ok('alice_corp', [], [], { acme: 'not-found', 'acme-corp': 'ok', 'acme-typo': 'not-found' }),
    },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();

  const { warnings } = board.view([], new Date());
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0] ?? '', /None of the polled accounts can find an organisation or user called acme-typo/);
});

test('with one account, an org it cannot find is a warning straight away', async () => {
  const cfg = await config({ DAILY_FOCUS_GITHUB_SCOPE: 'acme-typo' });
  const deps = fakeDeps({
    accounts: [{ login: 'alice', active: true }],
    tokens: { active: 't1' },
    fetches: { t1: ok('alice', [], [], { 'acme-typo': 'not-found' }) },
  });
  const board = new Board(cfg, () => {}, deps);
  await board.start();
  assert.match(board.view([], new Date()).warnings[0] ?? '', /^Can't find an organisation or user called acme-typo/);
});
