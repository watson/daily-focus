/**
 * The contract between the briefing agent and the dashboard.
 *
 * Two files, two owners, no shared writes:
 *
 *   items.json    written by the agent, read by the dashboard
 *   actions.jsonl appended by the dashboard, read by the agent
 *
 * See schema/items.schema.json for the payload and AGENTS.md for coding guardrails.
 */

/** Where an item came from. Unknown sources render fine, just without a themed accent. */
export type Source =
  | 'github'
  | 'email'
  | 'calendar'
  | 'jira'
  | 'slack'
  | 'workday'
  | 'tasks'
  | 'atlassian'
  | 'reminders'
  | 'messages'
  | 'eboks'
  | 'other';

/**
 * What an item *is*, which decides whether it can be completed.
 *
 * - `task`  something to do. Actionable, shows done/snooze/dismiss.
 * - `event` something happening at a time. Placed on the agenda.
 * - `info`  context worth knowing (a holiday, a heads-up). Dismissable, not completable.
 */
export type ItemKind = 'task' | 'event' | 'info';

/** A single line in the brief. */
export interface Item {
  /**
   * Stable across runs — this is what actions are keyed on.
   * Derive it from the upstream identity, never from the title or the date.
   * e.g. "github:pr:acme/webapp#3421", "email:thread:18f2a9c4b7"
   */
  id: string;
  source: Source;
  kind: ItemKind;
  title: string;
  /** Optional longer context. A small subset of Markdown is rendered (see markdown.ts). */
  detail?: string;
  /** Deep link back to the source. Rendered as "Open ↗". */
  url?: string;
  /**
   * 1-based rank for the handful of things that genuinely matter most today.
   * Items with a priority are lifted into the "Top priorities" band, lowest number first.
   * Leave unset for everything else — if everything is a priority, nothing is.
   */
  priority?: number;
  /** ISO 8601. Drives the "due" / "overdue" pill. */
  due?: string;
  /** ISO 8601. `kind: "event"` only — places the item on the agenda. */
  start?: string;
  end?: string;
  /**
   * False when an event belongs on the agenda but must not consume time — a
   * delivery window, a restaurant booking, anything you are not sat inside.
   *
   * Absent reads as blocking, and the asymmetry is deliberate: over-reserving the
   * day only understates the focus time available, while the opposite mistake
   * promises a block that isn't there. Only an explicit `false` frees the slot.
   */
  blocking?: boolean;
  /** Free-form labels, e.g. ["ci-failing", "review-requested"]. */
  tags?: string[];
  /** People attached to the item, e.g. ["@alice", "bob@example.com"]. */
  people?: string[];
  /**
   * ISO 8601 date the agent *first* raised this item. Carry it forward across runs
   * so the dashboard can age items ("on your list for 5 days"). Nagging is the point.
   */
  firstSeen?: string;
  /**
   * True when completing this genuinely moves the objective in focus.md forward.
   *
   * This is what makes "N working days since progress" computable: the archive
   * remembers which ids were objective-aligned, the action log remembers which were
   * completed, and the two join on this flag. Set it sparingly and honestly — a
   * generous reading of "related to the objective" makes the metric lie.
   */
  advancesObjective?: boolean;
}

/**
 * How long since the standing objective actually moved, derived by joining the
 * brief archive with the action log.
 */
export interface ObjectiveProgress {
  /** Working days since the last objective-aligned completion. Null when there's never been one. */
  workingDaysSince: number | null;
  /** ISO timestamp of that completion. */
  lastAt: string | null;
  /** What it was — the line you'd point at in a review. */
  lastTitle: string | null;
  /** Objective-aligned items completed within `windowDays`. */
  recentCount: number;
  windowDays: number;
}

/** The whole payload the agent writes to items.json. */
export interface Brief {
  /** Schema version. Bump only on a breaking change. */
  version: 1;
  /** ISO 8601 timestamp of the run that produced this file. Drives the staleness banner. */
  generatedAt: string;
  /**
   * Free-form label naming whichever agent produced this brief.
   *
   * Nothing in this project depends on which agent that is — the contract is with
   * "something outside", and it names itself here.
   */
  generatedBy?: string;
  /** The local date this brief is *for*, YYYY-MM-DD. Defaults to the date of generatedAt. */
  date?: string;
  /** One or two sentences at the top of the page. Rendered as inline Markdown. */
  headline?: string;
  /**
   * Today's actual working hours as local "HH:MM", when they differ from the
   * configured default.
   *
   * The agent derives these from the calendar, because the working day is not a
   * constant: short days, part-days and OOO markers all move the end of it.
   * A dashboard that assumes 09:00–17:00 every day computes the wrong free windows
   * and then confidently recommends a focus block that doesn't exist.
   */
  dayStart?: string;
  dayEnd?: string;
  items: Item[];
}

/**
 * What the dashboard can record against an item. `note` and `nudge` say something
 * about it and leave its status alone; the rest decide the status.
 *
 * A `nudge` carries nothing but its time: the user asked a pull request's
 * reviewers for a review somewhere GitHub can't see, such as Slack. It was a
 * `note` reading "Nudged reviewers" until the board needed to tell one from a
 * note the user typed; those older lines stay notes.
 */
