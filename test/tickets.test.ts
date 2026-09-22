/**
 * The rules that decide whether a ticket's status looks wrong. These tests are
 * the spec, as `test/prs.test.ts` is for the pull request board.
 *
 * The case worth being loudest about is the one that motivated the whole board:
 * a ticket needing several pull requests must not be called finished while any
 * of them is still open, *including* while one is still a draft. That is what
 * `hasOpenPr` carries, and three tests below pin it from both sides.
 *
 * `allPrsClosed` is the second half of that, and it exists because the first
 * half was silently untrue for a year: JQL's `.open` does not count a draft, so
 * `hasOpenPr` alone said "finished" about a ticket whose every pull request was
 * still being written. The settled court now demands a positive confirmation,
 * and the tests at the end of the judge section pin the three ways it can be
 * withheld.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countTickets, judge, resolveTickets, ticketCourtOrder } from '../src/tickets.ts';
import type { Action, Ticket } from '../src/types.ts';

const NOW = new Date('2026-09-22T09:00:00Z');

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  const base: Ticket = {
    id: 'jira:PROJ-8842',
    key: 'PROJ-8842',
    summary: 'Drop the retry loop from the ingest path',
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: 'https://acme.atlassian.net/browse/PROJ-8842',
    hasAnyPr: true,
    hasOpenPr: false,
    allPrsClosed: true,
    ...overrides,
  };
  // `allPrsClosed` defaults to whatever would be coherent with the two counts,
  // which is what a confirmed panel read produces, so every case that predates
  // the field keeps meaning what it did. A test wanting the unconfirmed ticket —
  // closed counts, no panel — sets it to false explicitly.
  return { ...base, allPrsClosed: overrides.allPrsClosed ?? (base.hasAnyPr && !base.hasOpenPr) };
}

/* ---------- judge ---------- */

test('a ticket whose every pull request is closed is settled, whatever its status', () => {
  for (const [workflowStatus, statusCategory] of [
    ['Committed', 'new'],
    ['In Progress', 'indeterminate'],
    ['In Review', 'indeterminate'],
  ] as const) {
    assert.equal(judge(ticket({ workflowStatus, statusCategory })), 'settled', workflowStatus);
  }
});

test('a ticket with a pull request still open is left alone', () => {
  assert.equal(judge(ticket({ hasAnyPr: true, hasOpenPr: true })), null);
});

/**
 * The multi-pull-request case, which is the reason this board reads Jira's own
 * counts rather than joining to GitHub. A draft counts as open, so the habit of
 * opening every pull request up front — most of them drafts — is what keeps a
 * half-finished ticket out of `settled` on its own. Jira's JQL does not supply
 * that on its own; `jira.ts` reads the development panel to make it true.
 */
test('a ticket is not settled while one of several pull requests is still a draft', () => {
  const stillDrafting = ticket({ workflowStatus: 'In Review', hasAnyPr: true, hasOpenPr: true });
  assert.equal(judge(stillDrafting), null);

  // The last draft merges, the panel confirms it, and only then does it read as
  // finished. Both halves are needed: `hasOpenPr` alone going false is exactly
  // the state a draft-only ticket used to arrive in.
  assert.equal(judge({ ...stillDrafting, hasOpenPr: false, allPrsClosed: true }), 'settled');
  assert.equal(judge({ ...stillDrafting, hasOpenPr: false, allPrsClosed: false }), null);
});

/**
 * The settled court is the one that tells the user to go and finish something,
 * so it is the one that has to be told, rather than left to infer. A panel that
 * could not be read leaves the two counts saying exactly what a draft-only
 * ticket's counts say, which is why the verdict is a field of its own.
 */
test('the settled court needs the panel to have confirmed it, not merely not denied it', () => {
  assert.equal(judge(ticket({ hasAnyPr: true, hasOpenPr: false, allPrsClosed: true })), 'settled');
  assert.equal(judge(ticket({ hasAnyPr: true, hasOpenPr: false, allPrsClosed: false })), null);
});

