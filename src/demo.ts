/**
 * The demo: everything `daily-focus --demo` puts around the sample brief so that
 * every screen has something on it, for either profile.
 *
 * The brief itself is `sample.ts`. This file adds what a store accumulates over a
 * few weeks of use — an objective, a filled-in source list, the action log, the
 * morning agent's runs and a few assistant conversations, and the archive those
 * metrics are computed from — and the two worlds the boards poll:
 * a set of open pull requests and a set of Jira tickets, handed to the pollers
 * in place of `gh` and `acli` so the tabs fill without anything being connected.
 *
 * Three things are deliberately true of it:
 *
 *  - Everything is invented. One person, Mara Lindqvist, at Acme by day and at
 *    home after, so the demo of either profile tells one coherent story.
 *  - It is the one place that writes the dashboard's own files by hand — logs
 *    and archive included — and it writes them only into a store that has no
 *    brief yet, which the CLI makes fresh under `tmpdir()` and deletes on exit.
 *  - Nothing in it runs anything. The agent and the assistant are off; the
 *    pollers are answered from memory; the one write the dashboard can make
 *    to the world, a ticket's status, moves a ticket in the sample world and
 *    nowhere else.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BoardDeps } from './board.ts';
import { PROFILES, type Profile } from './config.ts';
import { SETTINGS_FILE } from './env.ts';
import { QUICK_ACTIONS } from './assistant.ts';
import { actionOf, autoKeys, type AutoAction } from './autoask.ts';
import { judge } from './prs.ts';
import { dateFromNow, sampleBrief, sampleGeneratedAt } from './sample.ts';
import type { TicketBoardDeps } from './ticketboard.ts';
import { localDateKey } from './time.ts';
import type { Action, AgentStep, AssistantStep, BoardRow, Brief, Item, PullRequest, Ticket, TicketStatusCategory } from './types.ts';

/** The GitHub login every sample pull request was fetched as. */
const LOGIN = 'mara-l';
/** The Atlassian site the sample tickets link to. */
const JIRA_SITE = 'acme.atlassian.net';
const JIRA_ACCOUNT = 'mara@acme.example';

/* ---------- time ---------- */

const MINUTE = 60_000;

const hoursAgo = (now: Date, hours: number): string => new Date(now.getTime() - hours * 60 * MINUTE).toISOString();
const daysAgo = (now: Date, days: number): string => hoursAgo(now, days * 24);

/**
 * `minutes` ago, but never before today began. What the demo did "today" —
 * marked done, asked the assistant — has to have happened today whatever the
 * hour the demo starts at, or a demo opened just after midnight has nothing
 * cleared.
 */
function minutesAgo(now: Date, minutes: number): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1).getTime();
  return new Date(Math.max(start, now.getTime() - minutes * MINUTE)).toISOString();
}

/** The same clock time `days` days back, as a date. */
function dayBack(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, now.getHours(), now.getMinutes());
}

/**
 * The nth working day back, Monday to Friday, which is the dashboard's own
 * notion of a weekend when nothing says otherwise. The archive, the agent's runs
 * and the objective's last progress are dated on these, so a demo started on a
 * Monday doesn't show a scheduled run on Sunday.
 */
export function workingDayBack(now: Date, n: number): Date {
  let date = dayBack(now, 0);
  let left = n;
  while (left > 0) {
    date = dayBack(date, 1);
    const weekday = date.getDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return date;
}

/** `date` at a given local time, as ISO. */
function timeOn(date: Date, hour: number, minute = 0): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).toISOString();
}

/* ---------- the profile, the environment and the settings ---------- */