export type ActionType = 'done' | 'snooze' | 'dismiss' | 'reopen' | 'note' | 'nudge';

/** One appended line in actions.jsonl. */
export interface Action {
  /** Matches Item.id. */
  id: string;
  action: ActionType;
  /** ISO 8601 timestamp of the click. */
  at: string;
  /** `snooze` only: ISO 8601 date (YYYY-MM-DD) to resurface on or after. */
  until?: string;
  /** `note` only: free text aimed at the agent, e.g. "already replied on Slack". */
  text?: string;
}

/** The resolved state of an item after folding its action log. */
export type ItemStatus = 'open' | 'done' | 'snoozed' | 'dismissed';

/** An item plus everything the action log says about it. */
export interface ResolvedItem extends Item {
  status: ItemStatus;
  /** Set when status is `snoozed`. YYYY-MM-DD. */
  snoozedUntil?: string;
  /** When the current status was set. */
  statusAt?: string;
  /** Every note left on this item, oldest first. */
  notes: { text: string; at: string }[];
  /** Whole days between firstSeen and today. 0 when new or unknown. */
  ageDays: number;
}

/** A gap between meetings that is long enough to be worth protecting. */
export interface FreeWindow {
  start: string;
  end: string;
  minutes: number;
}

/**
 * Where the agenda's events came from.
 *
 * The events are read live from Calendar.app when that is set up and working,
 * and taken from the brief otherwise. Which one is in force has to reach the
 * screen: an agenda quietly served from this morning's brief looks exactly like
 * a live one, right up to the meeting you cancelled still sitting on it.
 */
export interface AgendaSource {
  /** True when these events came from the calendar rather than the brief. */
  live: boolean;
  /** When the calendar was last read. Null when the brief is the source. */
  fetchedAt: string | null;
  /**
   * Why the live agenda isn't in use when no read has failed: there has been no
   * read yet, or none of the configured calendars exists.
   */
  problem: string | null;
  /** The last read failed, so these events are older than they look, or the brief's. */
  failure: ReadFailure | null;
  /** Setup problems worth fixing that aren't stopping it working. */
  warnings: string[];
}

/**
 * A read that keeps failing, as its banner tells it: `message` is the one line
 * on the page, and the rest waits behind a click for whoever wants to know why.
 * Shared by the three pollers: GitHub, Jira and the calendar.
 */
export interface ReadFailure {
  /** What failed and, where there is something to do, what to do. Plain text: it quotes upstream errors. */
  message: string;
  /**
   * What was underneath, verbatim and possibly several lines: an error's chain
   * of causes, a command and what it printed, a stack. Empty when the message is
   * all there was.
   */
  detail: string;
  /** When the first failed attempt of this unbroken run was made. */
  since: string;
  /** Failed attempts in a row, the latest included. */
  attempts: number;
  /** When the poller will try again on its own, if nobody asks sooner. Null while it is trying. */
  retryAt: string | null;
  /** An attempt is in flight now. */
  retrying: boolean;
}

/** What the calendar poller knows: where the events came from, and the events. */
export interface CalendarState extends AgendaSource {
  events: Item[];
}

/** Today's schedule, derived from `kind: "event"` items. */
export interface Agenda {
  events: ResolvedItem[];
  /** Ids of events that overlap at least one other event. */
  conflictIds: string[];
  /**
   * Whether free windows and focus time are being tracked at all. Off for the
   * personal profile by default, where "the day" has no start or end worth
   * measuring against; the client shows the next event instead.
   */
  tracksFreeTime: boolean;
  freeWindows: FreeWindow[];
  /**
   * Unbooked minutes between now and the end of the working day.
   *
   * The honest answer to "how much can I actually still do today", which a list of
   * open items conspicuously fails to convey — fourteen rows look identical whether
   * you have six hours left or forty minutes.
   */
  remainingFocusMinutes: number;
  /** Local "HH:MM" bounds actually used, after the brief's overrides. */
  dayStart: string;
  dayEnd: string;
}

/* ---------- the pull request board ---------- */

/**
 * The review state of a pull request, as GitHub reports it. Null when the
 * repository requires no reviews, in which case `prs.ts` derives one from the
 * reviews themselves.
 */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

/** The status check rollup on the head commit, collapsed to what the board needs. */
export type CheckState = 'success' | 'failure' | 'pending' | null;

export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * GitHub's own reading of whether the merge button would work, which is a broader
 * question than `mergeable`.
 *
 * `mergeable` only answers "does this conflict". Repository policy — required
 * reviews, required checks, anything a ruleset adds — shows up here and nowhere
 * else, which is why an approved, conflict-free, green pull request can still be
 * `BLOCKED`. Null when the field wasn't fetched: a cache written before this
 * existed, or a token GitHub won't tell.
 */
export type MergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

/**
 * One named check on the head commit: either unfinished, or finished without
 * reaching a verdict. A fact, not a judgement — whether a given name is the
 * repository's merge-policy gate is a matter of private configuration, so it is
 * matched at read time and never stored.
 */
export interface PendingCheck {
  name: string;
  kind: 'check-run' | 'status-context';
  /** Where GitHub says to look. Null when it gave no link, or a non-http(s) one. */
  detailsUrl: string | null;
  /** Check runs only. The key an output lookup would cache under, if one is ever added. */
  checkRunId?: number;
}

