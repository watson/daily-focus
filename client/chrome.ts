/** The page around the lists: the header, the tabs, and the keyboard help. */

import { h, type JSX } from 'preact';

import type { DashboardState } from '../src/types.ts';
import { nextRunPhraseFor } from './banners.ts';
import { boardStatus } from './board.ts';
import { el } from './el.ts';
import { formatDay, formatTime } from './format.ts';
import { availableViews } from './state.ts';
import { ThemeToggle } from './theme.ts';
import { ticketStatus } from './tickets.ts';
import type { Handlers, UiState, View } from './types.ts';

/* ---------- header ---------- */

export function Header({ state, ui, handlers }: { state: DashboardState | null; ui: UiState; handlers: Handlers }): JSX.Element {
  const error = ui.connectionError.value;
  return el(
    'header',
    { class: 'page-header' },
    el(
      'div',
      { class: 'page-header__titles' },
      el('h1', null, 'Daily Focus'),
      el('p', { class: 'page-header__date', id: 'header-date' }, state ? headerDate(state) : ''),
    ),
    el(
      'div',
      { class: 'page-header__meta' },
      // The live connection, as a pill in the header rather than a banner under
      // the tabs. It belongs to the page and not to whichever tab is showing, and
      // it is a state rather than a message: EventSource reconnects on its own, so
      // there is nothing to read and nothing to do, only something to know — that
      // what is on screen stopped moving at the last update. The error's own words
      // go in the tooltip, since "Failed to fetch" is for whoever is debugging,
      // not the reader.
      el(
        'span',
        {
          class: 'connection',
          id: 'connection',
          role: 'status',
          hidden: !error,
          title: error ? `${error.message}. Showing the last update received; reconnecting on its own.` : undefined,
        },
        el('span', { class: 'connection__dot', 'aria-hidden': 'true' }),
        'Reconnecting…',
      ),
      state ? freshness(state, handlers) : el('span', { class: 'freshness', id: 'freshness', 'aria-live': 'polite' }),
      // The icon that starts the morning agent, beside the age it would reset.
      el('span', { class: 'brief-refresh', id: 'brief-refresh' }, state ? briefRefresh(state, handlers) : null),
      // One slot per board, each shown only on its own tab in place of the
      // brief's freshness. The boards render their source, last read and refresh
      // icon here rather than as a full-width strip above their rows: it is a
      // readout consulted now and then, and the details live in the icon's tooltip.
      el(
        'span',
        { class: 'board-refresh', id: 'board-refresh' },
        state?.board?.enabled ? boardStatus(state.board, new Date(state.now), handlers) : null,
      ),
      el(
        'span',
        { class: 'board-refresh', id: 'tickets-refresh' },
        state?.tickets?.enabled ? ticketStatus(state.tickets, handlers, ui.ticketMode.value) : null,
      ),
      h(ThemeToggle, { ui, handlers }),
      el(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          id: 'help-toggle',
          'aria-label': 'Keyboard shortcuts',
          title: 'Keyboard shortcuts',
          onClick: () => handlers.openHelp(),
        },
        el('span', { 'aria-hidden': 'true' }, '?'),
      ),
    ),
  );
}

function headerDate(state: DashboardState): string {
  const now = new Date(state.now);
  return formatDay(state.brief.date ?? state.now) || formatDay(now.toISOString());
}

/** "updated 2 hours ago by Codex", and the way in to the morning agent's runs once there is one. */
function freshness(state: DashboardState, handlers: Handlers): JSX.Element {
  let text: string;
  let stale: string;
  if (state.brief.generatedAt === null) {
    text = 'no brief yet';
    stale = 'true';
  } else {
    const hours = state.brief.ageHours ?? 0;
    const when = hours < 1 ? 'just now' : hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const by = state.brief.generatedBy ? ` by ${state.brief.generatedBy}` : '';
    text = `updated ${when}${by}`;
    stale = String(state.brief.stale);
  }

  // The readout is the way in to the morning agent's runs, once there is one:
  // what it did, what it reported, and the place to ask it why. A link rather
  // than a button in the header, so nothing new appears there for it.
  const last = state.agentRun?.last;
  return el(
    'span',
    { class: 'freshness', id: 'freshness', 'aria-live': 'polite', 'data-stale': stale },
    last
      ? el(
          'button',
          {
            type: 'button',
            class: 'freshness__link',
            title: "Open the morning agent's latest run: its report, and a place to ask it why",
            onClick: () => handlers.openRun(),
          },
          text,
        )
      : text,
  );
}

/**
 * The refresh icon beside the brief's age, when the dashboard may start the
 * morning agent. The same icon the boards use, spinning for the same reason,
 * but no label of its own: "updated … ago" beside it already is one.
 */
function briefRefresh(state: DashboardState, handlers: Handlers): JSX.Element | null {
  const agent = state.agentRun;
  if (!agent?.enabled) return null;
  const running = agent.last?.status === 'running';
  const label = running
    ? `The morning agent is writing a new brief, started ${formatTime(agent.last?.startedAt)}`
    : `Run the morning agent now, for a fresh brief${nextRunPhraseFor(agent)}`;
  return el(
    'button',
    {
      type: 'button',
      class: 'icon-button refresh-button',
      title: label,
      'aria-label': label,
      'aria-busy': String(running),
      'data-fetching': String(running),
      'data-stale': String(Boolean(state.brief.stale)),
      onClick: () => {
        if (!running) handlers.runAgent();
      },
    },
    el('span', { class: 'refresh-button__icon', 'aria-hidden': 'true' }),
  );
}

