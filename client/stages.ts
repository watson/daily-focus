/**
 * Where each ticket in a project stands, and what to do next about it.
 *
 * The Projects view joins three sources that each know part of the story. Jira
 * knows a ticket's status, whose it is and its blocks links; the ticket board
 * knows which of the user's own pull requests GitHub has for it; and the pull
 * request board knows where each of those stands while it is open. Nothing here
 * reads anything: it takes what the state already carries, so a test can hand it
 * any mix of the three.
 *
 * Pure and free of the DOM, for the reason `src/tickets.ts` is: a stage is a
 * judgement about facts read elsewhere, so it is worked out on every render and
 * never stored.
 *
 * Teammates' tickets get their Jira status and nothing more, apart from the
 * coarse stage Jira's own roll-up of their pull requests gives. Only the user's
 * own tickets lead to anything to do.
 */

import type {
  BoardRow,
  CourtReason,
  DashboardState,
  DoneCheckState,
  LinkedPull,
  LinkedPullState,
  OutsideTicket,
  ProjectPlan,
  ProjectPulls,
  ProjectRead,
  ProjectTicket,
} from '../src/types.ts';
import { planProject } from '../src/projects.ts';
import { relativeTime, waitedFor } from './format.ts';

/* ---------- stages ---------- */

/**
 * How far a ticket has got, least advanced first. `progress` is a ticket whose
 * status says the work has begun with no pull request to show for it.
 */
export type Stage = 'not-started' | 'progress' | 'draft' | 'review' | 'ready' | 'merged' | 'done';

export const STAGES: readonly Stage[] = ['not-started', 'progress', 'draft', 'review', 'ready', 'merged', 'done'];

/** What each stage is called on the page, in the legend and on a card. */
export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  'not-started': 'Not started',
  progress: 'In progress, no pull request',
  draft: 'Draft',
  review: 'In review',
  ready: 'Ready to merge',
  merged: 'Merged',
  done: 'Done',
};

/** Whether `stage` has got at least as far as `floor`. */
export function atLeast(stage: Stage, floor: Stage): boolean {
  return STAGES.indexOf(stage) >= STAGES.indexOf(floor);
}

/** Where one of the user's pull requests stands. */
export type PullStage = 'draft' | 'review' | 'ready' | 'merged' | 'closed';

const OPEN_STAGES: readonly PullStage[] = ['draft', 'review', 'ready'];

/** One of the user's pull requests for a ticket, joined to its row on the pull request board. */
export interface PullWork {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: LinkedPullState;
  closedAt: string | null;
  stage: PullStage;
  /** Its row on the pull request board, while it is open and the board has it. */
  row: BoardRow | null;
  /** The open pull request it is stacked on: one in the same repository whose branch is this one's base. */
  stackedOn: BoardRow | null;
}

/** One ticket, with how far it has got and the pull requests that say so. */
export interface TicketWork {
  ticket: ProjectTicket;
  stage: Stage;
  /**
   * What decided the stage: the user's pull requests as GitHub has them, Jira's
   * roll-up of a ticket's pull requests, or the status alone.
   */
  basis: 'github' | 'jira' | 'status';
  /** The user's pull requests for it, open ones first. Empty for a teammate's ticket. */
  pulls: PullWork[];
  /** An open pull request is waiting on the user: the pull request board's `you`. */
  needsYou: boolean;
  /** A reviewer asked for changes on an open one. */
  changesRequested: boolean;
}

/** What the state carries about the user's pull requests, gathered for joining. */
export interface PullSources {
  /** The pull requests GitHub has for each of the user's unfinished tickets, by upper-cased key. */
  linked: ReadonlyMap<string, readonly LinkedPull[]>;
  /** The pull request board's rows, by url. */
  rows: ReadonlyMap<string, BoardRow>;
  /** The same rows by `repo` and head branch, for telling which one another is stacked on. */
  heads: ReadonlyMap<string, BoardRow>;
}

const headKey = (repo: string, branch: string): string => `${repo}\n${branch}`;

/**
 * The pull request facts in a state. The ticket board carries a ticket once per
 * view it is in, so its pull requests are gathered from both and kept once each.
 */
