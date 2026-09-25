/** The Jira ticket board. */

import { h, type JSX } from 'preact';

import type { DashboardState, InProgressTicket, TicketBoardState, TicketRow } from '../src/types.ts';
import { banner } from './banners.ts';
import { el } from './el.ts';
import { formatDay, formatTime } from './format.ts';
import { cssId, onCard, renderSnoozeMenu, rowPills, type RowProps } from './items.ts';
import { renderMarkdown } from './markdown.ts';
import { refreshControl } from './refresh.ts';
import { drawer, section } from './section.ts';
import type { Handlers, TicketMode, UiState } from './types.ts';

/** Either kind of row this board shows. A row in a court is a `TicketRow`; one in Working on carries no court. */
export type AnyTicketRow = TicketRow | InProgressTicket;

/**
 * What each court claims, in the words the README uses for it.
 *
 * Each heading is the whole explanation, which is why there is no per-row reason
 * line here as there is on the pull request board: a ticket in `settled` has
 * exactly one thing wrong with it, and it is the heading.
 */
const TICKET_COURT_TITLE = {
  settled: 'No open pull requests left',
  started: 'Work has started, the ticket has not',
  idle: 'In flight with nothing linked',
};

const TICKET_COURT_ORDER = ['settled', 'started', 'idle'] as const;

/** What to do about a row, under the heading that says what is wrong with it. */
const TICKET_COURT_HINT = {
  settled:
    'Every pull request Jira has for these is closed. Move them on, or say what is still to come — ' +
    'a pull request nobody has written yet is invisible from here.',
  started: 'A pull request is open, so the work has begun. The status still says it has not.',
  idle: 'Nothing in Jira links any code to these. Fine for work that is not code; worth a look otherwise.',
};

/**
 * Issue type as a colour, because on this board the dot has nothing else to say.
 *
 * Everywhere else the dot carries the source, which is what lets the palette's
 * lighter hues sit below 3:1 contrast — the source name is always in text beside
 * it. Here every row is Jira, so the dot repeats itself once per row and the
 * colour is free to mean something else.
 *
 * Which means this is the one place colour carries a cue on its own, so it is
 * kept to the thing that changes the *least* about what you do: the load-bearing
 * facts — key, summary, status — stay as text, every dot carries its type as an
 * `aria-label` and a hover title, and `typeLegend` names the ones on the board.
 *
 * Task keeps Jira's own amber so the ordinary row looks exactly as it did and the
 * exceptions are what stand out. The rest are drawn from the categorical hues and
 * deliberately avoid red and the accent blue: red is this palette's "something is
 * wrong" and blue is its "selected", and an issue type is neither.
 */
const TYPE_COLOR: Readonly<Record<string, string>> = {
  task: 'var(--src-jira)',
  bug: 'var(--src-atlassian)',
  'sub-task': 'var(--src-tasks)',
  subtask: 'var(--src-tasks)',
  story: 'var(--src-calendar)',
};

const TYPE_FALLBACK = 'var(--src-other)';

export function typeColor(issueType: string): string {
  return TYPE_COLOR[issueType.trim().toLowerCase()] ?? TYPE_FALLBACK;
}

/**
 * The key to the dots, built from the types actually on the board rather than from
 * the list above — so it never names a type this board isn't showing, and a type
 * nobody anticipated still gets a swatch and its own name rather than going
 * silently grey.
 */
export function typeLegend(rows: readonly AnyTicketRow[]): JSX.Element | null {
  const seen: string[] = [];
  for (const row of rows) {
    const label = row.issueType.trim();
    if (label !== '' && !seen.includes(label)) seen.push(label);
  }
  if (seen.length < 2) return null;
  return el(
    'p',
    { class: 'legend' },
    seen
      .sort((a, b) => a.localeCompare(b))
      .map((label) =>
        el(
          'span',
          { class: 'legend__entry' },
          el('span', { class: 'legend__dot', style: `background:${typeColor(label)}`, 'aria-hidden': 'true' }),
          label,
        ),
      ),
  );
}

