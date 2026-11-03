/**
 * The Tickets tab's third view: an epic or an initiative, zoomed into.
 *
 * On a big epic the user posts many pull requests, some tickets need several,
 * and some can only land after others because a Jira blocks link says so. Jira
 * shows none of that at once, so this view does: how far the project has got,
 * what the user can do next, in which order the rest can land, and what is
 * done. Where each ticket stands is worked out in `stages.ts`; this only lays
 * it out.
 *
 * It adds no write of its own. Where Do next says to merge a pull request or
 * mark a draft ready, it offers the pull request board's own buttons, through
 * the board's handlers and its confirmation; every other action is a link out to
 * GitHub or Jira.
 */

import { h, type ComponentChild, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { BoardRow, DashboardState, ProjectSummary, ProjectsState } from '../src/types.ts';
import { banner } from './banners.ts';
import { boardFailures, renderPullWrites, type PullWrite } from './board.ts';
import { el, type Props } from './el.ts';
import { failureNotice } from './failure.ts';
import { formatTime } from './format.ts';
import { cssId, onCard } from './items.ts';
import { renderMarkdown } from './markdown.ts';
import { refreshControl } from './refresh.ts';
import { drawer } from './section.ts';
import {
  STAGES,
  STAGE_LABEL,
  assignLanes,
  blocksOf,
  listOf,
  loopPath,
  nameTicket,
  nextSteps,
  progressSentence,
  projectWork,
  pullSources,
  pullWording,
  stageCounts,
  stageLabel,
  type NextStep,
  type PlannedRead,
  type ProjectWork,
  type PullWork,
  type Rail,
  type Stage,
  type TicketWork,
} from './stages.ts';
import type { Handlers, UiState } from './types.ts';

/** How many things to do the list names before leaving the rest to the merge order below it. */
export const NEXT_SHOWN = 6;

/* ---------- the picker ---------- */

/**
 * The epics to zoom into, as a select: the ones assigned to the user, and the
 * one showing when it is not among them, which is how a parent or an epic
 * opened from an initiative stays named.
 */
export function projectPicker(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element | null {
  const projects = state.projects;
  if (!projects?.enabled) return null;
  const key = ui.projectKey.value;
  const options = projects.epics.map((epic) => ({ key: epic.key, label: `${epic.key} · ${epic.summary}` }));
  if (key && !options.some((option) => option.key === key)) {
    const root = projects.open?.[key]?.read?.root;
    options.unshift({ key, label: root ? `${key} · ${root.summary}` : key });
  }
  return el(
    'select',
    {
      class: 'project-picker',
      'aria-label': 'Which epic to show',
      value: key ?? '',
      onChange: (event: Event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        if (value) handlers.openProject(value);
      },
    },
    el('option', { value: '', disabled: true }, options.length > 0 ? 'Choose an epic…' : 'No epics assigned to you'),
    options.map((option) => el('option', { value: option.key, key: option.key }, option.label)),
  );
}

/* ---------- the header's refresh control ---------- */

/** "as of 10:42 · 4 epics assigned to you · 23 tickets in PAY-200", on the refresh control. */
export function projectStatus(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const projects = state.projects;
  const key = ui.projectKey.value;
  const entry = key ? projects?.open?.[key] : undefined;
  const fetching = Boolean(projects?.fetching || entry?.fetching);
  const fetchedAt = entry?.read?.fetchedAt ?? projects?.fetchedAt ?? null;
  const bits: string[] = [];
  if (fetching) bits.push('refreshing…');
  else if (fetchedAt) bits.push(`as of ${formatTime(fetchedAt)}`);
  if (projects?.fetchedAt) {
    const count = projects.epics.length;
    bits.push(`${count} unfinished ${count === 1 ? 'epic' : 'epics'} assigned to you`);
  }
  if (entry?.read) bits.push(`${entry.read.tickets.length} ${entry.read.tickets.length === 1 ? 'ticket' : 'tickets'} in ${entry.key}`);
  bits.push(`reading every ${state.tickets?.pollMinutes ?? 15} min`);
  return refreshControl({
    source: 'Jira',
    fetchedAt,
    status: bits.join(' · '),
    fetching,
    stale: false,
    action: 'Ask Jira and GitHub now (r)',
    onRefresh: () => handlers.refreshProjects(),
  });
}

/* ---------- the view ---------- */

export function ProjectsView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element {
  const projects = state.projects;
  const enabled = Boolean(projects?.enabled);
  const key = ui.projectKey.value;
  const entry = key ? projects?.open?.[key] : undefined;
  const missing = enabled && key !== null && entry === undefined;

  // Read the remembered project again on entering the view, which the server
  // answers at once when its read is fresh; and again whenever the server has
  // none of it, as after a restart. Choosing one in the picker asks on its own.
  const entered = useRef(false);
  useEffect(() => {
    if (!enabled || !key) return;
    if (!entered.current || missing) handlers.openProject(key);
    entered.current = true;
  }, [enabled, key, missing]);

  return el('div', { class: 'projects' }, projectParts(state, projects, key, ui, handlers));
}

function projectParts(
  state: DashboardState,
  projects: ProjectsState | undefined,
  key: string | null,
  ui: UiState,
  handlers: Handlers,
): ComponentChild[] {
  // Absent from a server older than the page, between a change on disk and the restart behind it.
  if (!projects) return [el('p', { class: 'empty' }, 'This dashboard is older than the page. Restart it to zoom into an epic.')];
  if (!projects.enabled) return [el('p', { class: 'empty' }, 'Projects read Jira, which is switched off (DAILY_FOCUS_JIRA=off).')];

  const now = new Date(state.now);
  const parts: ComponentChild[] = [];
  if (projects.reason) {
    parts.push(
      failureNotice(
        projects.reason,
        {
          fold: 'failure:projects',
          className: 'banner banner--critical',
          icon: '!',
          lastGood: projects.fetchedAt,
          now,
          onRetry: () => handlers.refreshProjects(),
        },
        ui,
        handlers,
      ),
    );
  }

  if (!key) {
    parts.push(el('p', { class: 'empty' }, noProjectLine(projects)));
    return parts;
  }

  const entry = projects.open?.[key];
  if (entry?.reason) {
    parts.push(
      failureNotice(
        entry.reason,
        {
          fold: `failure:project:${key}`,
          className: `banner ${entry.read ? 'banner--warning' : 'banner--critical'}`,
          icon: '!',
          lastGood: entry.read?.fetchedAt ?? null,
          now,
          onRetry: () => handlers.openProject(key),
        },
        ui,
        handlers,
      ),
    );
  }
  if (!entry?.read) {
    if (!entry?.reason) parts.push(el('p', { class: 'empty' }, `Reading ${key}…`));
    return parts;
  }

  parts.push(...readView(entry.read, state, ui, handlers, now));
  return parts;
}

/** What to say with no project chosen: why there is nothing to choose, or that there is. */
function noProjectLine(projects: ProjectsState): string {
  if (projects.epics.length > 0) return 'Choose an epic to see what is left in it, and in which order it can land.';
  if (projects.fetchedAt === null) return projects.fetching ? 'Asking Jira for your epics…' : projects.reason ? '' : 'Nothing read yet.';
  return 'No unfinished epics are assigned to you.';
}

/** One read project: its warnings, its header, and the epic or initiative layout. */
function readView(read: PlannedRead, state: DashboardState, ui: UiState, handlers: Handlers, now: Date): ComponentChild[] {
  const project = projectWork(read, pullSources(state));
  const parts: ComponentChild[] = [];
  // Where each pull request stands, and what it offers, is the board's last good read.
  if (state.board?.enabled) parts.push(...boardFailures(state.board, now, ui, handlers));
  for (const warning of read.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));
  for (const loop of read.plan.loops ?? []) parts.push(loopBanner(loop, read));

  parts.push(projectHeader(read, handlers));
  const all = project.order.map((key) => project.works.get(key)!);
  parts.push(progressView(all));

  if (read.epics.length > 0) parts.push(...initiativeView(project, state, ui, handlers, now));
  else parts.push(...epicView(project, state, ui, handlers, now));
  return parts;
}

/** "These tickets block each other: PROJ-2 → PROJ-3 → PROJ-2. Fix the links in Jira." */
function loopBanner(members: readonly string[], read: PlannedRead): JSX.Element {
  const { path, others } = loopPath(members, read.tickets);
  const also = others.length > 0 ? `, with ${listOf(others)} caught in it too` : '';
  return banner('warning', '!', `These tickets block each other: ${path.join(' → ')}${also}. Fix the links in Jira.`);
}

/**
 * The project's name as a headline, under a breadcrumb that zooms out to what
 * it sits under, when it sits under anything.
 */
function projectHeader(read: PlannedRead, handlers: Handlers): JSX.Element {
  const { root, parent } = read;
  const facts = [root.issueType, root.workflowStatus].filter(Boolean).join(' · ');
  return el(
    'header',
    { class: 'project-head' },
    el(
      'p',
      { class: 'project-crumbs' },
      parent
        ? [
            el(
              'button',
              { type: 'button', class: 'project-crumbs__up', title: `Zoom out to ${parent.key}`, onClick: () => handlers.openProject(parent.key) },
              parent.summary || parent.key,
            ),
            el('span', { class: 'project-crumbs__sep', 'aria-hidden': 'true' }, ' / '),
          ]
        : null,
      el('span', { class: 'project-crumbs__key' }, root.key),
      facts ? el('span', { class: 'project-crumbs__facts' }, ` · ${facts}`) : null,
    ),
    el(
      'h2',
      { class: 'project-title' },
      root.url ? el('a', { href: root.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${root.key} in Jira` }, root.summary) : root.summary,
    ),
  );
}

/* ---------- progress ---------- */

/** A stage as a small gauge: a circle filled a quarter for each step, with a check once done. */
export function stageGlyph(stage: Stage, props: Props = {}): JSX.Element {
  return el('span', { class: 'stage-glyph', 'data-stage': stage, 'aria-hidden': 'true', ...props });
}

/**
 * One bar per ticket, in merge order, each filled as far as its ticket has got.
 * Hidden from a screen reader, which is given the sentence under it instead.
 */
function progressStrip(works: readonly TicketWork[], className = ''): JSX.Element {
  return el(
    'div',
    { class: `progress-strip${className ? ` ${className}` : ''}`, 'aria-hidden': 'true' },
    works.map((work) =>
      el('span', {
        key: work.ticket.key,
        class: 'progress-strip__seg',
        'data-stage': work.stage,
        title: `${work.ticket.key}: ${stageLabel(work).text}`,
      }),
    ),
  );
}

function progressView(works: readonly TicketWork[]): JSX.Element {
  return el(
    'section',
    { class: 'progress', 'aria-label': 'How far it has got' },
    progressStrip(works),
    el('p', { class: 'progress__sentence' }, progressSentence(stageCounts(works))),
    stageLegend(),
  );
}

/** The key to the glyphs, read once beside the strip. Each carries its name in words. */
function stageLegend(): JSX.Element {
  return el(
    'p',
    { class: 'legend stage-legend' },
    STAGES.map((stage) => el('span', { class: 'legend__entry', key: stage }, stageGlyph(stage), STAGE_LABEL[stage])),
  );
}

/* ---------- the board's own writes ---------- */

/**
 * What a click may do to a pull request from here, by its url: the board's own
 * Merge (or its merge queue's, or the merge helper's) where Do next says to
 * merge it, and Ready for review where it says to mark a draft ready. Nowhere
 * else, so nothing here invites merging out of the order the links set: a
 * "then merge" waits for what is ahead of it, and gets only its link.
 */
type Writes = ReadonlyMap<string, readonly PullWrite[]>;

function writesOf(steps: readonly NextStep[]): Writes {
  const writes = new Map<string, PullWrite[]>();
  for (const step of steps) {
    const kinds: PullWrite[] = step.kind === 'merge' ? ['merge'] : step.kind === 'ready' ? ['ready'] : [];
    if (step.pull && kinds.length > 0) writes.set(step.pull.url, [...(writes.get(step.pull.url) ?? []), ...kinds]);
  }
  return writes;
}

/**
 * The board's buttons for a row, through the same handlers, so the same
 * confirmation asks before a merge and the row is pending while it goes. Only
 * where the board shows them: on an open row the server offers them on.
 */
function writeButtons(row: BoardRow | null, kinds: readonly PullWrite[] | undefined, ui: UiState, handlers: Handlers): JSX.Element[] {
  if (!row || row.status !== 'open' || !kinds || kinds.length === 0) return [];
  return renderPullWrites(row, ui, handlers, kinds);
}

/** What a card needs to offer the board's writes on its pull requests. */
interface CardWrites {
  writes: Writes;
  ui: UiState;
  handlers: Handlers;
}

/* ---------- an epic ---------- */

function epicView(project: ProjectWork, state: DashboardState, ui: UiState, handlers: Handlers, now: Date): ComponentChild[] {
  const parts: ComponentChild[] = [];
  const open = project.order.filter((key) => project.works.get(key)!.stage !== 'done');
  const done = project.order.filter((key) => project.works.get(key)!.stage === 'done');

  const steps = nextSteps(project, now);
  const writes: CardWrites = { writes: writesOf(steps), ui, handlers };
  if (steps.length > 0) parts.push(nextList(steps, writes));
  else if (open.length > 0) parts.push(el('p', { class: 'empty' }, 'Nothing of yours to move on here right now.'));

  if (open.length > 0) parts.push(h(MergeOrder, { project, keys: open, now, writes }));
  else parts.push(el('p', { class: 'empty' }, `Every ticket in ${project.read.root.key} is done.`));

  if (done.length > 0) {
    const rows = done.map((key) => ({ id: key, work: project.works.get(key)! }));
    parts.push(
      drawer(`projects:done:${project.read.root.key}`, `Done (${done.length})`, rows, state, ui, handlers, (row) =>
        el('li', { key: row.id, class: 'project-done' }, ticketCard(row.work, project, now)),
      ),
    );
  }
  return parts;
}

/**
 * The ranked list of what to do, as Today ranks its rows: a numeral in the
 * margin, and on the right the board's own button where there is one, then the
 * link to where the rest is done.
 */
function nextList(steps: readonly NextStep[], { writes, ui, handlers }: CardWrites): JSX.Element {
  const shown = steps.slice(0, NEXT_SHOWN);
  const rest = steps.length - shown.length;
  return el(
    'section',
    { class: 'section project-next' },
    sectionHeader('Do next', steps.length),
    el(
      'ol',
      { class: 'next-steps' },
      shown.map((step, i) =>
        el(
          'li',
          { key: `${step.kind}:${step.title}`, class: 'next-step', 'data-kind': step.kind },
          el('span', { class: 'item__mark', 'data-rank': String(i + 1) }),
          el(
            'div',
            { class: 'next-step__body' },
            el('p', { class: 'next-step__title' }, step.title),
            el('p', { class: 'next-step__reason' }, step.reason),
          ),
          el(
            'div',
            { class: 'next-step__actions' },
            writeButtons(step.pull, step.pull ? writes.get(step.pull.url) : undefined, ui, handlers),
            step.url
              ? el(
                  'a',
                  { class: 'button next-step__open', href: step.url, target: '_blank', rel: 'noopener noreferrer' },
                  step.on === 'github' ? 'Open on GitHub' : 'Open in Jira',
                )
              : null,
          ),
        ),
      ),
    ),
    rest > 0 ? el('p', { class: 'next-steps__more' }, `And ${rest} more, which the merge order below shows.`) : null,
  );
}

function sectionHeader(title: string, count: number): JSX.Element {
  return el(
    'div',
    { class: 'section__header' },
    el('h2', { class: 'section__title' }, title),
    el('span', { class: 'section__count' }, String(count)),
  );
}

/* ---------- the merge order and its rail ---------- */

/** Lane width on the rail, in pixels. Matches `--lane-width` in the stylesheet. */
const LANE = 16;

interface Point {
  x: number;
  y: number;
}

/**
 * Every unfinished ticket as a card, in an order that keeps each blocker ahead
 * of what it blocks, with the links drawn as a rail on the paper beside them.
 *
 * The rail's lines are one SVG laid over the cards' margin, drawn from where
 * the nodes actually ended up: the cards are as tall as their contents, so
 * nothing short of measuring knows where a node is. Measured again whenever the
 * list changes size and once the fonts have loaded. Where layout gives nothing
 * to measure, as in a test's document, there are no lines, and the text on each
 * card still says what waits for what.
 */
function MergeOrder({ project, keys, now, writes }: { project: ProjectWork; keys: readonly string[]; now: Date; writes: CardWrites }): JSX.Element {
  const rail: Rail | null = assignLanes(
    keys,
    (key) => project.waitsFor[key] ?? [],
    (blocker) => project.works.get(blocker)?.stage === 'merged',
  );
  const lanes = rail?.width ?? 1;
  const body = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<Record<string, Point> | null>(null);

  const measure = (): void => {
    const root = body.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const next: Record<string, Point> = {};
    let any = false;
    for (const node of root.querySelectorAll<HTMLElement>('[data-node]')) {
      const at = node.getBoundingClientRect();
      if (at.width === 0 && at.height === 0) continue;
      any = true;
      next[node.dataset.node ?? ''] = { x: at.left - box.left + at.width / 2, y: at.top - box.top + at.height / 2 };
    }
    const measured = any ? next : null;
    setPoints((previous) => (samePoints(previous, measured) ? previous : measured));
  };

  // After every render, since a card's height follows its contents.
  useLayoutEffect(measure);
  useEffect(() => {
    const root = body.current;
    let live = true;
    const observer = typeof ResizeObserver === 'function' && root ? new ResizeObserver(() => measure()) : null;
    if (observer && root) observer.observe(root);
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    void fonts?.ready?.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, []);

  return el(
    'section',
    { class: 'section merge-order' },
    sectionHeader('In merge order', keys.length),
    el(
      'div',
      { class: 'merge-order__body', ref: body, style: `--lanes:${lanes}`, 'data-rail': String(rail !== null) },
      el(
        'svg',
        { class: 'merge-order__rail', 'aria-hidden': 'true', focusable: 'false' },
        rail && points ? railPaths(rail, points) : null,
      ),
      el(
        'ol',
        { class: 'merge-order__list' },
        keys.map((key) => {
          const work = project.works.get(key)!;
          return el(
            'li',
            { key, class: 'merge-order__row', id: `project-${cssId(key)}`, 'data-key': key },
            stageGlyph(work.stage, {
              class: 'stage-glyph merge-order__node',
              'data-node': key,
              'data-lane': String(rail?.lanes[key] ?? 0),
              style: `--lane:${rail?.lanes[key] ?? 0}`,
            }),
            ticketCard(work, project, now, writes),
          );
        }),
      ),
    ),
  );
}

function samePoints(a: Record<string, Point> | null, b: Record<string, Point> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] && Math.abs(a[key]!.x - b[key]!.x) < 0.5 && Math.abs(a[key]!.y - b[key]!.y) < 0.5);
}

/**
 * Each line: out of the blocker's node, over to the lane it runs down, down to
 * just above what it blocks, and in. Lanes are a fixed width apart, so a lane's
 * x is found from the blocker's own node rather than measured.
 */
function railPaths(rail: Rail, points: Record<string, Point>): JSX.Element[] {
  const paths: JSX.Element[] = [];
  for (const edge of rail.edges) {
    const from = points[edge.from];
    const to = points[edge.to];
    if (!from || !to || to.y <= from.y) continue;
    const base = from.x - edge.fromLane * LANE;
    const via = base + edge.viaLane * LANE;
    const bend = Math.min(10, (to.y - from.y) / 4);
    let d = `M${from.x},${from.y}`;
    if (via !== from.x) d += ` C${from.x},${from.y + bend} ${via},${from.y + bend} ${via},${from.y + 2 * bend}`;
    d += ` L${via},${to.y - 2 * bend}`;
    d += via !== to.x ? ` C${via},${to.y - bend} ${to.x},${to.y - bend} ${to.x},${to.y}` : ` L${to.x},${to.y}`;
    paths.push(el('path', { key: `${edge.from}>${edge.to}`, d, 'data-dotted': String(edge.dotted) }));
  }
  return paths;
}

/* ---------- a ticket's card ---------- */

/**
 * One ticket: its key and summary, where it stands, the user's pull requests
 * for it, and a line of what Jira says: its status, whose it is, what it waits
 * for and what it holds up.
 */
function ticketCard(work: TicketWork, project: ProjectWork, now: Date, writes: CardWrites | null = null): JSX.Element {
  const ticket = work.ticket;
  const label = stageLabel(work);
  const title: ComponentChild[] = [el('span', { class: 'item__ref' }, ticket.key), ' ', ticket.summary];
  return el(
    'article',
    { class: 'project-card', 'data-stage': work.stage, 'data-mine': String(ticket.mine) },
    el(
      'div',
      { class: 'project-card__head' },
      el(
        'p',
        { class: 'project-card__title' },
        ticket.url ? el('a', { href: ticket.url, target: '_blank', rel: 'noopener noreferrer' }, title) : title,
      ),
      ' ',
      el('span', { class: 'project-card__stage', 'data-tone': label.tone ?? 'plain' }, label.text),
    ),
    work.pulls.length > 0 ? el('ul', { class: 'project-card__pulls' }, work.pulls.map((pull) => pullLine(pull, now, writes))) : null,
    ticketMeta(work, project),
    !ticket.linksRead && ticket.statusCategory !== 'done'
      ? el('p', { class: 'item__reason item__reason--waiting' }, 'Its links could not be read, so it may wait for more than this says.')
      : null,
  );
}

function pullLine(pull: PullWork, now: Date, writes: CardWrites | null): JSX.Element {
  const buttons = writes ? writeButtons(pull.row, writes.writes.get(pull.url), writes.ui, writes.handlers) : [];
  return el(
    'li',
    { key: pull.url, class: 'project-pull', 'data-stage': pull.stage },
    // The spaces read as words to a screen reader; the flex gap is what shows.
    el('a', { class: 'project-pull__ref', href: pull.url, target: '_blank', rel: 'noopener noreferrer', title: pull.title }, `${pull.repo} #${pull.number}`),
    ' ',
    el('span', { class: `project-pull__state${pull.row?.court === 'you' ? ' project-pull__state--you' : ''}` }, pullWording(pull, now)),
    pull.stackedOn ? [' ', el('span', { class: 'pill pill--tag', title: pull.stackedOn.title }, `Stacked on #${pull.stackedOn.number}`)] : null,
    buttons.length > 0 ? [' ', el('span', { class: 'project-pull__writes' }, buttons)] : null,
  );
}

function ticketMeta(work: TicketWork, project: ProjectWork): JSX.Element {
  const ticket = work.ticket;
  const bits: ComponentChild[] = [
    el(
      'span',
      { class: 'pill pill--status project-card__status', title: 'Its status in Jira' },
      el('span', { class: 'pill__dot', 'aria-hidden': 'true' }),
      ticket.workflowStatus || '—',
    ),
  ];
  if (!ticket.mine) bits.push(el('span', null, ticket.assignee ?? 'Unassigned'));
  if (work.stage !== 'done') {
    const waits = project.waitsFor[ticket.key] ?? [];
    if (waits.length > 0) bits.push(el('span', { class: 'project-card__waits' }, 'Waits for ', ticketNames(waits, project)));
    const held = blocksOf(ticket.key, project);
    if (held.length > 0) bits.push(el('span', { class: 'project-card__blocks' }, 'Blocks ', ticketNames(held, project)));
  }
  return el('div', { class: 'item__meta project-card__meta' }, bits);
}

/** Keys in a sentence. One outside the project says where it stands, and links to it; one inside is on this page. */
function ticketNames(keys: readonly string[], project: ProjectWork): ComponentChild[] {
  const parts: ComponentChild[] = [];
  keys.forEach((key, i) => {
    if (i > 0) parts.push(i === keys.length - 1 ? ' and ' : ', ');
    const outside = project.outside.get(key);
    if (outside?.url) {
      parts.push(el('a', { href: outside.url, target: '_blank', rel: 'noopener noreferrer' }, key), nameTicket(key, project).slice(key.length));
    } else {
      parts.push(nameTicket(key, project));
    }
  });
  return parts;
}

/* ---------- an initiative ---------- */

/**
 * An initiative, a card per epic: how far each has got, the first thing to do
 * in it, and what it waits for in the others. A click on one zooms into it.
 */
function initiativeView(project: ProjectWork, state: DashboardState, ui: UiState, handlers: Handlers, now: Date): ComponentChild[] {
  const { read } = project;
  const position = new Map(project.order.map((key, i) => [key, i]));
  const keysOf = (parent: string): string[] => project.order.filter((key) => project.works.get(key)!.ticket.parent === parent);
  const firstOpen = (keys: readonly string[]): number =>
    Math.min(Infinity, ...keys.filter((key) => project.works.get(key)!.stage !== 'done').map((key) => position.get(key)!));

  const groups = read.epics.map((epic, i) => ({ epic, keys: keysOf(epic.key), jira: i }));
  const open = groups
    .filter((group) => group.epic.statusCategory !== 'done')
    .sort((a, b) => firstOpen(a.keys) - firstOpen(b.keys) || a.jira - b.jira);
  const done = groups.filter((group) => group.epic.statusCategory === 'done');
  const loose = keysOf(read.root.key);

  const parts: ComponentChild[] = [];
  parts.push(
    el(
      'section',
      { class: 'section' },
      sectionHeader('Epics', open.length),
      el(
        'ol',
        { class: 'epic-cards' },
        open.map((group) => epicCard(group.epic, group.keys, project, handlers, now)),
        loose.length > 0 ? epicCard(null, loose, project, handlers, now) : null,
      ),
    ),
  );
  if (done.length > 0) {
    const rows = done.map((group) => ({ id: group.epic.key, group }));
    parts.push(
      drawer(`projects:done:${read.root.key}`, `Done (${done.length})`, rows, state, ui, handlers, (row) =>
        epicCard(row.group.epic, row.group.keys, project, handlers, now),
      ),
    );
  }
  return parts;
}

/** One epic of an initiative, or with `epic` null, the tickets that sit under the initiative itself. */
function epicCard(epic: ProjectSummary | null, keys: readonly string[], project: ProjectWork, handlers: Handlers, now: Date): JSX.Element {
  const works = keys.map((key) => project.works.get(key)!);
  const done = works.filter((work) => work.stage === 'done').length;
  const own = new Set(keys);
  const first = nextSteps(project, now, (work) => own.has(work.ticket.key))[0];

  // What its unfinished tickets wait for in other epics, by epic, and outside by ticket.
  const waits: string[] = [];
  for (const work of works) {
    if (work.stage === 'done') continue;
    for (const blocker of project.waitsFor[work.ticket.key] ?? []) {
      if (own.has(blocker)) continue;
      const inside = project.works.get(blocker);
      const name = inside ? inside.ticket.parent : nameTicket(blocker, project);
      if (!waits.includes(name)) waits.push(name);
    }
  }

  const label: ComponentChild[] = epic
    ? [el('span', { class: 'item__ref' }, epic.key), ' ', epic.summary]
    : [`Directly under ${project.read.root.key}`];
  const open = epic ? (): void => handlers.openProject(epic.key) : null;
  return el(
    'li',
    {
      key: epic?.key ?? '(loose)',
      class: 'project-card epic-card',
      'data-key': epic?.key,
      'data-openable': String(open !== null),
      onClick: (event: MouseEvent) => {
        if (open && onCard(event)) open();
      },
    },
    el(
      'div',
      { class: 'project-card__head' },
      el(
        'p',
        { class: 'project-card__title' },
        open ? el('button', { type: 'button', class: 'epic-card__open', title: `Zoom into ${epic!.key}`, onClick: open }, label) : label,
      ),
      ' ',
      el('span', { class: 'epic-card__count' }, `${done} of ${works.length} done`),
    ),
    works.length > 0 ? progressStrip(works, 'progress-strip--mini') : null,
    first
      ? el(
          'p',
          { class: 'epic-card__next' },
          el('span', { class: 'epic-card__next-label' }, 'Next: '),
          first.url ? el('a', { href: first.url, target: '_blank', rel: 'noopener noreferrer' }, first.title) : first.title,
        )
      : null,
    el(
      'div',
      { class: 'item__meta project-card__meta' },
      epic
        ? el('span', { class: 'pill pill--status', title: 'Its status in Jira' }, el('span', { class: 'pill__dot', 'aria-hidden': 'true' }), epic.workflowStatus || '—')
        : null,
      waits.length > 0 ? el('span', { class: 'project-card__waits' }, `Waits for ${listOf(waits)}`) : null,
    ),
  );
}