export function pullSources(state: Pick<DashboardState, 'tickets' | 'board'> & Partial<Pick<DashboardState, 'projects'>>): PullSources {
  const linked = new Map<string, LinkedPull[]>();
  const add = (key: string, pulls: readonly LinkedPull[]): void => {
    const name = key.toUpperCase();
    const list = linked.get(name) ?? [];
    for (const pull of pulls) if (!list.some((known) => known.url === pull.url)) list.push(pull);
    linked.set(name, list);
  };
  for (const ticket of [...(state.tickets?.rows ?? []), ...(state.tickets?.inProgress ?? [])]) add(ticket.key, ticket.pulls ?? []);
  // The ticket board shows only some of the user's tickets (flagged, or in an
  // in-progress status); the server hands each project ticket of theirs its
  // own, so one "In Review", say, still has its pull requests here.
  for (const entry of Object.values(state.projects?.open ?? {})) {
    for (const ticket of entry.read?.tickets ?? []) if (ticket.github) add(ticket.key, ticket.github);
  }
  const boardRows = state.board?.enabled ? (state.board.rows ?? []) : [];
  return {
    linked,
    rows: new Map(boardRows.map((row) => [row.url, row])),
    heads: new Map(boardRows.map((row) => [headKey(row.repo, row.headRef), row])),
  };
}

/** Where one open or closed pull request stands, from its board row when there is one. */
function pullStage(pull: LinkedPull, row: BoardRow | null): PullStage {
  if (pull.state === 'merged') return 'merged';
  if (pull.state === 'closed') return 'closed';
  // The board's reading wins over the ticket board's: it is read every few
  // minutes, and knows a draft marked ready since.
  if (row) {
    if (row.isDraft || row.court === 'draft') return 'draft';
    return row.court === 'ready' ? 'ready' : 'review';
  }
  return pull.state === 'draft' ? 'draft' : 'review';
}

/** The open board row `row` is stacked on, if any: same repository, and its base is that one's branch. */
function stackedOn(row: BoardRow | null, sources: PullSources): BoardRow | null {
  if (!row || !row.baseRef) return null;
  const base = sources.heads.get(headKey(row.repo, row.baseRef));
  return base && base.url !== row.url ? base : null;
}

/**
 * The coarse stage Jira's roll-up gives, for a ticket nobody here has the pull
 * requests of. The roll-up names one state and how many sit in it, so only a
 * roll-up that accounts for all of them can say they all merged; anything it
 * leaves unnamed might still be open, and is taken to be.
 */
function rollUpStage(pulls: ProjectPulls | null): Stage | null {
  if (!pulls || pulls.count < 1) return null;
  const state = pulls.state.toUpperCase();
  if (state === 'DRAFT') return 'draft';
  if (state === 'OPEN') return 'review';
  if (pulls.stateCount !== pulls.count) return 'review';
  if (state === 'MERGED') return 'merged';
  // Every one declined: as if there were none.
  return null;
}

/**
 * Where a ticket stands.
 *
 * Done when Jira says so. Otherwise, for the user's own ticket with pull
 * requests GitHub knows of: the least advanced open one decides, so a ticket
 * is ready to merge only when every open one is; with none open, merged when at
 * least one merged. Without those, Jira's roll-up decides, and without that the
 * status: begun or not.
 */
/**
 * The user's pull requests for a ticket, joined to their rows on the pull request
 * board, open ones first. Shared by the cards and the panel.
 */
export function ticketPulls(key: string, sources: PullSources): PullWork[] {
  const pulls = (sources.linked.get(key.toUpperCase()) ?? []).map((pull): PullWork => {
    const row = pull.state === 'open' || pull.state === 'draft' ? (sources.rows.get(pull.url) ?? null) : null;
    return {
      repo: pull.repo,
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: pull.state,
      closedAt: pull.closedAt,
      stage: pullStage(pull, row),
      row,
      stackedOn: stackedOn(row, sources),
    };
  });
  return pulls.sort((a, b) => Number(!OPEN_STAGES.includes(a.stage)) - Number(!OPEN_STAGES.includes(b.stage)));
}

export function ticketWork(ticket: ProjectTicket, sources: PullSources): TicketWork {
  const pulls: PullWork[] = ticket.mine ? ticketPulls(ticket.key, sources) : [];

  const open = pulls.filter((pull) => OPEN_STAGES.includes(pull.stage));
  const needsYou = open.some((pull) => pull.row?.court === 'you');
  const changesRequested = open.some((pull) => pull.row?.decision === 'CHANGES_REQUESTED');
  const work = (stage: Stage, basis: TicketWork['basis']): TicketWork => ({ ticket, stage, basis, pulls, needsYou, changesRequested });

  if (ticket.statusCategory === 'done') return work('done', 'status');
  if (open.length > 0) {
    const least = open.reduce((a, b) => (OPEN_STAGES.indexOf(b.stage) < OPEN_STAGES.indexOf(a.stage) ? b : a));
    return work(least.stage as Stage, 'github');
  }
  if (pulls.some((pull) => pull.stage === 'merged')) return work('merged', 'github');
  // GitHub's answer is the newer one when it has any: a roll-up still saying open
  // about pull requests GitHub says closed is Jira running behind.
  if (pulls.length === 0) {
    const coarse = rollUpStage(ticket.pulls);
    if (coarse) return work(coarse, 'jira');
  }
  return work(ticket.statusCategory === 'indeterminate' ? 'progress' : 'not-started', 'status');
}