test('an unconfirmed ticket is dropped rather than pushed into another court', () => {
  // Withholding the settled verdict must not invent a different complaint: the
  // row disappears for the round and comes back when the panel can be read.
  for (const statusCategory of ['new', 'indeterminate', 'undefined'] as const) {
    assert.equal(
      judge(ticket({ statusCategory, hasAnyPr: true, hasOpenPr: false, allPrsClosed: false })),
      null,
      statusCategory,
    );
  }
});

test('a ticket in a To Do status with an open pull request has started without saying so', () => {
  assert.equal(
    judge(ticket({ workflowStatus: 'Committed', statusCategory: 'new', hasAnyPr: true, hasOpenPr: true })),
    'started',
  );
});

test('an unstarted ticket with no pull requests is the backlog, not a problem', () => {
  assert.equal(judge(ticket({ workflowStatus: 'Committed', statusCategory: 'new', hasAnyPr: false, hasOpenPr: false })), null);
});

test('a ticket claiming work in flight with nothing linked is idle', () => {
  assert.equal(judge(ticket({ hasAnyPr: false, hasOpenPr: false })), 'idle');
});

test('a hold status answers the idle question, so it is not asked', () => {
  const blocked = ticket({ workflowStatus: 'Blocked', hasAnyPr: false, hasOpenPr: false });
  assert.equal(judge(blocked), 'idle');
  assert.equal(judge(blocked, ['Blocked']), null);
});

test('a hold status is matched case-insensitively and trimmed', () => {
  const blocked = ticket({ workflowStatus: 'Blocked', hasAnyPr: false, hasOpenPr: false });
  assert.equal(judge(blocked, ['  blocked  ']), null);
  assert.equal(judge(blocked, ['On Hold']), 'idle');
});

/**
 * Hold silences "why isn't this moving", which is a question it answers. It does
 * not silence "your pull requests all merged, so what is this still blocked on",
 * which it doesn't.
 */
test('a hold status does not excuse a ticket whose pull requests all merged', () => {
  const blocked = ticket({ workflowStatus: 'Blocked', hasAnyPr: true, hasOpenPr: false });
  assert.equal(judge(blocked, ['Blocked']), 'settled');
});

test('a ticket that is already Done is never flagged', () => {
  assert.equal(judge(ticket({ workflowStatus: 'Done', statusCategory: 'done' })), null);
  assert.equal(judge(ticket({ workflowStatus: 'Done', statusCategory: 'done', hasAnyPr: false })), null);
});

test('an uncategorised status is only ever judged on its pull requests', () => {
  assert.equal(judge(ticket({ statusCategory: 'undefined', hasAnyPr: true, hasOpenPr: false })), 'settled');
  // Nothing is claimed about a status Jira itself declines to place.
  assert.equal(judge(ticket({ statusCategory: 'undefined', hasAnyPr: false, hasOpenPr: false })), null);
  assert.equal(judge(ticket({ statusCategory: 'undefined', hasAnyPr: true, hasOpenPr: true })), null);
});

/* ---------- resolveTickets ---------- */

const settled = ticket({ id: 'jira:PROJ-1', key: 'PROJ-1', hasAnyPr: true, hasOpenPr: false });
const started = ticket({
  id: 'jira:PROJ-2',
  key: 'PROJ-2',
  workflowStatus: 'Committed',
  statusCategory: 'new',
  hasAnyPr: true,
  hasOpenPr: true,
});
const idle = ticket({ id: 'jira:PROJ-3', key: 'PROJ-3', hasAnyPr: false, hasOpenPr: false });
const healthy = ticket({ id: 'jira:PROJ-4', key: 'PROJ-4', hasAnyPr: true, hasOpenPr: true });

test('only the tickets that look wrong become rows', () => {
  const rows = resolveTickets([settled, started, idle, healthy], [], NOW);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['jira:PROJ-1', 'jira:PROJ-2', 'jira:PROJ-3'],
  );
});

test('rows are grouped by court, closest to finished first', () => {
  const rows = resolveTickets([idle, started, settled], [], NOW);
  assert.deepEqual(
    rows.map((row) => row.court),
    ['settled', 'started', 'idle'],
  );
  assert.ok(ticketCourtOrder('settled') < ticketCourtOrder('started'));
  assert.ok(ticketCourtOrder('started') < ticketCourtOrder('idle'));
});

