/**
 * An organization's setup over HTTP: offered in the state without what it
 * suggests as sources, reviewed with a GET that changes nothing, and used, put
 * off and stopped with guarded POSTs, the first and last restarting the
 * dashboard. GitHub and gh are stand-ins throughout; the organization is
 * invented.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BoardDeps } from '../src/board.ts';
import type { OrganizationReads } from '../src/organization.ts';
import { startServer, type StartedServer } from '../src/server.ts';
import type { DashboardState } from '../src/types.ts';

const C1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const FILES: Record<string, string> = {
  'daily-focus.json': JSON.stringify({
    version: 1,
    name: 'Acme',
    settings: { DAILY_FOCUS_GITHUB_SCOPE: 'org:acme', DAILY_FOCUS_GH: '/opt/acme/gh' },
    files: { DAILY_FOCUS_MERGE_HELPER: 'bin/merge-helper' },
    sources: 'sources.md',
  }),
  'bin/merge-helper': '#!/bin/sh\necho \'{"queue": false}\'\n',
  'sources.md': '## Acme\n\n- The #payments-oncall channel\n',
};

const asked: string[] = [];
const reads: OrganizationReads = {
  accounts: async () => [{ login: 'alice', token: 'token-alice', error: null }],
  organizations: async () => ['acme'],
  repository: async (_token, org) => {
    asked.push(`repo ${org}`);
    return org === 'acme' ? { branch: 'main', commit: C1 } : null;
  },
  file: async (_token, _repo, path) => (path in FILES ? new TextEncoder().encode(FILES[path]) : null),
};

const github: BoardDeps = {
  listAccounts: async () => [{ login: 'alice', active: true }],
  token: async () => 'token-alice',
  fetch: async () => ({ login: 'alice', pulls: [], warnings: [], orgs: {}, rateLimitRemaining: 4000 }),
  markReady: async () => assert.fail('no writes'),
  merge: async () => assert.fail('no writes'),
  enqueue: async () => assert.fail('no writes'),
  requiredApprovals: async () => 1,
  liveHeads: async () => new Map(),
  runHelper: async () => ({ code: 0, signal: null, stdout: '{"queue": false}\n', stderr: '' }),
};

let root: string;
let store: string;
let env: NodeJS.ProcessEnv;
let server: StartedServer | null = null;
let restarts = 0;

async function start(): Promise<void> {
  server = await startServer(env, {
    onRestart: () => {
      restarts++;
      const previous = server;
      server = null;
      void previous!.close().then(() => start());
    },
    integrations: { github, organization: reads },
  });
}

async function restarted(count: number): Promise<void> {
  for (let i = 0; i < 300 && (restarts < count || server === null); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(server, 'the dashboard came back');
}

const url = (path: string) => `${server!.url}${path}`;
const post = (path: string, body: unknown, contentType = 'application/json') =>
  fetch(url(path), { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });
const state = async (): Promise<DashboardState> => (await (await fetch(url('/api/state'))).json()) as DashboardState;

/** The state once the look at start has landed. */
async function looked(): Promise<DashboardState> {
  for (let i = 0; i < 300; i++) {
    const current = await state();
    if (current.organization?.checkedAt) return current;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('the look at start never finished');
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-focus-server-organization-'));
  store = join(root, 'work');
  await mkdir(store);
  await writeFile(
    join(store, 'settings.json'),
    JSON.stringify({
      DAILY_FOCUS_AGENT: 'off',
      DAILY_FOCUS_CALENDAR: 'off',
      DAILY_FOCUS_JIRA: 'off',
      DAILY_FOCUS_GITHUB_ACCOUNTS: 'alice',
      // Nothing here may reach a real gh, even by accident.
      DAILY_FOCUS_GH: join(root, 'no-gh'),
    }),
  );
  env = { PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' };
  await start();
});

after(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

test('a setup found is offered in the state, without the sources it suggests', async () => {
  const current = await looked();
  assert.deepEqual(current.organization?.offers, [{ org: 'acme', name: 'Acme', commit: C1, kind: 'new', dismissed: false }]);
  assert.equal(current.organization?.adopted, null);
  assert.doesNotMatch(JSON.stringify(current), /payments-oncall/);
});

test('the review is a GET that only reads what was found', async () => {
  const before = (await readdir(store)).sort();
  const lookedAt = asked.length;
  const res = await fetch(url('/api/organization/review?org=acme'));
  assert.equal(res.status, 200);
  const review = (await res.json()) as Record<string, any>;
  assert.equal(review.name, 'Acme');
  assert.deepEqual(review.settings.map((setting: { key: string }) => setting.key), ['DAILY_FOCUS_GITHUB_SCOPE']);
  assert.deepEqual(review.skipped.map((setting: { key: string }) => setting.key), ['DAILY_FOCUS_GH']);
  assert.equal(review.files[0].path, 'bin/merge-helper');
  assert.match(review.sources.text, /payments-oncall/);
  assert.equal((await fetch(url('/api/organization/review?org=globex'))).status, 404);
  assert.deepEqual((await readdir(store)).sort(), before, 'nothing written');
  assert.equal(asked.length, lookedAt, 'and GitHub not asked');
});

test('the POSTs are behind the guard, and take the setup and the commit its review showed', async () => {
  assert.equal((await post('/api/organization/adopt', { org: 'acme', commit: C1 }, 'text/plain')).status, 415);
  assert.equal((await post('/api/organization/adopt', { org: 'acme' })).status, 400);
  assert.equal((await post('/api/organization/dismiss', { commit: C1 })).status, 400);
  const stale = await post('/api/organization/adopt', { org: 'acme', commit: 'b2'.repeat(20) });
  assert.equal(stale.status, 409);
  assert.match(((await stale.json()) as { error: string }).error, /changed since you opened it/);
  assert.equal((await post('/api/organization/leave', {})).status, 409, 'none in use');
  assert.equal((await post('/api/organization/nothing', {})).status, 404);
  assert.equal(await readFile(join(store, 'organization.json'), 'utf8').catch(() => null), null, 'nothing written');
});

test('"Not now" puts it off; "Look again" looks again', async () => {
  const res = await post('/api/organization/dismiss', { org: 'acme', commit: C1 });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as DashboardState).organization?.offers[0]?.dismissed, true);
  const checked = await post('/api/organization/check', {});
  assert.equal(checked.status, 200);
  assert.equal(((await checked.json()) as DashboardState).organization?.offers[0]?.dismissed, true, 'still put off');
});