/**
 * How a card's stage was worked out, for its hover. A ticket is only as far
 * along as the least advanced of its open pull requests (Draft, then In review,
 * then Ready to merge), unless one of them needs the user, which is said instead.
 * Without pull requests of the user's that GitHub links to it, Jira's roll-up of
 * its pull requests or its status decides.
 */
export function stageWhy(work: TicketWork): string {
  const open = work.pulls.filter((pull) => OPEN_STAGES.includes(pull.stage));
  if (work.stage === 'done') return 'Done in Jira.';
  if (work.changesRequested) return 'A reviewer asked for changes on one of its open pull requests.';
  if (work.needsYou) return 'One of its open pull requests is waiting on you.';
  if (work.basis === 'github') {
    if (open.length === 1) return `From its one open pull request, ${pullRef(open[0]!)}.`;
    if (open.length > 1) return `The least advanced of its ${open.length} open pull requests: a ticket is only as far along as the one furthest behind.`;
    return 'Every pull request of its has merged, and the ticket is not Done in Jira yet.';
  }
  if (work.basis === 'jira') {
    return work.ticket.mine
      ? "From Jira's summary of its pull requests: GitHub links none of yours to it here."
      : "From Jira's summary of its pull requests.";
  }
  return work.stage === 'progress'
    ? `${work.ticket.workflowStatus || 'In progress'} in Jira, with no pull request yet.`
    : 'Not started in Jira, and no pull request yet.';
}

/** What a card says on its right, and in which tone. Colour only agrees with the words. */
export function stageLabel(work: TicketWork): { text: string; tone: 'good' | 'critical' | null } {
  if (work.stage === 'done') return { text: STAGE_LABEL.done, tone: null };
  if (work.changesRequested) return { text: 'Changes requested', tone: 'critical' };
  if (work.needsYou) return { text: 'Waiting on you', tone: 'critical' };
  if (work.stage === 'ready') return { text: STAGE_LABEL.ready, tone: 'good' };
  // A teammate's pull requests are theirs to know about, so "no pull request"
  // would be a claim this page can't make.
  if (work.stage === 'progress' && !work.ticket.mine) return { text: 'In progress', tone: null };
  return { text: STAGE_LABEL[work.stage], tone: null };
}

/* ---------- wording ---------- */

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `acme/payments-api #412`: how a title names a pull request. */
export function pullRef(pull: { repo: string; number: number }): string {
  return `${pull.repo} #${pull.number}`;
}

/** One of the board's reasons, in a few words. Empty for a kind this page does not word. */
export function reasonText(reason: CourtReason, row: BoardRow, now: Date): string {
  switch (reason.kind) {
    case 'changes-requested':
      return `changes requested${reason.login ? ` by @${reason.login}` : ''}`;
    case 'ci-failing': {
      const names = row.failingChecks ?? [];
      return names.length > 0 ? `CI failing: ${listOf(names.slice(0, 2))}${names.length > 2 ? ' and more' : ''}` : 'CI failing';
    }
    case 'conflicts':
      return 'conflicts with the base branch';
    case 'behind':
      return 'the branch is behind its base';
    case 'activity':
      return reason.login ? `@${reason.login} ${reason.activity === 'review' ? 'reviewed' : 'commented'} ${relativeTime(reason.at, now)}` : '';
    default:
      return '';
  }
}

/**
 * Where a pull request stands, in the pull request board's words: "Ready to
 * merge", "Waiting on reviewers for 2 days", "Draft, checks passed".
 */
