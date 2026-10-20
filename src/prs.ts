import type { Action, BoardRow, Court, CourtReason, PendingCheck, PullRequest, ReviewDecision } from './types.ts';
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

const COURT_ORDER: readonly Court[] = ['you', 'ready', 'reviewers', 'gate', 'blocked', 'checks', 'draft'];

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
  nudgedAt?: string;
  nudgedUntil?: string;
}

/**
 * Which of a pull request's unfinished checks the user has declared to be the
 * repository's merge policy.
 *
 * Exact, case-sensitive string equality, because that is how GitHub's own
 * repository rules name a required status check: a check matched loosely is a
 * check matched wrongly, and the cost of a miss is a row presented as ordinary
 * pending checks rather than as a gate — while the cost of a false match is a
 * bucket claiming to know something about the policy that nobody told us.
 */
export function matchMergeGates(pr: PullRequest, gates: readonly string[]): PendingCheck[] {
  if (gates.length === 0) return [];
  return (pr.pendingChecks ?? []).filter((check) => gates.includes(check.name));
}

/**
 * Whether every pending gate says, in the line GitHub shows beside its name, that
 * approvals are all it is waiting for. `reviews` is `mergeGateReviews`, already
 * anchored to the whole title; null reads no title at all.
 *
 * A gate's rules are its own, and its pending state alone says nothing about
 * whose move it is. Its own words can: a gate that wants reviewers it hasn't
 * heard from is a review still required, whatever `reviewDecision` says, since
 * GitHub's branch protection may ask for less than the gate does. A wording the
 * pattern doesn't match, or none at all, leaves the row with the gate. That is
 * the safe miss: the row stays where it would have been anyway.
 */
function gatesWantOnlyApprovals(gate: readonly PendingCheck[], reviews: RegExp | null): boolean {
  if (!reviews || gate.length === 0) return false;
  return gate.every((check) => reviews.test(check.description ?? ''));
}

