/**
 * A write a row's button asked for that failed: the note it leaves on the
 * row's card, and the toast that points to it.
 *
 * The note is the point. A toast goes in seconds, and the reason it gave, often
 * a long line from the merge helper or GitHub, went with it. The note stays on
 * the card the click was made from until it is put away, the write goes
 * through, or the row shows it happened anyway, and it offers the same write
 * again. The server is a stand-in for `fetch`.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { h, render } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, handlersWith, mount, mountOne, settle, uiWith } from './dom.ts';
import { TOAST_MS, handlers, showError, showToast } from '../client/actions.ts';
import { Toast } from '../client/app.ts';
import { renderPullRow } from '../client/board.ts';
import { formatTime } from '../client/format.ts';
import { WRITE_FAILURES_KEY, readWriteFailures, state, ui } from '../client/state.ts';
import { renderTicketRow } from '../client/tickets.ts';
import type { WriteFailure } from '../client/types.ts';
import { writeFailureNote } from '../client/writefailure.ts';
import { resolveTickets } from '../src/tickets.ts';
import type { BoardRow, DashboardState, TicketRow } from '../src/types.ts';

const NOW = '2026-11-05T09:50:00Z';
const PR = 'github:pr:acme/payments-api#412';
const HELPER_SAID = 'ERROR: could not reach the queue service, please check that you are connected.';

function row(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    id: PR,
    account: 'alice',
    repo: 'acme/payments-api',
    number: 412,
    title: 'Change 412',
    url: 'https://github.com/acme/payments-api/pull/412',
    isDraft: false,
    createdAt: '2026-11-03T09:00:00Z',
    readyAt: '2026-11-03T09:00:00Z',
    updatedAt: '2026-11-04T09:00:00Z',
    headRef: 'alice/change-412',
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
    headSha: 'head-412',
    lastActivityByYou: '2026-11-04T09:00:00Z',
    lastActivityByOthers: null,
    nodeId: 'PR_kwDOAcme412',
    defaultBranch: 'main',
    mergeMethod: 'SQUASH',
    mergeHelper: { kind: 'queue', label: 'Add to merge queue', stacks: false },
    court: 'ready',
    decision: 'APPROVED',
    reasons: [],
    stale: false,
    nudge: false,
    since: '2026-11-04T09:00:00Z',
    status: 'open',
    notes: [],
    offers: ['helper', 'merge'],
    ...overrides,
  };
}

function ticketRow(workflowStatus = 'In Progress'): TicketRow {
  const rows = resolveTickets(
    [
      {
        id: 'jira:PROJ-7',
        key: 'PROJ-7',
        summary: 'Retire the old importer',
        workflowStatus,
        statusCategory: 'indeterminate',
        issueType: 'Task',
        url: 'https://acme.atlassian.net/browse/PROJ-7',
        hasAnyPr: true,
        hasOpenPr: false,
        allPrsClosed: true,
      },
    ],
    [],
    new Date(NOW),
  );
  assert.equal(rows.length, 1, 'the fixture should produce one row');
  return rows[0]!;
}

function stateWith(rows: BoardRow[], tickets: TicketRow[] = []): DashboardState {
  return {
    now: NOW,
    items: [],
    board: { enabled: true, rows },
    tickets: { enabled: true, rows: tickets, inProgress: [], statuses: { PROJ: ['In Progress', 'In Review', 'Done'] } },
  } as unknown as DashboardState;
}

const failure = (overrides: Partial<WriteFailure> = {}): WriteFailure => ({
  headline: 'Couldn’t add it to the merge queue',
  message: HELPER_SAID,
  at: '2026-11-05T09:46:00Z',
  attempts: 1,
  retry: { kind: 'merge', route: 'helper' },
  ...overrides,
});

function server(answer: (path: string) => Response | Promise<Response>) {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return answer(String(url));
  }) as typeof fetch;
  return requests;
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await settle();
  assert.ok(done(), 'it never landed');
}

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const asked: string[] = [];

function confirmWith(answer: boolean): void {
  window.confirm = (message?: string) => {
    asked.push(message ?? '');
    return answer;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  asked.length = 0;
  ui.pending.value = new Set();
  ui.writeFailures.value = new Map();
  sessionStorage.clear();
  handlers.hideToast();
  handlers.hideToast();
  state.value = null;
  ui.view.value = 'today';
  ui.drawers.value = new Map();
  // Each test's cards are its own: a note is found by its row, and Show takes the first showing.
  document.body.replaceChildren();
});

const note = (root: Element) => byClass(root, 'write-failure')[0];

/** Put an element at `top` in the window, which happy-dom doesn't lay out. */
function placeAt(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () => ({ top, bottom: top + 80, left: 0, right: 600, width: 600, height: 80, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

/* ---------- the note ---------- */

test('the note says what failed, when, and why in the words given, with Try again and Dismiss', () => {
  const node = mountOne(renderPullRow(row(), stateWith([row()]), uiWith({ writeFailures: new Map([[PR, failure()]]) }), handlersWith()));
  const shown = note(node);
  assert.ok(shown, 'expected the note on the card');
  assert.equal(byClass(shown, 'write-failure__headline')[0]?.textContent, 'Couldn’t add it to the merge queue');
  assert.equal(byClass(shown, 'write-failure__when')[0]?.textContent, `at ${formatTime('2026-11-05T09:46:00Z')}`);
  assert.equal(byClass(shown, 'write-failure__message')[0]?.textContent, HELPER_SAID, 'the whole reason, not cut to a line');
  assert.deepEqual(buttonLabels(shown), ['Try again', 'Dismiss']);
  assert.deepEqual(
    [...shown.children].map((child) => child.className),
    ['write-failure__head', 'write-failure__message', 'write-failure__actions'],
    'the reason comes before the buttons, to the eye and the keyboard alike',
  );
  assert.equal(shown.getAttribute('role'), 'group');
  const by = (attr: string) => document.getElementById(shown.getAttribute(attr) ?? '')?.textContent;
  assert.equal(by('aria-labelledby'), `!Couldn’t add it to the merge queue at ${formatTime('2026-11-05T09:46:00Z')}`);
  assert.equal(by('aria-describedby'), HELPER_SAID, 'a screen reader that lands on it hears why');
});

test('a click on the note, or a selection in it, leaves the panel alone; elsewhere on the card it opens it', () => {
  const selected: string[] = [];
  const node = mountOne(
    renderPullRow(row(), stateWith([row()]), uiWith({ writeFailures: new Map([[PR, failure()]]) }), handlersWith({ onSelect: (id) => void selected.push(id) })),
  );
  (byClass(node, 'write-failure__message')[0] as HTMLElement).click();
  (byClass(node, 'write-failure__headline')[0] as HTMLElement).click();
  assert.deepEqual(selected, []);
  (byClass(node, 'item__meta')[0] as HTMLElement).click();
  assert.deepEqual(selected, [PR]);
});

test('a card with no failure has no note', () => {
  const node = mountOne(renderPullRow(row(), stateWith([row()]), uiWith(), handlersWith()));
  assert.equal(note(node), undefined);
});

test('after failing again it says how many times, and when last', () => {
  const node = mountOne(writeFailureNote(PR, stateWith([row()]), uiWith({ writeFailures: new Map([[PR, failure({ attempts: 3, at: '2026-11-05T09:49:00Z' })]]) }), handlersWith()));
  assert.equal(byClass(node, 'write-failure__when')[0]?.textContent, `3 attempts · last at ${formatTime('2026-11-05T09:49:00Z')}`);
});

test('Try again is left out where the row no longer offers that write, and is busy while one is on its way', () => {
  const failures = new Map([[PR, failure()]]);
  const gone = mountOne(writeFailureNote(PR, stateWith([row({ offers: ['merge'] })]), uiWith({ writeFailures: failures }), handlersWith()));
  assert.deepEqual(buttonLabels(gone), ['Dismiss'], 'the helper is no longer offered, so asking it again would be refused');

  const busy = mountOne(writeFailureNote(PR, stateWith([row()]), uiWith({ writeFailures: failures, pending: new Set([PR]) }), handlersWith()));
  const retry = [...busy.querySelectorAll('button')].find((each) => each.textContent === 'Trying…') as HTMLButtonElement | undefined;
  assert.ok(retry?.disabled, 'disabled while the write is on its way');
  assert.equal(retry?.getAttribute('aria-busy'), 'true');
});

test("a failed move offers Try again only where the card's status menu would offer that status", () => {
  const move = new Map([['jira:PROJ-7', failure({ headline: 'Couldn’t move it to Done', retry: { kind: 'move', key: 'PROJ-7', status: 'Done', from: 'In Progress' } })]]);
  const labels = (current: DashboardState) => buttonLabels(mountOne(writeFailureNote('jira:PROJ-7', current, uiWith({ writeFailures: move }), handlersWith())));
  assert.deepEqual(labels(stateWith([], [ticketRow()])), ['Try again', 'Dismiss']);
  const unseen = { ...stateWith([], [ticketRow()]), tickets: { ...stateWith([], [ticketRow()]).tickets, statuses: { PROJ: ['In Progress', 'In Review'] } } } as DashboardState;
  assert.deepEqual(labels(unseen), ['Dismiss'], 'a status the project is not seen in is no longer offered');
  assert.deepEqual(labels(stateWith([], [{ ...ticketRow(), mine: false } as TicketRow])), ['Dismiss'], "a teammate's ticket is theirs to move");
  assert.deepEqual(labels(stateWith([], [])), ['Dismiss'], 'nor one the page no longer has');
});

test('a note the row contradicts is not shown: it is in the merge queue after all', () => {
  const failures = new Map([[PR, failure()]]);
  assert.equal(writeFailureNote(PR, stateWith([row({ helperQueued: true })]), uiWith({ writeFailures: failures }), handlersWith()), null);
  assert.equal(writeFailureNote(PR, stateWith([row({ inMergeQueue: true })]), uiWith({ writeFailures: failures }), handlersWith()), null);
  const ready = new Map([[PR, failure({ retry: { kind: 'ready' } })]]);
  assert.equal(writeFailureNote(PR, stateWith([row({ isDraft: false })]), uiWith({ writeFailures: ready }), handlersWith()), null, 'it is ready for review already');
});

test('its buttons ask for the retry and the dismissal by the row id', () => {
  const calls: string[] = [];
  const node = mountOne(
    writeFailureNote(
      PR,
      stateWith([row()]),
      uiWith({ writeFailures: new Map([[PR, failure()]]) }),
      handlersWith({ retryWrite: (id) => void calls.push(`retry ${id}`), dismissWriteFailure: (id) => void calls.push(`dismiss ${id}`) }),
    ),
  );
  for (const each of node.querySelectorAll('button')) (each as HTMLButtonElement).click();
  assert.deepEqual(calls, [`retry ${PR}`, `dismiss ${PR}`]);
});

/* ---------- what a failure leaves, and what clears it ---------- */

test('a refused merge leaves its note on the card and in this tab, and Try again asks again and clears it', async () => {
  state.value = stateWith([row()]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  handlers.mergePull(PR, 'helper');
  await until(() => ui.pending.value.size === 0 && ui.writeFailures.value.has(PR));

  const kept = ui.writeFailures.value.get(PR)!;
  assert.equal(kept.headline, 'Couldn’t add it to the merge queue');
  assert.equal(kept.message, HELPER_SAID);
  assert.deepEqual(readWriteFailures(sessionStorage.getItem(WRITE_FAILURES_KEY)).get(PR)?.message, HELPER_SAID, 'kept for the self-reload an update brings');
  await until(() => ui.toast.value !== null);
  assert.equal(ui.toast.value?.message, 'Couldn’t add acme/payments-api#412 to the merge queue. The reason is on its card.');
  assert.equal(ui.toast.value?.sticky, false, 'the toast only points; the note is what stays');

  const node = mount(h(() => (state.value ? renderPullRow(row(), state.value, ui, handlers) : null), {}));
  assert.ok(note(node), 'the card shows it');

  // Again, refused again: the count goes up, rather than a second note.
  handlers.hideToast();
  (document.activeElement as HTMLElement | null)?.blur?.();
  placeAt(note(node)!, 200);
  handlers.retryWrite(PR);
  await until(() => ui.pending.value.size === 0 && ui.writeFailures.value.get(PR)?.attempts === 2);
  await settle();
  assert.deepEqual(asked, ['Add acme/payments-api #412 to the merge queue?', 'Add acme/payments-api #412 to the merge queue?'], 'Try again asks first, as the button does');
  // The disabled button dropped the keyboard to the page, and the note is in the window:
  // the keyboard goes to it, which says it there.
  assert.ok(document.activeElement === note(node), 'the keyboard is on the note');
  assert.equal(ui.toast.value, null, 'and no toast points at what the keyboard is already on');

  // And then it goes through.
  server(() => reply({ ...stateWith([row({ helperQueued: true })]), notice: 'Added to the queue' }));
  handlers.retryWrite(PR);
  await until(() => ui.pending.value.size === 0 && !ui.writeFailures.value.has(PR));
  // `peek`, not `value`: the assertion above has narrowed `value` to null for the type checker.
  assert.equal(ui.toast.peek()?.message, 'Added to the queue');
  assert.equal(sessionStorage.getItem(WRITE_FAILURES_KEY), null);
  await settle();
  assert.equal(note(node), undefined, 'the card no longer shows it');
  render(null, node);
});

test('Dismiss puts it away, in this tab too', () => {
  ui.writeFailures.value = new Map([[PR, failure()], ['jira:PROJ-7', failure({ retry: { kind: 'move', key: 'PROJ-7', status: 'Done', from: null } })]]);
  handlers.dismissWriteFailure(PR);
  assert.deepEqual([...ui.writeFailures.value.keys()], ['jira:PROJ-7']);
  assert.deepEqual([...readWriteFailures(sessionStorage.getItem(WRITE_FAILURES_KEY)).keys()], ['jira:PROJ-7']);
});

test('a refused Jira move leaves its note on the ticket card, and Try again moves from where it is now', async () => {
  const ticket = ticketRow();
  state.value = stateWith([], [ticket]);
  server((path) => (path === '/api/tickets/transition' ? reply({ error: 'Transition is not allowed from In Progress to Done.' }, 409) : reply(stateWith([], [ticket]))));
  handlers.moveTicket('PROJ-7', 'Done', 'In Progress');
  await until(() => ui.pending.value.size === 0 && ui.writeFailures.value.has('jira:PROJ-7'));
  assert.equal(ui.writeFailures.value.get('jira:PROJ-7')?.headline, 'Couldn’t move it to Done');
  await until(() => ui.toast.value !== null);
  assert.equal(ui.toast.value?.message, 'Couldn’t move PROJ-7 to Done. The reason is on its card.');

  const node = mountOne(renderTicketRow(ticket, state.value!, ui, handlers));
  assert.equal(byClass(note(node)!, 'write-failure__message')[0]?.textContent, 'Transition is not allowed from In Progress to Done.');
  assert.deepEqual(buttonLabels(note(node)!), ['Try again', 'Dismiss']);

  const requests = server(() => reply(stateWith([], [ticketRow('Done')])));
  handlers.retryWrite('jira:PROJ-7');
  await until(() => ui.pending.value.size === 0 && !ui.writeFailures.value.has('jira:PROJ-7'));
  assert.deepEqual(requests, ['POST /api/tickets/transition']);
  assert.equal(ui.toast.value?.message, 'PROJ-7 moved to Done');
  assert.equal(ui.toast.value?.action?.label, 'Undo', 'and its Undo goes back to In Progress');
});

test('a state that shows the write happened anyway clears its note', async () => {
  state.value = stateWith([row()]);
  ui.writeFailures.value = new Map([[PR, failure()]]);
  sessionStorage.setItem(WRITE_FAILURES_KEY, JSON.stringify([[PR, failure()]]));
  server(() => reply(stateWith([row({ helperQueued: true })])));
  handlers.refreshBoard();
  await until(() => !ui.writeFailures.value.has(PR));
  assert.equal(sessionStorage.getItem(WRITE_FAILURES_KEY), null);
});

test('what this tab kept is read back, and anything malformed is left out', () => {
  const good = failure();
  const read = readWriteFailures(
    JSON.stringify([
      [PR, good],
      ['github:pr:acme/payments-api#9', { ...good, retry: { kind: 'explode' } }],
      ['github:pr:acme/payments-api#8', { headline: 'x' }],
      'not an entry',
      ['jira:PROJ-7', { ...good, attempts: 'many', retry: { kind: 'move', key: 'PROJ-7', status: 'Done', from: null } }],
    ]),
  );
  assert.deepEqual([...read.keys()], [PR, 'jira:PROJ-7']);
  assert.deepEqual(read.get(PR), good);
  assert.equal(read.get('jira:PROJ-7')?.attempts, 1);
  assert.deepEqual(readWriteFailures('{not json'), new Map());
  assert.deepEqual(readWriteFailures(null), new Map());
});

/* ---------- the toast ---------- */

test('an error stays until it is closed; anything else goes, unless the pointer is on it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  showError('Could not refresh: the server is down');
  t.mock.timers.tick(TOAST_MS * 10);
  assert.equal(ui.toast.value?.message, 'Could not refresh: the server is down', 'an error is not timed out');
  handlers.hideToast();

  showToast('Saved');
  handlers.holdToast(true);
  t.mock.timers.tick(TOAST_MS * 2);
  assert.equal(ui.toast.value?.message, 'Saved', 'held while the pointer is on it');
  handlers.holdToast(false);
  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(ui.toast.value?.message, 'Saved', 'its full time again once the pointer leaves');
  t.mock.timers.tick(1);
  assert.equal(ui.toast.value, null);
});

test('an error toast is spoken as an alert and closes with ×; a notice is spoken politely, with its button', async () => {
  const root = mount(h(Toast, { ui, handlers }));
  const pill = root.querySelector('.toast') as HTMLElement;
  const alert = root.querySelector('[role="alert"]') as HTMLElement;
  const status = root.querySelector('[role="status"]') as HTMLElement;
  assert.ok(alert && status, 'both live regions are on the page before anything is said');
  assert.equal(pill.getAttribute('role'), null, 'the pill itself is not a live region, so nothing is said twice');

  showError('Could not save: disk full');
  await settle();
  assert.equal(alert.textContent, 'Could not save: disk full');
  assert.equal(status.textContent, '');
  assert.equal(pill.getAttribute('data-error'), 'true');
  assert.deepEqual(buttonLabels(pill), ['×']);
  (pill.querySelector('.toast__close') as HTMLButtonElement).click();
  await settle();
  assert.equal(ui.toast.value, null);
  assert.ok(pill.hidden);
  assert.equal(alert.textContent, '');

  let undone = 0;
  showToast('Snoozed', () => undone++);
  await settle();
  assert.equal(status.textContent, 'Snoozed');
  assert.deepEqual(buttonLabels(pill), ['Undo']);
  (pill.querySelector('.toast__action') as HTMLButtonElement).click();
  assert.equal(undone, 1);
  assert.equal(ui.toast.value, null);
});

test('a notice over an error goes in its time, and the error comes back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  showError('Could not save: disk full');
  showToast('Copied');
  assert.equal(ui.toast.value?.message, 'Copied');
  t.mock.timers.tick(TOAST_MS);
  assert.equal(ui.toast.value?.message, 'Could not save: disk full', 'closing it is the only way an error goes');
  handlers.hideToast();
  assert.equal(ui.toast.value, null);
});

test('a refresh that works takes away the error the last one left', async () => {
  state.value = stateWith([row()]);
  server(() => reply({ error: 'gh is not signed in' }, 502));
  handlers.refreshBoard();
  await until(() => ui.toast.value?.sticky === true);
  assert.equal(ui.toast.value?.message, 'Could not refresh GitHub: gh is not signed in');
  server(() => reply(stateWith([row()])));
  handlers.refreshBoard();
  await until(() => ui.toast.value === null);
});

test("with the panel open over the board, the keyboard goes to the panel's copy of the note", async () => {
  state.value = stateWith([row()]);
  ui.writeFailures.value = new Map([[PR, failure()]]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  const card = mount(h(() => (state.value ? renderPullRow(row(), state.value, ui, handlers) : null), {}));
  const panel = mount(h('aside', { id: 'flyout' }, h(() => (state.value ? writeFailureNote(PR, state.value, ui, handlers) : null), {})));
  placeAt(note(card)!, 200);
  placeAt(note(panel)!, 120);
  (document.activeElement as HTMLElement | null)?.blur?.();
  handlers.retryWrite(PR);
  await until(() => ui.pending.value.size === 0 && ui.writeFailures.value.get(PR)?.attempts === 2);
  await settle();
  assert.ok(document.activeElement === note(panel), "the panel's copy, which sits over the board's");
  assert.equal(ui.toast.value, null);
  render(null, card);
  render(null, panel);
});

test('a note out of the window takes no focus: the page stays put, and a toast says what failed', async () => {
  state.value = stateWith([row()]);
  ui.writeFailures.value = new Map([[PR, failure()]]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  const node = mount(h(() => (state.value ? renderPullRow(row(), state.value, ui, handlers) : null), {}));
  // Scrolled on down the board while the helper works, with nothing focused, as Safari leaves a click.
  placeAt(note(node)!, 2400);
  (document.activeElement as HTMLElement | null)?.blur?.();
  handlers.retryWrite(PR);
  await until(() => ui.pending.value.size === 0 && ui.toast.value?.action?.label === 'Show');
  assert.ok(document.activeElement !== note(node), 'nothing was focused, so nothing scrolled');
  assert.equal(ui.toast.value?.message, 'Couldn’t add acme/payments-api#412 to the merge queue. The reason is on its card.');
  render(null, node);
});

test("when the keyboard has moved on, a toast says what failed, and its Show brings the card's note into view", async () => {
  state.value = stateWith([row()]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  const toast = mount(h(Toast, { ui, handlers }));
  const node = mount(h(() => (state.value ? renderPullRow(row(), state.value, ui, handlers) : null), {}));
  // Typing a note somewhere else while the helper works: the keyboard is left where it is.
  const elsewhere = document.createElement('input');
  document.body.append(elsewhere);
  handlers.mergePull(PR, 'helper');
  elsewhere.focus();
  await until(() => ui.pending.value.size === 0 && ui.toast.value?.action?.label === 'Show');
  assert.ok(document.activeElement === elsewhere, 'the keyboard stays where it went');
  assert.equal(ui.toast.value?.message, 'Couldn’t add acme/payments-api#412 to the merge queue. The reason is on its card.');
  assert.equal(ui.toast.value?.error, true);

  await settle();
  (toast.querySelector('.toast__action') as HTMLButtonElement).click();
  assert.ok(document.activeElement === note(node), 'the keyboard is on the note');
  assert.ok(note(node)!.classList.contains('write-failure--revealed'), 'marked for a moment, for the eye');
  assert.equal(ui.toast.value, null, 'and the toast has done its job');
  render(null, node);
});

test('Show from the toast keeps an error it covered, which comes back until it is closed', async () => {
  state.value = stateWith([row()]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  const toast = mount(h(Toast, { ui, handlers }));
  const node = mount(h(() => (state.value ? renderPullRow(row(), state.value, ui, handlers) : null), {}));
  showError('Could not save: disk full');
  const elsewhere = document.createElement('input');
  document.body.append(elsewhere);
  handlers.mergePull(PR, 'helper');
  elsewhere.focus();
  await until(() => ui.pending.value.size === 0 && ui.toast.value?.action?.label === 'Show');
  await settle();

  (toast.querySelector('.toast__action') as HTMLButtonElement).click();
  assert.ok(document.activeElement === note(node), 'the keyboard is on the note');
  assert.equal(ui.toast.value?.message, 'Could not save: disk full', 'the error it covered is back, not cleared with it');
  assert.equal(ui.toast.value?.sticky, true);
  render(null, node);
});

test("Show goes to the board and unfolds the row's section when its card isn't showing, and says so when it is nowhere", async () => {
  state.value = stateWith([row()]);
  ui.drawers.value = new Map([['board:ready', false]]);
  server((path) => (path === '/api/board/merge' ? reply({ error: HELPER_SAID }, 409) : reply(stateWith([row()]))));
  confirmWith(true);
  const toast = mount(h(Toast, { ui, handlers }));
  handlers.mergePull(PR, 'helper');
  await until(() => ui.pending.value.size === 0 && ui.toast.value?.action?.label === 'Show');
  await settle();
  (toast.querySelector('.toast__action') as HTMLButtonElement).click();
  assert.equal(ui.view.value, 'board');
  assert.equal(ui.drawers.value.get('board:ready'), true);
  // Nothing renders the board here, so even there the note can't be found.
  await until(() => ui.toast.value !== null);
  assert.equal(ui.toast.value?.message, 'Its card isn’t on the page any more, so its note can’t be shown.');
});

