/** The Today tab: the objective, the numbers, the headline, and the brief itself. */

import type { JSX } from 'preact';

import type { Agenda, DashboardState, ObjectiveProgress, ResolvedItem } from '../src/types.ts';
import { nextEventStat, stat } from './agenda.ts';
import { el } from './el.ts';
import { daysFromToday, formatDuration } from './format.ts';
import { SOURCE_LABEL, SOURCE_ORDER, renderItem } from './items.ts';
import { renderMarkdown } from './markdown.ts';
import { drawer, section } from './section.ts';
import type { Handlers, UiState } from './types.ts';

export function TodayView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  return [
    el(
      'p',
      { class: 'focus-bar', id: 'focus-bar', hidden: !ui.focusMode.value },
      'Focus mode — everything but the top item is hidden. ',
      el('button', { type: 'button', class: 'button', id: 'focus-exit', onClick: () => handlers.setFocusMode(false) }, 'Show everything'),
    ),
    renderObjective(state),
    renderStats(state),
    renderHeadline(state),
    renderSections(state, ui, handlers),
  ];
}

/* ---------- standing objective ---------- */

/**
 * The one thing on this page that isn't about what arrived overnight. It sits
 * above the stats deliberately: the point is that you read it before you read
 * the list of things other people want.
 */
export function renderObjective(state: Pick<DashboardState, 'focus'>): JSX.Element {
  const focus = state.focus;

  // No focus.md at all means the feature is off, not forgotten: show nothing.
  if (!focus) {
    return el('section', { class: 'objective', id: 'objective', 'aria-label': 'Current objective', hidden: true });
  }

  // A blank objective is a normal stretch between objectives, not a failure, so
  // the reminder is quiet rather than a banner.
  if (!focus.objective) {
    return el(
      'section',
      { class: 'objective objective--empty', id: 'objective', 'aria-label': 'Current objective', hidden: false },
      el('p', { class: 'objective__label' }, 'No current objective'),
      el(
        'p',
        { class: 'objective__note' },
        'Set ',
        el('code', null, 'objective:'),
        ' in ',
        el('code', null, 'focus.md'),
        ' in your store to have the day ranked against it.',
      ),
    );
  }

  return el(
    'section',
    { class: 'objective', id: 'objective', 'aria-label': 'Current objective', hidden: false },
    el('p', { class: 'objective__label' }, 'Current objective'),
    el('p', { class: 'objective__text' }, renderMarkdown(focus.objective)),
    focus.blocker
      ? el(
          'p',
          { class: 'objective__blocker' },
          el('span', { class: 'objective__blocker-label' }, 'Blocked on: '),
          renderMarkdown(focus.blocker),
        )
      : null,
    focus.note ? el('p', { class: 'objective__note' }, renderMarkdown(focus.note)) : null,
  );
}

/* ---------- stats ---------- */

export function renderStats(state: DashboardState): JSX.Element {
  const { open, completedToday, overdue } = state.stats;
  return el(
    'section',
    { class: 'stats', id: 'stats', 'aria-label': 'Today at a glance' },
    objectiveStat(state.objectiveProgress),
    focusTimeStat(state.agenda, new Date(state.now)),
    stat('Needs action', open, null),
    stat('Overdue', overdue, overdue > 0 ? 'critical' : null),
    stat('Cleared today', completedToday, completedToday > 0 ? 'good' : null),
  );
}

/**
 * Unbooked time between now and the end of the working day.
 *
 * A list of open items reads identically whether six hours remain or forty
 * minutes, which is precisely when it misleads. This is the number that decides
 * whether today's plan is possible.
 *
 * When free time isn't tracked (the personal profile's default: an evening at home
 * has no end to count down to), the slot shows the next timed event instead. That
 * is the one time-shaped fact the agenda still knows for certain.
 */
function focusTimeStat(agenda: Agenda, now: Date): JSX.Element {
  if (!agenda.tracksFreeTime) return nextEventStat(agenda, now);
  const minutes = agenda.remainingFocusMinutes;
  const tone = minutes === 0 ? 'critical' : minutes < 60 ? 'critical' : null;
  return stat('Focus time left', minutes === 0 ? 'None' : formatDuration(minutes), tone, `Day ends ${agenda.dayEnd}`);
}

/**
 * Working days since the objective last moved — the one number here that isn't
 * about today's inbox. Only shown when focus.md sets an objective.
 */
function objectiveStat(progress: ObjectiveProgress | null): JSX.Element | null {
  if (!progress) return null;

  if (progress.workingDaysSince === null) {
    return stat('Since objective progress', '—', null, 'Nothing recorded yet');
  }

  const days = progress.workingDaysSince;
  const tone = days === 0 ? 'good' : days >= 3 ? 'critical' : null;
  const value = days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`;

  return stat('Since objective progress', value, tone, progress.lastTitle);
}

export function renderHeadline(state: DashboardState): JSX.Element {
  const headline = state.brief.headline;
  return el('p', { class: 'headline', id: 'headline', hidden: !headline }, headline ? renderMarkdown(headline) : null);
}

/* ---------- sections ---------- */

export function renderSections(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  const actionable = state.items.filter((item) => item.kind !== 'event');

  const open = actionable.filter((item) => item.status === 'open');
  const priorities = open
    .filter((item): item is ResolvedItem & { priority: number } => item.priority !== undefined && item.kind === 'task')
    .sort((a, b) => a.priority - b.priority);
  const prioritised = new Set(priorities.map((item) => item.id));

  const sections: JSX.Element[] = [];

  if (priorities.length > 0) {
    sections.push(section('Top priorities', priorities, state, ui, handlers, null, renderItem));
  }

  const tasks = open.filter((item) => item.kind === 'task' && !prioritised.has(item.id));
  for (const source of SOURCE_ORDER) {
    const group = tasks.filter((item) => item.source === source);
    if (group.length > 0) {
      sections.push(section(SOURCE_LABEL[source] ?? 'Other', group, state, ui, handlers, source, renderItem));
    }
  }

  const info = open.filter((item) => item.kind === 'info' && !prioritised.has(item.id));
  if (info.length > 0) {
    sections.push(section('Heads up', info, state, ui, handlers, null, renderItem));
  }

  if (sections.length === 0) {
    sections.push(
      el(
        'p',
        { class: 'empty' },
        state.problem
          ? 'Nothing to show until a brief lands.'
          : state.items.length === 0
            ? 'The brief is empty — nothing needs you today.'
            : 'Everything here is handled. Enjoy the quiet.',
      ),
    );
  }

  const snoozed = actionable.filter((item) => item.status === 'snoozed');
  if (snoozed.length > 0) {
    sections.push(drawer('today:snoozed', `Snoozed (${snoozed.length})`, snoozed, state, ui, handlers, renderItem));
  }

  const now = new Date(state.now);
  const cleared = actionable.filter(
    (item) =>
      (item.status === 'done' || item.status === 'dismissed') &&
      item.statusAt &&
      daysFromToday(item.statusAt, now) === 0,
  );
  if (cleared.length > 0) {
    sections.push(drawer('today:cleared', `Cleared today (${cleared.length})`, cleared, state, ui, handlers, renderItem));
  }

  return el('div', { id: 'sections' }, sections);
}