/** The newest review in a given state, or undefined. */
function newest(pr: PullRequest, state: string): { login: string; at: string } | undefined {
  return pr.reviews.filter((review) => review.state === state).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

/**
 * Whose move it is, and why.
 *
 * `nudgedAt` is the newest time the user pressed Nudged. Asking on Slack is
 * invisible to GitHub, and this is how the board is told: it restarts the clock
 * on "time to ask", for a row waiting on reviewers and nothing else. It never
 * moves a PR between courts, since the court is about what GitHub can see. A note
 * restarts nothing; it is free text, and the board doesn't read it.
 *
 * `gates` are the configured merge-gate check names, from `mergeGateChecks`.
 * Nothing is a gate by default — the list arrives from the user's private config,
 * and an empty one simply leaves those rows in `checks`. `reviews` is the gate
 * title meaning only approvals are missing, from `mergeGateReviews`.
 *
 * The order the questions are asked in is the whole design, so it is written out
 * rather than left implicit:
 *
 *   1. drafts, which ask nothing of anyone
 *   2. anything only you can fix — a verdict against you, red CI, a conflict, a
 *      stale branch, or somebody having spoken after you
 *   3. a review GitHub itself still requires, or one a pending gate says it is
 *      missing and nothing else, which outranks any check
 *   4. a configured merge gate that hasn't finished
 *   5. GitHub reporting the merge blocked without naming an unfinished check
 *   6. GitHub reporting an ordinary check wait or an unstable merge
 *   7. ready, which needs GitHub to agree the merge would work
 *   8. otherwise, waiting on reviewers
 */
export function judge(
  pr: PullRequest,
  now: Date,
  nudgedAt: string | null,
  gates: readonly string[] = [],
  reviews: RegExp | null = null,
): Judgement {
  const decision = deriveDecision(pr);
  // `?? null`: a pull read back from an older file may lack the key entirely.
  const you = pr.lastActivityByYou ?? null;
  const others = pr.lastActivityByOthers ?? null;
  const mergeState = pr.mergeStateStatus ?? null;

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
  // `DIRTY` is GitHub's own word for the conflict `mergeable` reports, so the two
  // are one reason rather than two rows saying the same thing twice.
  if (pr.mergeable === 'CONFLICTING' || mergeState === 'DIRTY') reasons.push({ kind: 'conflicts' });
  // Behind the base branch: nobody else can press the update button for you.
  if (mergeState === 'BEHIND') reasons.push({ kind: 'behind' });

  const theirMove = others !== null && (you === null || others.at > you);
  const approval = newest(pr, 'APPROVED');
  // An approval is itself "someone acted after you", and the right reading of it
  // is ready, not your move. Anything by others newer than the newest approval is
  // by definition not that approval: a comment in the conversation, an inline
  // review comment, a "one more thing before you merge". That puts it back in
  // your court.
  const afterApproval = others !== null && approval !== undefined && others.at > approval.at;
  const approved = decision === 'APPROVED' && !afterApproval;

  if (theirMove && others && !approved) {
    reasons.push({ kind: 'activity', login: others.login, at: others.at, activity: others.kind });
  }

  if (reasons.length > 0) {
    // The wait began when the ball landed: their last action if that's what put it
    // here, otherwise whenever GitHub last saw the PR change.
    const since = theirMove && others ? others.at : pr.updatedAt;
    return { court: 'you', decision, reasons, stale: false, nudge: false, since };
  }

  // A check-related wait started when the commit the checks are running on
  // landed, which is the same clock the reviewer wait uses: `lastActivityByYou`
  // already includes the head commit's date.
  const waitingSince = laterISO(pr.readyAt, you) ?? pr.createdAt;
  const settled = (court: Court, reason: CourtReason): Judgement => ({
    court,
    decision,
    reasons: [reason],
    stale: false,
    nudge: false,
    since: waitingSince,
  });

  // GitHub's own "a review is still required" outranks every check, including a
  // gate: a gate that is waiting for that same approval would otherwise hide the
  // one thing a person can act on. So does a gate saying approvals are all it is
  // missing, for the same reason; the row carries the gate as its reason, since
  // the gate's link is where it says whose approval. Outstanding
  // `requestedReviewers` deliberately do not count — GitHub keeps asking long
  // after the required approvals landed.
  const gate = matchMergeGates(pr, gates);
  const gateReview = gatesWantOnlyApprovals(gate, reviews);
  if (gateReview) reasons.push({ kind: 'merge-gate', checks: gate });
  if (decision !== 'REVIEW_REQUIRED' && !gateReview) {
    if (gate.length > 0) return settled('gate', { kind: 'merge-gate', checks: gate });

    // Named when GitHub returned the contexts, and deliberately unnamed when it
    // didn't — a cache from before they were fetched. Nothing invents a name.
    const pending = pr.pendingChecks ?? [];
    const running: CourtReason = { kind: 'checks-pending' };
    if (pending.length > 0) running.checks = pending;

    // Blocked with nothing pending to blame: a required check that never ran, or
    // a ruleset whose decision has no check of its own. It is not a check wait.
    if (mergeState === 'BLOCKED' && pending.length === 0) {
      return settled('blocked', { kind: 'merge-blocked' });
    }
    if (mergeState === 'BLOCKED' || mergeState === 'UNSTABLE') return settled('checks', running);
    // GitHub computes the merge state lazily, so a pull request it hasn't looked
    // at recently answers UNKNOWN once and properly on the next poll. Not ready,
    // but not a state anything needs to be clever about either.
    if (mergeState === 'UNKNOWN') return settled('checks', { kind: 'mergeability-unknown' });

    if (approved) {
      if (mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS') {
        return { court: 'ready', decision, reasons: [], stale: false, nudge: false, since: approval?.at ?? pr.updatedAt };
      }
      // No merge state at all: a cache written before the field was fetched, or a
      // token GitHub won't tell. The pre-merge-state reading of ready still
      // applies, but only where nothing visible is outstanding — a refresh fills
      // the field in, and until then "approved and quiet" is the most that can
      // honestly be claimed. Approved with something still running is a check
      // wait, not a reviewer one: nudging would not move it.
      if (mergeState === null) {
        const unfinished = pr.checks === 'pending' || pending.length > 0;
        if (!unfinished) {
          return { court: 'ready', decision, reasons: [], stale: false, nudge: false, since: approval?.at ?? pr.updatedAt };
        }
        return settled('checks', running);
      }
    }
  }

  // Waiting on reviewers, since the later of becoming ready and your last push.
  const quietSince = laterISO(waitingSince, nudgedAt) ?? waitingSince;
  const waited = now.getTime() - (ms(quietSince) ?? now.getTime());
  const verdict: Judgement = { court: 'reviewers', decision, reasons, stale: false, nudge: waited >= NUDGE_AFTER_MS, since: waitingSince };
  // Nudged while the nudge is what holds the prompt back. One from before your
  // last push is about a wait that push started over, as any push does.
  const nudged = ms(nudgedAt);
  if (nudgedAt && nudged !== null && quietSince === nudgedAt && !verdict.nudge) {
    verdict.nudgedAt = nudgedAt;
    verdict.nudgedUntil = new Date(nudged + NUDGE_AFTER_MS).toISOString();
  }
  return verdict;
}

/**
 * The board: every fetched PR, judged, joined with the action log, and sorted so
 * the longest wait in each court comes first.
 *
 * Only two things in the log are honoured. A snooze parks the row until its date,
 * which is how a draft is deliberately shelved; `foldActionLog` has already turned
 * an expired one back into open. The newest nudge resets the nudge timer. Notes
 * are carried along to be shown. Done and dismissed are ignored on purpose: the
 * brief may raise "CI failing on #3402" and the user may mark that done, but #3402
 * is still open, and this board shows what is open.
 *
 * `gates` is `github.mergeGateChecks`, and `reviews` is `github.mergeGateReviews`
 * — configuration rather than facts about the pull request, which is why the
 * match happens here and never reaches `prs.json`.
 */
export function resolveBoard(
  pulls: readonly PullRequest[],
  actions: readonly Action[],
  now: Date,
  gates: readonly string[] = [],
  reviews: RegExp | null = null,
): BoardRow[] {
  const folded = foldActionLog(actions, now);

  const rows = pulls.map((pr): BoardRow => {
    const log = folded.get(canonicalId(pr.id));
    const verdict = judge(pr, now, log?.nudgedAt ?? null, gates, reviews);

    const row: BoardRow = { ...pr, ...verdict, status: log?.status === 'snoozed' ? 'snoozed' : 'open', notes: log?.notes ?? [] };
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
  const counts: Record<Court | 'parked', number> = {
    you: 0,
    ready: 0,
    reviewers: 0,
    gate: 0,
    blocked: 0,
    checks: 0,
    draft: 0,
    parked: 0,
  };
  for (const row of rows) {
    if (row.status === 'snoozed') counts.parked++;
    else counts[row.court]++;
  }
  return counts;
}
