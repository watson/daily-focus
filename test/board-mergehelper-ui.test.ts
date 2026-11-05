/**
 * The merge helper on the page: its button where the server offers it, with
 * GitHub's merge beside it, Merge stack on a stack's top, "in merge queue" on
 * what it took, and what a click asks, sends and says. Rows come from the server's own reading (`resolveBoard`)
 * with the helper's answers handed in; the server is a stand-in for `fetch`.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mountOne, settle, uiWith } from './dom.ts';
import { handlers, mergeQuestion, stackQuestion } from '../client/actions.ts';
import { renderPullRow } from '../client/board.ts';
import { state, ui } from '../client/state.ts';
import { resolveBoard, type MergeContext } from '../src/prs.ts';
import type { BoardRow, DashboardState, MergeHelperView, PullRequest } from '../src/types.ts';

const NOW = new Date('2026-11-03T12:00:00Z');

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

function rows(pulls: PullRequest[], helper: MergeHelperView | null = { kind: 'queue', label: 'Add to merge queue', stacks: true }, queued: string[] = []): BoardRow[] {
  const merging: MergeContext = { helper: () => helper, queued: (id) => queued.includes(id), approvals: () => 1 };
  return resolveBoard(pulls, [], NOW, [], null, merging);
}

const byNumber = (list: BoardRow[], number: number) => list.find((each) => each.number === number)!;

const STATE = { now: NOW.toISOString() } as unknown as DashboardState;

function render(row: BoardRow, handlersOver = handlersWith(), uiOver = uiWith()): HTMLElement {
  return mountOne(renderPullRow(row, STATE, uiOver, handlersOver));
}

const button = (node: HTMLElement, label: string) => byTag(node, 'button').find((each) => each.textContent === label) as HTMLButtonElement | undefined;

/* ---------- the row ---------- */

test("the helper's button, in its own words, comes first, GitHub's merge beside it, and each sends the row's id and its way", () => {
  const clicked: string[] = [];
  const mine = handlersWith({ mergePull: (id, route) => clicked.push(`${route} ${id}`) });
  const node = render(byNumber(rows([pull(412)], { kind: 'queue', label: 'Queue with the merge bot', stacks: false }), 412), mine);
  assert.deepEqual(buttonLabels(node), ['Queue with the merge bot', 'Squash and merge', 'Snooze']);
  assert.match(button(node, 'Queue with the merge bot')!.title, /merge helper for main/);
  assert.match(button(node, 'Squash and merge')!.title, /into main on GitHub, without the merge queue/);
  button(node, 'Queue with the merge bot')!.click();
  button(node, 'Squash and merge')!.click();
  assert.deepEqual(clicked, ['helper github:pr:acme/payments-api#412', 'merge github:pr:acme/payments-api#412']);

  // Not where GitHub's own queue is on, which a merge straight in would bypass.
  assert.deepEqual(buttonLabels(render(byNumber(rows([pull(412, { mergeQueue: true })]), 412))), ['Add to merge queue', 'Snooze']);
  // queue: false, or a check that failed, is GitHub's merge alone; still asking is no merge at all.
  assert.deepEqual(buttonLabels(render(byNumber(rows([pull(412)], null), 412))), ['Squash and merge', 'Snooze']);
  assert.deepEqual(buttonLabels(render(byNumber(rows([pull(412)], { kind: 'asking' }), 412))), ['Snooze']);
});