/** Something a person other than the author did on a pull request. */
export interface PullActivity {
  at: string;
  login: string;
  kind: 'review' | 'comment';
}

/**
 * One open pull request the user authored, as fetched. Facts only: the court it
 * is in is derived at render time in `prs.ts`, because that depends on the clock
 * and on the action log, neither of which belongs in the file on disk.
 */
export interface PullRequest {
  /** The brief's recipe, `github:pr:<owner>/<repo>#<number>`, so actions join across both. */
  id: string;
  /** The login it was fetched as. */
  account: string;
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  /** When it last left draft; `createdAt` when it was never one. */
  readyAt: string;
  updatedAt: string;
  headRef: string;
  baseRef: string;
  reviewDecision: ReviewDecision;
  checks: CheckState;
  /**
   * The checks that failed, by name. Derived from the individual check runs and
   * statuses rather than the rollup's summary state, because the summary has been
   * seen to say success while a required check was red.
   */
  failingChecks: string[];
  mergeable: MergeableState;
  /** GitHub's broader merge state. Null on a cache written before it was fetched. */
  mergeStateStatus: MergeStateStatus | null;
  /**
   * The head commit's unfinished checks, by name, with whatever link GitHub gave.
   * Read from the first hundred contexts only, the same window `checks` is derived
   * from — a gate beyond that is missed for presentation, never for readiness,
   * since `mergeStateStatus` still says blocked.
   */
  pendingChecks: PendingCheck[];
  /**
   * The head commit's cancelled checks, by name. A cancelled run reached no
   * verdict about the code, so it is neither red nor still running: it is kept
   * apart from both, shown on the row as plain text, and never moves a court.
   * Empty on a cache written before cancellations were told apart from failures.
   */
  cancelledChecks: PendingCheck[];
  autoMerge: boolean;
  /** Reviewers still requested, users by login and teams by slug. */
  requestedReviewers: string[];
  /** The latest formal review per reviewer, bots and the author excluded. */
  reviews: { login: string; state: string; at: string }[];
  /**
   * The head commit, which an answer about its failing checks is about. Absent
   * on a cache written before it was kept.
   */
  headSha?: string | null;
  /** Newest thing the author did: opened it, pushed, commented, reviewed, marked ready. */
  lastActivityByYou: string | null;
  /** Newest thing anyone else did, bots excluded. */
  lastActivityByOthers: PullActivity | null;
}

export interface BoardAccount {
  login: string;
  ok: boolean;
  /** Why this account couldn't be polled, when it couldn't. */
  error: string | null;
}

/** `prs.json`: the last successful fetch, written by the server and only the server. */
export interface PullsFile {
  version: 1;
  fetchedAt: string;
  accounts: BoardAccount[];
  scope: string[];
  warnings: string[];
  pulls: PullRequest[];
}

/**
 * Whose move it is.
 *
 * - `you`        changes requested, CI red, conflicts, a stale branch, or someone
 *                acted after you did.
 * - `ready`      approved, nothing red, and GitHub says the merge would work.
 * - `reviewers`  waiting on a review, or on a re-review since your last push.
 * - `gate`       a check the user named as the repository's aggregate merge-policy
 *                decision hasn't finished. Nobody here knows whose move that is —
 *                the gate's own rules are private to whatever implements them.
 * - `blocked`    GitHub says the merge is blocked, but returned no unfinished check
 *                to explain it. This may be any repository or ruleset policy.
 * - `checks`     an unfinished check is named, or GitHub says the merge is unstable.
 * - `draft`      not yet asking anyone for anything.
 */
export type Court = 'you' | 'ready' | 'reviewers' | 'gate' | 'blocked' | 'checks' | 'draft';

/** Why a pull request sits where it does. Formatted by the client, since the times are relative. */
export interface CourtReason {
  kind:
    | 'changes-requested'
    | 'ci-failing'
    | 'conflicts'
    | 'activity'
    | 'behind'
    /** A configured merge gate is pending; `checks` names it. */
    | 'merge-gate'
    /** Ordinary checks are still running; `checks` names them when GitHub said. */
    | 'checks-pending'
    /** GitHub says blocked but returned no pending context to blame. */
    | 'merge-blocked'
    /** GitHub hasn't worked out whether the merge would succeed. */
    | 'mergeability-unknown';
  login?: string;
  at?: string;
  activity?: 'review' | 'comment';
  /** The checks this reason is about, for the gate and pending-check kinds. */
  checks?: PendingCheck[];
}

/** A pull request plus everything the clock and the action log add to it. */
export interface BoardRow extends PullRequest {
  court: Court;
  /** `reviewDecision`, or the one derived from the reviews when GitHub gives none. */
  decision: ReviewDecision;
  reasons: CourtReason[];
  /** A draft nobody has touched in a long while. */
  stale: boolean;
  /** Waiting on reviewers for long enough that it's time to ask. */
  nudge: boolean;
  /**
   * When the user said they asked, while that nudge is what keeps `nudge` false.
   * Set only in the reviewers court; the board shows these rows apart, as Nudged.
   */
  nudgedAt?: string;
  /** When a nudged row is due to ask again: `nudgedAt` plus a day. Set with it. */
  nudgedUntil?: string;
  /** When the current wait began. The sort key within a court. */
  since: string;
  /** Only snooze is honoured here: a done or dismissed PR is still open upstream. */
  status: 'open' | 'snoozed';
  snoozedUntil?: string;
  notes: { text: string; at: string }[];
}