/**
 * The two questions this tab answers, one at a time.
 *
 * "What here is out of sync with reality" is the one that asks for action, so it
 * is where the tab opens and what its badge counts. "What am I working on" is a
 * different frame of mind, looked for rather than acted on, and it used to sit in
 * a drawer under Parked — styled like Parked, read like overflow from the list
 * above it. So the two are separate views behind a switch, and neither is ever
 * scrolled past on the way to the other.
 */
const TICKET_MODES: readonly TicketMode[] = ['sync', 'working'];

const TICKET_MODE_LABEL: Record<TicketMode, string> = {
  sync: 'Out of sync',
  working: 'Working on',
};

export function TicketsView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  return renderTicketBoard(state, ui, handlers);
}

export function renderTicketBoard(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const board = state.tickets;

  if (!board || !board.enabled) {
    return [el('p', { class: 'empty' }, 'The Jira ticket board is switched off (DAILY_FOCUS_JIRA=off).')];
  }

  // Absent from a server older than the page, which is what a tab sees between a
  // renderer changing on disk and the process behind it restarting.
  const inProgress = board.inProgress ?? [];
  const open = board.rows.filter((row) => row.status === 'open');
  const mode: TicketMode = ui.ticketMode.value === 'working' ? 'working' : 'sync';

  const parts: JSX.Element[] = [];
  // On the switch's line rather than beside the rows: it is a key, read once,
  // and a key repeated per court would be three copies of the same sentence.
  // Built from both views' rows, so it is the same key on either side of the
  // switch: one built per view vanished whenever a view held a single type, and
  // the line under it jumped as it came and went.
  const legend = typeLegend([...board.rows, ...inProgress]);
  parts.push(
    el(
      'div',
      { class: 'ticket-toolbar' },
      ticketModeSwitch(mode, { sync: open.length, working: inProgress.length }, handlers),
      legend,
    ),
  );

  // In both views: they are about whether the read can be trusted, and that is
  // as true of the list of work in progress as of the list of what is wrong.
  if (board.reason) parts.push(banner('critical', '!', board.reason));
  for (const warning of board.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));

  if (mode === 'working') parts.push(...workingOnView(board, inProgress, state, ui, handlers));
  else parts.push(...outOfSyncView(board, open, state, ui, handlers));

  return parts;
}

/** The switch between the two views, each with how many tickets it holds. */
function ticketModeSwitch(mode: TicketMode, counts: Record<TicketMode, number>, handlers: Handlers): JSX.Element {
  return el(
    'div',
    { class: 'mode-switch', role: 'tablist', 'aria-label': 'Which tickets to show' },
    TICKET_MODES.map((option) =>
      el(
        'button',
        {
          type: 'button',
          class: 'mode-switch__option',
          role: 'tab',
          'aria-selected': String(option === mode),
          title: `${TICKET_MODE_LABEL[option]} (w switches)`,
          onClick: () => handlers.setTicketMode(option),
        },
        TICKET_MODE_LABEL[option],
        el('span', { class: 'mode-switch__count' }, String(counts[option])),
      ),
    ),
  );
}

/** Nothing on screen, said so as to tell an empty answer from no answer yet. */
function emptyTicketView(board: TicketBoardState, whenRead: string): JSX.Element {
  return el(
    'p',
    { class: 'empty' },
    board.fetchedAt === null
      ? board.fetching
        ? 'Asking Jira…'
        : 'Nothing read yet.'
      : // Deliberately says how many were looked at. An empty board and a
        // board that examined nothing look the same, and only one of them is
        // good news — the same trap the agenda and the PR board each guard.
        `${whenRead} ${board.checked} unfinished ${board.checked === 1 ? 'ticket' : 'tickets'} checked.`,
  );
}