/* ---------- tabs ---------- */

/**
 * Three views, one page.
 *
 * Each badge says the one number its tab wants read from the others. The board's
 * is how many pull requests are waiting on you right now, which is urgent and
 * styled as such. The ticket board's is how many statuses look wrong, which never
 * is — nobody is blocked on a mislabelled ticket — so it is the whole flagged
 * count rather than a subset, and quiet rather than red.
 *
 * The two board tabs are hidden until the first state says their board is
 * switched on, so an instance without one never flashes its tab.
 */
export function Tabs({ state, ui, handlers }: { state: DashboardState | null; ui: UiState; handlers: Handlers }): JSX.Element {
  const views = availableViews(state);
  const current = ui.view.value;
  const waiting = state?.board?.enabled ? state.board.counts.you : 0;
  const flagged = state?.tickets?.enabled ? state.tickets.rows.filter((row) => row.status === 'open').length : 0;
  return el(
    'nav',
    { class: 'tabs', 'aria-label': 'Views', role: 'tablist' },
    tab('today', 'Today', current, true, null, handlers),
    tab(
      'board',
      'Pull requests',
      current,
      views.includes('board'),
      badge('board-badge', waiting, `${waiting} ${waiting === 1 ? 'pull request is' : 'pull requests are'} waiting on you`, false),
      handlers,
    ),
    tab(
      'tickets',
      'Jira tickets',
      current,
      views.includes('tickets'),
      badge(
        'tickets-badge',
        flagged,
        `${flagged} ${flagged === 1 ? 'ticket has a status that looks' : 'tickets have statuses that look'} wrong`,
        true,
      ),
      handlers,
    ),
  );
}

function tab(view: View, label: string, current: View, shown: boolean, badge: JSX.Element | null, handlers: Handlers): JSX.Element {
  return el(
    'button',
    {
      type: 'button',
      class: 'tab',
      id: `tab-${view}`,
      role: 'tab',
      'aria-selected': String(current === view),
      'data-view': view,
      hidden: !shown,
      onClick: () => handlers.setView(view),
    },
    label,
    badge,
  );
}

/** The label doubles as the hover tooltip, so a bare number can be decoded. */
function badge(id: string, count: number, label: string, quiet: boolean): JSX.Element {
  return el(
    'span',
    {
      class: quiet ? 'tab__badge tab__badge--quiet' : 'tab__badge',
      id,
      hidden: count === 0,
      'aria-label': label,
      title: label,
    },
    String(count),
  );
}

/* ---------- keyboard help ---------- */

const SHORTCUTS: readonly [readonly string[], string][] = [
  [['1', '2', '3'], 'Today / pull requests / Jira tickets'],
  [['j', 'k'], 'Next / previous item'],
  [['e'], 'Mark done'],
  [['s'], 'Snooze until tomorrow'],
  [['x'], 'Dismiss — not relevant'],
  [['n'], "Open the item's panel, ready for a note"],
  [['a'], "Open the item's panel, ready to ask the assistant"],
  [['Esc'], 'Close the menu, then the panel'],
  [['o'], 'Open the source link'],
  [['u'], 'Undo the last action'],
  [['f'], 'Focus mode — hide all but the top item'],
  [['p'], 'Start a focus session on the selected item'],
  [['r'], 'Refresh whichever board you are on'],
  [['w'], 'Jira tickets: switch between out of sync and working on'],
  [['?'], 'This help'],
];

export function HelpDialog(_props: object): JSX.Element {
  return el(
    'dialog',
    { class: 'help', id: 'help' },
    el('h2', null, 'Keyboard shortcuts'),
    el(
      'dl',
      null,
      SHORTCUTS.map(([keys, what]) =>
        el(
          'div',
          null,
          el(
            'dt',
            null,
            keys.flatMap((key, index) => [index > 0 ? ' / ' : null, el('kbd', null, key)]),
          ),
          el('dd', null, what),
        ),
      ),
    ),
    el(
      'p',
      { class: 'help__note' },
      'Done, snoozed and dismissed all tell the morning agent to leave an item out of ' +
        "tomorrow's brief. A note is sent along with it as free text. On both boards only " +
        "snooze and note apply: a pull request stays until it's merged or closed, and a " +
        'ticket whose status looks wrong is put right in Jira rather than here. Click a card ' +
        'to open its panel, where its notes and the assistant live; the panel stays on the ' +
        'item it was opened for. The assistant is a CLI run on your machine; it reads and ' +
        'drafts, never sends or posts. Click "updated … ago" in the header to open the ' +
        "morning agent's latest run: its report, earlier runs, and a place to ask it why " +
        'it did what it did.',
    ),
    el('form', { method: 'dialog' }, el('button', { type: 'submit', class: 'button' }, 'Close')),
  );
}