/**
 * Jira is asked for `ORDER BY updated ASC` and the sort is stable, so the least
 * recently touched ticket in a court stays at the top of it. That ordering is the
 * only thing this board says about age — none of the timestamp fields survive
 * acli's search whitelist — so losing it would lose the lot.
 */
test('the order Jira returned survives within a court', () => {
  const older = ticket({ id: 'jira:PROJ-10', key: 'PROJ-10', hasAnyPr: true, hasOpenPr: false });
  const newer = ticket({ id: 'jira:PROJ-11', key: 'PROJ-11', hasAnyPr: true, hasOpenPr: false });
  const rows = resolveTickets([older, newer, idle], [], NOW);
  assert.deepEqual(
    rows.map((row) => row.key),
    ['PROJ-10', 'PROJ-11', 'PROJ-3'],
  );
});

const at = (iso: string) => iso;

test('a snooze parks a row and carries its date', () => {
  const actions: Action[] = [{ id: 'jira:PROJ-1', action: 'snooze', at: at('2026-09-22T08:00:00Z'), until: '2026-09-30' }];
  const rows = resolveTickets([settled], actions, NOW);
  assert.equal(rows[0]?.status, 'snoozed');
  assert.equal(rows[0]?.snoozedUntil, '2026-09-30');
  assert.deepEqual(countTickets(rows), { settled: 0, started: 0, idle: 0, parked: 1 });
});

test('an expired snooze is open again', () => {
  const actions: Action[] = [{ id: 'jira:PROJ-1', action: 'snooze', at: at('2026-09-01T08:00:00Z'), until: '2026-09-10' }];
  assert.equal(resolveTickets([settled], actions, NOW)[0]?.status, 'open');
});

/**
 * The ids are shared with the brief, which may raise "reply to the question on
 * PROJ-8842" — and marking that done says nothing about the ticket's status. The
 * fix for one of these rows is a status change in Jira, and the next read drops
 * it without being told.
 */
test('done and dismiss are ignored, as they are on the pull request board', () => {
  for (const action of ['done', 'dismiss'] as const) {
    const rows = resolveTickets([settled], [{ id: 'jira:PROJ-1', action, at: at('2026-09-22T08:00:00Z') }], NOW);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0]?.status, 'open', action);
  }
});

test('notes are carried onto the row and never change its status', () => {
  const actions: Action[] = [
    { id: 'jira:PROJ-1', action: 'note', at: at('2026-09-22T08:00:00Z'), text: 'two more repos to go' },
  ];
  const rows = resolveTickets([settled], actions, NOW);
  assert.equal(rows[0]?.status, 'open');
  assert.deepEqual(
    rows[0]?.notes.map((note) => note.text),
    ['two more repos to go'],
  );
});

test('an action is matched to a ticket through the canonical id', () => {
  const actions: Action[] = [{ id: '  JIRA:PROJ-1  ', action: 'snooze', at: at('2026-09-22T08:00:00Z'), until: '2026-09-30' }];
  assert.equal(resolveTickets([settled], actions, NOW)[0]?.status, 'snoozed');
});

/** A park was about a complaint. When the complaint goes, so does the row. */
test('a parked ticket that no longer looks wrong is dropped rather than left in the drawer', () => {
  const actions: Action[] = [{ id: 'jira:PROJ-1', action: 'snooze', at: at('2026-09-22T08:00:00Z'), until: '2026-09-30' }];
  const fixed = { ...settled, workflowStatus: 'Done', statusCategory: 'done' as const };
  assert.deepEqual(resolveTickets([fixed], actions, NOW), []);
});

test('the hold list reaches judge through resolveTickets', () => {
  assert.deepEqual(resolveTickets([{ ...idle, workflowStatus: 'Blocked' }], [], NOW, ['Blocked']), []);
});

test('counts add up per court, with parked counted once and only once', () => {
  const actions: Action[] = [{ id: 'jira:PROJ-3', action: 'snooze', at: at('2026-09-22T08:00:00Z'), until: '2026-09-30' }];
  const rows = resolveTickets([settled, started, idle, healthy], actions, NOW);
  assert.deepEqual(countTickets(rows), { settled: 1, started: 1, idle: 0, parked: 1 });
});
