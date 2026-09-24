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

import { countTickets, judge, resolveInProgress, resolveTickets, ticketCourtOrder } from '../src/tickets.ts';
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


/* ---------- resolveInProgress ---------- */

/**
 * The case that made Working on status-based. An In Progress ticket with no pull
 * request yet is work in progress, and the idle court flagging it is a separate
 * question — so it is a row in that court and in Working on too. It used to be
 * left out, which is to say missing from the list of work under way.
 */
test('an In Progress ticket with nothing linked is in Working on as well as its court', () => {
  assert.deepEqual(
    resolveTickets([idle], [], NOW).map((row) => row.court),
    ['idle'],
  );
  assert.deepEqual(
    resolveInProgress([idle], [], NOW).map((entry) => entry.key),
    ['PROJ-3'],
  );
});

/** Working on goes by status alone: in progress by Jira's own category, and nothing else. */
test('Working on holds what Jira has in progress, whatever a court makes of it', () => {
  const review = ticket({ id: 'jira:PROJ-5', key: 'PROJ-5', workflowStatus: 'In Review', hasAnyPr: true, hasOpenPr: true });
  const backlog = ticket({
    id: 'jira:PROJ-6',
    key: 'PROJ-6',
    workflowStatus: 'Committed',
    statusCategory: 'new',
    hasAnyPr: false,
    hasOpenPr: false,
  });
  const uncategorised = ticket({ id: 'jira:PROJ-7', key: 'PROJ-7', statusCategory: 'undefined', hasOpenPr: true });
  const finished = ticket({ id: 'jira:PROJ-8', key: 'PROJ-8', workflowStatus: 'Done', statusCategory: 'done', hasOpenPr: true });
  assert.deepEqual(
    resolveInProgress([settled, started, idle, healthy, review, backlog, uncategorised, finished], [], NOW).map(
      (entry) => entry.key,
    ),
    ['PROJ-1', 'PROJ-3', 'PROJ-4', 'PROJ-5'],
    'settled and idle are in progress too; started, the backlog, uncategorised and done are not',
  );
});

/**
 * The property Working on rests on, asked of every combination of facts rather
 * than a handful: it is exactly the tickets in progress. What the courts, the
 * hold statuses or the pull request counts say changes nothing about it.
 */
test('Working on is exactly the tickets in progress, across every combination of facts', () => {
  const all: Ticket[] = [];
  for (const statusCategory of ['new', 'indeterminate', 'done', 'undefined'] as const) {
    for (const hasAnyPr of [false, true]) {
      for (const hasOpenPr of [false, true]) {
        for (const allPrsClosed of [false, true]) {
          for (const workflowStatus of ['In Progress', 'Blocked']) {
            const key = `PROJ-${all.length + 1}`;
            all.push(ticket({ id: `jira:${key}`, key, statusCategory, hasAnyPr, hasOpenPr, allPrsClosed, workflowStatus }));
          }
        }
      }
    }
  }

  assert.deepEqual(
    resolveInProgress(all, [], NOW).map((entry) => entry.id),
    all.filter((entry) => entry.statusCategory === 'indeterminate').map((entry) => entry.id),
  );
});

/**
 * A hold status silences the idle court because it answers "why isn't this
 * moving". Working on never asked that, so the hold list has nothing to say to it:
 * a blocked ticket is in progress whether or not the court is silenced.
 */
test('the hold statuses do not reach Working on', () => {
  const blockedIdle = { ...idle, workflowStatus: 'Blocked' };
  assert.deepEqual(resolveTickets([blockedIdle], [], NOW, ['Blocked']), [], 'silenced in the court');
  assert.deepEqual(
    resolveInProgress([blockedIdle], [], NOW).map((entry) => entry.key),
    ['PROJ-3'],
    'and in Working on regardless',
  );
});

test('a ticket whose pull requests could not be confirmed is still in progress', () => {
  const unconfirmed = ticket({ id: 'jira:PROJ-9', key: 'PROJ-9', hasAnyPr: true, hasOpenPr: false, allPrsClosed: false });
  assert.deepEqual(
    resolveInProgress([unconfirmed], [], NOW).map((entry) => entry.key),
    ['PROJ-9'],
  );
});

