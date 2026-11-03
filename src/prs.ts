import type { Action, BoardRow, Court, CourtReason, MergeHelperView, PendingCheck, PullOffer, PullRequest, ReviewDecision } from './types.ts';
import { canonicalId } from './ids.ts';
import { foldActionLog } from './store.ts';
import { laterISO, parseISO } from './time.ts';

/**
 * How long a pull request may sit waiting on reviewers before the board suggests
 * asking. Calendar hours, not working hours: a Friday afternoon PR being flagged
 * on Monday morning is the right answer.
 */
export const NUDGE_AFTER_MS = 24 * 3_600_000;

/** How long a draft may go untouched before it's flagged as forgotten. */
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
 * Only two things in the log are honoured. A snooze sets the row aside until its date,
 * which is how a draft is deliberately shelved; `foldActionLog` has already turned
 * an expired one back into open. The newest nudge resets the nudge timer. Notes
 * are carried along to be shown. Done and dismissed are ignored on purpose: the
 * brief may raise "CI failing on #3402" and the user may mark that done, but #3402
 * is still open, and this board shows what is open.
 *
 * `gates` is `github.mergeGateChecks`, and `reviews` is `github.mergeGateReviews`
 * — configuration rather than facts about the pull request, which is why the
 * match happens here and never reaches `prs.json`. `merging` is what the merge
 * helper said, when one is set, and stays out of the file for the same reason.
 */