/** The optional services the dashboard reads through a CLI: GitHub through gh, Jira through acli. */
export type Service = 'github' | 'jira';

/**
 * Connecting a service from the page, which fetches its CLI when there is none
 * and signs it in; see `connect.ts`. `waiting` once it waits on the user in the
 * browser, with a code to enter at `url` for GitHub; `done` or `failed` once it
 * has ended, until the next one starts.
 */
export interface ConnectionState {
  /**
   * The CLI as it stands: whether there is one to run, and whether it is the
   * copy Daily Focus fetched, there being none of the user's: then nobody has
   * it in a terminal, so the page is the only place to sign it in.
   */
  cli: { found: boolean; fetched: boolean };
  status: 'idle' | 'fetching' | 'starting' | 'waiting' | 'choosing' | 'done' | 'failed';
  /** While `choosing`: the Atlassian sites acli asks to pick from, the one chosen in the browser among them. */
  choices: string[] | null;
  /**
   * While `waiting`: the CLI asks its questions in a window of its own, where the
   * user answers them. acli on Windows, whose prompts take keys from a console
   * and from nothing else.
   */
  inWindow: boolean;
  /** The one-time code GitHub's device page asks for. */
  code: string | null;
  url: string | null;
  /** Who the CLI said it signed in as, once done. */
  login: string | null;
  /** Why it failed, in the CLI's words. */
  error: string | null;
  /** The command that signs in from a terminal, for when the page couldn't. */
  command: string | null;
}

/** The board as the client sees it. */
export interface BoardState {
  enabled: boolean;
  /** Why the board can't run at all right now, when it can't: no gh, not logged in. */
  reason: ReadFailure | null;
  /**
   * Accounts the last poll couldn't read, one entry per distinct error, so two
   * accounts cut off by the same outage say so once. Their rows stay from the
   * last poll that could. Empty when `reason` is set, which says it for them.
   */
  failures: ReadFailure[];
  fetchedAt: string | null;
  fetching: boolean;
  accounts: BoardAccount[];
  scope: string[];
  warnings: string[];
  pollMinutes: number;
  /**
   * Whether connecting GitHub would fix what failed: there is no gh, it holds no
   * login, none for an account the board reads as, or GitHub turned a token away.
   */
  connect: boolean;
  rows: BoardRow[];
  counts: Record<Court | 'parked', number>;
}

/* ---------- the Jira ticket board ---------- */

/**
 * Jira's own three-way grouping of a workflow status.
 *
 * Every Jira has these four keys whatever its statuses are called, which is the
 * whole reason the board branches on them: "Committed", "In Progress" and "In
 * Review" are one site's names for its columns, and this repo is published.
 * `undefined` is Jira's own key for a status nobody categorised.
 */
export type TicketStatusCategory = 'new' | 'indeterminate' | 'done' | 'undefined';

/**
 * One unfinished Jira ticket, reduced to the facts a status can be judged against.
 *
 * Facts only, exactly as `PullRequest` is: which court a ticket lands in depends
 * on the clock-free question "does this status match the code", but also on the
 * user's configured hold statuses, which are private configuration and have no
 * business in a cache of Jira facts. So the court is derived on every read, in
 * `tickets.ts`, and a ticket here carries no verdict.
 */
export interface Ticket {
  /**
   * `jira:<KEY>` — deliberately the same id the brief uses for a Jira item, so a
   * ticket the morning brief also raises is one thing and not two. See `ids.ts`.
   */
  id: string;
  /** The issue key on its own, e.g. `PROJ-8842`. Shown as the row's reference. */
  key: string;
  summary: string;
  /**
   * The status as this site spells it — "Committed", "In Review". Shown on the
   * row and never branched on, and deliberately not called `status`: everywhere
   * else in this codebase that word means what the action log says, and a row
   * carrying both would be one assignment away from a ticket that reads as
   * parked because Jira happens to call its column something.
   */
  workflowStatus: string;
  statusCategory: TicketStatusCategory;
  /** `Task`, `Bug`, `Sub-task`. Shown, so a sub-task doesn't read as a stray task. */
  issueType: string;
  /** Browse link. Null when `acli` never told us which site it is logged in to. */
  url: string | null;
  /**
   * Whether Jira has ever linked a pull request to this ticket.
   *
   * From Jira's own development panel first, because Jira is the side that knows
   * every link: of one real board's 33 open pull requests, one named its ticket
   * in the title and eighteen in the branch, while Jira had the link for all of
   * them. But Jira hears about pull requests through a connector that can run
   * days behind, so this and the two below are corrected from GitHub where
   * GitHub has the newer answer; see `fromGitHub`.
   */
  hasAnyPr: boolean;
  /**
   * Whether at least one of those pull requests is still open, **a draft counting
   * as open** — which is the property that makes a ticket needing four pull
   * requests safe to reason about, since the habit of opening them all up front
   * keeps the ticket out of the settled court until the last one merges.
   *
   * Jira does not answer this on its own. `development[pullrequests].open` counts
   * only pull requests GitHub calls `OPEN`, and its integration reports a draft as
   * a state *beside* `OPEN` rather than a kind of it, with `open: false` — so a
   * ticket whose every pull request is a draft looked, through JQL alone, exactly
   * like one whose every pull request had merged. Measured on a real board, five
   * of nineteen settled rows were draft-only. `fetchTickets` repairs the count
   * from the development panel; see `readDevPullRequests`.
   */
  hasOpenPr: boolean;
  /**
   * Whether Jira's development panel was read and **positively said** every pull
   * request it knows about is merged or declined.
   *
   * The settled court requires this rather than inferring it from
   * `hasAnyPr && !hasOpenPr`, because those two booleans cannot distinguish "all
   * closed" from "we could not find out". The panel read is per-ticket and allowed
   * to fail on its own, and a ticket it could not answer for must not fall back to
   * the reading that caused this field to exist. Same polarity as
   * `readTransitionReport`: being told the work is finished, rather than merely
   * failing to find work outstanding.
   */
  allPrsClosed: boolean;
  /**
   * The pull requests GitHub has that name this ticket, read from GitHub itself:
   * every open one, and those closed in the last couple of months. Absent when
   * GitHub was not asked or named none. See `linked.ts`.
   */
  pulls?: LinkedPull[];
  /**
   * Set when GitHub's answer replaced Jira's in the three readings above: a pull
   * request merged that Jira still has open, or one opened that Jira has not
   * heard of. `pulls` is the evidence, and the row shows it.
   */
  fromGitHub?: boolean;
}