test('Working on keeps the order Jira returned', () => {
  const older = ticket({ id: 'jira:PROJ-20', key: 'PROJ-20', hasOpenPr: true });
  const newer = ticket({ id: 'jira:PROJ-21', key: 'PROJ-21', hasOpenPr: true });
  assert.deepEqual(
    resolveInProgress([older, settled, newer], [], NOW).map((entry) => entry.key),
    ['PROJ-20', 'PROJ-1', 'PROJ-21'],
  );
});

test('notes reach Working on, matched through the canonical id', () => {
  const actions: Action[] = [
    { id: '  JIRA:PROJ-4  ', action: 'note', at: at('2026-09-22T08:00:00Z'), text: 'waiting on the schema review' },
  ];
  assert.deepEqual(
    resolveInProgress([healthy], actions, NOW)[0]?.notes.map((note) => note.text),
    ['waiting on the schema review'],
  );
});

/**
 * A park is about a complaint, and Working on makes none. So a ticket parked in a
 * court is parked there and still listed here, and nothing of the park follows it.
 */
test('a park neither hides a ticket from Working on nor follows it in', () => {
  const actions: Action[] = [{ id: 'jira:PROJ-3', action: 'snooze', at: at('2026-09-22T08:00:00Z'), until: '2026-09-30' }];
  assert.equal(resolveTickets([idle], actions, NOW)[0]?.status, 'snoozed', 'parked in its court');
  const [entry] = resolveInProgress([idle], actions, NOW);
  assert.ok(entry, 'and still in Working on');
  assert.ok(!('status' in entry), 'Working on carries no park status');
  assert.ok(!('snoozedUntil' in entry), 'nor the date of one');
  assert.ok(!('court' in entry), 'and no court, which is how the client tells the two kinds of row apart');
});

/* ---------- narrowing Working on to named statuses ---------- */

const inProgress = ticket({ id: 'jira:PROJ-30', key: 'PROJ-30', workflowStatus: 'In Progress', hasOpenPr: true });
const inReview = ticket({ id: 'jira:PROJ-31', key: 'PROJ-31', workflowStatus: 'In Review', hasOpenPr: true });
const blocked = ticket({ id: 'jira:PROJ-32', key: 'PROJ-32', workflowStatus: 'Blocked', hasAnyPr: false });

/**
 * Jira files "I am working on this" and "this waits on a reviewer" under the one
 * category, so only a name tells them apart — and which name is which belongs to
 * the user's workflow, so it arrives as configuration.
 */
test('named statuses narrow Working on to the work in your own hands', () => {
  const all = [inProgress, inReview, blocked];
  assert.deepEqual(
    resolveInProgress(all, [], NOW).map((entry) => entry.workflowStatus),
    ['In Progress', 'In Review', 'Blocked'],
    'unnamed, Working on keeps the whole category',
  );
  assert.deepEqual(
    resolveInProgress(all, [], NOW, ['In Progress']).map((entry) => entry.workflowStatus),
    ['In Progress'],
  );
});

/** One real board spelled it "In Progress" in one project and "In progress" in another. */
test('a named status is matched case-insensitively and trimmed', () => {
  const lower = { ...inProgress, workflowStatus: 'In progress' };
  assert.deepEqual(
    resolveInProgress([inProgress, lower], [], NOW, ['  in PROGRESS ']).map((entry) => entry.workflowStatus),
    ['In Progress', 'In progress'],
  );
});

/** Naming covers the flagged ones like any other: Working on is by status, not by complaint. */
test('a named status keeps a flagged ticket in Working on', () => {
  assert.deepEqual(
    resolveInProgress([idle, { ...idle, id: 'jira:PROJ-35', key: 'PROJ-35', workflowStatus: 'In Review' }], [], NOW, [
      'In Progress',
    ]).map((entry) => entry.key),
    ['PROJ-3'],
  );
});

/** The list filters the category. It cannot name a ticket into Working on from outside it. */
test('naming a status Jira does not count as in progress admits nothing', () => {
  const committed = ticket({
    id: 'jira:PROJ-34',
    key: 'PROJ-34',
    workflowStatus: 'Committed',
    statusCategory: 'new',
    hasAnyPr: false,
  });
  assert.deepEqual(resolveInProgress([committed], [], NOW, ['Committed']), []);
});

test('a ticket with no status name is never matched by a named one', () => {
  assert.deepEqual(resolveInProgress([{ ...inProgress, workflowStatus: '' }], [], NOW, ['In Progress']), []);
});