test('"Use it" writes the setup and restarts into it; the settings page says where each value came from', async () => {
  const count = restarts;
  const res = await post('/api/organization/adopt', { org: 'acme', commit: C1 });
  assert.equal(res.status, 200);
  await restarted(count + 1);
  const record = JSON.parse(await readFile(join(store, 'organization.json'), 'utf8'));
  assert.equal(record.adopted.commit, C1);
  assert.equal(await readFile(join(store, 'organization', 'merge-helper'), 'utf8'), FILES['bin/merge-helper']);

  const page = (await (await fetch(url('/api/settings'))).json()) as Record<string, any>;
  assert.deepEqual(page.organization, { name: 'Acme' });
  const scope = page.settings.find((setting: { key: string }) => setting.key === 'DAILY_FOCUS_GITHUB_SCOPE');
  assert.deepEqual([scope.value, scope.source], ['org:acme', 'organization']);
  const helper = page.settings.find((setting: { key: string }) => setting.key === 'DAILY_FOCUS_MERGE_HELPER');
  assert.deepEqual([helper.value, helper.source], [join(store, 'organization', 'merge-helper'), 'organization']);
  const gh = page.settings.find((setting: { key: string }) => setting.key === 'DAILY_FOCUS_GH');
  assert.equal(gh.source, 'settings', 'never the setup’s');

  const current = await looked();
  assert.equal(current.organization?.adopted?.name, 'Acme');
  assert.deepEqual(current.organization?.offers, []);
});

test('"Stop using" removes the setup and restarts without it', async () => {
  const count = restarts;
  const res = await post('/api/organization/leave', {});
  assert.equal(res.status, 200);
  await restarted(count + 1);
  assert.equal(JSON.parse(await readFile(join(store, 'organization.json'), 'utf8')).adopted, null);
  assert.equal(await readdir(join(store, 'organization')).catch(() => null), null);
  const page = (await (await fetch(url('/api/settings'))).json()) as Record<string, any>;
  assert.equal(page.organization, null);
  const scope = page.settings.find((setting: { key: string }) => setting.key === 'DAILY_FOCUS_GITHUB_SCOPE');
  assert.equal(scope.source, 'default');
});

test('a setup whose values can’t be used with the store’s own is set aside at start, and the page says so', async () => {
  const other = await mkdtemp(join(tmpdir(), 'daily-focus-server-organization-conflict-'));
  try {
    const dir = join(other, 'work');
    await mkdir(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ DAILY_FOCUS_GITHUB: 'off', DAILY_FOCUS_JIRA: 'off', DAILY_FOCUS_CALENDAR: 'off', DAILY_FOCUS_WORK_END: '10' }),
    );
    await writeFile(
      join(dir, 'organization.json'),
      JSON.stringify({ adopted: { org: 'acme', name: 'Acme', commit: C1, settings: { DAILY_FOCUS_WORK_START: '11' }, files: {} }, dismissed: [] }),
    );
    const conflicted = await startServer({ ...env, DAILY_FOCUS_DATA: other });
    try {
      const current = (await (await fetch(`${conflicted.url}/api/state`)).json()) as DashboardState;
      assert.ok(current.setupWarnings.some((warning) => /Acme's setup has a value the dashboard can't use with yours, so it is ignoring the setup/.test(warning)));
      assert.ok(!current.setupWarnings.some((warning) => /ignoring the whole file/.test(warning)), 'the store’s own settings stand');
    } finally {
      await conflicted.close();
    }
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});