test('Merge stack is on the top of a stack only, and sends the top row’s id', () => {
  const clicked: string[] = [];
  const mine = handlersWith({ mergeStack: (id) => clicked.push(id), mergePull: (id) => clicked.push(`one ${id}`) });
  const board = rows([pull(410), above(411, 410), above(412, 411)]);
  assert.deepEqual(buttonLabels(render(byNumber(board, 410), mine)), ['Add to merge queue', 'Squash and merge', 'Snooze']);
  assert.deepEqual(buttonLabels(render(byNumber(board, 411), mine)), ['Snooze']);
  const top = render(byNumber(board, 412), mine);
  assert.deepEqual(buttonLabels(top), ['Merge stack', 'Snooze']);
  assert.match(button(top, 'Merge stack')!.title, /the 2 pull requests under this one and then this one, from the bottom/);
  button(top, 'Merge stack')!.click();
  assert.deepEqual(clicked, ['github:pr:acme/payments-api#412']);
});

test('what the helper took says it is in the merge queue, and so does what GitHub queued', () => {
  const pills = (row: BoardRow) => byClass(render(row), 'pill').map((pill) => pill.textContent);
  const queued = byNumber(rows([pull(412)], undefined, ['github:pr:acme/payments-api#412']), 412);
  assert.ok(pills(queued).includes('in merge queue'));
  assert.deepEqual(buttonLabels(render(queued)), ['Snooze'], 'and offers nothing more');
  assert.ok(pills(byNumber(rows([pull(413, { mergeQueue: true, inMergeQueue: true })], null), 413)).includes('in merge queue'));
  assert.ok(!pills(byNumber(rows([pull(414)]), 414)).includes('in merge queue'));
});

test("while a stack is on its way, its rows' buttons are disabled", () => {
  const board = rows([pull(410), above(411, 410), above(412, 411)]);
  const pending = uiWith({ pending: new Set(board.map((each) => each.id)) });
  for (const [number, label] of [[410, 'Add to merge queue'], [412, 'Merge stack']] as const) {
    assert.equal(button(render(byNumber(board, number), handlersWith(), pending), label)!.disabled, true, `#${number}`);
  }
});

/* ---------- a click ---------- */

/** The requests the page made, and a way to answer each. */
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

function stateWith(list: BoardRow[]): DashboardState {
  return { now: NOW.toISOString(), items: [], board: { enabled: true, rows: list } } as unknown as DashboardState;
}

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

test('the questions name the pull requests, and a stack in the order it merges', () => {
  assert.equal(mergeQuestion(byNumber(rows([pull(412)]), 412)), 'Add acme/payments-api #412 to the merge queue?');
  assert.equal(mergeQuestion(byNumber(rows([pull(412)]), 412), 'helper'), 'Add acme/payments-api #412 to the merge queue?');
  assert.equal(
    mergeQuestion(byNumber(rows([pull(412)]), 412), 'merge'),
    'Squash and merge acme/payments-api #412 into main on GitHub, without the merge queue?',
    'skipping the queue says so',
  );
  assert.equal(mergeQuestion(byNumber(rows([pull(412)], { kind: 'queue', label: 'Ship with the bot', stacks: false }), 412)), 'Ship with the bot: acme/payments-api #412?');
  const board = rows([pull(410), above(411, 410), above(412, 411)]);
  assert.equal(stackQuestion([410, 411, 412].map((number) => byNumber(board, number))), 'Merge this stack of 3 pull requests from the bottom: #410, #411, #412?');
});

test("handing one to the helper asks first, sends the head shown, and the toast is the helper's line", async () => {
  state.value = stateWith(rows([pull(412)]));
  const requests = server(() => reply({ ...stateWith([]), notice: 'Queued at position 3' }));
  confirmWith(true);
  handlers.mergePull('github:pr:acme/payments-api#412');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.deepEqual(asked, ['Add acme/payments-api #412 to the merge queue?']);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/board/merge', body: { id: 'github:pr:acme/payments-api#412', head: 'head-412', route: 'helper' } }]);
  assert.equal(ui.toast.value?.message, 'Queued at position 3');
  assert.equal('notice' in (state.value as object), false, 'the notice is not part of the state');
});