/** The courts, what to do about each, and the rows parked out of them. */
function outOfSyncView(board: TicketBoardState, open: TicketRow[], state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const parts: JSX.Element[] = [];
  for (const court of TICKET_COURT_ORDER) {
    const rows = open.filter((row) => row.court === court);
    if (rows.length === 0) continue;
    // No dot on the heading, as on the pull request board. On the brief a section
    // dot is its source, but here the row dots mean the issue type, and an amber
    // one over a court heading reads as a claim that the court is Tasks.
    parts.push(section(TICKET_COURT_TITLE[court], rows, state, ui, handlers, null, renderTicketRow));
    parts.push(el('p', { class: 'court-hint' }, TICKET_COURT_HINT[court]));
  }

  if (open.length === 0 && !board.reason) parts.push(emptyTicketView(board, 'Nothing looks mislabelled.'));

  const parked = board.rows.filter((row) => row.status === 'snoozed');
  if (parked.length > 0) {
    parts.push(drawer('tickets:parked', `Parked (${parked.length})`, parked, state, ui, handlers, renderTicketRow));
  }
  return parts;
}

/**
 * The tickets in progress, grouped by the status each one is in.
 *
 * Grouped because the category holds more than one kind of thing — In Progress
 * and In Review, and a hold status if the user has one — and a heading per status
 * says which is which without reading every gutter. Matched case-insensitively,
 * since one real board spelled "In Progress" differently in two projects, and
 * titled by the first spelling seen. Alphabetical, so the groups don't trade
 * places as tickets move; within a group, Jira's own least-recently-touched order.
 */
