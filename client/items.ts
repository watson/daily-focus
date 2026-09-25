/** One brief item, and the pieces of a row the boards share with it. */

import { h, type JSX } from 'preact';

import type { DashboardState, ResolvedItem } from '../src/types.ts';
import { el } from './el.ts';
import { daysFromToday, formatShortDay, localDateKey, relativeDay } from './format.ts';
import { renderMarkdown } from './markdown.ts';
import { clock, remainingSeconds } from './timer.ts';
import type { Handlers, UiState } from './types.ts';

// The user's own lists, `tasks` and `reminders`, sit right after the obligations that
// come with a deadline attached: every other source is a queue somebody else fills,
// and their own list ranking below everyone else's noise is how it ends up ignored.
export const SOURCE_ORDER: readonly string[] = [
  'workday',
  'eboks',
  'tasks',
  'reminders',
  'email',
  'messages',
  'github',
  'slack',
  'jira',
  'atlassian',
  'calendar',
  'other',
];

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  workday: 'Workday',
  tasks: 'Tasks',
  email: 'Email',
  github: 'GitHub',
  slack: 'Slack',
  jira: 'Jira',
  atlassian: 'Atlassian',
  calendar: 'Calendar',
  reminders: 'Reminders',
  messages: 'Messages',
  eboks: 'e-Boks',
  other: 'Other',
};

export function sourceColor(source: string): string {
  return `var(--src-${SOURCE_ORDER.includes(source) ? source : 'other'})`;
}

/** CSS-safe id fragment — item ids contain ':', '#' and '/'. */
export function cssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Path segments github.com spends on itself. `/orgs/acme/projects/5` is not a
 * repository called `acme` owned by `orgs`, and a row claiming it was would be
 * worse than a row that said nothing.
 */
const GITHUB_NON_OWNER = new Set([
  'account',
  'apps',
  'codespaces',
  'collections',
  'dashboard',
  'explore',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'users',
]);

/**
 * Which repository a GitHub row belongs to, read off its link.
 *
 * The title is prose an agent wrote, so it names the repository when it happens
 * to read well and not otherwise — and the organisation almost never, which is
 * the half that matters when two of them own a `web-ui`.
 *
 * Off the URL rather than off the id: the id's `github:pr:<owner>/<repo>#<n>`
 * shape is the prompt's to spell, and this file treats it as opaque on purpose.
 * A link naming no repository yields nothing rather than a guess, for the same
 * reason — the row can be quiet about where it lives, but it must not be wrong.
 */
export function githubRepo(item: Pick<ResolvedItem, 'source' | 'url'>): string | null {
  if (item.source !== 'github' || !item.url) return null;

  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }

  // github.com, or an enterprise host spelled github.<company>.com. A gist lives
  // on gist.github.com and its second segment is a hash, not a repository name.
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com' && !host.startsWith('github.')) return null;

  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo || GITHUB_NON_OWNER.has(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}

/** Let links, buttons and inputs do their own thing; anywhere else on a card is the card. */
export function onCard(event: Event): boolean {
  const target = event.target as Element | null;
  return !target?.closest?.('a, button, input, textarea, summary');
}

export interface RowProps<T> {
  item: T;
  state: DashboardState;
  ui: UiState;
  handlers: Handlers;
}

/** One brief row, keyed by its id so a rebuilt list keeps the element. */
export function renderItem(item: ResolvedItem, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  return h(ItemRow, { key: item.id, item, state, ui, handlers });
}

/**
 * A component rather than a plain function, so that the one row with a session
 * running can read the clock and be the only thing rerun by its tick.
 */