test("GitHub's merge beside the helper asks as GitHub's, sends its way, and says it merged", async () => {
  state.value = stateWith(rows([pull(412)]));
  const requests = server(() => reply(stateWith([])));
  confirmWith(true);
  handlers.mergePull('github:pr:acme/payments-api#412', 'merge');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.deepEqual(asked, ['Squash and merge acme/payments-api #412 into main on GitHub, without the merge queue?']);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/board/merge', body: { id: 'github:pr:acme/payments-api#412', head: 'head-412', route: 'merge' } }]);
  assert.equal(ui.toast.value?.message, 'acme/payments-api#412 merged into main');

  // A way the row doesn't offer asks nothing and sends nothing.
  handlers.hideToast();
  asked.length = 0;
  state.value = stateWith(rows([pull(413, { mergeQueue: true })]));
  handlers.mergePull('github:pr:acme/payments-api#413', 'merge');
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(requests.length, 1);
});

test('a helper that says nothing gets a toast of ours; its refusal is the toast, in its words', async () => {
  state.value = stateWith(rows([pull(412)]));
  server(() => reply({ ...stateWith([]), notice: '' }));
  confirmWith(true);
  handlers.mergePull('github:pr:acme/payments-api#412');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.equal(ui.toast.value?.message, 'acme/payments-api#412 went to your merge helper');

  handlers.hideToast();
  state.value = stateWith(rows([pull(412)]));
  const requests = server((path) => (path === '/api/board/merge' ? reply({ error: 'acme/payments-api is frozen for the release' }, 409) : reply(stateWith([]))));
  handlers.mergePull('github:pr:acme/payments-api#412');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.equal(ui.toast.value?.message, 'Your merge helper would not take acme/payments-api#412: acme/payments-api is frozen for the release');
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), ['POST /api/board/merge', 'GET /api/state']);
});

test('Merge stack asks with the order, sends every head shown, and keeps the whole stack pending until the answer', async () => {
  const board = rows([pull(410), above(411, 410), above(412, 411)]);
  state.value = stateWith(board);
  let answer: (res: Response) => void = () => {};
  const requests = server(() => new Promise<Response>((resolve) => (answer = resolve)));
  confirmWith(true);

  handlers.mergeStack('github:pr:acme/payments-api#412');
  await until(() => requests.length === 1);
  assert.deepEqual(asked, ['Merge this stack of 3 pull requests from the bottom: #410, #411, #412?']);
  assert.deepEqual(requests[0], {
    method: 'POST',
    path: '/api/board/merge-stack',
    body: {
      id: 'github:pr:acme/payments-api#412',
      heads: { 'github:pr:acme/payments-api#410': 'head-410', 'github:pr:acme/payments-api#411': 'head-411', 'github:pr:acme/payments-api#412': 'head-412' },
    },
  });
  assert.deepEqual([...ui.pending.value].sort(), board.map((each) => each.id).sort());

  // The bottom's own button meanwhile sends nothing.
  handlers.mergePull('github:pr:acme/payments-api#410');
  handlers.mergeStack('github:pr:acme/payments-api#412');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(asked.length, 1);

  answer(reply({ ...stateWith([]), notice: 'Stack of 3 queued' }));
  await until(() => ui.pending.value.size === 0);
  assert.equal(ui.toast.value?.message, 'Stack of 3 queued');
});

test('a no to Merge stack sends nothing, and the fallback toast names the stack', async () => {
  const board = rows([pull(410), above(411, 410), above(412, 411)]);
  state.value = stateWith(board);
  const requests = server(() => reply({ ...stateWith([]), notice: '' }));
  confirmWith(false);
  handlers.mergeStack('github:pr:acme/payments-api#412');
  await settle();
  assert.deepEqual(requests, []);

  confirmWith(true);
  handlers.mergeStack('github:pr:acme/payments-api#412');
  await until(() => ui.toast.value !== null && ui.pending.value.size === 0);
  assert.equal(ui.toast.value?.message, 'acme/payments-api#412 and the 2 under it went to your merge helper');
});
