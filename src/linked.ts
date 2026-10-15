/**
 * The ticket board's second opinion on pull requests: GitHub's, read live.
 *
 * Jira learns about pull requests from the GitHub-for-Jira connector, and that
 * connector can run days behind — a pull request merged on Monday can still be
 * open in Jira's development panel on Thursday. Every reading in `jira.ts` comes
 * from that panel, so the board inherited the lag: a finished ticket stayed out
 * of "no open pull requests left", and a ticket with a fresh pull request sat in
 * "in flight with nothing linked".
 *
 * So the board asks GitHub as well, for every pull request the user wrote that
 * is open or recently closed, finds the ticket keys in each one's title, branch,
 * description and commit messages — the places the connector reads them from —
 * and lets GitHub's answer replace Jira's where GitHub's is newer. Jira stays the
 * authority on everything GitHub cannot see: pull requests by someone else, or
 * outside the configured scope, or closed too long ago to be searched.
 *
 * Read-only, like the rest of the board's GitHub access, and borrowing the pull
 * request board's accounts and scope rather than having its own: the two boards
 * are about the same pull requests.
 */

import type { GitHubConfig } from './config.ts';
import { fetchTicketPulls, ghToken, type TicketPullsFetch } from './github.ts';
import type { LinkedPull, Ticket } from './types.ts';

/**
 * How far back closed pull requests are searched. Jira's lag is days, so this
 * only has to outlast that; but a ticket's pull requests can span weeks, and one
 * that closed before the window is one fewer than Jira counts, which leaves Jira
 * in charge of that ticket. Two months keeps that rare at a few pages a read.
 */
export const CLOSED_LOOKBACK_DAYS = 60;

/* ---------- finding keys ---------- */

const KEYISH = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*)-(\d+)/g;

/**
 * Every ticket key a piece of text could be naming, upper-cased.
 *
 * Case-insensitive, because branches are usually lower case — `proj-8842-drop-
 * retry` — and the connector reads them regardless. A key can't continue a word
 * (`XPROJ-1` names nothing) and its number is read whole, so `PROJ-12` is never
 * found inside `PROJ-123`.
 *
 * An underscore is ambiguous: project keys may contain one, and so may a branch
 * prefix. So `mara_proj-8842` offers both MARA_PROJ-8842 and PROJ-8842. That
 * generosity costs nothing, because only keys that are on the board are ever
 * looked up — which is also why "UTF-8" here is harmless.
 */
export function issueKeysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(KEYISH)) {
    const parts = match[1]!.split('_');
    for (let i = 0; i < parts.length; i++) {
      const project = parts.slice(i).join('_');
      if (/^[A-Za-z]/.test(project)) keys.add(`${project.toUpperCase()}-${match[2]}`);
    }
  }
  return keys;
}

/* ---------- reading GitHub ---------- */

export interface LinkedRead {
  /** The pull requests naming each ticket key, by the upper-cased key. */
  byKey: Map<string, LinkedPull[]>;
  /**
   * Whether every account answered, and answered in full. Only a complete reading
   * may say that a ticket's pull requests have all closed, since one it missed
   * could be the one still open; an incomplete one can still say one is open.
   */
  complete: boolean;
  /** Why the reading is incomplete, worded for the board's banner. */
  warnings: string[];
}

/** What the reading talks to, gathered so a test can supply its own. */
export interface LinkedDeps {
  token(ghPath: string, login: string | null): Promise<string>;
  search(token: string, scope: readonly string[], closedSince: string, signal?: AbortSignal): Promise<TicketPullsFetch>;
}

const realDeps: LinkedDeps = { token: ghToken, search: fetchTicketPulls };

/** What an incomplete reading costs, said once at the end of each warning about one. */
const CONSEQUENCE = 'so a merged pull request counts only once Jira has it';

/**
 * Ask GitHub, as each configured account or as gh's active one, for the pull
 * requests the user wrote that are open or closed in the last
 * `CLOSED_LOOKBACK_DAYS`, and index them by the ticket keys they name.
 *
 * Throws only when no account could be asked at all. One account failing makes
 * the reading incomplete rather than failed, for the reason `board.ts` keeps one
 * account's rows through another's outage.
 */