export function ItemRow({ item, state, ui, handlers }: RowProps<ResolvedItem>): JSX.Element {
  const now = new Date(state.now);
  const selected = ui.selectedId.value === item.id;
  const active = state.session?.active ?? null;
  const running = active !== null && active.id === item.id;
  const overrun = running && remainingSeconds(active, ui.clock.value) < 0;

  // Ahead of the title and inside the link, which is where the board tab puts the
  // same fact. Always, even when the title says it too: a column you can run an
  // eye down is worth more than the odd repeated word.
  const repo = githubRepo(item);
  const title = item.url
    ? el(
        'a',
        { href: item.url, target: '_blank', rel: 'noopener noreferrer' },
        repo ? [el('span', { class: 'item__ref' }, repo), ' '] : null,
        item.title,
      )
    : item.title;

  return el(
    'li',
    {
      class: 'item',
      id: `item-${cssId(item.id)}`,
      'data-id': item.id,
      'data-status': item.status,
      'data-selected': String(selected),
      'data-priority': String(item.priority !== undefined && item.status === 'open'),
      'data-pending': String(ui.pending.value.has(item.id)),
      'data-running': String(running),
      'data-overrun': String(overrun),
      'data-detail': String(ui.detailFor.value === item.id),
      // A click on the card opens the panel on it: one way in, and the whole card is it.
      onClick: (event: MouseEvent) => {
        if (onCard(event)) handlers.onSelect(item.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      el('span', {
        class: 'item__dot',
        style: `background:${sourceColor(item.source)}`,
        'aria-hidden': 'true',
      }),
    ),
    el(
      'div',
      { class: 'item__body' },
      el('p', { class: 'item__title' }, title),
      renderMeta(item, state, ui, now),
      item.detail ? el('p', { class: 'item__detail' }, renderMarkdown(item.detail)) : null,
    ),
    renderActions(item, state, ui, handlers),
    ui.menuFor.value === item.id ? renderSnoozeMenu(item, now, handlers) : null,
  );
}

function renderMeta(item: ResolvedItem, state: DashboardState, ui: UiState, now: Date): JSX.Element {
  const pills: JSX.Element[] = [];
  const said = new Set<string>();
  const pill = (cls: string, text: string): void => {
    pills.push(el('span', { class: cls }, text));
    said.add(text.trim().toLowerCase());
  };

  const active = state.session?.active ?? null;
  if (active && active.id === item.id) {
    pills.push(
      el(
        'span',
        { class: 'pill pill--running' },
        el('span', { class: 'item__running-clock' }, clock(remainingSeconds(active, ui.clock.value))),
        ' focusing',
      ),
    );
  }

  if (item.priority !== undefined && item.status === 'open') {
    pill('pill pill--priority', `#${item.priority}`);
  }

  for (const [cls, text] of rowPillTexts(item, state)) pill(cls, text);

  // Marks the rows that actually move the objective, so they're findable at a glance
  // even when they aren't the top-ranked thing on the page.
  if (item.advancesObjective) {
    pill('pill pill--objective', 'objective');
  }

  if (item.due) {
    const diff = daysFromToday(item.due, now);
    if (diff !== null && diff < 0) {
      pill('pill pill--overdue', `overdue ${relativeDay(item.due, now)}`);
    } else if (diff !== null && diff <= 7) {
      pill('pill pill--due', `due ${relativeDay(item.due, now)}`);
    }
  }

  // Only nag once something has genuinely lingered.
  if (item.ageDays >= 2 && item.status === 'open') {
    pill('pill pill--age', `${item.ageDays} days on the list`);
  }

  if (state.agenda?.conflictIds.includes(item.id)) {
    pill('pill pill--conflict', 'clashes');
  }

  if (item.status === 'snoozed') {
    pill('pill', item.snoozedUntil ? `snoozed until ${relativeDay(item.snoozedUntil, now)}` : 'snoozed');
  }

  // The agent sometimes tags an item with a word the pills already say —
  // "objective" alongside the objective pill. Showing it twice is just noise.
  for (const tag of item.tags ?? []) {
    if (said.has(tag.trim().toLowerCase())) continue;
    pill('pill pill--tag', tag);
  }

  return el(
    'div',
    { class: 'item__meta' },
    // The source name in text is what carries identity; the dot only reinforces it.
    el('span', { class: 'item__source' }, SOURCE_LABEL[item.source] ?? 'Other'),
    item.people?.length ? el('span', null, `· ${item.people.join(', ')}`) : null,
    pills,
  );
}

/**
 * What every kind of row says about its panel: how many notes it carries, and
 * that the assistant is working on it. The notes themselves live in the panel,
 * and the card is the way there.
 */
function rowPillTexts(row: { id: string; notes?: readonly unknown[] }, state: DashboardState): [string, string][] {
  const pills: [string, string][] = [];
  const count = row.notes?.length ?? 0;
  if (count > 0) {
    pills.push(['pill pill--notes', count === 1 ? '1 note' : `${count} notes`]);
  }
  if (state.assistant?.items?.[row.id]?.running) {
    pills.push(['pill pill--assistant', 'assistant working…']);
  }
  return pills;
}

export function rowPills(row: { id: string; notes?: readonly unknown[] }, state: DashboardState): JSX.Element[] {
  return rowPillTexts(row, state).map(([cls, text]) => el('span', { class: cls }, text));
}

function renderActions(item: ResolvedItem, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  const buttons: JSX.Element[] = [];
  const act = (id: string, action: 'done' | 'dismiss' | 'reopen') => () => handlers.onAction(id, action);

  const running = state.session?.active?.id === item.id;

  if (item.status === 'open') {
    if (item.kind === 'task') {
      buttons.push(
        el(
          'button',
          {
            type: 'button',
            class: running ? 'button button--primary' : 'button',
            title: running ? 'Stop the focus session' : 'Start a focus session on this',
            onClick: () => (running ? handlers.stopSession() : handlers.startSession(item.id)),
          },
          running ? 'Stop' : 'Focus',
        ),
      );
      buttons.push(el('button', { type: 'button', class: 'button', onClick: act(item.id, 'done') }, 'Done'));
      buttons.push(
        el(
          'button',
          {
            type: 'button',
            class: 'button',
            'aria-expanded': String(ui.menuFor.value === item.id),
            onClick: () => handlers.toggleMenu(item.id),
          },
          'Snooze',
        ),
      );
    }
    buttons.push(el('button', { type: 'button', class: 'button', onClick: act(item.id, 'dismiss') }, 'Dismiss'));
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onClick: act(item.id, 'reopen') }, 'Undo'));
  }

  return el('div', { class: 'item__actions' }, buttons);
}

