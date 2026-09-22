/**
 * Whether a Jira ticket's status matches what its pull requests say, and nothing
 * else. Pure, for the reason `prs.ts` is: the verdict depends on the user's
 * private configuration, so it is derived on every read and never stored.
 */

import type { Action, Ticket, TicketCourt, TicketRow } from './types.ts';
import { canonicalId } from './ids.ts';
import { foldActionLog } from './store.ts';

/** Order the courts render in: closest to finished first. */
const COURT_ORDER: readonly TicketCourt[] = ['settled', 'started', 'idle'];

export function ticketCourtOrder(court: TicketCourt): number {
  return COURT_ORDER.indexOf(court);
}

/**
 * Whether the user has declared this status a place a ticket may legitimately sit
 * still.
 *
 * Case-insensitive and trimmed, which is deliberately looser than the exact match
 * `matchMergeGates` uses, because the two lists are different kinds of thing. A
 * merge-gate check name is GitHub's own string, copied from a ruleset; a status
 * name is one the user reads off a Jira board and retypes. And the costs run
 * opposite ways: a gate matched wrongly invents a claim about a repository's
 * policy, while a hold status matched wrongly only means a row keeps showing —
 * visible, and self-correcting the moment they notice.
 */
function onHold(ticket: Ticket, holdStatuses: readonly string[]): boolean {
  const status = ticket.workflowStatus.trim().toLowerCase();
  if (status === '') return false;
  return holdStatuses.some((hold) => hold.trim().toLowerCase() === status);
}

/**
 * What looks wrong about this ticket's status, or null when nothing does.
 *
 * The order the questions are asked in is written out rather than left implicit,
 * as it is above `judge` in `prs.ts`. The three conditions happen to be mutually
 * exclusive — the first needs a pull request with none open, the second needs one
 * open, the third needs none at all — so the order is for the reader rather than
 * for the result, and any future court has to earn its place in it.
 *
 *   1. every pull request Jira knows about is closed, and the ticket isn't Done
 *   2. the status says the work hasn't begun, and a pull request is open
 *   3. the status claims work in flight with no code linked to it at all
 *
 * What is deliberately *not* asked: whether an open pull request is still a draft,
 * which is the difference between "In Progress" and "In Review" and the one
 * transition this board says nothing about. A draft counts as open here, so the
 * first question passes over it — but that is a fact `jira.ts` has to go and
 * establish rather than one JQL hands over, since `.open` excludes drafts. What
 * stays out of scope is the *court*: saying "this is still a draft, so you are
 * not really In Review" would need to know which pull request, and the only join
 * to one is a key in a branch name that more than a third of real pull requests
 * don't carry.
 *
 * The first question also demands `allPrsClosed` rather than reading it off
 * `hasAnyPr && !hasOpenPr`. Those two cannot distinguish "every pull request is
 * closed" from "the panel could not be read", and this court is the one that
 * tells the user to go and finish something.
 *
 * `holdStatuses` silences the third question only. A status the user has named as
 * a deliberate hold — Blocked, On Hold, Waiting — is an answer to "why isn't this
 * moving", so a ticket sitting in one with no code is exactly what it claims to
 * be. It is not an answer to "your pull requests all merged, so what is this
 * blocked on": that ticket stays flagged.
 */
export function judge(ticket: Ticket, holdStatuses: readonly string[] = []): TicketCourt | null {
  if (ticket.statusCategory === 'done') return null;
  if (ticket.hasAnyPr && !ticket.hasOpenPr && ticket.allPrsClosed) return 'settled';
  if (ticket.statusCategory === 'new' && ticket.hasOpenPr) return 'started';
  if (ticket.statusCategory === 'indeterminate' && !ticket.hasAnyPr && !onHold(ticket, holdStatuses)) return 'idle';
  return null;
}

/**
 * The board: every fetched ticket that looks wrong, joined with the action log.
 *
 * A ticket nothing looks wrong about is dropped rather than carried as a row with
 * no court — including a parked one, since the park was about a complaint that no
 * longer stands.
 *
 * Only two things in the log are honoured, exactly as on the pull request board
 * and for the same reason. A snooze parks the row until its date; `foldActionLog`
 * has already turned an expired one back into open. Notes are shown. Done and
 * dismissed are ignored on purpose: the ids are shared with the brief, which may
 * raise "reply to the question on PROJ-8842", and marking that done says nothing
 * about the ticket's status. Nor would it need to — the fix for one of these rows
 * is a status change in Jira, and the next read drops the row on its own.
 *
 * Sorted by court only. `Array.prototype.sort` is stable, so rows keep the order
 * they arrived in within each court, which is Jira's own `ORDER BY updated ASC` —
 * least recently touched first. That ordering is the only claim this board makes
 * about age, because none of the timestamp fields survive `acli`'s search
 * whitelist and a made-up "5 days on the list" pill is worse than none.
 */
export function resolveTickets(
  tickets: readonly Ticket[],
  actions: readonly Action[],
  now: Date,
  holdStatuses: readonly string[] = [],
): TicketRow[] {
  const folded = foldActionLog(actions, now);

  const rows: TicketRow[] = [];
  for (const ticket of tickets) {
    const court = judge(ticket, holdStatuses);
    if (!court) continue;
    const log = folded.get(canonicalId(ticket.id));
    const row: TicketRow = {
      ...ticket,
      court,
      status: log?.status === 'snoozed' ? 'snoozed' : 'open',
      notes: log?.notes ?? [],
    };
    if (row.status === 'snoozed' && log?.snoozedUntil) row.snoozedUntil = log.snoozedUntil;
    rows.push(row);
  }

  return rows.sort((a, b) => ticketCourtOrder(a.court) - ticketCourtOrder(b.court));
}

/** How many rows sit in each court, plus the parked ones, for the badge and headers. */
export function countTickets(rows: readonly TicketRow[]): Record<TicketCourt | 'parked', number> {
  const counts: Record<TicketCourt | 'parked', number> = { settled: 0, started: 0, idle: 0, parked: 0 };
  for (const row of rows) {
    if (row.status === 'snoozed') counts.parked++;
    else counts[row.court]++;
  }
  return counts;
}