/** A pull request's state as GitHub reports it, with a draft told apart from open. */
export type LinkedPullState = 'open' | 'draft' | 'merged' | 'closed';

/** A GitHub pull request that names a Jira ticket. Facts only, as on `PullRequest`. */
export interface LinkedPull {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  state: LinkedPullState;
  /** When it merged or was closed. Null while it is open. */
  closedAt: string | null;
}

/**
 * What looks wrong about a ticket's status. One word each, because the row's
 * heading is the whole explanation.
 *
 * - `settled` every linked pull request is closed, and it isn't Done
 * - `started` the status says the work hasn't begun; an open pull request disagrees
 * - `idle`    the status claims work in flight with no code linked to it at all
 */
export type TicketCourt = 'settled' | 'started' | 'idle';

/** A ticket plus everything the action log adds to it. */
export interface TicketRow extends Ticket {
  court: TicketCourt;
  /**
   * Only snooze is honoured, for the reason `BoardRow.status` gives: a hygiene row
   * is fixed in Jira, not here, and the next read drops it on its own.
   */
  status: 'open' | 'snoozed';
  snoozedUntil?: string;
  notes: { text: string; at: string }[];
}

/**
 * A ticket whose status says it is in progress — the work being done, for the
 * ticket board's Working on view. The same ticket may also be a `TicketRow` in a
 * court.
 *
 * No `court`, because the view asks no question a court answers, and no
 * `status`, because the only status a board row can take from the log is a park,
 * and a park silences a complaint. The missing `court` is also how the client
 * tells the two kinds of row apart. Notes are carried: they are how "two more
 * repos to go" reaches the agent, and that is as true of a ticket going well as
 * of one that looks stuck.
 */
export interface InProgressTicket extends Ticket {
  notes: { text: string; at: string }[];
}

/** The ticket board as the client sees it. */
export interface TicketBoardState {
  enabled: boolean;
  /** Why the last read failed: no acli, acli not logged in, or a search Jira refused. */
  reason: ReadFailure | null;
  fetchedAt: string | null;
  fetching: boolean;
  /** Whoever `acli` is authenticated as, for the status line. Null when unknown. */
  account: string | null;
  /** Whether connecting Jira would fix what failed: there is no acli, or it has no session. */
  connect: boolean;
  /** Projects the search is limited to. Empty means every project the user sees. */
  projects: string[];
  warnings: string[];
  pollMinutes: number;
  rows: TicketRow[];
  counts: Record<TicketCourt | 'parked', number>;
  /** Every ticket in progress, by status — including ones `rows` also flags. */
  inProgress: InProgressTicket[];
  /** How many unfinished tickets were examined to produce those rows. */
  checked: number;
  /**
   * Statuses the status menu may offer, keyed by project — observed on the user's
   * own tickets rather than read from a workflow, because `acli` exposes no way
   * to ask which transitions a work item allows. So this is an offer and not a
   * promise: Jira is the authority on whether a given move is legal, and says so
   * by refusing.
   */
  statuses: Record<string, string[]>;
}

/** The last good read, as it sits in `tickets.json`. Facts and a timestamp only. */
export interface TicketsFile {
  version: 1;
  fetchedAt: string;
  account: string | null;
  projects: string[];
  warnings: string[];
  tickets: Ticket[];
  /** The status vocabulary, by project. Absent on a file written before it existed. */
  statuses?: Record<string, string[]>;
}

/** Everything the client needs for one render. */
/* ---------- the assistant ---------- */

/**
 * One request to the assistant and what came back. A line-pair in
 * `assistant.jsonl`: a `started` record, then one of `finished`, `failed` or
 * `aborted`. The transcript itself stays with the CLI, which keeps it under the
 * session id; this is the join, plus what the panel has to redraw after a
 * reload: the reply, and the steps that led to it.
 */
