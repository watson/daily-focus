/**
 * What the page does when a pull request row's GitHub buttons are clicked: Merge
 * asks first and Ready for review doesn't, each sends the row's id and nothing
 * else, the row is pending until the server answers, and GitHub's refusal is
 * what the toast says. The server is a stand-in for `fetch`.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { settle } from './dom.ts';
import { handlers, mergeQuestion } from '../client/actions.ts';
import { state, ui } from '../client/state.ts';
import type { BoardRow, DashboardState } from '../src/types.ts';

function row(number: number, overrides: Partial<BoardRow> = {}): BoardRow {
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
    headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
    lastActivityByYou: '2026-11-02T09:00:00Z',
    lastActivityByOthers: null,
    nodeId: `PR_kwDOAcme${number}`,
    defaultBranch: 'main',
    mergeMethod: 'SQUASH',
    court: 'ready',
    decision: 'APPROVED',
    reasons: [],
    stale: false,
    nudge: false,
    since: '2026-11-02T09:00:00Z',
    status: 'open',
    notes: [],
    offers: ['merge'],
    ...overrides,
  };
}

function stateWith(rows: BoardRow[]): DashboardState {
  return { now: '2026-11-03T12:00:00Z', items: [], board: { enabled: true, rows } } as unknown as DashboardState;
}

/** The requests the page made, and a way to answer each in turn. */
function server(answer: (path: string, body: unknown) => Response | Promise<Response>) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ method: init?.method ?? 'GET', path, body });
    return answer(path, body);
  }) as typeof fetch;
  return requests;
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Wait for what a click set going to land. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await settle();
  assert.ok(done(), 'it never landed');
}

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const asked: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  asked.length = 0;
  ui.pending.value = new Set();
  handlers.hideToast();
});

function confirmWith(answer: boolean): void {
  window.confirm = (message?: string) => {
    asked.push(message ?? '');
    return answer;
  };
}

test('Merge asks first, naming the pull request, the branch and the method', () => {
  assert.equal(mergeQuestion(row(412, { mergeMethod: 'MERGE' })), 'Merge acme/payments-api #412 into main?');
  assert.equal(mergeQuestion(row(412)), 'Squash and merge acme/payments-api #412 into main?');
  assert.equal(mergeQuestion(row(412, { mergeMethod: 'REBASE' })), 'Rebase and merge acme/payments-api #412 into main?');
  assert.equal(mergeQuestion(row(413, { mergeQueue: true, offers: ['queue'] })), 'Add acme/payments-api #413 to the merge queue for main?');
});

test('a no sends nothing', async () => {
  state.value = stateWith([row(412)]);
  const requests = server(() => assert.fail('nothing should be sent'));
  confirmWith(false);
  handlers.mergePull('github:pr:acme/payments-api#412');
  await settle();
  assert.deepEqual(asked, ['Squash and merge acme/payments-api #412 into main?']);
  assert.deepEqual(requests, []);
  assert.equal(ui.pending.value.size, 0);
});

test('a yes sends the row id and the way to merge, and the row is pending until the server answers', async () => {
  const merged = stateWith([]);
  let answer: (res: Response) => void = () => {};
  state.value = stateWith([row(412)]);
  const requests = server(() => new Promise<Response>((resolve) => (answer = resolve)));
  confirmWith(true);

  handlers.mergePull('github:pr:acme/payments-api#412');
  await until(() => requests.length === 1);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/board/merge', body: { id: 'github:pr:acme/payments-api#412', head: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', route: 'merge' } }]);
  assert.ok(ui.pending.value.has('github:pr:acme/payments-api#412'), 'pending while GitHub merges');

  // A second click meanwhile asks nothing and sends nothing.
  handlers.mergePull('github:pr:acme/payments-api#412');
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(requests.length, 1);

  answer(reply(merged));
  await until(() => ui.pending.value.size === 0);
  assert.deepEqual(state.value, merged, 'the board read back replaces the page');
  assert.equal(ui.toast.value?.message, 'acme/payments-api#412 merged into main');
});

test('Ready for review does not ask', async () => {
  state.value = stateWith([row(410, { isDraft: true, court: 'draft', offers: ['ready'] })]);
  const requests = server(() => reply(stateWith([row(410, { court: 'reviewers', offers: [] })])));
  window.confirm = () => assert.fail('marking ready asks nothing');

  handlers.markReady('github:pr:acme/payments-api#410');
  await until(() => ui.toast.value !== null);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/board/ready', body: { id: 'github:pr:acme/payments-api#410' } }]);
  assert.equal(ui.toast.value?.message, 'acme/payments-api#410 is ready for review');
  assert.equal(ui.pending.value.size, 0);
});

test("GitHub's refusal is what the toast says, and the page reads the board again", async () => {
  state.value = stateWith([row(413, { mergeQueue: true, offers: ['queue'] })]);
  const requests = server((path) =>
    path === '/api/board/merge' ? reply({ error: 'Head branch was modified. Review and try the merge again.' }, 409) : reply(stateWith([])),
  );
  confirmWith(true);

  handlers.mergePull('github:pr:acme/payments-api#413');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.deepEqual(asked, ['Add acme/payments-api #413 to the merge queue for main?']);
  assert.equal(ui.toast.value?.message, 'GitHub would not queue acme/payments-api#413: Head branch was modified. Review and try the merge again.');
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['POST /api/board/merge', 'GET /api/state'],
  );
});
