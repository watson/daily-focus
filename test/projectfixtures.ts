/**
 * An invented epic for the Projects view's tests, and the boards around it:
 * the ticket board's linked pull requests and the pull request board's rows,
 * judged by the server's own `resolveBoard` so they are what the page is sent.
 *
 * PAY-200, "Ledger rewrite", under the initiative PAY-100:
 *
 *   PAY-201 ready to merge (#412)           blocks PAY-202 and PAY-203
 *   PAY-202 ready to merge (#415, stacked on #412), waits for PAY-201
 *   PAY-203 a draft, checks passed (#420), waits for PAY-201
 *   PAY-204 not started, waits for PAY-202 and PAY-203
 *   PAY-205 Dana's, in review as far as Jira's roll-up says
 *   PAY-206 not started, nothing to wait for
 *   PAY-207 every pull request merged (#398), still In Review in Jira
 *   PAY-208 done
 *   PAY-209 waiting on reviewers long enough to nudge (acme/web #88), waits for OPS-7 elsewhere
 *   PAY-210 changes requested (#430)
 */

import { planProject } from '../src/projects.ts';
import { resolveBoard } from '../src/prs.ts';
import type {
  BoardRow,
  BoardState,
  DashboardState,
  InProgressTicket,
  LinkedPull,
  OutsideTicket,
  ProjectRead,
  ProjectSummary,
  ProjectTicket,
  ProjectsState,
  PullRequest,
  TicketBoardState,
  TicketStatusCategory,
} from '../src/types.ts';
import type { PlannedRead } from '../client/stages.ts';

export const NOW = new Date('2026-10-14T12:00:00Z');
export const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const SITE = 'https://acme.atlassian.net/browse/';

const STATUS: Record<TicketStatusCategory, string> = { new: 'To Do', indeterminate: 'In Progress', done: 'Done', undefined: '' };

export function ticket(key: string, overrides: Partial<ProjectTicket> = {}): ProjectTicket {
  const category = overrides.statusCategory ?? 'indeterminate';
  return {
    key,
    summary: `Work for ${key}`,
    issueType: 'Task',
    workflowStatus: STATUS[category],
    statusCategory: category,
    url: `${SITE}${key}`,
    parent: 'PAY-200',
    assignee: 'Alex Moreau',
    mine: true,
    blockedBy: [],
    blocks: [],
    pulls: null,
    linksRead: true,
    ...overrides,
  };
}

export function summary(key: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    key,
    summary: `Project ${key}`,
    issueType: 'Epic',
    level: 1,
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    url: `${SITE}${key}`,
    ...overrides,
  };
}

/** A read as the server sends it: planned by the server's own `planProject`. */
export function planned(tickets: ProjectTicket[], overrides: Partial<ProjectRead> = {}): PlannedRead {
  const read: ProjectRead = {
    root: summary('PAY-200', { summary: 'Ledger rewrite' }),
    parent: summary('PAY-100', { summary: 'Payments platform', issueType: 'Initiative', level: 2 }),
    epics: [],
    tickets,
    outside: [],
    warnings: [],
    fetchedAt: hoursAgo(0),
    ...overrides,
  };
  return { ...read, plan: planProject(read.tickets, read.outside) };
}

export function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'github:pr:acme/payments-api#412',
    account: 'alex',
    repo: 'acme/payments-api',
    number: 412,
    title: 'Add the ledger table',
    url: 'https://github.com/acme/payments-api/pull/412',
    isDraft: false,
    createdAt: hoursAgo(72),
    readyAt: hoursAgo(72),
    updatedAt: hoursAgo(24),
    headRef: 'pay-201-ledger-table',
    baseRef: 'main',
    reviewDecision: 'APPROVED',
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [{ login: 'sam', state: 'APPROVED', at: hoursAgo(6) }],
    lastActivityByYou: hoursAgo(48),
    lastActivityByOthers: { at: hoursAgo(6), login: 'sam', kind: 'review' },
    // What the board needs to offer Merge and Ready for review on it.
    nodeId: `PR_node_${overrides.number ?? 412}`,
    headSha: `head${overrides.number ?? 412}`,
    defaultBranch: 'main',
    mergeMethod: 'SQUASH',
    ...overrides,
  };
}

/** A pull request as the ticket board links it to a ticket. */
export function linked(pr: PullRequest, state: LinkedPull['state'] = pr.isDraft ? 'draft' : 'open', closedAt: string | null = null): LinkedPull {
  return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, state, closedAt };
}