/**
 * The park / snooze menu.
 *
 * `indefinite` offers "until the agent decides", which is a brief item's escape
 * hatch and deliberately not a board's: `foldActionLog` keeps a dateless snooze
 * parked forever, and a board row hidden forever with nothing to say so is the
 * failure these boards exist to avoid.
 *
 * `longRange` adds months and quarters, for the boards where something can
 * legitimately not be this month's problem. Both are calendar arithmetic from
 * today rather than jumps to the 1st, which keeps them consistent with the three
 * above — "Next week" is seven days, not next Monday — and avoids the collision
 * that "the start of next quarter" would hit every time the quarter is nearly
 * over: in late September it and "next month" would both be 1 October.
 */
export function renderSnoozeMenu(
  item: { id: string },
  now: Date,
  handlers: Handlers,
  { indefinite = true, longRange = false }: { indefinite?: boolean; longRange?: boolean } = {},
): JSX.Element {
  const presets: [string, string, boolean][] = [
    ['Tomorrow', addDays(now, 1), false],
    ['In 3 days', addDays(now, 3), false],
    ['Next week', addDays(now, 7), false],
  ];
  if (longRange) {
    presets.push(['Next month', addMonths(now, 1), true], ['Next quarter', addMonths(now, 3), true]);
  }

  // The date field is left to the browser; the button beside it reads it when pressed.
  let dateInput: HTMLInputElement | null = null;

  return el(
    'div',
    { class: 'menu', role: 'menu' },
    presets.map(([label, until, dated]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: () => handlers.onAction(item.id, 'snooze', { until }),
        },
        label,
        // Only the long ones show the date they resolve to. You know what date
        // next Tuesday is; you do not know what date three months out is, and a
        // park that long is worth being sure about before clicking it.
        dated ? el('span', { class: 'menu__when' }, formatShortDay(until)) : null,
      ),
    ),
    indefinite
      ? el(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            onClick: () => handlers.onAction(item.id, 'snooze', {}),
          },
          'Until the agent decides',
        )
      : null,
    el(
      'div',
      { class: 'menu__date' },
      el('input', {
        type: 'date',
        'aria-label': 'Snooze until a specific date',
        ref: (node: HTMLInputElement | null) => {
          dateInput = node;
        },
      }),
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          onClick: () => {
            if (dateInput?.value) handlers.onAction(item.id, 'snooze', { until: dateInput.value });
          },
        },
        'Set',
      ),
    ),
  );
}

function addDays(from: Date, days: number): string {
  return localDateKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

/**
 * The same day some months ahead, clamped to the end of a short month.
 *
 * The clamp is the whole reason this isn't a one-liner: `new Date(y, m + 1, 31)`
 * for the 31st of January is the 3rd of March, because the day overflows February
 * and rolls on. A park set from the last day of a long month would quietly land
 * days into the month after the one it named.
 */
function addMonths(from: Date, months: number): string {
  const target = new Date(from.getFullYear(), from.getMonth() + months, 1);
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(from.getDate(), lastDay));
  return localDateKey(target);
}
