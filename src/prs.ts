import type { Action, BoardRow, Court, CourtReason, PullRequest, ReviewDecision } from './types.ts';
import { canonicalId } from './ids.ts';
import { foldActionLog } from './store.ts';
import { laterISO, parseISO } from './time.ts';

/**
 * How long a pull request may sit waiting on reviewers before the board suggests
 * asking. Calendar hours, not working hours: a Friday afternoon PR being flagged
 * on Monday morning is the right answer.
 */
export const NUDGE_AFTER_MS = 24 * 3_600_000;

/** How long a draft may go untouched before it's flagged as parked-by-accident. */
export const STALE_DRAFT_AFTER_MS = 14 * 86_400_000;

const COURT_ORDER: readonly Court[] = ['you', 'ready', 'reviewers', 'draft'];

/** Order the buckets render in: what only you can move first, drafts last. */
export function courtOrder(court: Court): number {
  return COURT_ORDER.indexOf(court);
}

function ms(iso: string | null | undefined): number | null {
  const parsed = parseISO(iso);
  return parsed ? parsed.getTime() : null;
}

/**
 * Stand in for `reviewDecision` when the repository requires no reviews.
 *
 * GitHub only reports a decision under branch protection; everywhere else it is
 * null, which would leave an approved PR looking unreviewed forever. The latest
 * review per person is enough to say: any outstanding request for changes wins,
 * otherwise any approval counts.
 */
export function deriveDecision(pr: PullRequest): ReviewDecision {
  if (pr.reviewDecision) return pr.reviewDecision;
  if (pr.reviews.some((review) => review.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (pr.reviews.some((review) => review.state === 'APPROVED')) return 'APPROVED';
  return null;
}

interface Judgement {
  court: Court;
  decision: ReviewDecision;
  reasons: CourtReason[];
  stale: boolean;
  nudge: boolean;
  since: string;
}

/** The newest review in a given state, or undefined. */
function newest(pr: PullRequest, state: string): { login: string; at: string } | undefined {
  return pr.reviews.filter((review) => review.state === state).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

/**
 * Whose move it is, and why.
 *
 * `lastNoteAt` is the newest note the user left through the dashboard. A note is
 * treated as "I did something about this" for the nudge timer only: nudging on
 * Slack is invisible to GitHub, and this is how the board is told. It never moves
 * a PR between courts, since the court is about what GitHub can see.
 */
export function judge(pr: PullRequest, now: Date, lastNoteAt: string | null): Judgement {
  const decision = deriveDecision(pr);
  // `?? null`: a pull read back from an older file may lack the key entirely.
  const you = pr.lastActivityByYou ?? null;
  const others = pr.lastActivityByOthers ?? null;

  if (pr.isDraft) {
    const touched = you ?? pr.createdAt;
    const idle = now.getTime() - (ms(touched) ?? now.getTime());
    return { court: 'draft', decision, reasons: [], stale: idle >= STALE_DRAFT_AFTER_MS, nudge: false, since: touched };
  }

  const reasons: CourtReason[] = [];
  if (decision === 'CHANGES_REQUESTED') {
    const request = newest(pr, 'CHANGES_REQUESTED');
    reasons.push({ kind: 'changes-requested', login: request?.login, at: request?.at });
  }
  if (pr.checks === 'failure') reasons.push({ kind: 'ci-failing' });
  if (pr.mergeable === 'CONFLICTING') reasons.push({ kind: 'conflicts' });

  const theirMove = others !== null && (you === null || others.at > you);
  const approval = newest(pr, 'APPROVED');
  // An approval is itself "someone acted after you", and the right reading of it
  // is ready, not your move. Anything by others newer than the newest approval is
  // by definition not that approval: a comment in the conversation, an inline
  // review comment, a "one more thing before you merge". That puts it back in
  // your court.
  const afterApproval = others !== null && approval !== undefined && others.at > approval.at;
  const ready = decision === 'APPROVED' && !afterApproval;

  if (theirMove && others && !ready) {
    reasons.push({ kind: 'activity', login: others.login, at: others.at, activity: others.kind });
  }

  if (reasons.length > 0) {
    // The wait began when the ball landed: their last action if that's what put it
    // here, otherwise whenever GitHub last saw the PR change.
    const since = theirMove && others ? others.at : pr.updatedAt;
    return { court: 'you', decision, reasons, stale: false, nudge: false, since };
  }

  if (ready) {
    return { court: 'ready', decision, reasons, stale: false, nudge: false, since: approval?.at ?? pr.updatedAt };
  }

  // Waiting on reviewers, since the later of becoming ready and your last push.
  const since = laterISO(pr.readyAt, you) ?? pr.createdAt;
  const quietSince = laterISO(since, lastNoteAt) ?? since;
  const waited = now.getTime() - (ms(quietSince) ?? now.getTime());
  return { court: 'reviewers', decision, reasons, stale: false, nudge: waited >= NUDGE_AFTER_MS, since };
}

/**
 * The board: every fetched PR, judged, joined with the action log, and sorted so
 * the longest wait in each court comes first.
 *
 * Only two things in the log are honoured. A snooze parks the row until its date,
 * which is how a draft is deliberately shelved; `foldActionLog` has already turned
 * an expired one back into open. Notes are shown, and the newest one resets the
 * nudge timer. Done and dismissed are ignored on purpose: the brief may raise "CI
 * failing on #3402" and the user may mark that done, but #3402 is still open, and
 * this board shows what is open.
 */
export function resolveBoard(pulls: readonly PullRequest[], actions: readonly Action[], now: Date): BoardRow[] {
  const folded = foldActionLog(actions, now);

  const rows = pulls.map((pr): BoardRow => {
    const log = folded.get(canonicalId(pr.id));
    const notes = log?.notes ?? [];
    const lastNoteAt = notes.length > 0 ? notes[notes.length - 1]!.at : null;
    const verdict = judge(pr, now, lastNoteAt);

    const row: BoardRow = { ...pr, ...verdict, status: log?.status === 'snoozed' ? 'snoozed' : 'open', notes };
    if (row.status === 'snoozed' && log?.snoozedUntil) row.snoozedUntil = log.snoozedUntil;
    return row;
  });

  return rows.sort((a, b) => {
    const court = courtOrder(a.court) - courtOrder(b.court);
    if (court !== 0) return court;
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** How many rows sit in each court, plus the parked ones, for the badge and the headers. */
export function countBoard(rows: readonly BoardRow[]): Record<Court | 'parked', number> {
  const counts: Record<Court | 'parked', number> = { you: 0, ready: 0, reviewers: 0, draft: 0, parked: 0 };
  for (const row of rows) {
    if (row.status === 'snoozed') counts.parked++;
    else counts[row.court]++;
  }
  return counts;
}