function workingOnView(
  board: TicketBoardState,
  inProgress: InProgressTicket[],
  state: DashboardState,
  ui: UiState,
  handlers: Handlers,
): JSX.Element[] {
  if (inProgress.length === 0) return board.reason ? [] : [emptyTicketView(board, 'Nothing in progress.')];

  const groups = new Map<string, { title: string; rows: InProgressTicket[] }>();
  for (const row of inProgress) {
    const name = row.workflowStatus.trim() || '—';
    const group = groups.get(name.toLowerCase()) ?? { title: name, rows: [] };
    group.rows.push(row);
    groups.set(name.toLowerCase(), group);
  }
  return [...groups.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((group) => section(group.title, group.rows, state, ui, handlers, null, renderTicketRow));
}

/** "as of 10:42 · 19 of 86 unfinished tickets · reading as you@work every 15 min", on the refresh control. */
export function ticketStatus(board: TicketBoardState, handlers: Handlers, mode: TicketMode = 'sync'): JSX.Element[] {
  const bits: string[] = [];
  // "refreshing…", as the pull request board says, so it cannot land beside the
  // "reading … every 15 min" clause below and say the same word twice.
  if (board.fetching) bits.push('refreshing…');
  else if (board.fetchedAt) bits.push(`as of ${formatTime(board.fetchedAt)}`);
  if (board.fetchedAt) {
    const unfinished = `${board.checked} unfinished ${board.checked === 1 ? 'ticket' : 'tickets'}`;
    bits.push(
      mode === 'working'
        ? `${(board.inProgress ?? []).length} of ${unfinished} in progress`
        : `${board.rows.filter((row) => row.status === 'open').length} of ${unfinished}`,
    );
  }
  if (board.projects.length > 0) bits.push(`in ${board.projects.join(', ')}`);
  // One clause, so "reading…" above doesn't land next to a second "reading".
  bits.push(`reading ${board.account ? `as ${board.account} ` : ''}every ${board.pollMinutes} min`);

  // No stale state: this status line has never carried an age to judge one by.
  return refreshControl({
    source: 'Jira',
    fetchedAt: board.fetchedAt,
    status: bits.join(' · '),
    fetching: board.fetching,
    stale: false,
    action: 'Ask Jira now (r)',
    onRefresh: () => handlers.refreshTickets(),
  });
}

/** Whether a row is one of the flagged kind, with a court and a park status. */
function flagged(row: AnyTicketRow): row is TicketRow {
  return 'court' in row && typeof row.court === 'string';
}

/** One ticket row, keyed by its id so a rebuilt list keeps the element. */
export function renderTicketRow(row: AnyTicketRow, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  return h(TicketRowView, { key: row.id, item: row, state, ui, handlers });
}

export function TicketRowView({ item: row, state, ui, handlers }: RowProps<AnyTicketRow>): JSX.Element {
  const now = new Date(state.now);
  const selected = ui.selectedId.value === row.id;

  // The key rather than the title, and a link only when there is a site to link
  // to: `url` is null when acli never named one, and an anchor with no href
  // would look clickable and go nowhere. So the reference degrades to text.
  const reference = el('span', { class: 'item__ref' }, row.key);
  const title = row.url
    ? el('a', { href: row.url, target: '_blank', rel: 'noopener noreferrer' }, reference, ' ', row.summary)
    : el('span', null, reference, ' ', row.summary);

  return el(
    'li',
    {
      class: 'item item--ticket',
      // Its own scheme, for `PullRow`'s reason: the same ticket can be a brief
      // row too, and two elements with one id is an ambiguous target.
      id: `ticket-${cssId(row.id)}`,
      'data-id': row.id,
      // Only a flagged row has either. One in Working on has no complaint to be
      // filed under and nothing to be parked from, so it carries neither.
      ...(flagged(row) ? { 'data-status': row.status, 'data-court': row.court } : {}),
      'data-selected': String(selected),
      'data-pending': String(ui.pending.value.has(row.id)),
      'data-detail': String(ui.detailFor.value === row.id),
      onClick: (event: MouseEvent) => {
        if (onCard(event)) handlers.onSelect(row.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      // Not aria-hidden, unlike the source dots: this one is the only place the
      // issue type appears, so it has to be readable without seeing the colour.
      el('span', {
        class: 'item__dot',
        style: `background:${typeColor(row.issueType)}`,
        role: 'img',
        'aria-label': row.issueType || 'unknown type',
        title: row.issueType || 'unknown type',
      }),
    ),
    el(
      'div',
      { class: 'item__body' },
      renderTicketStatus(row, state, ui, handlers),
      el('p', { class: 'item__title' }, title),
      renderTicketMeta(row, state, handlers),
    ),
    renderTicketActions(row, ui, handlers),
    ui.menuFor.value === row.id ? renderSnoozeMenu(row, now, handlers, { indefinite: false, longRange: true }) : null,
  );
}

/**
 * The status the ticket is actually in — the other half of the sentence the court
 * heading starts, and the thing the user is about to go and change. Always shown,
 * even empty-handed, and alone in its own element because the stylesheet stands
 * it in a fixed gutter so every summary on the board starts at the same x.
 *
 * Pressable only when the board has seen somewhere for this ticket to go. There
 * is deliberately no way to type a status name here: the offer is limited to
 * what has been observed, and a project whose workflow has never been seen
 * reaching an end simply cannot be finished from this tab. That is a known
 * limitation taken on purpose — a free-text field would invite naming statuses
 * that don't exist, and the answer to those is a refusal nobody needed to see.
 */
function renderTicketStatus(row: AnyTicketRow, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  const offered = ticketStatusOptions(row, state);
  if (offered.length === 0) {
    return el('div', { class: 'item__meta item__meta--status' }, el('span', { class: 'pill pill--status' }, row.workflowStatus || '—'));
  }

  return el(
    'div',
    { class: 'item__meta item__meta--status' },
    el(
      'button',
      {
        type: 'button',
        class: 'pill pill--status pill--button',
        title: `Move ${row.key} to another status`,
        'aria-expanded': String(ui.statusFor.value === row.id),
        onClick: () => handlers.toggleStatus(row.id),
      },
      row.workflowStatus || '—',
    ),
    ui.statusFor.value === row.id ? renderStatusMenu(row, offered, ui, handlers) : null,
  );
}

/**
 * The statuses this row may be offered, which is *not* the same question as
 * which transitions Jira will allow.
 *
 * `acli` cannot answer the second — a work item's `transitions` come back null
 * and there is no command for them — so the offer is built from the statuses the
 * user's own tickets in that project are seen in, and Jira is left to be the
 * authority by refusing. Which means a refusal is an expected outcome here
 * rather than a bug, and has to read as Jira's answer rather than as an error.
 *
 * Scoped to the row's own project, because projects disagree: one real board was
 * running "In Progress" and "In progress" in two of them, and offering one
 * project's vocabulary on another's ticket is offering a refusal for certain.
 */
function ticketStatusOptions(row: AnyTicketRow, state: DashboardState): string[] {
  const project = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(row.key.trim())?.[1]?.toUpperCase();
  const all = (project && state.tickets?.statuses?.[project]) || [];
  const current = row.workflowStatus.trim().toLowerCase();
  return all.filter((status) => status.trim().toLowerCase() !== current);
}

function renderStatusMenu(row: AnyTicketRow, offered: readonly string[], ui: UiState, handlers: Handlers): JSX.Element {
  const busy = ui.pending.value.has(row.id);
  return el(
    'div',
    { class: 'menu menu--status', role: 'menu' },
    offered.map((status) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: busy,
          onClick: () => handlers.moveTicket(row.key, status, row.workflowStatus),
        },
        status,
      ),
    ),
  );
}

/**
 * The pills that are worth a second line because they are exceptions: a ticket
 * in Working on that is also out of sync, a pull request still open, or a row
 * someone parked. Null when there are none, which is the ordinary case and why
 * most cards are one line tall.
 */
function renderTicketMeta(row: AnyTicketRow, state: DashboardState, handlers: Handlers): JSX.Element | null {
  const pills: JSX.Element[] = [];
  const flag = flagged(row) ? null : outOfSyncFlag(row, state, handlers);
  if (flag) pills.push(flag);
  if (row.hasOpenPr) pills.push(el('span', { class: 'pill pill--tag' }, 'open PR'));
  if (flagged(row) && row.status === 'snoozed' && row.snoozedUntil) {
    pills.push(el('span', { class: 'pill pill--tag' }, `parked until ${formatDay(row.snoozedUntil)}`));
  }
  pills.push(...rowPills(row, state));
  return pills.length > 0 ? el('div', { class: 'item__meta item__meta--extra' }, pills) : null;
}

/**
 * On a Working on row, whether the same ticket is out of sync — and a way to go
 * and see it there.
 *
 * This is how the more urgent of the two views reaches the other one. The row is
 * never shown twice on one screen, so without this an In Progress ticket whose
 * pull requests have all closed would read, in Working on, as work going fine.
 * The words carry it and the colour only agrees with them. A parked row gets no
 * flag: the park asked for exactly that complaint to stay quiet until its date.
 */
function outOfSyncFlag(row: InProgressTicket, state: DashboardState, handlers: Handlers): JSX.Element | null {
  const hit = state.tickets?.rows?.find((candidate) => candidate.id === row.id && candidate.status === 'open');
  if (!hit) return null;
  return el(
    'button',
    {
      type: 'button',
      class: 'pill pill--button pill--flag',
      title: 'Show it under Out of sync',
      onClick: () => handlers.jumpToTicket(row.id),
    },
    `Out of sync: ${TICKET_COURT_TITLE[hit.court]}`,
  );
}

/**
 * Park — and deliberately nothing else.
 *
 * No Done: the fix is a status change in Jira, and the next read drops the row on
 * its own. No Nudged either, which the pull request board offers: there is nobody
 * to nudge about your own ticket's status. Notes are written in the panel, which
 * a click on the card opens.
 *
 * And no Open, which the pull request board does have. The strip is absolutely
 * positioned over the card's top right, so on a 460px column every button in it
 * is width taken off the summary — and this one bought nothing, because the
 * summary beside it is already an anchor to the same browse URL, as is `o`. The
 * one that remains is the reason `.item__title` reserves the room it does.
 *
 * A row in Working on gets no strip at all. A park silences a complaint until a
 * date, and nothing on that row is complaining.
 */
function renderTicketActions(row: AnyTicketRow, ui: UiState, handlers: Handlers): JSX.Element | null {
  if (!flagged(row)) return null;
  const buttons: JSX.Element[] = [];

  if (row.status === 'open') {
    buttons.push(
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          title: 'Park this until a date',
          'aria-expanded': String(ui.menuFor.value === row.id),
          onClick: () => handlers.toggleMenu(row.id),
        },
        'Park',
      ),
    );
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onClick: () => handlers.unpark(row.id) }, 'Unpark'));
  }

  return buttons.length > 0 ? el('div', { class: 'item__actions' }, buttons) : null;
}