export function pullWording(pull: PullWork, now: Date): string {
  if (pull.stage === 'merged') return pull.closedAt ? `Merged ${relativeTime(pull.closedAt, now)}` : 'Merged';
  if (pull.stage === 'closed') return pull.closedAt ? `Closed without merging ${relativeTime(pull.closedAt, now)}` : 'Closed without merging';
  const row = pull.row;
  if (!row) return pull.stage === 'draft' ? 'Draft' : 'Open';
  switch (row.court) {
    case 'ready':
      return 'Ready to merge';
    case 'reviewers':
      return `Waiting on reviewers for ${waitedFor(row.since, now)}${row.nudgedAt ? ', nudged' : ''}`;
    case 'you': {
      const why = row.reasons.map((reason) => reasonText(reason, row, now)).filter(Boolean);
      return why.length > 0 ? `Waiting on you: ${why[0]}` : 'Waiting on you';
    }
    case 'gate':
      return 'Waiting on merge gate';
    case 'blocked':
      return 'Merge blocked by GitHub';
    case 'checks':
      return 'Waiting on checks';
    case 'draft':
      return row.checks === 'success'
        ? 'Draft, checks passed'
        : row.checks === 'failure'
          ? 'Draft, CI failing'
          : row.checks === 'pending'
            ? 'Draft, checks running'
            : 'Draft';
    default:
      return 'Open';
  }
}

/**
 * An open pull request's draft flag, the one thing a click on its state changes:
 * a draft, or not, which GitHub calls ready for review and the page calls In
 * review. Null once it is merged or closed.
 */
export function pullDraftState(pull: PullWork): 'draft' | 'review' | null {
  if (pull.stage === 'merged' || pull.stage === 'closed') return null;
  return pull.stage === 'draft' ? 'draft' : 'review';
}

/**
 * What follows that state: "checks passed" after Draft, the board's own words
 * after In review ("Ready to merge"), and the whole wording once merged or
 * closed. Empty when the state says it all.
 */
export function pullDetail(pull: PullWork, now: Date): string {
  const wording = pullWording(pull, now);
  if (pull.stage === 'draft') return wording.replace(/^Draft,?\s*/, '');
  return wording === 'Open' ? '' : wording;
}

/* ---------- a project ---------- */

/** A read, planned, as the state carries it. */
export type PlannedRead = ProjectRead & { plan: ProjectPlan };

/** A project's tickets joined to their pull requests, with what the plan says about each. */
export interface ProjectWork {
  read: PlannedRead;
  /** Every ticket, by key. */
  works: ReadonlyMap<string, TicketWork>;
  /** `plan.order`, keeping only keys that are tickets of the read. */
  order: readonly string[];
  /** What each ticket still waits for, from the plan. */
  waitsFor: Readonly<Record<string, readonly string[]>>;
  /** For each ticket, the unfinished tickets inside the project waiting for it, in order. */
  dependents: ReadonlyMap<string, readonly string[]>;
  outside: ReadonlyMap<string, OutsideTicket>;
  /** What the done check says about the user's own tickets, shown on their cards; null from an older server. */
  checks: DoneCheckState | null;
  /** The plan the order comes from: the server's, or one made again with the pull requests' stacks in it. */
  plan: ProjectPlan;
  /** For each ticket, the tickets whose pull requests its own are stacked on. */
  stackedOn: ReadonlyMap<string, readonly string[]>;
  /** Where Jira's links said the opposite of a stack, which won: `ticket` is stacked on `over`, though Jira said it blocks `over`. */
  overruled: readonly { ticket: string; over: string }[];
  /** The tickets with the links the plan was made from: Jira's, with the stacks in and the links they overruled out. */
  links: readonly ProjectTicket[];
}

/**
 * The stacks between tickets: a ticket whose pull request is stacked on
 * another ticket's pull request merges after that ticket, whatever Jira's links
 * say, since a stack is the order the code will actually land in. Stacks inside
 * one ticket are its own business.
 */
function ticketStacks(works: ReadonlyMap<string, TicketWork>): Map<string, string[]> {
  const ticketOf = new Map<string, string>();
  for (const work of works.values()) for (const pull of work.pulls) ticketOf.set(pull.url, work.ticket.key);
  const stacks = new Map<string, string[]>();
  for (const work of works.values()) {
    for (const pull of work.pulls) {
      const parent = pull.stackedOn ? ticketOf.get(pull.stackedOn.url) : undefined;
      if (!parent || parent === work.ticket.key) continue;
      const parents = stacks.get(work.ticket.key) ?? [];
      if (!parents.includes(parent)) parents.push(parent);
      stacks.set(work.ticket.key, parents);
    }
  }
  return stacks;
}

/**
 * The plan with the stacks in it. Each stack becomes a link the plan honours, and
 * a Jira link pointing the other way between the same two tickets is dropped, so
 * the stack wins rather than the two making a loop. Null when there are no
 * stacks between tickets, and the server's plan stands as it is.
 */