export interface AssistantTurn {
  id: string;
  /** The item the turn was about: a brief item, a pull request row or a ticket. */
  itemId: string;
  agent: import('./config.ts').AssistantAgent;
  /** The CLI's own session id, for resuming. Null until the CLI has said. */
  sessionId: string | null;
  /** What was asked, as sent: a quick action's text or what was typed. */
  request: string;
  /** The quick action it came from, when it did. */
  action: string | null;
  /**
   * Set when the dashboard asked on its own rather than the user: what about the
   * row it answered, as `autoask.ts` keys it. Null for a turn the user started.
   */
  auto: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'aborted';
  /**
   * The answer: the assistant's last message, once the turn is over. Markdown.
   * Empty while it runs, when everything it says is still on the way there and
   * is in `steps`.
   */
  reply: string;
  /** What it did on the way to the answer, in order. Empty on turns logged before steps were kept. */
  steps: AssistantStep[];
  /** Why a turn failed or was aborted, in the CLI's words where it had any. */
  error: string | null;
}

/**
 * One thing the assistant did on the way to its answer: a tool it called, or
 * something it said before it was done. Kept so the panel can show the work
 * while it happens, and after.
 */
export interface AssistantStep {
  kind: 'tool' | 'message';
  /** A tool step in a few words ("View the pull request", "Gmail: get thread"), or the message itself. */
  text: string;
  /** The command, query, address or arguments behind a tool step, cut short. Null for a message. */
  detail: string | null;
  /** A message is always done. A tool step is running until the CLI says how the call went. */
  state: 'running' | 'done' | 'failed';
}

/** A canned request offered as a button, so common asks need no typing. */
export interface AssistantQuickAction {
  id: string;
  label: string;
  /** The text sent as the request. */
  request: string;
  /** Which sources it applies to; null means every row. */
  sources: readonly Source[] | null;
}

/** Everything the panel on one row needs. */
export interface AssistantItemState {
  running: boolean;
  /** The session the next message resumes, once there has been a first turn. */
  sessionId: string | null;
  turns: AssistantTurn[];
}

/** The assistant as the client sees it. */
export interface AssistantState {
  enabled: boolean;
  agent: import('./config.ts').AssistantAgent | null;
  quickActions: AssistantQuickAction[];
  /** By item id. Only items that have ever been asked about appear. */
  items: Record<string, AssistantItemState>;
  /** Asking ahead, on the pull requests waiting on the user. */
  auto: AssistantAuto;
}

/**
 * The assistant asked ahead: on its own, about pull requests waiting on the
 * user, so the answer is on the row when they look. See `autoask.ts`.
 */
export interface AssistantAuto {
  /** `DAILY_FOCUS_ASSISTANT_AUTO`, and an assistant to ask. */
  enabled: boolean;
  /** How many turns it may start a day, and how many it has today. */
  limit: number;
  usedToday: number;
  /**
   * By row id, what the row's state calls for now, as the keys a turn's `auto`
   * carries. A turn whose key is still listed answers the row as it stands; one
   * whose key has gone answered something that has since changed.
   */
  rows: Record<string, string[]>;
}

/* ---------- the morning agent, run by the dashboard ---------- */

/**
 * One run of the morning agent, and the conversation that may follow it. Lines
 * in `agent.jsonl`, shaped like the assistant's: a `started` record, then one
 * of `finished`, `failed` or `aborted`; after that, a pair per follow-up. The
 * transcript itself stays with the CLI under the session id; this is the join,
 * plus what the panel needs to redraw after a reload.
 */
export interface AgentRun {
  id: string;
  cli: import('./config.ts').CliName;
  /** Started by the dashboard's own clock, or by a click. */
  trigger: 'schedule' | 'hand';
  /** The CLI's session id, which a follow-up resumes. Null until it has said. */
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'aborted';
  /**
   * What the agent reported back, as its prompt asks it to: what it wrote, what
   * it dropped, what it could not reach. While running, the latest thing it
   * said. Markdown.
   */
  report: string;
  /**
   * Everything the agent said along the way, oldest first, the report included
   * when it was the last thing said. Its working commentary — "reading the
   * calendar", "two threads dropped as handled" — kept so the reasoning behind
   * a brief can be read back after the fact. Markdown.
   */
  messages: string[];
  /**
   * What the run did, in order: everything the agent said, every call it made,
   * and every part of the work it handed to a subagent, with the subagent's own
   * steps after it. Sent for the newest run only, since a run makes a hundred
   * and every tab is sent the state on each; the log keeps every run's. Empty
   * on runs logged before steps were kept.
   */
  steps: AgentStep[];
  /** Why a run failed or was aborted, in the CLI's words where it had any. */
  error: string | null;
  /** Questions asked of this run afterwards, oldest first. */
  turns: AgentTurn[];
  /**
   * Whether a follow-up can be asked: the run is over, it left a session, and
   * that session belongs to the CLI configured now. A Claude session means
   * nothing to Codex.
   */
  resumable: boolean;
}

/**
 * One thing a run did, as the assistant's steps are, plus whose it was: the
 * agent's, or a subagent's it handed part of the work to.
 */
