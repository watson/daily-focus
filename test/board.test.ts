import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Board, readPullsFile, type BoardDeps } from '../src/board.ts';
import { GhAuthError, GhMissingError, type AccountFetch } from '../src/github.ts';
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
    mergeable: 'UNKNOWN',
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

const ok = (login: string, pulls: PullRequest[], warnings: string[] = []) => async (): Promise<AccountFetch> => ({
  login,
  pulls,
  warnings,
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
  assert.match(view.warnings[0] ?? '', /^alice_corp: no token/);
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
        return { login: 'alice_corp', pulls: [pull('alice_corp', 9)], warnings: [], rateLimitRemaining: 4000 };
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
  assert.match(view.warnings.join('\n'), /alice_corp: GitHub answered 502/);
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
  assert.match(view.reason ?? '', /gh is not logged in/);
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
  assert.match(board.view([], new Date()).reason ?? '', /could not run `\/nope\/gh`/);
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