function stackedPlan(
  read: PlannedRead,
  stacks: ReadonlyMap<string, readonly string[]>,
): { plan: ProjectPlan; overruled: { ticket: string; over: string }[]; tickets: ProjectTicket[] } | null {
  if (stacks.size === 0) return null;
  const overruled: { ticket: string; over: string }[] = [];
  const contradicted = (child: string, parent: string): boolean => (stacks.get(child) ?? []).includes(parent);
  const tickets = read.tickets.map((ticket) => {
    const parents = stacks.get(ticket.key) ?? [];
    // Jira saying a ticket stacked on this one blocks it: the stack says the reverse.
    const blockedBy = ticket.blockedBy.filter((blocker) => {
      if (!contradicted(blocker, ticket.key)) return true;
      overruled.push({ ticket: blocker, over: ticket.key });
      return false;
    });
    const blocks = ticket.blocks.filter((blocked) => !contradicted(ticket.key, blocked));
    return { ...ticket, blockedBy: [...new Set([...blockedBy, ...parents])], blocks };
  });
  for (const ticket of read.tickets) {
    for (const blocked of ticket.blocks) if (contradicted(ticket.key, blocked)) overruled.push({ ticket: ticket.key, over: blocked });
  }
  // Said once per pair, however many of the two tickets named the link.
  const once = new Map(overruled.map((each) => [`${each.ticket}>${each.over}`, each]));
  return { plan: planProject(tickets, read.outside), overruled: [...once.values()], tickets };
}

export function projectWork(read: PlannedRead, sources: PullSources, checks: DoneCheckState | null = null): ProjectWork {
  const works = new Map(read.tickets.map((ticket) => [ticket.key, ticketWork(ticket, sources)]));
  const stacks = ticketStacks(works);
  const restacked = stackedPlan(read, stacks);
  const plan = restacked?.plan ?? read.plan;
  const order = plan.order.filter((key) => works.has(key));
  // A ticket the order missed still gets a place, at the end: dropped, it
  // would be the one thing on the project nobody sees.
  for (const ticket of read.tickets) if (!order.includes(ticket.key)) order.push(ticket.key);
  const waitsFor: Record<string, readonly string[]> = {};
  for (const key of order) waitsFor[key] = plan.waitsFor?.[key] ?? [];
  const dependents = new Map<string, string[]>(order.map((key) => [key, []]));
  for (const key of order) {
    if (works.get(key)!.stage === 'done') continue;
    for (const blocker of waitsFor[key]!) dependents.get(blocker)?.push(key);
  }
  return {
    read,
    works,
    order,
    waitsFor,
    dependents,
    outside: new Map(read.outside.map((ticket) => [ticket.key, ticket])),
    checks,
    plan,
    stackedOn: stacks,
    overruled: restacked?.overruled ?? [],
    links: restacked?.tickets ?? read.tickets,
  };
}

export type StageCounts = Record<Stage, number>;

export function stageCounts(works: Iterable<TicketWork>): StageCounts {
  const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as StageCounts;
  for (const work of works) counts[work.stage]++;
  return counts;
}

/**
 * A ticket named where it waits or blocks: its key, and for one outside the
 * project what it is and where it stands, as "OPS-7 (another epic, In Review)".
 */
export function nameTicket(key: string, project: ProjectWork): string {
  const outside = project.outside.get(key);
  if (outside) return `${key} (another epic${outside.workflowStatus ? `, ${outside.workflowStatus}` : ''})`;
  return key;
}

/**
 * What a ticket holds up: the unfinished tickets inside waiting for it, then
 * those outside its links name that are not known to be done.
 */
export function blocksOf(key: string, project: ProjectWork): string[] {
  const inside = [...(project.dependents.get(key) ?? [])];
  const ticket = project.works.get(key)?.ticket;
  const beyond = (ticket?.blocks ?? []).filter(
    (other) => !project.works.has(other) && project.outside.get(other)?.statusCategory !== 'done' && !inside.includes(other),
  );
  return [...inside, ...beyond];
}

/**
 * A loop, as a path round it: "PROJ-2 → PROJ-3 → PROJ-2". The plan gives the
 * members of each loop; this finds a cycle through them along the links, and
 * names any member the cycle missed after it.
 */