export const PULLS = {
  ready: pull(),
  stacked: pull({
    id: 'github:pr:acme/payments-api#415',
    number: 415,
    title: 'Write entries through the ledger',
    url: 'https://github.com/acme/payments-api/pull/415',
    headRef: 'pay-202-write-through',
    baseRef: 'pay-201-ledger-table',
  }),
  draft: pull({
    id: 'github:pr:acme/payments-api#420',
    number: 420,
    title: 'Backfill old balances',
    url: 'https://github.com/acme/payments-api/pull/420',
    headRef: 'pay-203-backfill',
    isDraft: true,
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [],
    lastActivityByOthers: null,
  }),
  merged: pull({
    id: 'github:pr:acme/payments-api#398',
    number: 398,
    title: 'Remove the dual write flag',
    url: 'https://github.com/acme/payments-api/pull/398',
    headRef: 'pay-207-flag',
  }),
  waiting: pull({
    id: 'github:pr:acme/web#88',
    repo: 'acme/web',
    number: 88,
    title: 'Show ledger balances',
    url: 'https://github.com/acme/web/pull/88',
    headRef: 'pay-209-balances',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'BLOCKED',
    requestedReviewers: ['sam'],
    reviews: [],
    lastActivityByYou: hoursAgo(72),
    lastActivityByOthers: null,
  }),
  changes: pull({
    id: 'github:pr:acme/payments-api#430',
    number: 430,
    title: 'Round ledger amounts',
    url: 'https://github.com/acme/payments-api/pull/430',
    headRef: 'pay-210-rounding',
    reviewDecision: 'CHANGES_REQUESTED',
    reviews: [{ login: 'sam', state: 'CHANGES_REQUESTED', at: hoursAgo(5) }],
    lastActivityByOthers: { at: hoursAgo(5), login: 'sam', kind: 'review' },
  }),
};

export const OPS_7: OutsideTicket = {
  key: 'OPS-7',
  summary: 'Open the ledger port',
  workflowStatus: 'In Review',
  statusCategory: 'indeterminate',
  url: `${SITE}OPS-7`,
};

export function epicTickets(): ProjectTicket[] {
  return [
    ticket('PAY-201', { summary: 'Add the ledger table', workflowStatus: 'In Review', blocks: ['PAY-202', 'PAY-203'] }),
    ticket('PAY-202', { summary: 'Write entries through the ledger', workflowStatus: 'In Review', blockedBy: ['PAY-201'] }),
    ticket('PAY-203', { summary: 'Backfill old balances', blockedBy: ['PAY-201'] }),
    ticket('PAY-204', { summary: 'Drop the old balance column', statusCategory: 'new', workflowStatus: 'To Do', blockedBy: ['PAY-202', 'PAY-203'] }),
    ticket('PAY-205', {
      summary: 'Ledger metrics',
      mine: false,
      assignee: 'Dana Reyes',
      pulls: { count: 1, state: 'OPEN', stateCount: 1 },
    }),
    ticket('PAY-206', { summary: 'Document the ledger', statusCategory: 'new', workflowStatus: 'To Do' }),
    ticket('PAY-207', { summary: 'Remove the dual write flag', workflowStatus: 'In Review' }),
    ticket('PAY-208', { summary: 'Fix rounding in the old path', statusCategory: 'done', workflowStatus: 'Done', linksRead: false }),
    ticket('PAY-209', { summary: 'Show ledger balances', workflowStatus: 'In Review', blockedBy: ['OPS-7'] }),
    ticket('PAY-210', { summary: 'Round ledger amounts', workflowStatus: 'In Review' }),
  ];
}

export function epicRead(): PlannedRead {
  return planned(epicTickets(), { outside: [OPS_7] });
}

/** The pull request board's rows for the fixture's open pull requests. */
export function boardRows(): BoardRow[] {
  return resolveBoard([PULLS.ready, PULLS.stacked, PULLS.draft, PULLS.waiting, PULLS.changes], [], NOW);
}

/** The ticket board's rows for the user's unfinished tickets, carrying what GitHub linked to each. */
export function ticketRows(): InProgressTicket[] {
  const row = (key: string, pulls: LinkedPull[]): InProgressTicket =>
    ({
      id: `jira:${key}`,
      key,
      summary: `Work for ${key}`,
      workflowStatus: 'In Progress',
      statusCategory: 'indeterminate',
      issueType: 'Task',
      url: `${SITE}${key}`,
      hasAnyPr: pulls.length > 0,
      hasOpenPr: pulls.some((each) => each.state === 'open' || each.state === 'draft'),
      allPrsClosed: false,
      pulls,
      notes: [],
    }) as InProgressTicket;
  return [
    row('PAY-201', [linked(PULLS.ready)]),
    row('PAY-202', [linked(PULLS.stacked)]),
    row('PAY-203', [linked(PULLS.draft)]),
    row('PAY-207', [linked(PULLS.merged, 'merged', hoursAgo(30))]),
    row('PAY-209', [linked(PULLS.waiting)]),
    row('PAY-210', [linked(PULLS.changes)]),
  ];
}

export function projectsState(overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    enabled: true,
    epics: [summary('PAY-200', { summary: 'Ledger rewrite' }), summary('PAY-300', { summary: 'Refund flow' })],
    fetchedAt: hoursAgo(0),
    fetching: false,
    reason: null,
    open: {},
    ...overrides,
  };
}

/** A state with the fixture's boards and `projects`, everything else left out. */
export function stateWith(projects: ProjectsState | undefined, overrides: { board?: Partial<BoardState>; tickets?: Partial<TicketBoardState> } = {}): DashboardState {
  const board = { enabled: true, rows: boardRows(), ...overrides.board } as BoardState;
  const tickets = {
    enabled: true,
    reason: null,
    fetchedAt: hoursAgo(0),
    fetching: false,
    account: null,
    connect: false,
    projects: [],
    warnings: [],
    pollMinutes: 15,
    rows: [],
    counts: { settled: 0, started: 0, idle: 0, snoozed: 0 },
    inProgress: ticketRows(),
    checked: 6,
    statuses: {},
    ...overrides.tickets,
  } as TicketBoardState;
  return { now: NOW.toISOString(), items: [], board, tickets, projects } as unknown as DashboardState;
}