export function resolveBoard(
  pulls: readonly PullRequest[],
  actions: readonly Action[],
  now: Date,
  gates: readonly string[] = [],
  reviews: RegExp | null = null,
  merging: MergeContext | null = null,
): BoardRow[] {
  const folded = foldActionLog(actions, now);

  const rows = pulls.map((pr): BoardRow => {
    const log = folded.get(canonicalId(pr.id));
    const verdict = judge(pr, now, log?.nudgedAt ?? null, gates, reviews);

    const row: BoardRow = { ...pr, ...verdict, status: log?.status === 'snoozed' ? 'snoozed' : 'open', notes: log?.notes ?? [] };
    if (row.status === 'snoozed' && log?.snoozedUntil) row.snoozedUntil = log.snoozedUntil;
    if (merging) {
      // Only a branch the helper is asked about: the default one.
      const helper = pr.defaultBranch && pr.baseRef === pr.defaultBranch ? merging.helper(pr.repo, pr.baseRef) : null;
      if (helper) row.mergeHelper = helper;
      if (merging.queued(pr.id)) row.helperQueued = true;
    }
    row.offers = pullOffers(row);
    return row;
  });

  // A stack is read from the whole board, so once every row is judged.
  if (merging) {
    for (const row of rows) {
      if (!row.defaultBranch || row.baseRef === row.defaultBranch) continue;
      const { chain } = findStack(row, rows, (repo) => merging.approvals(repo));
      if (!chain) continue;
      row.offers = [...(row.offers ?? []), 'stack'];
      row.stack = chain.map((member) => member.id);
    }
  }

  return rows.sort((a, b) => {
    const court = courtOrder(a.court) - courtOrder(b.court);
    if (court !== 0) return court;
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/* ---------- what a click may do upstream ---------- */

/** The facts the offers are read from: a row, or anything shaped like one. */
type OfferFacts = Pick<
  BoardRow,
  | 'court'
  | 'account'
  | 'baseRef'
  | 'headSha'
  | 'nodeId'
  | 'defaultBranch'
  | 'mergeMethod'
  | 'mergeQueue'
  | 'inMergeQueue'
  | 'stacked'
  | 'mergeStateStatus'
  | 'mergeHelper'
  | 'helperQueued'
>;

/** Said when a row comes from a cache older than the facts an action needs: the next poll reads them. */
const UNREAD = "the board hasn't read what that needs from GitHub yet; refresh the board and try again";

/** Said while the merge helper hasn't answered for a branch, which offers no merge until it has. */
const ASKING = "the merge helper hasn't said yet how this repository merges; try again in a moment";

/**
 * Why the board won't mark this pull request ready for review: null when it will.
 *
 * Only a draft, and only as the account that read it, which is the one the
 * mutation runs as. The same reading decides the button and the server's answer
 * to a click, so neither can offer what the other refuses.
 */
export function refuseReady(row: OfferFacts): string | null {
  if (row.court !== 'draft') return 'it is not a draft';
  if (!row.nodeId || !row.account) return UNREAD;
  return null;
}

/**
 * Why the board won't merge this pull request: null when it will.
 *
 * Only one in the ready court, so GitHub has said the merge would work, and only
 * into its repository's default branch: a pull request stacked on another's
 * branch would merge into that branch, not land. A member of a GitHub stack
 * merges through the stack's own API, which this doesn't speak; GitHub's page
 * does. The head commit is needed too, since the merge is made conditional on it:
 * a push since the last poll makes GitHub refuse rather than merge commits nobody
 * here has seen.
 *
 * Where the user's merge helper said the branch merges through it, these rules
 * still decide, and the helper merges in GitHub's place (`mergeRoute`). While it
 * hasn't said, nothing is offered: a merge can't be taken back, and the answer
 * is seconds away.
 */
export function refuseMerge(row: OfferFacts): string | null {
  if (row.court !== 'ready') return 'it is not ready to merge';
  // The ready court also holds an approved, quiet pull request whose merge
  // state couldn't be read, so the court alone is not GitHub saying yes.
  if (row.mergeStateStatus !== 'CLEAN' && row.mergeStateStatus !== 'HAS_HOOKS') return "GitHub hasn't said the merge would work";
  if (!row.nodeId || !row.account || !row.headSha || !row.defaultBranch) return UNREAD;
  if (row.stacked) return 'it is part of a stack on GitHub, which merges there';
  if (row.baseRef !== row.defaultBranch) return `it targets ${row.baseRef}, not ${row.defaultBranch}`;
  if (row.inMergeQueue || row.helperQueued) return 'it is in the merge queue already';
  if (row.mergeHelper?.kind === 'asking') return ASKING;
  if (row.mergeHelper?.kind === 'queue' || row.mergeQueue) return null;
  if (!row.mergeMethod) return UNREAD;
  return null;
}

/** How a merge the board offers would go: through the merge helper, into GitHub's merge queue, or straight in. */
export function mergeRoute(row: OfferFacts): 'helper' | 'queue' | 'merge' {
  if (row.mergeHelper?.kind === 'queue') return 'helper';
  return row.mergeQueue ? 'queue' : 'merge';
}

/** What a click on the row may do to the pull request upstream, a stack apart: see `findStack`. */
export function pullOffers(row: OfferFacts): PullOffer[] {
  const offers: PullOffer[] = [];
  if (refuseReady(row) === null) offers.push('ready');
  if (refuseMerge(row) === null) offers.push(mergeRoute(row));
  return offers;
}

/* ---------- a stack, merged from its top ---------- */

/** The longest stack looked for, so a chain of branches can't keep the board walking. */
const MAX_STACK = 20;

/**
 * What the board knows of the merge helper when one is set, for `resolveBoard`
 * to work the rows' offers out from. See `mergehelper.ts`.
 */
export interface MergeContext {
  /** What it said about a repository's branch; null for GitHub's own merge. */
  helper(repo: string, base: string): MergeHelperView | null;
  /** Whether it says a pull request handed to it from the dashboard is still in its queue. */
  queued(id: string): boolean;
  /** The approvals a repository's default branch requires, or null until the board has read them. */
  approvals(repo: string): number | null;
}

/** How many people approved it, by their latest review. */
function approvalsOf(row: BoardRow): number {
  return row.reviews.filter((review) => review.state === 'APPROVED').length;
}

/** Why a pull request above a stack's bottom can't go with it: null when it can. */
function refuseAbove(row: BoardRow, needed: number, branch: string): string | null {
  const ref = `#${row.number}`;
  if (!row.headSha || !row.account) return UNREAD;
  if (row.isDraft) return `${ref} is a draft`;
  if (row.stacked) return `${ref} is part of a stack on GitHub, which merges there`;
  if (row.decision === 'CHANGES_REQUESTED') return `${ref} has changes requested`;
  if (row.checks === 'failure' || row.failingChecks.length > 0) return `${ref} has failing checks`;
  if (row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY') return `${ref} has conflicts`;
  if (row.inMergeQueue || row.helperQueued) return `${ref} is in the merge queue already`;
  const approvals = approvalsOf(row);
  if (approvals < needed) {
    return `${ref} has ${approvals === 0 ? 'no' : approvals} approval${approvals === 1 ? '' : 's'}, and ${branch} needs ${needed}`;
  }
  return null;
}

/**
 * The stack `top` tops, bottom first, for the merge helper to merge from it, or
 * why there is none.
 *
 * A stack is a chain of the user's open pull requests in one repository, read
 * as one account, each based on the branch of the one below, down to one based
 * on the default branch. A chain, not a tree: a pull request with two others on
 * its branch belongs to two stacks, and merging one would pull the other's base
 * out from under it. Only its top offers the merge, and only when all of it
 * could go: the bottom offers the helper's own merge, and the helper said it
 * merges stacks; each one above is not a draft, has no changes requested, no
 * failing checks and no conflicts, and has as many approvals as the default
 * branch's rules require, and at least one, since the board calls nothing
 * ready that nobody approved.
 *
 * `rows` is the whole board, from which the chain is read; nothing outside it
 * can be part of one, so a branch someone else's pull request owns breaks it.
 */
export function findStack(
  top: BoardRow,
  rows: readonly BoardRow[],
  approvals: (repo: string) => number | null,
): { chain: BoardRow[]; why: null } | { chain: null; why: string } {
  const no = (why: string) => ({ chain: null, why }) as const;
  if (!top.defaultBranch || !top.account) return no(UNREAD);
  if (top.baseRef === top.defaultBranch) return no('it is not stacked on another of your pull requests');

  const repo = top.repo.toLowerCase();
  const account = top.account.toLowerCase();
  const kin = rows.filter((row) => row.repo.toLowerCase() === repo && row.account.toLowerCase() === account);
  const on = (branch: string) => kin.filter((row) => row.baseRef === branch);
  const owning = (branch: string) => kin.filter((row) => row.headRef === branch);

  const above = on(top.headRef);
  if (above.length > 0) return no(`#${above[0]!.number} is stacked on it; merge the stack from its top`);

  const chain: BoardRow[] = [top];
  let current = top;
  while (current.baseRef !== top.defaultBranch) {
    const below = owning(current.baseRef);
    if (below.length === 0) return no(`#${current.number} is based on ${current.baseRef}, which isn't the branch of another of your open pull requests`);
    if (below.length > 1) return no(`more than one of your pull requests is on ${current.baseRef}`);
    const next = below[0]!;
    if (chain.includes(next) || chain.length >= MAX_STACK) return no(`the branches under #${current.number} never reach ${top.defaultBranch}`);
    if (on(next.headRef).length > 1) return no(`#${next.number} has more than one pull request stacked on it`);
    chain.unshift(next);
    current = next;
  }

  const bottom = chain[0]!;
  const helper = bottom.mergeHelper;
  if (!helper) return no(`no merge helper merges ${top.repo}'s ${top.defaultBranch}`);
  if (helper.kind === 'asking') return no(ASKING);
  if (!helper.stacks) return no('the merge helper merges one pull request at a time');
  const why = refuseMerge(bottom);
  if (why) return no(`#${bottom.number}, at the bottom: ${why}`);
  if (mergeRoute(bottom) !== 'helper') return no(`#${bottom.number}, at the bottom, doesn't merge through the merge helper`);

  const required = approvals(top.repo);
  if (required === null) return no(`the board hasn't read how many approvals ${top.defaultBranch} needs yet; try again in a moment`);
  const needed = Math.max(1, required);
  for (const row of chain.slice(1)) {
    const refused = refuseAbove(row, needed, top.defaultBranch);
    if (refused) return no(refused);
  }
  return { chain, why: null };
}

/** How many rows sit in each court, plus the snoozed ones, for the badge and the headers. */
export function countBoard(rows: readonly BoardRow[]): Record<Court | 'snoozed', number> {
  const counts: Record<Court | 'snoozed', number> = {
    you: 0,
    ready: 0,
    reviewers: 0,
    gate: 0,
    blocked: 0,
    checks: 0,
    draft: 0,
    snoozed: 0,
  };
  for (const row of rows) {
    if (row.status === 'snoozed') counts.snoozed++;
    else counts[row.court]++;
  }
  return counts;
}