export interface AgentStep extends AssistantStep {
  /** The subagent that took the step, as its handoff's `subagent` names it. Null for the agent itself. */
  by: string | null;
  /**
   * Set on a handoff, the step that gave a subagent its work: the id the
   * subagent's own steps carry in `by`. The handoff is running for as long as
   * the subagent is, which can be longer than the call that started it.
   */
  subagent?: string;
}

/** One question asked of a finished run, and the answer. */
export interface AgentTurn {
  id: string;
  question: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'aborted';
  /** The agent's final message, or so far while running. Markdown. */
  reply: string;
  error: string | null;
}

/** The morning agent as the client sees it. */
export interface AgentRunState {
  enabled: boolean;
  cli: import('./config.ts').CliName | null;
  /** The dashboard's own clock, when it has one. */
  schedule: {
    /** Local time of day, `HH:MM`. */
    at: string;
    /** When the dashboard will next start the agent. Null if never. */
    nextRunAt: string | null;
  } | null;
  /** The newest run, finished or not. Null before the first. */
  last: AgentRun | null;
  /** Recent runs, newest first; the log keeps the rest. */
  runs: AgentRun[];
}

export interface DashboardState {
  /**
   * The standing objective from focus.md, with the agent-only section removed.
   * Null when focus.md doesn't exist.
   */
  focus: import('./focus.ts').PublicFocus | null;
  /** Only computed when focus.md sets an objective; null otherwise. */
  objectiveProgress: ObjectiveProgress | null;
  /** Whether the agenda is live from the calendar, or the brief's own events. */
  agendaSource: AgendaSource;
  /**
   * Which weekdays the briefing agent runs on — the dashboard's whole notion of a
   * weekend, which is why it's resolved once and sent rather than assumed twice.
   */
  schedule: {
    /** Days a run is due, 0 = Sunday. */
    days: number[];
    /** `config` when `DAILY_FOCUS_AGENT_DAYS` said so, `default` for Mon–Fri. */
    source: 'config' | 'default';
    /** Human-readable form of `days`, e.g. "Mon–Fri". */
    description: string;
    /** Whether a run was due today. */
    runsToday: boolean;
    /** Next local date a run is due, `YYYY-MM-DD`. */
    nextRunDate: string | null;
  };
  brief: {
    generatedAt: string | null;
    generatedBy: string | null;
    date: string | null;
    headline: string | null;
    /** Whole hours since generatedAt. Null when there is no brief yet. */
    ageHours: number | null;
    /** Within the refresh grace period on a run day, not proof the agent is running. */
    refreshPending: boolean;
    /**
     * True once the refresh threshold and 45-minute grace period have elapsed.
     * The brief is old enough that the agent has probably missed a run.
     * Counted only in hours the agent was scheduled for — see `workingMsBetween` —
     * so days off never make a brief look neglected.
     */
    stale: boolean;
  };
  items: ResolvedItem[];
  agenda: Agenda;
  /** The live pull request board. Present even when off, so the client can say why. */
  board: BoardState;
  /** Connecting GitHub and Jira from the page; see `connect.ts`. */
  connections: Record<Service, ConnectionState>;
  /** The Jira ticket board. Present even when off, for the same reason. */
  tickets: TicketBoardState;
  /** The on-demand assistant. Present even when off, so the client can hide the button. */
  assistant: AssistantState;
  /** The morning agent, run by the dashboard. Present even when off, so the client can hide the button. */
  agentRun: AgentRunState;
  stats: {
    open: number;
    topPriority: number;
    completedToday: number;
    overdue: number;
  };
  /** Populated when items.json is missing or unreadable. Surfaced as a banner. */
  problem: string | null;
  /** Non-fatal complaints about the agent's payload, e.g. dropped malformed items. */
  warnings: string[];
  /**
   * What is wrong with how this dashboard is set up rather than with the brief:
   * links in the store that don't point at this checkout (see `src/links.ts`), or
   * a settings file it couldn't use. Markdown written by this repo, never by the
   * agent.
   */
  setupWarnings: string[];
  /**
   * What changed in how this dashboard is set up and is worth saying, though
   * nothing is wrong: a store that moved into its profile's folder, for a day
   * after the move. Markdown written by this repo.
   */
  setupNotices: string[];
  /**
   * Settings were saved and the dashboard restarts to apply them as soon as
   * nothing is running: `waiting` while the morning agent or the assistant is,
   * `manual` when nothing here can restart it and the user has to.
   */
  restart: 'waiting' | 'manual' | null;
  /** What a new store still needs; see `src/setup.ts`. */
  setup: SetupState;
  /**
   * The setup screen, while a new store is being set up; null otherwise, which
   * is every store that has finished it or ever had a brief. See `onboarding.ts`.
   */
  onboarding: OnboardingState | null;
  /** Server time at render, so the client can place the "now" marker without clock skew. */
  now: string;
  /**
   * The dashboard's IANA time zone: the one a browser last reported, or the
   * Mac's if it has moved since; see `src/zone.ts`. Scheduling, calendar dates
   * and every displayed clock time use it, even in a browser somewhere else.
   */
  timeZone: string;
  /**
   * Fingerprint of the files in `public/`. The client reloads itself when this
   * changes, because the SSE stream carries state but never code.
   */
  assetVersion: string;
  /**
   * Which store this dashboard is on; see `Store.fingerprint`. A tab outlives the
   * dashboard that served it, and its live feed reconnects to whichever one is
   * next on the same address, on whatever store.
   */
  storeId: string;
}