export async function readLinkedPulls(
  github: GitHubConfig,
  now: Date,
  signal?: AbortSignal,
  deps: LinkedDeps = realDeps,
): Promise<LinkedRead> {
  const closedSince = new Date(now.getTime() - CLOSED_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const logins: (string | null)[] = github.accounts.length > 0 ? [...github.accounts] : [null];

  const results = await Promise.allSettled(
    logins.map(async (login) => deps.search(await deps.token(github.ghPath, login), github.scope, closedSince, signal)),
  );
  if (results.every((result) => result.status === 'rejected')) {
    throw (results[0] as PromiseRejectedResult).reason;
  }

  const warnings: string[] = [];
  let complete = true;
  const byKey = new Map<string, LinkedPull[]>();
  const seen = new Set<string>();
  results.forEach((result, i) => {
    const who = logins[i] ? ` as ${logins[i]}` : '';
    if (result.status === 'rejected') {
      complete = false;
      warnings.push(`Could not ask GitHub${who} about these tickets' pull requests (${(result.reason as Error).message}), ${CONSEQUENCE}.`);
      return;
    }
    if (!result.value.complete) {
      complete = false;
      warnings.push(`GitHub did not list every pull request${who}, ${CONSEQUENCE}.`);
    }
    for (const { pull, text } of result.value.pulls) {
      if (seen.has(pull.url)) continue;
      seen.add(pull.url);
      const keys = new Set<string>();
      for (const piece of text) for (const key of issueKeysIn(piece)) keys.add(key);
      for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), pull]);
    }
  });
  return { byKey, complete, warnings };
}

/* ---------- reconciling the two ---------- */

function isOpen(pull: LinkedPull): boolean {
  return pull.state === 'open' || pull.state === 'draft';
}

/** Open ones first, then the most recently closed, so the row leads with what changed. */
function byRecency(a: LinkedPull, b: LinkedPull): number {
  if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
  return (b.closedAt ?? '').localeCompare(a.closedAt ?? '');
}

/** The pull requests GitHub has naming this ticket. */
export function linkedTo(ticket: Ticket, linked: LinkedRead | null): LinkedPull[] {
  return linked?.byKey.get(ticket.key.toUpperCase()) ?? [];
}

/**
 * Whether `reconcile` needs Jira's own count of this ticket's pull requests to
 * decide it: GitHub, reading in full, has only closed ones, and Jira has some
 * that it does not call closed. `fetchTickets` reads the development panel for
 * these, which it otherwise only does for tickets JQL says have nothing open.
 */
export function needsJiraCount(ticket: Ticket, linked: LinkedRead | null): boolean {
  const found = linkedTo(ticket, linked);
  return Boolean(linked?.complete) && found.length > 0 && !found.some(isOpen) && ticket.hasAnyPr && !ticket.allPrsClosed;
}

/**
 * The ticket with GitHub's answer folded into Jira's, given how many pull
 * requests Jira's development panel counts for it — null when that was not read.
 *
 * Two rules, and they are not symmetric:
 *
 *   1. **An open pull request on GitHub is open**, whatever Jira says and however
 *      incomplete the reading. GitHub is live, so this is a fact rather than an
 *      inference.
 *   2. **All closed takes more.** GitHub must have answered in full, every pull
 *      request it has must be closed, and it must have found at least as many as
 *      Jira counts. Jira can only be behind, never ahead, so a stale Jira knows
 *      the same pull requests or fewer; if it knows more, one of them is
 *      something GitHub could not see — another author's, another organisation's
 *      — and might be open, so Jira's reading stands.
 *
 * The count is the weak point, and deliberately the only one: it cannot tell
 * *which* pull requests Jira knows, since nothing `acli` reaches will list them.
 * An open pull request by someone else, alongside as many of the user's own
 * closed ones as Jira has heard of, would pass. The row shows the pull requests
 * whenever GitHub decided it, so that claim can always be checked in one click.
 */
export function reconcile(ticket: Ticket, linked: LinkedRead | null, jiraCount: number | null): Ticket {
  const found = [...linkedTo(ticket, linked)].sort(byRecency);
  if (found.length === 0) return ticket;

  const jira = { hasAnyPr: ticket.hasAnyPr, hasOpenPr: ticket.hasOpenPr, allPrsClosed: ticket.allPrsClosed };
  let reading = jira;
  if (found.some(isOpen)) {
    reading = { hasAnyPr: true, hasOpenPr: true, allPrsClosed: false };
  } else if (linked?.complete && !ticket.allPrsClosed) {
    // A ticket JQL found no pull requests for has a count of none, which needs no panel.
    const known = ticket.hasAnyPr ? jiraCount : 0;
    if (known !== null && found.length >= known) reading = { hasAnyPr: true, hasOpenPr: false, allPrsClosed: true };
  }

  const changed =
    reading.hasAnyPr !== jira.hasAnyPr || reading.hasOpenPr !== jira.hasOpenPr || reading.allPrsClosed !== jira.allPrsClosed;
  return { ...ticket, ...reading, pulls: found, ...(changed ? { fromGitHub: true } : {}) };
}