export function loopPath(members: readonly string[], tickets: readonly ProjectTicket[]): { path: string[]; others: string[] } {
  const inLoop = new Set(members);
  const next = new Map<string, Set<string>>(members.map((key) => [key, new Set<string>()]));
  for (const ticket of tickets) {
    if (!inLoop.has(ticket.key)) continue;
    for (const blocker of ticket.blockedBy) if (inLoop.has(blocker)) next.get(blocker)!.add(ticket.key);
    for (const blocked of ticket.blocks) if (inLoop.has(blocked)) next.get(ticket.key)!.add(blocked);
  }
  const start = members[0];
  if (start === undefined) return { path: [], others: [] };
  // Breadth first, for the shortest way back round.
  const cameFrom = new Map<string, string>();
  const queue = [start];
  let closing: string | null = null;
  while (queue.length > 0 && closing === null) {
    const key = queue.shift()!;
    for (const to of next.get(key) ?? []) {
      if (to === start) {
        closing = key;
        break;
      }
      if (!cameFrom.has(to)) {
        cameFrom.set(to, key);
        queue.push(to);
      }
    }
  }
  if (closing === null) return { path: [...members], others: [] };
  const path = [start];
  for (let key: string | undefined = closing; key !== undefined && key !== start; key = cameFrom.get(key)) path.splice(1, 0, key);
  path.push(start);
  return { path, others: members.filter((key) => !path.includes(key)) };
}

/* ---------- what to do next ---------- */

export type NextKind = 'merge' | 'merge-after' | 'close' | 'ready' | 'answer' | 'nudge' | 'start';

/** One thing the user can do now, as the list ranks it. */
export interface NextStep {
  kind: NextKind;
  /** The ticket it moves on. */
  key: string;
  /** What to do, as a verb: "Merge acme/payments-api #412". */
  title: string;
  /** Why, in a line: the ticket, and what it unblocks or waits for. */
  reason: string;
  /** Where the button goes, and so what it says. Null when there is nowhere to link. */
  url: string | null;
  on: 'github' | 'jira';
  /**
   * The pull request board's row the step is about, when it is about an open
   * pull request the board has: what the page needs to offer the board's own
   * Merge or Ready for review beside the link. Null for a ticket's step.
   */
  pull: BoardRow | null;
}

/**
 * Everything the user can do now to move the project on, in the order worth
 * doing it:
 *
 * 1. Merge what is ready and waits for nothing, what frees the most first.
 * 2. Then merge what is ready behind blockers that are themselves only waiting
 *    to be merged (or stacked on a pull request that is), saying after which.
 * 3. Move to Done a ticket whose pull requests have all merged.
 * 4. Mark ready for review a draft whose checks passed, once what its ticket
 *    waits for is at least ready to merge.
 * 5. Answer a pull request waiting on the user, or fix its CI.
 * 6. Nudge reviewers who have been asked long enough.
 * 7. Start a ticket of theirs that waits for nothing.
 *
 * Only the user's own tickets lead anywhere. `only` narrows it to some
 * tickets, as an initiative's epic cards do.
 */