/**
 * What a new store still needs before a morning brief can work. The Today tab
 * walks through it while `needed`; the objective, the agent and the boards are
 * read from the rest of the state.
 */
export interface SetupState {
  /** Nothing has ever written a brief to this store. */
  needed: boolean;
  /** What this instance briefs. */
  profile: 'work' | 'personal';
  /**
   * Whether `sources.md` exists, and how many of the template's placeholders it
   * still holds. Never its text: that goes only to the editor that asks for it.
   */
  sources: { exists: boolean; placeholders: number };
  /** Where each CLI the dashboard can run was found, or null when it wasn't. */
  clis: Record<'claude' | 'codex', string | null>;
  /**
   * The live agenda: whether this machine can have one, whether the helper is
   * built, how many calendars are chosen, and the command that builds the helper.
   * `macApp` is where to get the Mac app, which comes with the helper, offered
   * before the command when the npm package runs on a Mac; null otherwise.
   */
  calendar: { supported: boolean; built: boolean; chosen: number; buildCommand: string; macApp: string | null };
}

/**
 * The setup screen: every question it asks, in order, each with what it would
 * write and how far the user has got. The questions are the dashboard's; what
 * is already ticked is what the user is likely to want, which for some of them
 * a CLI has looked into (`proposal`). See `src/questions.ts`.
 */
export interface OnboardingState {
  /**
   * Whether it has looked for the CLIs yet. The screen asks it to when it opens:
   * nothing is run before someone is there to see it.
   */
  detected: boolean;
  steps: OnboardingStep[];
  /** The step the screen is on: the first neither answered nor put off. Null once only the finish is left. */
  current: string | null;
  /** Why the last finish was refused, in the words of what refused it. */
  error: string | null;
}

export interface OnboardingStep {
  id: string;
  title: string;
  /** What it is about in a few words, for the list of what is still to come. */
  topic: string;
  /** `later` is a step put off: it writes nothing, and its setting keeps its default. */
  status: 'answered' | 'later' | 'open';
  /** The answer in a sentence, for a step that has one: "Claude Code writes your brief." */
  summary: string | null;
  card: OnboardingCard;
  /** The CLI's look into this step, when it has one. */
  proposal: OnboardingProposal | null;
  answer: OnboardingAnswer | null;
}

/** One question as the screen draws it. */
export interface OnboardingCard {
  /**
   * Bumped when what the card offers changes under the user: a proposal
   * landing, or being revised. A draft made against an older version is kept,
   * and the screen offers the new one rather than overwriting it.
   */
  version: number;
  /** Why these are ticked, in a sentence or two. */
  why: string | null;
  choices: OnboardingChoice[];
  fields: OnboardingField[];
  /**
   * Something to fix outside the dashboard, and how. `blocking` when the card
   * can't be answered until it is; otherwise the answer stands without it.
   */
  problem: { message: string; command: string | null; blocking: boolean; links?: { label: string; url: string }[] } | null;
  /** Whether the user can tell the CLI what to change: the step has a proposal behind it. */
  revisable: boolean;
  /** The button that leaves the question unanswered, named for what it does; null where Continue already can. */
  later: string | null;
  /** What the box for replying to the CLI invites, when the question wants more than corrections. */
  reply?: string;
  /**
   * The services the card's `services` choice offers, each with who it is
   * connected as, or null while it isn't. A ticked one connects on the card
   * itself, from `DashboardState.connections`, and Continue waits until every
   * ticked one is connected.
   */
  connections?: { service: Service; account: string | null }[];
  /** What Continue says while every field is empty, where that is a way to answer: "Continue without one". */
  empty?: string;
}

export interface OnboardingChoice {
  id: string;
  /** A heading for the choice, when a card has more than one. */
  label: string | null;
  multiple: boolean;
  options: OnboardingOption[];
  selected: string[];
  /** Placeholder for a value of the user's own, when one may be added. */
  custom: string | null;
}

export interface OnboardingOption {
  value: string;
  label: string;
  detail: string | null;
  /** Options sharing a group are drawn under its name: the account a calendar is on. */
  group: string | null;
}

export interface OnboardingField {
  id: string;
  label: string;
  value: string;
  placeholder: string | null;
  help: string | null;
  /** Values offered for it, none of them filled in: a click puts one in the field. */
  suggestions?: { text: string; detail: string | null }[];
}

export interface OnboardingProposal {
  status: 'working' | 'ready' | 'failed';
  /**
   * What it said and what the user told it, in order: its reason for each
   * proposal, and each change asked for. The card shows them where the user
   * typed, so a reply lands under the question it answers.
   */
  conversation: { from: 'you' | 'it'; text: string }[];
  /** What the CLI did on the way, as the assistant's panel shows it. */
  steps: AssistantStep[];
  error: string | null;
}

/** What the user chose on a card, or that they would rather decide later. */
export type OnboardingAnswer =
  | { later: true }
  | { later?: false; choices: Record<string, string[]>; fields: Record<string, string> };
