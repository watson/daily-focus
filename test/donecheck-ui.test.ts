/**
 * The done check's line, as a ticket row and a Projects card render it.
 *
 * The rules worth holding: each verdict reads as itself with when it was
 * checked; one from before the latest change says so; a failure says it failed
 * and never reads as complete; Check now asks for the ticket it is on; and the
 * line is advice, so nothing else about the row changes with it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { byClass, handlersWith, mount, mountOne, uiWith } from './dom.ts';
import { checkPending } from '../client/donecheck.ts';
import { renderTicketBoard, renderTicketRow } from '../client/tickets.ts';
import type { Handlers, UiValues } from '../client/types.ts';
import { resolveInProgress, resolveTickets } from '../src/tickets.ts';
import type { DashboardState, DoneCheckState, DoneCheckTicket, ProjectState, Ticket } from '../src/types.ts';
import { epicRead, hoursAgo, projectsState, stateWith } from './projectfixtures.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const HOURS_AGO = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'jira:PAY-8842',
    key: 'PAY-8842',
    summary: 'Cap the ingest retries',
    workflowStatus: 'Committed',
    statusCategory: 'new',
    issueType: 'Task',
    url: 'https://acme.atlassian.net/browse/PAY-8842',
    hasAnyPr: true,
    hasOpenPr: false,
    allPrsClosed: true,
    pulls: [{ repo: 'acme/ingest', number: 12, title: 'Cap retries', url: 'https://github.com/acme/ingest/pull/12', state: 'merged', closedAt: HOURS_AGO(30), headSha: 'abc1234' }],
    ...overrides,
  };
}

function checks(entry: Partial<DoneCheckTicket> | null, overrides: Partial<DoneCheckState> = {}): DoneCheckState {
  return {
    enabled: true,
    auto: false,
    limit: 50,
    usedToday: 0,
    tickets: entry ? { 'PAY-8842': { checkable: true, verdict: null, running: null, failure: null, dueAt: null, ...entry } } : {},
    ...overrides,
  };
}

/** The row in Out of sync, with the done check as given. */
function row(doneCheck: DoneCheckState | undefined, ui: Partial<UiValues> = {}, handlers: Partial<Handlers> = {}): HTMLElement {
  const [flagged] = resolveTickets([ticket()], [], NOW);
  assert.ok(flagged, 'the fixture should be out of sync');
  const state = { now: NOW.toISOString(), doneCheck } as unknown as DashboardState;
  return mountOne(renderTicketRow(flagged, state, uiWith(ui), handlersWith(handlers)));
}