export function nextSteps(project: ProjectWork, now: Date, only: (work: TicketWork) => boolean = () => true): NextStep[] {
  const { works, order, waitsFor } = project;
  const position = new Map(order.map((key, i) => [key, i]));
  const mine = order.map((key) => works.get(key)!).filter((work) => work.ticket.mine && work.stage !== 'done' && only(work));

  // Whether a ticket's work can land once merging starts: it is ready, or
  // merged, and so is everything it waits for. A loop never can.
  const memo = new Map<string, boolean>();
  const path = new Set<string>();
  const clear = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const work = works.get(key);
    if (!work || path.has(key)) return false;
    if (work.stage === 'done') return true;
    path.add(key);
    const result = (work.stage === 'ready' || work.stage === 'merged') && (waitsFor[key] ?? []).every(clear);
    path.delete(key);
    memo.set(key, result);
    return result;
  };

  const freedBy = (key: string): number =>
    (project.dependents.get(key) ?? []).filter((other) => waitsFor[other]!.every((blocker) => blocker === key)).length;
  const unblocks = (key: string): string => {
    const held = blocksOf(key, project);
    return held.length > 0 ? `unblocks ${listOf(held.map((other) => nameTicket(other, project)))}` : '';
  };
  const line = (key: string, ...parts: string[]): string => [key, ...parts.filter(Boolean)].join(' · ');
  const byImpact = (a: string, b: string): number =>
    freedBy(b) - freedBy(a) ||
    (project.dependents.get(b)?.length ?? 0) - (project.dependents.get(a)?.length ?? 0) ||
    position.get(a)! - position.get(b)!;

  // Whose each of the user's pull requests is, so a stack on a blocker's own
  // pull request is said once, as the blocker, rather than twice.
  const ticketOf = new Map<string, string>();
  for (const work of works.values()) for (const pull of work.pulls) ticketOf.set(pull.url, work.ticket.key);

  const merge: { key: string; step: NextStep }[] = [];
  const mergeAfter: NextStep[] = [];
  const close: NextStep[] = [];
  const ready: NextStep[] = [];
  const answer: NextStep[] = [];
  const nudge: NextStep[] = [];
  const start: { key: string; step: NextStep }[] = [];

  for (const work of mine) {
    const key = work.ticket.key;
    const waits = waitsFor[key] ?? [];
    const summary = work.ticket.summary;

    if (work.stage === 'merged') {
      close.push({
        kind: 'close',
        key,
        title: `Move ${key} to Done`,
        reason: line(key, 'every pull request has merged', unblocks(key)),
        url: work.ticket.url,
        on: 'jira',
        pull: null,
      });
    }
    if (work.stage === 'not-started' && waits.length === 0) {
      start.push({ key, step: { kind: 'start', key, title: `Start ${key}`, reason: line(key, summary, unblocks(key)), url: work.ticket.url, on: 'jira', pull: null } });
    }

    for (const pull of work.pulls) {
      const row = pull.row;
      // A ticket whose links could not be read may wait for something unseen, so
      // it is never offered to merge; its card says why.
      if (pull.stage === 'ready' && work.ticket.linksRead) {
        const base = pull.stackedOn;
        if (waits.length === 0 && !base) {
          merge.push({ key, step: { kind: 'merge', key, title: `Merge ${pullRef(pull)}`, reason: line(key, unblocks(key) || summary), url: pull.url, on: 'github', pull: row } });
        } else if (waits.every(clear) && (!base || (base.court === 'ready' && !base.isDraft))) {
          const baseTicket = base ? ticketOf.get(base.url) : undefined;
          const after = [...waits, ...(base && !(baseTicket && waits.includes(baseTicket)) ? [`#${base.number}`] : [])];
          mergeAfter.push({
            kind: 'merge-after',
            key,
            title: `Then merge ${pullRef(pull)} (after ${listOf(after)})`,
            reason: line(key, unblocks(key) || summary),
            url: pull.url,
            on: 'github',
            pull: row,
          });
        }
      }
      if (row && pull.stage === 'draft' && row.checks === 'success' && waits.every((other) => atLeastReady(other, project))) {
        const behind = waits.length > 0 ? `${listOf(waits)} ${waits.length === 1 ? 'is' : 'are'} ready to merge` : '';
        ready.push({
          kind: 'ready',
          key,
          title: `Mark ${pullRef(pull)} ready for review`,
          reason: line(key, 'checks passed', behind),
          url: pull.url,
          on: 'github',
          pull: row,
        });
      }
      if (row && row.court === 'you') {
        // A reviewer who asked for changes has also, by doing so, acted last: once is enough.
        const askers = new Set(row.reasons.flatMap((reason) => (reason.kind === 'changes-requested' && reason.login ? [reason.login] : [])));
        const why = row.reasons
          .filter((reason) => !(reason.kind === 'activity' && reason.login && askers.has(reason.login)))
          .map((reason) => reasonText(reason, row, now))
          .filter(Boolean);
        answer.push({ kind: 'answer', key, title: answerTitle(row, pull), reason: line(key, ...why.slice(0, 2)), url: pull.url, on: 'github', pull: row });
      }
      if (row && row.nudge) {
        const asked = row.requestedReviewers.length > 0 ? `asked ${row.requestedReviewers.map((login) => `@${login}`).join(', ')}` : '';
        nudge.push({
          kind: 'nudge',
          key,
          title: `Nudge reviewers on ${pullRef(pull)}`,
          reason: line(key, `waiting on reviewers for ${waitedFor(row.since, now)}`, asked),
          url: pull.url,
          on: 'github',
          pull: row,
        });
      }
    }
  }

  return [
    ...merge.sort((a, b) => byImpact(a.key, b.key)).map((entry) => entry.step),
    ...mergeAfter,
    ...close,
    ...ready,
    ...answer,
    ...nudge,
    ...start.sort((a, b) => byImpact(a.key, b.key)).map((entry) => entry.step),
  ];
}