/** `work` unless asked for `personal`; anything else is refused before a store is made. */
export function demoProfile(raw: string | undefined): Profile {
  const chosen = (raw ?? '').trim().toLowerCase() || 'work';
  if (!(PROFILES as readonly string[]).includes(chosen)) {
    throw new Error(`--profile must be one of ${PROFILES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return chosen as Profile;
}

/**
 * The environment the demo runs in: `base`, with the data folder the CLI made
 * for it and the profile whose store it wrote there, and any free port unless
 * one was asked for, so the demo never collides with a dashboard already
 * running on 4321.
 */
export function demoEnv(base: NodeJS.ProcessEnv, root: string, profile: Profile): NodeJS.ProcessEnv {
  return { ...base, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PROFILE: profile, DAILY_FOCUS_PORT: base.DAILY_FOCUS_PORT ?? '0' };
}

/**
 * The settings held over the demo store's own, so that nothing in it runs: no
 * agent, no assistant, and no read of Calendar.app, which would ask for access.
 * The page shows them and can't change them. The boards need nothing fixed, as
 * they are answered from the sample worlds whatever their settings say.
 */
export const DEMO_FIXED: Readonly<Record<string, string>> = {
  DAILY_FOCUS_AGENT: 'off',
  DAILY_FOCUS_ASSISTANT: 'off',
  DAILY_FOCUS_CALENDAR: 'off',
};

/** The demo store's own settings, as a user of either profile might have saved them. */
export function demoSettings(profile: Profile): Record<string, string> {
  if (profile === 'personal') return { DAILY_FOCUS_PROFILE: 'personal' };
  return {
    DAILY_FOCUS_PROFILE: 'work',
    DAILY_FOCUS_GITHUB_SCOPE: 'acme',
    DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS: 'merge-policy',
    DAILY_FOCUS_JIRA_PROJECTS: 'PROJ, PLAT',
    DAILY_FOCUS_JIRA_HOLD_STATUSES: 'Blocked',
    DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES: 'In Progress, In Review',
  };
}

/* ---------- the pull request world ---------- */

type PullSeed = Pick<PullRequest, 'repo' | 'number' | 'title' | 'createdAt'> & Partial<PullRequest>;

/** One open pull request with every fact a fresh fetch would give it, unless the seed says otherwise. */
function pull(seed: PullSeed): PullRequest {
  const { repo, number, title, createdAt } = seed;
  return {
    id: `github:pr:${repo}#${number}`,
    account: LOGIN,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: false,
    readyAt: createdAt,
    updatedAt: seed.lastActivityByOthers?.at ?? seed.lastActivityByYou ?? createdAt,
    headRef: `${LOGIN}/${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)}`,
    baseRef: 'main',
    reviewDecision: null,
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    lastActivityByYou: createdAt,
    lastActivityByOthers: null,
    ...seed,
  };
}

/**
 * The open pull requests, dated relative to `now` so the waits read the same
 * however long the demo has been up. One or two in every court the board has,
 * plus one parked by the action log.
 */
export function demoPulls(profile: Profile, now: Date = new Date()): PullRequest[] {
  if (profile === 'personal') return personalPulls(now);
  return [
    // Waiting on you: red CI, a comment since your push, and a conflict.
    pull({
      repo: 'acme/webapp',
      number: 3402,
      title: 'Show the currency on order confirmation emails',
      createdAt: daysAgo(now, 1),
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'failure',
      failingChecks: ['unit-tests (node-20)'],
      headSha: '9c41e07d2b5f3a8e6d1c0b4a7f2e9d8c5b3a1f60',
      mergeStateStatus: 'UNSTABLE',
      lastActivityByYou: hoursAgo(now, 3),
      requestedReviewers: ['eli'],
    }),
    pull({
      repo: 'acme/webapp',
      number: 3398,
      title: 'Retry failed payment webhooks with backoff',
      createdAt: daysAgo(now, 4),
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED',
      lastActivityByYou: daysAgo(now, 1),
      lastActivityByOthers: { at: hoursAgo(now, 3), login: 'dana', kind: 'comment' },
    }),
    pull({
      repo: 'acme/infra',
      number: 512,
      title: 'Pin the Node 22 base image',
      createdAt: daysAgo(now, 6),
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'eli', state: 'APPROVED', at: daysAgo(now, 2) }],
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      lastActivityByYou: daysAgo(now, 3),
      lastActivityByOthers: { at: daysAgo(now, 2), login: 'eli', kind: 'review' },
    }),
    // Ready to merge.
    pull({
      repo: 'acme/webapp',
      number: 3410,
      title: 'Drop the legacy coupon field from checkout',
      createdAt: daysAgo(now, 2),
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'chris', state: 'APPROVED', at: hoursAgo(now, 2) }],
      lastActivityByYou: daysAgo(now, 1),
      lastActivityByOthers: { at: hoursAgo(now, 2), login: 'chris', kind: 'review' },
    }),
    // Waiting on reviewers: one long enough to ask, one fresh, and one nudged this morning.
    pull({
      repo: 'acme/webapp',
      number: 3395,
      title: 'Bump date-fns to 4.1.0',
      createdAt: daysAgo(now, 3),
      reviewDecision: 'REVIEW_REQUIRED',
      requestedReviewers: ['bob'],
      mergeStateStatus: 'BLOCKED',
    }),
    pull({
      repo: 'acme/docs',
      number: 77,
      title: 'Document the gift card API',
      createdAt: hoursAgo(now, 5),
      reviewDecision: 'REVIEW_REQUIRED',
      requestedReviewers: ['dana', 'eli'],
      mergeStateStatus: 'BLOCKED',
    }),
    pull({
      repo: 'acme/webapp',
      number: 3405,
      title: 'Cache product images at the edge',
      createdAt: daysAgo(now, 2),
      reviewDecision: 'REVIEW_REQUIRED',
      requestedReviewers: ['chris'],
      mergeStateStatus: 'BLOCKED',
    }),
    // Waiting on the merge gate: approved, and the repository's own policy check still pending.
    pull({
      repo: 'acme/webapp',
      number: 3418,
      title: 'Lazy-load the reviews widget on product pages',
      createdAt: daysAgo(now, 2),
      reviewDecision: 'APPROVED',
      reviews: [{ login: 'alice', state: 'APPROVED', at: hoursAgo(now, 22) }],
      checks: 'pending',
      pendingChecks: [{ name: 'merge-policy', kind: 'status-context', detailsUrl: 'https://github.com/acme/webapp/pull/3418/checks' }],
      mergeStateStatus: 'BLOCKED',
      lastActivityByYou: hoursAgo(now, 20),
      lastActivityByOthers: { at: hoursAgo(now, 22), login: 'alice', kind: 'review' },
    }),
    // Merge blocked by GitHub, with nothing pending to blame.
    pull({
      repo: 'acme/infra',
      number: 509,
      title: 'Rotate the staging deploy key',
      createdAt: daysAgo(now, 2),
      reviews: [{ login: 'eli', state: 'APPROVED', at: daysAgo(now, 1) }],
      mergeStateStatus: 'BLOCKED',
      lastActivityByYou: daysAgo(now, 1),
      lastActivityByOthers: { at: daysAgo(now, 1), login: 'eli', kind: 'review' },
    }),
    // Waiting on checks.
    pull({
      repo: 'acme/webapp',
      number: 3425,
      title: 'Stream the order export instead of buffering it',
      createdAt: hoursAgo(now, 26),
      checks: 'pending',
      pendingChecks: [
        { name: 'e2e (chromium)', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/actions/runs/88120451', checkRunId: 88120451 },
        { name: 'e2e (webkit)', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/actions/runs/88120452', checkRunId: 88120452 },
      ],
      cancelledChecks: [{ name: 'visual-regression', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/actions/runs/88120449' }],
      mergeStateStatus: 'BLOCKED',
      lastActivityByYou: hoursAgo(now, 1),
    }),
    // Drafts: one from last night, one forgotten for weeks, one parked on purpose.
    pull({
      repo: 'acme/webapp',
      number: 3430,
      title: 'Add gift card codes to the order export behind a flag',
      createdAt: hoursAgo(now, 14),
      isDraft: true,
    }),
    pull({
      repo: 'acme/webapp',
      number: 3350,
      title: 'Spike: speculative prefetch for the checkout bundle',
      createdAt: daysAgo(now, 24),
      isDraft: true,
      lastActivityByYou: daysAgo(now, 22),
    }),
    pull({
      repo: 'acme/webapp',
      number: 3360,
      title: 'Experiment: server-rendered product pages',
      createdAt: daysAgo(now, 12),
      isDraft: true,
      lastActivityByYou: daysAgo(now, 9),
    }),
  ];
}

/** Side projects have pull requests too: a few of Mara's own, and one to someone else's project. */
function personalPulls(now: Date): PullRequest[] {
  return [
    pull({
      repo: 'mara-l/pedalboard',
      number: 51,
      title: 'Fix clipping on the looper’s overdub path',
      createdAt: daysAgo(now, 2),
      checks: 'failure',
      failingChecks: ['build (macos)'],
      headSha: '3e8a1c5f9b2d7e4a6c0f1b8d3e5a7c9f2b4d6e81',
      mergeStateStatus: 'UNSTABLE',
      lastActivityByYou: hoursAgo(now, 15),
    }),
    pull({
      repo: 'mara-l/birdfeeder-cam',
      number: 12,
      title: 'Move the firmware to ESP-IDF 5.2',
      createdAt: daysAgo(now, 9),
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      lastActivityByYou: daysAgo(now, 5),
    }),
    pull({
      repo: 'openbird/feeder-firmware',
      number: 204,
      title: 'Add the Danish species list',
      createdAt: daysAgo(now, 5),
      reviewDecision: 'REVIEW_REQUIRED',
      requestedReviewers: ['kasper-ob'],
      mergeStateStatus: 'BLOCKED',
    }),
    pull({
      repo: 'mara-l/pedalboard',
      number: 49,
      title: 'Tuner: move pitch detection to an AudioWorklet',
      createdAt: hoursAgo(now, 40),
      checks: 'pending',
      pendingChecks: [{ name: 'build (linux)', kind: 'check-run', detailsUrl: 'https://github.com/mara-l/pedalboard/actions/runs/4410233' }],
      mergeStateStatus: 'BLOCKED',
      lastActivityByYou: hoursAgo(now, 2),
    }),
    pull({
      repo: 'mara-l/pedalboard',
      number: 50,
      title: 'Add a metronome click track',
      createdAt: hoursAgo(now, 30),
      isDraft: true,
    }),
    pull({
      repo: 'mara-l/dotfiles',
      number: 9,
      title: 'Try the new terminal config',
      createdAt: daysAgo(now, 6),
      isDraft: true,
    }),
  ];
}

/* ---------- the ticket world ---------- */

/** The status vocabulary of each sample project, as the status menu offers it. */
const TICKET_STATUSES: Readonly<Record<string, readonly string[]>> = {
  PROJ: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Done'],
  PLAT: ['Backlog', 'Committed', 'In Progress', 'In Review', 'Done'],
};

/** Jira's three-way grouping, as the sample workflows file their statuses. */
function categoryOf(status: string): TicketStatusCategory {
  const name = status.trim().toLowerCase();
  if (name === 'done') return 'done';
  if (['to do', 'backlog', 'committed'].includes(name)) return 'new';
  return 'indeterminate';
}

/** Whether a ticket's pull requests are none, some still open, or all merged or declined. */
type Prs = 'none' | 'open' | 'closed';

function ticket(key: string, summary: string, workflowStatus: string, issueType: string, prs: Prs): Ticket {
  return {
    id: `jira:${key}`,
    key,
    summary,
    workflowStatus,
    statusCategory: categoryOf(workflowStatus),
    issueType,
    url: `https://${JIRA_SITE}/browse/${key}`,
    hasAnyPr: prs !== 'none',
    hasOpenPr: prs === 'open',
    allPrsClosed: prs === 'closed',
  };
}

/**
 * The unfinished tickets, with something in every court and a Working on view
 * with two statuses to group by. Returned fresh each time: the demo's ticket
 * world is mutable, since moving a status is the one thing the dashboard does
 * to Jira, and the demo lets it be done.
 */
export function demoTickets(now = new Date()): { tickets: Ticket[]; statuses: Record<string, string[]> } {
  return {
    tickets: [
      // Every pull request closed, and the ticket not Done.
      ticket('PROJ-8842', 'Show the gift card balance at checkout', 'In Review', 'Task', 'closed'),
      // The same, known only from GitHub: Jira still has the pull request open.
      {
        ...ticket('PLAT-311', 'Remove the legacy cart API', 'In Progress', 'Task', 'closed'),
        pulls: [
          {
            repo: 'acme/infra',
            number: 514,
            title: 'PLAT-311: drop the /v1/cart routes',
            url: 'https://github.com/acme/infra/pull/514',
            state: 'merged',
            closedAt: hoursAgo(now, 5),
          },
        ],
        fromGitHub: true,
      },
      // A pull request open while the status says the work has not begun.
      ticket('PROJ-8871', 'Lazy-load the reviews widget on product pages', 'To Do', 'Story', 'open'),
      ticket('PROJ-8877', 'Document the gift card API', 'To Do', 'Task', 'open'),
      // In progress with no code linked to it.
      ticket('PROJ-8865', 'Write the gift card support guide', 'In Progress', 'Task', 'none'),
      ticket('PLAT-298', 'Audit third-party script load order', 'In Progress', 'Bug', 'none'),
      ticket('PLAT-305', 'Retire the old newsletter signup form', 'In Progress', 'Task', 'none'),
      // A deliberate hold: in the configured hold status, so not flagged.
      ticket('PROJ-8850', 'Migrate to the new tax rates API', 'Blocked', 'Story', 'none'),
      // Going as they should.
      ticket('PROJ-8858', 'Fix rounding in gift card balances', 'In Progress', 'Bug', 'open'),
      ticket('PROJ-8869', 'Update the order fixtures for the new export format', 'In Progress', 'Sub-task', 'open'),
      ticket('PROJ-8860', 'Drop the legacy coupon field from checkout', 'In Review', 'Task', 'open'),
      ticket('PLAT-320', 'Evaluate a second payment provider', 'Backlog', 'Story', 'none'),
    ],
    statuses: Object.fromEntries(Object.entries(TICKET_STATUSES).map(([project, names]) => [project, [...names]])),
  };
}

/* ---------- what stands in for gh and acli ---------- */

export interface DemoIntegrations {
  github: BoardDeps;
  jira: TicketBoardDeps;
}

/**
 * The pollers' dependencies, answered from the sample worlds. A refresh in the
 * demo moves the "as of" time, but the pull requests stay dated from when the
 * demo started, the `now` its store was written with: the assistant's answers
 * ahead in that store are keyed by when each review came in, and a review that
 * moved with the clock would be a new one at every read. A demo lasts minutes,
 * so the waits barely move. A ticket moved from the dashboard moves here, and
 * the refresh that follows reads it back, exactly as a real one would.
 */
export function demoIntegrations(profile: Profile, now: Date = new Date()): DemoIntegrations {
  const world = demoTickets();
  return {
    github: {
      async listAccounts() {
        return [{ login: LOGIN, active: true }];
      },
      async token() {
        return 'demo';
      },
      async fetch() {
        return { login: LOGIN, pulls: demoPulls(profile, now), warnings: [], orgs: {}, rateLimitRemaining: null };
      },
    },
    jira: {
      async identity() {
        return { site: JIRA_SITE, account: JIRA_ACCOUNT };
      },
      async fetch() {
        return { tickets: world.tickets.map((entry) => ({ ...entry })), statuses: world.statuses, warnings: [] };
      },
      // The sample tickets already carry what GitHub would have added.
      async linked() {
        return { byKey: new Map(), complete: true, warnings: [] };
      },
      async transition(_acli, key, status) {
        const found = world.tickets.find((entry) => entry.key === key);
        if (!found) throw new Error(`no work item ${key} in the sample data`);
        const project = key.split('-')[0] ?? '';
        if (!(world.statuses[project] ?? []).includes(status)) {
          // Jira's own kind of answer: the move is refused, and the row stays.
          throw new Error(`${project} has no status called ${status}`);
        }
        found.workflowStatus = status;
        found.statusCategory = categoryOf(status);
      },
    },
  };
}

/* ---------- the store ---------- */

/** The standing objective, with the private half the editor shows and the page never does. */
const FOCUS: Readonly<Record<Profile, string>> = {
  work: `---
objective: Launch gift cards in the storefront before the holiday sale starts
blocker: The balance rounding fix in webapp#3421 is still waiting on review
---

Get the balance rounding right first; nothing downstream can launch until it is.

<!-- agent-only -->
The gift card launch is on the Q4 roadmap review on the 24th, and Dana presents it.
If gift cards can't be bought in staging by then, the launch misses the holiday
sale. Weigh the day against that, but don't put it on screen.
`,
  personal: `---
objective: Get the house ready for winter — gutters cleared, boiler serviced, loft insulation booked
blocker: The loft insulation quote from Nordvarme still hasn't arrived
---

Boiler is done. Gutters are booked for the 18th. The insulation is the one thing still open.

<!-- agent-only -->
The insulation comes out of what's left of the renovation savings, about 40,000 kr. If
the quote lands above that the job waits until spring. Rank accordingly; keep the
amount off the board.
`,
};

/** The source list, as a user fills it in once the placeholders are gone. */
const SOURCES: Readonly<Record<Profile, string>> = {
  work: `# Sources

The personal half of your morning brief. The prompt next to this file
(\`prompt.md\`) says *what* to gather and how to judge it; this file says *who* and
*where*. The briefing agent reads it; the dashboard shows it only in its editor.

## Identity

- Name, as meeting notes and Doc assignments write it: \`Mara Lindqvist\`
- Work email: \`mara@acme.example\`
- GitHub login: \`mara-l\` — review requests and authorship are judged against it

## Calendars

Query:

- the primary work calendar
- \`Platform team\` — the shared team calendar; its events block time too

Never query or include: \`Lunch roulette\`.

## Holiday calendars

- \`Holidays in United States\` — most of the webapp team is there; a holiday there
  means slow replies, and it is worth saying so.
- \`Holidays in Denmark\` — call one out today, or within the next 14 days.

## Recurring meeting notes

- https://docs.google.com/document/d/1xK9sampleP1atf0rmTeamN0tes/edit?tab=t.0 — Platform
  team weekly; only the newest dated section is current
- https://docs.google.com/document/d/1xK9sampleGiftCardP1an/edit?tab=t.3 — Gift card
  launch plan, the "Open questions" tab

## Jira and GitHub

- Jira projects: \`PROJ\` (webapp) and \`PLAT\` (platform). \`Blocked\` is a deliberate hold.
- GitHub organisation: \`acme\`. The board already shows every open pull request;
  raise only what needs judgement today.
`,
  personal: `# Sources

The private half of your morning brief. The prompt next to this file
(\`prompt.md\`) says *what* to gather and how to judge it; this file says *who* and
*where*. The briefing agent reads it; the dashboard shows it only in its editor.

## Identity

- Name: \`Mara Lindqvist\`
- Personal email: \`mara@lindqvist.example\`
- GitHub login: \`mara-l\` — review requests and authorship are judged against it

## My weeks

- Workdays end at 16:00; personal time is from then until 22:00.
- Daycare pickup by 16:45 on Mondays, Tuesdays and Thursdays. Sam does the other two.
- Every other week Noa has football on Wednesday; the \`Family\` calendar says which.

## Calendars

- \`Personal\`
- \`Family\` — shared with Sam; its events block time too

Never query or include: \`Sam — work\`.

## Holiday calendars

- \`Holidays in Denmark\` — including school holidays; a school week off changes who
  needs looking after.

## Email

The Gmail connector reaches \`mara@lindqvist.example\`. Always raise mail from Noa's
school and from the kommune. Skip newsletters and the running club's digest.

## e-Boks

The \`eboks\` CLI, logged in as me. Read letters from the kommune, Skattestyrelsen and
the pension fund first.

## Reminders

The Apple Reminders connector; read the \`Home\` list only.

## Messages

The Apple Messages connector. Skip the "Lindqvist family 📸" group, which is photos.

## GitHub

My own projects: \`mara-l/pedalboard\`, \`mara-l/dotfiles\`, \`mara-l/birdfeeder-cam\`.
Anything I have open elsewhere is a contribution, and ranks below those.
`,
};

/**
 * What the archive remembers that today's brief does not: the objective-aligned
 * item whose completion is the last progress recorded, which gives the Today tab
 * its "since objective progress" number.
 */
function finishedObjectiveItem(profile: Profile, now: Date): Item {
  return profile === 'work'
    ? {
        id: 'github:pr:acme/webapp#3388',
        source: 'github',
        kind: 'task',
        title: 'Put gift card checkout behind a feature flag',
        url: 'https://github.com/acme/webapp/pull/3388',
        firstSeen: dateFromNow(now, -7),
        advancesObjective: true,
      }
    : {
        id: 'email:thread:19a07a1b22',
        source: 'email',
        kind: 'task',
        title: 'Book the boiler service before the heating season',
        url: 'https://mail.google.com/mail/u/0/#inbox/19a07a1b22',
        firstSeen: dateFromNow(now, -8),
        advancesObjective: true,
      };
}

/** When the last objective-aligned item was marked done: two working days ago at work, one at home. */
function objectiveDoneAt(profile: Profile, now: Date): string {
  return profile === 'work' ? timeOn(workingDayBack(now, 2), 15, 40) : timeOn(workingDayBack(now, 1), 19, 10);
}

/**
 * The past briefs the archive holds: the three working days before today, each
 * with the items that already existed then, under the same `firstSeen` so
 * nothing reads as reset. The finished objective item is in the briefs before
 * it was marked done, and not after, as the agent would have left it out.
 */
function demoArchive(brief: Brief, profile: Profile, now: Date): Brief[] {
  const extra = finishedObjectiveItem(profile, now);
  const doneAt = objectiveDoneAt(profile, now);
  const briefs: Brief[] = [];
  for (const back of [3, 2, 1]) {
    const day = workingDayBack(now, back);
    const key = localDateKey(day);
    const items = brief.items.filter((item) => item.firstSeen !== undefined && item.firstSeen <= key);
    // In the brief written the morning it was marked done, and not the one after.
    if (extra.firstSeen !== undefined && extra.firstSeen <= key && timeOn(day, 6, 36) <= doneAt) items.unshift(extra);
    briefs.push({
      version: 1,
      generatedAt: timeOn(day, 6, 36),
      generatedBy: brief.generatedBy,
      date: key,
      items,
    });
  }
  return briefs;
}

/**
 * The action log: what has been handled today, what was snoozed, the notes
 * left for the agent, and the parks, notes and nudges on the boards' rows. Oldest first,
 * as the dashboard appends it.
 */
function demoActions(profile: Profile, now: Date): Action[] {
  const until = (days: number) => dateFromNow(now, days);
  const actions: Action[] =
    profile === 'work'
      ? [
          { id: 'github:pr:acme/webapp#3388', action: 'done', at: objectiveDoneAt(profile, now) },
          { id: 'jira:PLAT-305', action: 'note', text: 'Waiting on the comms plan from marketing', at: daysAgo(now, 3) },
          { id: 'jira:PLAT-305', action: 'snooze', until: until(30), at: daysAgo(now, 3) },
          { id: 'github:pr:acme/webapp#3395', action: 'note', text: 'Asked Bob in #webapp-dev', at: daysAgo(now, 2) },
          { id: 'github:pr:acme/webapp#3360', action: 'note', text: 'Revisit after the holiday freeze', at: daysAgo(now, 1) },
          { id: 'github:pr:acme/webapp#3360', action: 'snooze', until: until(30), at: daysAgo(now, 1) },
          { id: 'jira:PROJ-8865', action: 'note', text: 'Docs only — no pull request expected', at: daysAgo(now, 1) },
          { id: 'github:pr:acme/webapp#3405', action: 'nudge', at: hoursAgo(now, 3) },
          { id: 'github:pr:acme/webapp#3430', action: 'done', at: minutesAgo(now, 140) },
          { id: 'email:thread:18f31c0d9e', action: 'note', text: 'Membership runs to the 28th; no rush', at: minutesAgo(now, 131) },
          { id: 'email:thread:18f31c0d9e', action: 'snooze', until: until(7), at: minutesAgo(now, 130) },
          { id: 'slack:msg:C04ABCDE/1757480412.118', action: 'done', at: minutesAgo(now, 55) },
          {
            id: 'email:thread:18f2a9c4b7',
            action: 'note',
            text: 'Told Bob on Slack I’ll send the split after my 1:1 with Alice',
            at: minutesAgo(now, 50),
          },
        ]
      : [
          { id: 'email:thread:19a07a1b22', action: 'done', at: objectiveDoneAt(profile, now) },
          { id: 'email:thread:19a0c4e2f1', action: 'note', text: 'Called on Tuesday, left a voicemail', at: daysAgo(now, 2) },
          { id: 'github:pr:openbird/feeder-firmware#204', action: 'note', text: 'Pinged Kasper on the project Discord', at: daysAgo(now, 1) },
          { id: 'github:pr:mara-l/dotfiles#9', action: 'snooze', until: until(14), at: daysAgo(now, 1) },
          { id: 'email:thread:19a0b9f0a2', action: 'done', at: minutesAgo(now, 70) },
          {
            id: 'eboks:message:4417911204',
            action: 'note',
            text: 'Deductions look right; check again once the holiday pay is in',
            at: minutesAgo(now, 61),
          },
          { id: 'eboks:message:4417911204', action: 'snooze', until: until(7), at: minutesAgo(now, 60) },
          { id: 'messages:thread:chat7731/9A3D4B6C-1E22', action: 'done', at: minutesAgo(now, 25) },
        ];
  return actions.sort((a, b) => a.at.localeCompare(b.at));
}

/** One finished run of the morning agent, as the log's line pair, plus any question asked of it. */
interface RunSeed {
  id: string;
  startedAt: string;
  seconds: number;
  trigger: 'schedule' | 'hand';
  messages: string[];
  /** What it did on the way, the messages among it. Only the newest run's are ever shown. */
  steps?: AgentStep[];
  /** The last message is the report, unless the run failed. */
  error?: string;
  question?: { at: string; text: string; reply: string };
}

function runLines(seed: RunSeed): Record<string, unknown>[] {
  const endedAt = new Date(new Date(seed.startedAt).getTime() + seed.seconds * 1000).toISOString();
  const lines: Record<string, unknown>[] = [{ event: 'started', run: seed.id, cli: 'codex', trigger: seed.trigger, at: seed.startedAt }];
  if (seed.error) {
    lines.push({ event: 'failed', run: seed.id, sessionId: null, error: seed.error, report: '', messages: seed.messages, at: endedAt });
    return lines;
  }
  const report = seed.messages.at(-1) ?? '';
  lines.push({ event: 'finished', run: seed.id, sessionId: `sample-${seed.id}`, report, messages: seed.messages, steps: seed.steps ?? [], at: endedAt });
  if (seed.question) {
    const turn = `${seed.id}-q1`;
    const replied = new Date(new Date(seed.question.at).getTime() + 48_000).toISOString();
    lines.push({ event: 'asked', run: seed.id, turn, question: seed.question.text, at: seed.question.at });
    lines.push({ event: 'replied', run: seed.id, turn, reply: seed.question.reply, at: replied });
  }
  return lines;
}

/** The morning agent's log: today's run with its report and the way there, and the runs before it. */
function demoAgentLog(profile: Profile, now: Date): Record<string, unknown>[] {
  // Today's run ends exactly when the brief says it was written.
  const todaySeconds = profile === 'work' ? 388 : 251;
  const today = new Date(new Date(sampleGeneratedAt(now)).getTime() - todaySeconds * 1000).toISOString();
  const runs: RunSeed[] =
    profile === 'work'
      ? [
          {
            id: 'run-3',
            startedAt: timeOn(workingDayBack(now, 3), 6, 30),
            seconds: 71,
            trigger: 'schedule',
            messages: ['Reading `focus.md`, the action log and the previous brief.'],
            error: 'codex exited with code 1: network is unreachable',
          },
          {
            id: 'run-2',
            startedAt: timeOn(workingDayBack(now, 2), 11, 20),
            seconds: 318,
            trigger: 'hand',
            messages: [
              'A rerun: the previous brief is from 06:30 today. Keeping every `firstSeen` from it.',
              'Calendar: the all-hands moved to tomorrow, which frees 14:00–17:00 today. Rewriting the headline around that.',
              'Wrote **16 items** for today, 3 with a priority. The afternoon is now free from 14:00; the headline says so, and the ' +
                'gift card repro write-up is the thing to spend it on. Dropped 2 as handled since this morning. Could not reach: nothing.',
            ],
          },
          {
            id: 'run-1',
            startedAt: timeOn(workingDayBack(now, 1), 6, 30),
            seconds: 402,
            trigger: 'schedule',
            messages: [
              'Reading `focus.md`, the action log and the previous brief. Not a first run.',
              'Calendar: 3 events, no clashes. Day ends at 17:00.',
              'Wrote **17 items** for today, 3 with a priority: the compliance training, the review request on `webapp#3421`, and ' +
                'the Lisbon travel approval. Dropped 2 as handled. Could not reach: nothing.',
            ],
          },
          {
            id: 'run-0',
            startedAt: today,
            seconds: todaySeconds,
            trigger: 'schedule',
            messages: [
              'Reading `focus.md`, the action log and the previous brief. The objective is the gift card launch; the log has ' +
                '4 done, 1 dismissed and a snooze that has not arrived yet.',
              'Calendar: 5 events today, one clash at 11:00 — your 1:1 with Alice overlaps the design review. The lunch & learn is ' +
                'marked free. Day ends at 17:00.',
              'Gmail: 31 threads in the window, 4 need something from you. GitHub: a review request from Alice and a red check on ' +
                '`#3402` are worth raising; the rest is on the board. Jira: PROJ-8842 is still open with both pull requests merged.',
              'Slack: one direct question from Chris in #webapp-dev. Workday: the compliance deadline is today and the Berlin ' +
                'expenses are still in draft. Writing `items.json`.',
              [
                'Wrote **20 items** for today, 3 with a priority. Not a first run.',
                '',
                '- **#1** the compliance training in Workday, due tonight — the third reminder, and it escalates after today.',
                '- **#2** Alice’s review request on `webapp#3421`; merging it lets gift cards go live in staging, so it carries `advancesObjective`.',
                '- **#3** the Q4 headcount thread, where Bob followed up again yesterday.',
                '',
                'Dropped as handled: 3 — the Lisbon hotel thread and the on-call swap you marked done, and the vendor security ' +
                  'questionnaire you dismissed. Carried forward with their original `firstSeen`: 11, the Berlin expense report now at 8 days.',
                '',
                'Left out on purpose: the 12 open pull requests already on the board, and PROJ-8871’s status, which the ticket board flags itself.',
                '',
                'Could not reach: the **Platform team meeting notes** — the document returned 403 to the connector. If Tuesday’s meeting ' +
                  'left you action items, they are not here.',
              ].join('\n'),
            ],
            question: {
              at: minutesAgo(now, 95),
              text: 'Why isn’t the Berlin expense report one of the priorities?',
              reply:
                'It has a deadline, but five days out, and nothing escalates before then. The three priorities each have a deadline ' +
                'today or a person waiting on you now. It is on the list with its age showing — 8 days — which is the nag it has ' +
                'earned. If the finance cut-off is earlier than Workday says, leave a note on the item and I will rank it higher tomorrow.',
            },
          },
        ]
      : [
          {
            id: 'run-2',
            startedAt: timeOn(workingDayBack(now, 2), 6, 30),
            seconds: 240,
            trigger: 'schedule',
            messages: [
              'Reading `focus.md`, the action log and the previous brief.',
              'Wrote **14 items**, 2 with a priority: the boiler service, which moves the objective, and the parents’ evening reply. ' +
                'e-Boks had nothing new. Could not reach: nothing.',
            ],
          },
          {
            id: 'run-1',
            startedAt: timeOn(workingDayBack(now, 1), 6, 30),
            seconds: 265,
            trigger: 'schedule',
            messages: [
              'Reading `focus.md`, the action log and the previous brief. The boiler service was marked done last night — the objective moved.',
              'Wrote **15 items**, 3 with a priority: the daycare invoice, the insulation quote, and Ida’s dentist. Dropped 1 as handled. ' +
                'Could not reach: nothing.',
            ],
          },
          {
            id: 'run-0',
            startedAt: today,
            seconds: todaySeconds,
            trigger: 'schedule',
            messages: [
              'Reading `focus.md`, the action log and yesterday’s brief. Objective: the house ready for winter; blocker: the insulation quote.',
              'Calendars: Personal and Family read; 6 events, one clash at 16:30 — the insurance call overlaps the daycare pickup. Sam ' +
                'is away all day. No `dayStart` or `dayEnd`, as the profile asks.',
              'e-Boks: 5 letters in the window. The daycare invoice and the tax assessment ask for something; three are confirmations. ' +
                'Gmail: 3 threads need you. Messages: Jonas’s question and the photos you promised Priya.',
              [
                'Wrote **17 items** for today, 3 with a priority. Not a first run.',
                '',
                '- **#1** the daycare invoice from the kommune, due Friday — a late fee follows the deadline.',
                '- **#2** chasing Nordvarme for the insulation quote: the only thing today that moves the objective, and quiet for nine days.',
                '- **#3** Jonas’s question about Saturday, unanswered since Tuesday.',
                '',
                'e-Boks: 2 letters raised, 3 skipped as confirmations. Messages: 2 obligations, both yours. Reminders: the Home list has ' +
                  'not been touched since May, so it is one `info` item rather than seven.',
                '',
                'Dropped as handled: 2 — the boiler service and the parents’ evening thread. Could not reach: nothing; the Family calendar ' +
                  'was read through Sam’s share.',
              ].join('\n'),
            ],
            question: {
              at: minutesAgo(now, 75),
              text: 'Is the tax assessment really not urgent?',
              reply:
                'The correction deadline is 20 days out and the letter asks for a check, not a payment. It is on the list and will age. ' +
                'If you would rather deal with it on a particular day, snooze it to that day and it comes back then.',
            },
          },
        ];
  const newest = runs.find((run) => run.id === 'run-0')!;
  newest.steps = demoRunSteps(profile, newest.messages);
  return runs.flatMap(runLines);
}

/**
 * Today's run as its panel shows it: what it said, what it ran, and the
 * sources it handed to subagents, each with what the subagent did.
 */
function demoRunSteps(profile: Profile, messages: readonly string[]): AgentStep[] {
  const said = (text: string, by: string | null = null): AgentStep => ({ kind: 'message', text, detail: null, state: 'done', by });
  const call = (text: string, detail: string | null, by: string | null = null): AgentStep => ({ kind: 'tool', text, detail, state: 'done', by });
  const handoff = (name: string): AgentStep => ({ ...call('Hand part of it to a subagent', name), subagent: name });
  const wait = call('Wait for its subagents', null);
  const start = [
    said(messages[0]!),
    call('Run a command', 'cat prompt.md focus.md sources.md items.json'),
    call('Run a command', 'tail -n 400 actions.jsonl'),
  ];
  const finish = [call('Run a command', 'mv items.json.tmp items.json'), said(messages.at(-1)!)];
  if (profile === 'work') {
    return [
      ...start,
      handoff('calendar'),
      handoff('gmail'),
      handoff('github'),
      call('Google calendar list events', '{"calendar_id":"primary","time_min":"today 00:00"}', 'calendar'),
      said('5 events. The 1:1 with Alice and the design review both sit at 11:00; the lunch & learn is marked free.', 'calendar'),
      call('Gmail search emails', '{"query":"newer_than:3d -category:promotions"}', 'gmail'),
      call('Gmail batch read email', '{"message_ids":["19a2f…","19a31…","19a33…","19a35…"]}', 'gmail'),
      said('31 threads in the window. 4 ask something of you; Bob followed up on Q4 headcount yesterday.', 'gmail'),
      call('Run a command', 'gh search prs --review-requested=@me --state=open --json url,title,updatedAt', 'github'),
      call('Run a command', 'gh pr checks 3402 -R acme/webapp', 'github'),
      said('A review request from Alice on acme/webapp#3421, and a red check on #3402. The rest is already on the board.', 'github'),
      wait,
      said(messages[1]!),
      said(messages[2]!),
      handoff('jira'),
      handoff('slack'),
      handoff('workday'),
      call('Run a command', 'acli jira workitem search --jql "assignee = currentUser() AND statusCategory != Done"', 'jira'),
      said('PROJ-8842 is still open, with both of its pull requests merged.', 'jira'),
      call('Slack search messages', '{"query":"to:me after:yesterday"}', 'slack'),
      said('One direct question, from Chris in #webapp-dev.', 'slack'),
      call('Workday list inbox tasks', null, 'workday'),
      said('The compliance training is due tonight. The Berlin expense report is still a draft.', 'workday'),
      { ...wait },
      said(messages[3]!),
      ...finish,
    ];
  }
  return [
    ...start,
    handoff('calendar'),
    handoff('eboks'),
    handoff('email'),
    call('Google calendar list events', '{"calendar_id":"personal","time_min":"today 00:00"}', 'calendar'),
    call('Google calendar list events', '{"calendar_id":"family","time_min":"today 00:00"}', 'calendar'),
    said('6 events across Personal and Family. The insurance call at 16:30 overlaps the daycare pickup.', 'calendar'),
    call('Run a command', 'eboks list --since 3d --json', 'eboks'),
    call('Run a command', 'eboks text --json 4417911204', 'eboks'),
    said('5 letters. The daycare invoice and the tax assessment ask for something; three are confirmations.', 'eboks'),
    call('Gmail search emails', '{"query":"newer_than:3d -category:promotions"}', 'email'),
    said('3 threads need you, the insulation quote among them, quiet for nine days.', 'email'),
    wait,
    said(messages[1]!),
    handoff('messages'),
    call('Run a command', 'messages recent --since 3d --json', 'messages'),
    said('Jonas asked about Saturday on Tuesday, and Priya is still waiting for the photos.', 'messages'),
    { ...wait },
    said(messages[2]!),
    ...finish,
  ];
}

/** One assistant exchange, as the log's line pair: what was asked, what it did, and what came back. */
interface TurnSeed {
  id: string;
  item: string;
  /** A quick action's id, or null for typed text. */
  action: string | null;
  text?: string;
  at: string;
  seconds: number;
  steps: AssistantStep[];
  reply: string;
  /** Asked ahead: the key of what it answered, from `aheadKey`. */
  auto?: string;
}

/** A tool call in a demo turn's trail. */
const call = (text: string, detail: string, state: AssistantStep['state'] = 'done'): AssistantStep => ({ kind: 'tool', text, detail, state });
/** Something said on the way. */
const said = (text: string): AssistantStep => ({ kind: 'message', text, detail: null, state: 'done' });

function turnLines(seed: TurnSeed): Record<string, unknown>[] {
  const quick = seed.action ? QUICK_ACTIONS.find((candidate) => candidate.id === seed.action) : undefined;
  const request = quick ? (seed.text ? `${quick.request}\n\n${seed.text}` : quick.request) : (seed.text ?? '');
  const endedAt = new Date(new Date(seed.at).getTime() + seed.seconds * 1000).toISOString();
  return [
    {
      event: 'started',
      turn: seed.id,
      item: seed.item,
      agent: 'claude',
      request,
      action: quick?.id ?? null,
      ...(seed.auto ? { auto: seed.auto } : {}),
      at: seed.at,
    },
    { event: 'finished', turn: seed.id, sessionId: `sample-${seed.item}`, reply: seed.reply, steps: seed.steps, at: endedAt },
  ];
}

/**
 * The key the board hands a sample pull request's answer ahead, worked out the
 * way the board works it out, so the answer in the log is still on the row. A
 * sample that no longer calls for that question is a mistake in the samples.
 */
function aheadKey(profile: Profile, now: Date, id: string, action: AutoAction): string {
  const pr = demoPulls(profile, now).find((candidate) => candidate.id === id);
  if (!pr) throw new Error(`the demo has no pull request ${id}`);
  const row: BoardRow = { ...pr, ...judge(pr, now, null), status: 'open', notes: [] };
  const key = autoKeys(row).find((candidate) => actionOf(candidate) === action);
  if (!key) throw new Error(`the demo's ${id} calls for no ${action} ahead`);
  return key;
}

/** The assistant's log: a few conversations on rows the demo shows, read back into their panels. */
function demoAssistantLog(profile: Profile, now: Date): Record<string, unknown>[] {
  const fence = '```';
  const turns: TurnSeed[] =
    profile === 'work'
      ? [
          {
            id: 'turn-a1',
            item: 'github:pr:acme/webapp#3421',
            action: 'summarise-pr',
            at: minutesAgo(now, 46),
            seconds: 52,
            steps: [
              call('View the pull request', 'gh pr view 3421 --repo acme/webapp --json title,body,files,reviews'),
              call('Read the diff', 'gh pr diff 3421 --repo acme/webapp'),
              said('Four files. The balance change is the substance; the rest is its tests and a type.'),
              call('Read the issue it closes', 'gh issue view 3388 --repo acme/webapp --comments'),
            ],
            reply: [
              '**What it changes.** Gift card balances are stored as floating-point amounts and rounded only for display, so a ' +
                'card spent across several orders can drift by a cent, and checkout then refuses its last cent. The change ' +
                'stores balances as whole minor units (cents), does the arithmetic there, and rounds once, when an amount is ' +
                'shown, to the currency’s own number of decimals.',
              '',
              '**Why.** It is the most reported gift card bug in staging, and the launch can’t go ahead while a customer can be left with a cent they can’t spend.',
              '',
              '**Likely pushback**',
              '',
              '1. The migration converts existing balances with `Math.round`, which rounds halves away from zero. Finance may want banker’s rounding, and nothing records the choice.',
              '2. A currency with no minor unit, such as the yen, goes through the same path, but no test covers one.',
              '3. The old floating-point column is kept for a release, just in case. A reviewer will ask when it goes, or for a ticket that says so.',
              '',
              'The first two paragraphs are paste-ready as a description; the three points are what I would raise if I were reviewing.',
            ].join('\n'),
          },
          {
            id: 'turn-a2',
            item: 'github:pr:acme/webapp#3421',
            action: null,
            text: 'Is the yen case actually reachable?',
            at: minutesAgo(now, 44),
            seconds: 31,
            steps: [
              call('Find where the minor units are worked out', 'gh search code "minorUnits" --repo acme/webapp'),
              call('Read the payments docs on supported currencies', 'gh api repos/acme/payments-docs/contents/currencies.md', 'failed'),
              call("Read the webapp's list of currencies", 'gh api repos/acme/webapp/contents/docs/currencies.md'),
            ],
            reply:
              'Not yet: the storefront sells in euros, pounds and dollars, and its currency list has nothing without a minor unit. ' +
              'It becomes reachable the day the yen is added, so I would ask Alice for the one test now rather than a fix later.',
          },
          {
            id: 'turn-b1',
            item: 'email:thread:18f2a9c4b7',
            action: 'draft-reply',
            at: minutesAgo(now, 38),
            seconds: 64,
            steps: [
              call('Gmail: get thread', '{"threadId":"18f2a9c4b7"}'),
              call('Gmail: search threads', '{"query":"Q4 planning doc headcount"}'),
              said('Bob wants numbers per team with a reason each. The planning doc has both.'),
              call('Gmail: create draft', '{"threadId":"18f2a9c4b7"}'),
            ],
            reply: [
              'I read the thread — four messages, Bob twice. He wants the Q4 team split: how many of the six open roles go to ' +
                'Platform and how many to Webapp, with a line of justification each, by the end of the week so it lands in the planning deck.',
              '',
              'I have created a Gmail draft on the thread, from you, proposing four Platform and two Webapp with the reasons from the ' +
                'planning doc, and asking whether the deck can carry a footnote that the payments hire depends on the Q3 numbers. It is ' +
                '**not sent**; it is waiting on the thread when you open it.',
              '',
              'Created: [Gmail draft](https://mail.google.com/mail/u/0/#drafts?compose=18f2a9c4b7)',
            ].join('\n'),
          },
          {
            id: 'turn-d1',
            item: 'github:pr:acme/webapp#3398',
            action: 'assess-review',
            auto: aheadKey(profile, now, 'github:pr:acme/webapp#3398', 'assess-review'),
            at: minutesAgo(now, 172),
            seconds: 47,
            steps: [
              call('Read the review comments', 'gh pr view 3398 --repo acme/webapp --comments'),
              call('Read the diff', 'gh pr diff 3398 --repo acme/webapp'),
            ],
            reply: [
              'Dana is right: the backoff never resets after a delivery succeeds.',
              '',
              'She commented on `webhooks.ts:41` that `attempt` is only zeroed when the worker starts. The diff bears her out: after ' +
                'one failed delivery, every later failure waits longer, for as long as the worker runs. Reset `attempt` in the ' +
                'success branch of `deliverWebhook` and add a test where a success between two failures starts the delay over.',
              '',
              'Her second point, capping the delay at 30 seconds rather than 60, is a preference. Sixty is defensible for a ' +
                'webhook the payment provider retries anyway; say so and leave it.',
            ].join('\n'),
          },
          {
            id: 'turn-c1',
            item: 'github:pr:acme/webapp#3402',
            action: 'explain-ci',
            auto: aheadKey(profile, now, 'github:pr:acme/webapp#3402', 'explain-ci'),
            at: minutesAgo(now, 20),
            seconds: 58,
            steps: [
              call('List the checks', 'gh pr checks 3402 --repo acme/webapp'),
              call('Read the failing job’s log', 'gh run view 9182734 --repo acme/webapp --log-failed'),
              said('One failure, in emails/confirmation.spec.ts. Reading the refund path it exercises.'),
              call('Read the email code', 'gh api repos/acme/webapp/contents/src/emails/confirmation.ts'),
            ],
            reply: [
              'Yours, not flaky: refunds skip the new currency field.',
              '',
              'The failing check is `unit-tests (node-20)`, in `emails/confirmation.spec.ts`:',
              '',
              fence,
              'expected the currency on the refund confirmation',
              '  Expected: "€12.50"',
              '  Received: "12.50"',
              fence,
              '',
              'Your change adds the currency when an order confirmation is built, but refunds build theirs in `refundConfirmation`, ' +
                'which formats the amount on its own and never sees the new field. The smallest fix is to pass the order’s currency ' +
                'through — one line in `refundConfirmation`. The other three jobs are green, so this is yours rather than flaky infrastructure.',
            ].join('\n'),
          },
        ]
      : [
          {
            id: 'turn-p1',
            item: 'github:pr:mara-l/pedalboard#47',
            action: 'summarise-pr',
            at: minutesAgo(now, 52),
            seconds: 47,
            steps: [
              call('View the pull request', 'gh pr view 47 --repo mara-l/pedalboard --json title,body,files,commits'),
              call('Read the diff', 'gh pr diff 47 --repo mara-l/pedalboard'),
            ],
            reply: [
              'Tomas adds MIDI clock sync to the looper: the transport listens for MIDI clock at 24 pulses per quarter note and for ' +
                'start and stop, derives the tempo, and quantises the loop start to the next beat. +212/−18 across three files, with a ' +
                'test for the tempo derivation.',
              '',
              'Worth raising before merging:',
              '',
              '1. The clock listener is never removed when the looper is destroyed, so switching patches leaks a listener per switch.',
              '2. Tempo is derived from the last 24 ticks only, which will jitter on a flaky USB connection; a short rolling average would settle it.',
              '3. Nothing says what happens when the clock stops mid-loop.',
              '',
              'A kind review that asks for the first two and lets the third go is probably right for a first contribution.',
            ].join('\n'),
          },
          {
            id: 'turn-p3',
            item: 'github:pr:mara-l/pedalboard#51',
            action: 'explain-ci',
            auto: aheadKey(profile, now, 'github:pr:mara-l/pedalboard#51', 'explain-ci'),
            at: minutesAgo(now, 64),
            seconds: 39,
            steps: [
              call('List the checks', 'gh pr checks 51 --repo mara-l/pedalboard'),
              call('Read the failing job’s log', 'gh run view 4471920 --repo mara-l/pedalboard --log-failed'),
            ],
            reply: [
              'Not your change: the macOS runner could not download the JUCE cache.',
              '',
              'The `build (macos)` job stops in its setup step with a 503 from the cache server, before any of your code is ' +
                'compiled. The Linux and Windows builds of the same commit pass. Rerun the job; if it fails the same way, the ' +
                'cache key in `.github/workflows/build.yml` can fall back to a fresh download.',
            ].join('\n'),
          },
          {
            id: 'turn-p2',
            item: 'email:thread:19a0c4e2f1',
            action: 'draft-reply',
            at: minutesAgo(now, 30),
            seconds: 41,
            steps: [call('Gmail: get thread', '{"threadId":"19a0c4e2f1"}'), call('Gmail: create draft', '{"threadId":"19a0c4e2f1"}')],
            reply:
              'The thread is three messages: your request on the 28th, their “within the week” on the 29th, and nothing since. I have ' +
              'created a Gmail draft on it that asks, briefly and politely, whether the quote is still coming this week, and says the ' +
              'other quotes are in and you would like to decide by Friday. It is **not sent**; open the thread to read it.\n\n' +
              'Created: [Gmail draft](https://mail.google.com/mail/u/0/#drafts?compose=19a0c4e2f1)',
          },
        ];
  return turns.flatMap(turnLines);
}

const lines = (records: readonly unknown[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join('');

/**
 * Write the demo store: the brief and everything around it, for one profile.
 *
 * Refuses a store that already has a brief, as `seed` does and for the same
 * reason: nothing here is meant for a real store, and the logs it writes would
 * sit beside a real history as if they were part of it.
 */
export async function writeDemoStore(store: string, profile: Profile, now: Date = new Date()): Promise<void> {
  const brief = sampleBrief(now, profile);
  await mkdir(join(store, 'archive'), { recursive: true });
  // `wx`: the existence check and the write are one operation.
  await writeFile(join(store, 'items.json'), `${JSON.stringify(brief, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  for (const past of demoArchive(brief, profile, now)) {
    await writeFile(join(store, 'archive', `items-${past.date}.json`), `${JSON.stringify(past, null, 2)}\n`, 'utf8');
  }
  await writeFile(join(store, SETTINGS_FILE), `${JSON.stringify(demoSettings(profile), null, 2)}\n`, 'utf8');
  await writeFile(join(store, 'focus.md'), FOCUS[profile], 'utf8');
  await writeFile(join(store, 'sources.md'), SOURCES[profile], 'utf8');
  await writeFile(join(store, 'actions.jsonl'), lines(demoActions(profile, now)), 'utf8');
  await writeFile(join(store, 'agent.jsonl'), lines(demoAgentLog(profile, now)), 'utf8');
  await writeFile(join(store, 'assistant.jsonl'), lines(demoAssistantLog(profile, now)), 'utf8');
}