const text = (node: Element | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const line = (node: Element): HTMLElement | undefined => byClass(node, 'item__check')[0];

test('each verdict reads as itself, with when it was checked', () => {
  const left = row(checks({ verdict: { verdict: 'work-left', line: 'The backoff never resets.', at: HOURS_AGO(2), current: true } }));
  assert.equal(text(line(left)), '✦Work left: The backoff never resets. · checked 2 h ago Check again');
  assert.equal(line(left)!.dataset.verdict, 'work-left');

  const complete = row(checks({ verdict: { verdict: 'complete', line: '', at: HOURS_AGO(2), current: true } }));
  assert.equal(text(line(complete)), '✦Looks complete · checked 2 h ago Check again');

  const unclear = row(checks({ verdict: { verdict: 'unclear', line: 'The description is empty.', at: HOURS_AGO(26), current: true } }));
  assert.match(text(line(unclear)), /^✦Can’t tell: The description is empty\. · checked/);
});

test('a verdict from before the latest change says so, until the new one lands', () => {
  const stale = row(
    checks({ verdict: { verdict: 'complete', line: '', at: HOURS_AGO(3), current: false }, dueAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() }, { auto: true }),
  );
  assert.match(text(line(stale)), /Looks complete · checked 3 h ago · from before the latest change · checks on its own around .+, once it has settled/);
  assert.equal(line(stale)!.dataset.age, 'stale');

  const capped = row(
    checks({ verdict: { verdict: 'complete', line: '', at: HOURS_AGO(3), current: false }, dueAt: NOW.toISOString() }, { auto: true, usedToday: 50 }),
  );
  assert.match(text(line(capped)), /from before the latest change · today’s 50 checks are used/);
});

test('a failed check says it failed, and never reads as complete', () => {
  const failed = row(checks({ failure: { error: 'it answered, but not in the shape asked for', at: HOURS_AGO(1), current: true } }));
  assert.match(text(line(failed)), /^✦Couldn’t check whether its pull requests finish it: it answered, but not in the shape asked for · 1 h ago/);
  assert.doesNotMatch(text(line(failed)), /complete/i);

  const after = row(
    checks({
      verdict: { verdict: 'work-left', line: 'Docs are missing.', at: HOURS_AGO(5), current: false },
      failure: { error: 'Claude is busy right now', at: HOURS_AGO(1), current: true },
    }),
  );
  assert.match(text(line(after)), /Work left: Docs are missing\. · checked 5 h ago · from before the latest change · checking again failed/);
});

test('a running check says so, with nothing to press', () => {
  const running = row(checks({ running: { since: HOURS_AGO(0), by: 'click' } }));
  assert.equal(text(line(running)), '✦Checking whether its pull requests finish it…');
  assert.equal(line(running)!.dataset.status, 'running');
  assert.equal(byClass(running, 'item__check-now').length, 0);
});

test('Check now asks for the ticket it is on, waits while its request goes, and needs the assistant', () => {
  const asked: string[] = [];
  const fresh = row(checks({}), {}, { checkTicket: (key) => void asked.push(key) });
  assert.equal(text(line(fresh)), '✦Not checked yet whether its pull requests finish it Check now');
  byClass(fresh, 'item__check-now')[0]!.click();
  assert.deepEqual(asked, ['PAY-8842']);

  const pending = row(checks({}), { pending: new Set([checkPending('PAY-8842')]) });
  assert.equal((byClass(pending, 'item__check-now')[0] as HTMLButtonElement).disabled, true);
  assert.equal(row(checks({}), { pending: new Set([checkPending('PAY-8842')]) }).dataset.pending, 'false', 'the row itself stays live');

  const off = row(checks({ verdict: { verdict: 'complete', line: '', at: HOURS_AGO(2), current: true } }, { enabled: false }));
  assert.equal(byClass(off, 'item__check-now').length, 0, 'no CLI to check with');
  assert.match(text(line(off)), /Looks complete/, 'the verdict stays');
});

test('nothing is said about a ticket the check has no part in, or by a server older than the page', () => {
  assert.equal(line(row(checks(null))), undefined);
  assert.equal(line(row(checks({ checkable: false }))), undefined);
  assert.equal(line(row(undefined)), undefined);
});

test('a verdict is advice: the row keeps its court, its status and its controls', () => {
  const plain = row(checks(null));
  const judged = row(checks({ verdict: { verdict: 'complete', line: '', at: HOURS_AGO(2), current: true } }));
  for (const name of ['court', 'status', 'selected', 'pending']) assert.equal(judged.dataset[name], plain.dataset[name], name);
  assert.equal(text(byClass(judged, 'item__meta--status')[0]), 'Committed');
  assert.deepEqual(
    byClass(judged, 'item__actions').map((node) => text(node)),
    byClass(plain, 'item__actions').map((node) => text(node)),
  );
});

test('a Working on row shows the line too', () => {
  const [working] = resolveInProgress([ticket({ statusCategory: 'indeterminate', workflowStatus: 'In Review' })], [], NOW);
  const state = {
    now: NOW.toISOString(),
    doneCheck: checks({ verdict: { verdict: 'work-left', line: 'Backfill missing.', at: HOURS_AGO(1), current: true } }),
  } as unknown as DashboardState;
  const node = mountOne(renderTicketRow(working!, state, uiWith(), handlersWith()));
  assert.match(text(line(node)), /Work left: Backfill missing\./);
});

/* ---------- on a Projects card ---------- */

test('a Projects card shows the verdict on the user’s own ticket, with Check now, and none on a teammate’s', () => {
  const read = epicRead();
  const open: Record<string, ProjectState> = { [read.root.key]: { key: read.root.key, read, fetching: false, reason: null } };
  const state = stateWith(projectsState({ open }));
  const entry = (verdict: DoneCheckTicket['verdict']): DoneCheckTicket => ({ checkable: true, verdict, running: null, failure: null, dueAt: null });
  state.doneCheck = {
    ...checks(null),
    tickets: {
      'PAY-201': entry({ verdict: 'work-left', line: 'The index is not in the migration.', at: hoursAgo(1), current: true }),
      // Never there for a teammate's ticket; drawn on no card if it were.
      'PAY-205': entry({ verdict: 'complete', line: '', at: hoursAgo(1), current: true }),
    },
  };
  const asked: string[] = [];
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith({ checkTicket: (key) => void asked.push(key) }))));
  const card = (key: string) => node.querySelector(`.merge-order__row[data-key="${key}"] .project-card`)!;
  assert.ok(card('PAY-201'), 'the fixture puts PAY-201 in the merge order');
  assert.match(text(line(card('PAY-201'))), /Work left: The index is not in the migration\. · checked 1 h ago/);
  assert.equal(line(card('PAY-205')), undefined);
  assert.equal(line(card('PAY-202')), undefined, 'nothing for a ticket the check has no part in');
  byClass(card('PAY-201'), 'item__check-now')[0]!.click();
  assert.deepEqual(asked, ['PAY-201']);
  assert.equal(card('PAY-201').getAttribute('data-stage'), 'ready', 'its stage is still its pull requests’');
});
