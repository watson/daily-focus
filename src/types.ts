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

/** What the dashboard can record against an item. */
export type ActionType = 'done' | 'snooze' | 'dismiss' | 'reopen' | 'note';

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
  /** Why the live agenda isn't in use, or why it may be stale. */
  problem: string | null;
  /** Setup problems worth fixing that aren't stopping it working. */
  warnings: string[];
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

/** The running focus session as persisted on disk. */
export interface StoredSession {
  id: string;
  title: string;
  startedAt: string;
  minutes: number;
  advancesObjective: boolean;
  /**
   * The last moment this machine was known to be in use while the session ran.
   *
   * A checkpoint, not a measurement: something stamps it while there's evidence of
   * a person, and the moment it stops advancing — because they walked away, because
   * the lid shut, because the server wasn't running — it marks where the honest end
   * of the session is. That's what makes the away-close retroactive: the recorded
   * end is this timestamp, never the moment we noticed.
   *
   * Absent when nothing has ever been able to answer the question.
   */
  lastActiveAt?: string;
}

/**
 * Why a session stopped, which decides how much its `actualMinutes` can be trusted.
 *
 * - `user`  they pressed Stop. Exact.
 * - `away`  the machine went untouched, so it was closed back at the last sign of
 *           life. Honest to within a poll interval, and never inflated.
 * - `limit` it ran past the two-hour backstop with no way to tell whether anyone
 *           was there. A ceiling, not a measurement — read it as "at most this".
 */
export type SessionEnd = 'user' | 'away' | 'limit';

/**
 * A session the dashboard ended by itself, surfaced so the UI can own up to it.
 *
 * A timer that dies silently is worse than no timer, and silence is exactly what
 * made the record wrong before this existed: a forgotten session was quietly
 * truncated to two hours and filed as if it were fact.
 */
export interface UnattendedClose {
  id: string;
  title: string;
  /** When the session was recorded as ending — the last sign of life, not the discovery. */
  endedAt: string;
  actualMinutes: number;
  reason: Exclude<SessionEnd, 'user'>;
}

/** The running session as the client sees it. */
export interface ActiveSession extends StoredSession {
  endsAt: string;
  /** Negative once the planned time has passed — the timer keeps counting up. */
  remainingSeconds: number;
  overrun: boolean;
  /** True when the session would run into the next meeting. */
  collidesWithNextEvent: boolean;
  nextEventAt: string | null;
}

/** Focus timer state: what's running, and what's been done today. */
export interface SessionState {
  active: ActiveSession | null;
  completedToday: number;
  minutesToday: number;
  /**
   * Today's most recent self-closed session, when it's the last thing that happened.
   * The UI reports it on their return; null once they start something else.
   */
  unattendedClose: UnattendedClose | null;
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
  /** When the current wait began. The sort key within a court. */
  since: string;
  /** Only snooze is honoured here: a done or dismissed PR is still open upstream. */
  status: 'open' | 'snoozed';
  snoozedUntil?: string;
  notes: { text: string; at: string }[];
}

/** The board as the client sees it. */
export interface BoardState {
  enabled: boolean;
  /** Why the board can't run at all right now, when it can't: no gh, not logged in. */
  reason: string | null;
  fetchedAt: string | null;
  fetching: boolean;
  accounts: BoardAccount[];
  scope: string[];
  warnings: string[];
  pollMinutes: number;
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
   * From Jira's own development panel rather than from a key in a branch or a
   * title, because Jira is the side that actually knows: of one real board's 33
   * open pull requests, one named its ticket in the title and eighteen in the
   * branch, while Jira had the link for all of them.
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
}

/**
 * What looks wrong about a ticket's status. One word each, because the row's
 * heading is the whole explanation.
 *
 * - `settled` every pull request Jira knows about is closed, and it isn't Done
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
  /** Why nothing can be read at all: no acli, or acli not logged in. */
  reason: string | null;
  fetchedAt: string | null;
  fetching: boolean;
  /** Whoever `acli` is authenticated as, for the status line. Null when unknown. */
  account: string | null;
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
 * session id; this is the join, plus the one thing the panel has to redraw after
 * a reload, which is the reply.
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
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'aborted';
  /** The assistant's final message, or so far while running. Markdown. */
  reply: string;
  /** Why a turn failed or was aborted, in the CLI's words where it had any. */
  error: string | null;
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
}

/* ---------- the morning agent, started by hand ---------- */

/**
 * One run of the morning agent that the dashboard started. A line-pair in
 * `agent.jsonl`, shaped like the assistant's. Runs the scheduler starts never
 * appear here: the dashboard neither sees them nor has anything to say about them.
 */
export interface AgentRun {
  id: string;
  cli: import('./config.ts').CliName;
  /** The CLI's session id, so the run can be opened there. Null until it has said. */
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
  /** Why a run failed or was aborted, in the CLI's words where it had any. */
  error: string | null;
}

/** The hand-started agent as the client sees it. */
export interface AgentRunState {
  enabled: boolean;
  cli: import('./config.ts').CliName | null;
  /** The newest run, finished or not. Null before the first. */
  last: AgentRun | null;
}

export interface DashboardState {
  /**
   * The standing objective from focus.md, with the agent-only section removed.
   * Null when focus.md doesn't exist.
   */
  focus: import('./focus.ts').PublicFocus | null;
  /** Only computed when focus.md sets an objective; null otherwise. */
  objectiveProgress: ObjectiveProgress | null;
  /** Focus timer: the running session, plus today's tally. */
  session: SessionState;
  /** Whether the agenda is live from the calendar, or the brief's own events. */
  agendaSource: AgendaSource;
  /**
   * Which weekdays the briefing agent runs on — the dashboard's whole notion of a
   * weekend, which is why it's resolved once and sent rather than assumed twice.
   */
  schedule: {
    /** Days a run is due, 0 = Sunday. */
    days: number[];
    /** `config` when it was told, `observed` when derived from the archive. */
    source: 'config' | 'observed' | 'default';
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
  /** The Jira ticket board. Present even when off, for the same reason. */
  tickets: TicketBoardState;
  /** The on-demand assistant. Present even when off, so the client can hide the button. */
  assistant: AssistantState;
  /** The morning agent, run from the dashboard. Present even when off, so the client can hide the button. */
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
  /** Server time at render, so the client can place the "now" marker without clock skew. */
  now: string;
  /**
   * Fingerprint of the files in `public/`. The client reloads itself when this
   * changes, because the SSE stream carries state but never code.
   */
  assetVersion: string;
}