/** Whether a blocker is out of the way of marking its dependent's draft ready: inside, and at least ready to merge. */
function atLeastReady(key: string, project: ProjectWork): boolean {
  const work = project.works.get(key);
  return work !== undefined && atLeast(work.stage, 'ready');
}

/** "Fix CI on …", "Answer the review on …": the board's first reason, as what to do about it. */
function answerTitle(row: BoardRow, pull: PullWork): string {
  const ref = pullRef(pull);
  const first = row.reasons[0];
  switch (first?.kind) {
    case 'ci-failing':
      return `Fix CI on ${ref}`;
    case 'conflicts':
      return `Fix the conflicts on ${ref}`;
    case 'behind':
      return `Update the branch of ${ref}`;
    case 'changes-requested':
      return `Answer the review on ${ref}`;
    case 'activity':
      return first.login ? `Answer @${first.login} on ${ref}` : `Answer ${ref}`;
    default:
      return `Answer ${ref}`;
  }
}

/* ---------- the rail ---------- */

/** One line on the rail: from a blocker's node, down a lane, into what it blocks. */
export interface RailEdge {
  from: string;
  to: string;
  fromLane: number;
  /** The lane the line runs down between the two rows. */
  viaLane: number;
  toLane: number;
  /** The blocker's work has landed, so only Jira is left between them. */
  dotted: boolean;
}

export interface Rail {
  /** Each key's lane, from 0 at the left. */
  lanes: Record<string, number>;
  edges: RailEdge[];
  /** How many lanes it uses. */
  width: number;
}

/** The most lanes a rail may take before it is left out for the text alone. */
export const MAX_LANES = 4;

/**
 * Lanes for a list of tickets in merge order, as `git log --graph` lays out its
 * columns: a chain stays in one lane, and a branch takes the next free one.
 *
 * Read top to bottom. A line waiting to reach a ticket holds its lane until it
 * does, so nothing is ever drawn through a node. A ticket lands in the leftmost
 * lane a line is bringing to it, or the leftmost free one; its first line out
 * carries on down its own lane, and each other one takes a free lane or joins a
 * line already heading the same way. Only lines running down the list are drawn:
 * one running up is a loop, which the page names in words instead.
 *
 * Null when it would take more than `maxLanes`, since a rail that wide says less
 * than the text beside each card.
 */
export function assignLanes(
  keys: readonly string[],
  blockersOf: (key: string) => readonly string[],
  dotted: (blocker: string) => boolean = () => false,
  maxLanes: number = MAX_LANES,
): Rail | null {
  const index = new Map(keys.map((key, i) => [key, i]));
  const after = new Map<string, string[]>(keys.map((key) => [key, []]));
  for (const key of keys) {
    for (const blocker of blockersOf(key)) {
      const from = index.get(blocker);
      if (from === undefined || from >= index.get(key)! || after.get(blocker)!.includes(key)) continue;
      after.get(blocker)!.push(key);
    }
  }
  for (const list of after.values()) list.sort((a, b) => index.get(a)! - index.get(b)!);

  // The ticket each lane's line is on its way to, or null when the lane is free.
  const heading: (string | null)[] = [];
  const freeLane = (): number => {
    const lane = heading.indexOf(null);
    if (lane !== -1) return lane;
    heading.push(null);
    return heading.length - 1;
  };
  const lanes: Record<string, number> = {};
  const via = new Map<string, number>();
  let width = 0;

  for (const key of keys) {
    const arriving = heading.flatMap((to, lane) => (to === key ? [lane] : []));
    const lane = arriving.length > 0 ? arriving[0]! : freeLane();
    for (const each of arriving) heading[each] = null;
    lanes[key] = lane;
    let ownTaken = false;
    for (const to of after.get(key)!) {
      let carrying = heading.indexOf(to);
      if (carrying === -1) {
        if (!ownTaken && heading[lane] === null) {
          carrying = lane;
          ownTaken = true;
        } else {
          carrying = freeLane();
        }
        heading[carrying] = to;
      }
      via.set(`${key}\n${to}`, carrying);
    }
    width = Math.max(width, lane + 1, ...heading.map((to, each) => (to === null ? 0 : each + 1)));
    if (width > maxLanes) return null;
  }

  const edges: RailEdge[] = [];
  for (const [from, list] of after) {
    for (const to of list) {
      edges.push({ from, to, fromLane: lanes[from]!, viaLane: via.get(`${from}\n${to}`)!, toLane: lanes[to]!, dotted: dotted(from) });
    }
  }
  return { lanes, edges, width: Math.max(width, keys.length > 0 ? 1 : 0) };
}
