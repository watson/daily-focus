/** Today's agenda, in the pane beside the list, and the stat it lends the top of the page. */

import type { JSX } from 'preact';

import type { Agenda, AgendaSource, DashboardState, FreeWindow, ResolvedItem } from '../src/types.ts';
import { el } from './el.ts';
import { formatDuration, formatTime } from './format.ts';

export function renderAgenda(state: DashboardState): JSX.Element {
  const now = new Date(state.now);
  const { events, conflictIds, freeWindows } = state.agenda;

  type Entry = { at: number; node: JSX.Element };
  const entries: Entry[] = [
    ...events.map((event) => ({ at: new Date(event.start ?? '').getTime(), node: eventRow(event, now, conflictIds) })),
    ...freeWindows.map((window) => ({ at: new Date(window.start).getTime(), node: freeRow(window) })),
  ].sort((a, b) => a.at - b.at);

  const rows: JSX.Element[] = [];
  let nowPlaced = false;
  for (const entry of entries) {
    if (!nowPlaced && entry.at > now.getTime()) {
      rows.push(nowRow(now));
      nowPlaced = true;
    }
    rows.push(entry.node);
  }
  if (!nowPlaced && entries.length > 0) rows.push(nowRow(now));

  return el(
    'div',
    { class: 'agenda' },
    el('h2', { class: 'agenda__title' }, 'Today'),
    agendaNotes(state.agendaSource),
    rows.length > 0 ? el('ul', { class: 'agenda__list' }, rows) : el('p', { class: 'empty' }, 'No events today.'),
  );
}

/**
 * Why this agenda says what it says, when that isn't simply "the calendar".
 *
 * Kept inside the pane rather than in the page banners on purpose: it is about
 * these rows, and a global banner for a stale calendar would compete with the
 * ones about the brief. But it is never silent when the source isn't live — an
 * agenda quietly served from this morning looks exactly like a live one right up
 * to the event you cancelled still sitting on it.
 */
function agendaNotes(source: AgendaSource | null | undefined): JSX.Element[] {
  if (!source) return [];
  const notes: JSX.Element[] = [];
  if (source.problem) {
    notes.push(el('p', { class: `agenda__note agenda__note--${source.live ? 'warn' : 'stale'}` }, source.problem));
  }
  for (const warning of source.warnings ?? []) {
    notes.push(el('p', { class: 'agenda__note agenda__note--warn' }, warning));
  }
  return notes;
}

export function eventRow(event: ResolvedItem, now: Date, conflictIds: readonly string[]): JSX.Element {
  const start = new Date(event.start ?? '');
  const end = event.end ? new Date(event.end) : null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start ?? '');
  const past = (end ?? start).getTime() < now.getTime();
  const clashes = conflictIds.includes(event.id);
  // Only an explicit false frees the slot, which is the reading `agenda.ts` gives
  // the same field when it works out what the day has left.
  const blocking = event.blocking !== false;

  const name = event.url
    ? el('a', { href: event.url, target: '_blank', rel: 'noopener noreferrer' }, event.title)
    : event.title;

  // Said in words and not only in ink, for the reason the palette gives at the top
  // of the stylesheet. Folded into the "until" line rather than added beneath it: a
  // row that grows a third line to announce it wants less attention has taken more.
  const until = !allDay && end ? `until ${formatTime(event.end)}` : null;
  const sub = blocking ? until : [until, 'marked free'].filter(Boolean).join(' · ');

  return el(
    'li',
    { class: 'agenda__row', 'data-past': String(past), 'data-blocking': String(blocking) },
    el('span', { class: 'agenda__time' }, allDay ? 'all day' : formatTime(event.start)),
    el(
      'span',
      { class: 'agenda__name' },
      name,
      clashes ? el('span', { class: 'agenda__sub' }, '⚠ clashes with another event') : null,
      sub ? el('span', { class: 'agenda__sub' }, sub) : null,
    ),
  );
}

function freeRow(window: FreeWindow): JSX.Element {
  return el(
    'li',
    { class: 'agenda__row agenda__row--free' },
    el('span', { class: 'agenda__time' }, formatTime(window.start)),
    el(
      'span',
      { class: 'agenda__name' },
      `Free · ${formatDuration(window.minutes)}`,
      el('span', { class: 'agenda__sub' }, `until ${formatTime(window.end)}`),
    ),
  );
}

function nowRow(now: Date): JSX.Element {
  return el(
    'li',
    { class: 'agenda__row agenda__row--now', 'aria-hidden': 'true' },
    el('span', { class: 'agenda__now-label' }, formatTime(now.toISOString())),
    el('span', { class: 'agenda__now-line' }),
  );
}

/** One tile in the strip under the objective. */
export function stat(label: string, value: string | number, tone: string | null, footnote?: string | null): JSX.Element {
  return el(
    'div',
    { class: 'stat' },
    el('p', { class: 'stat__label' }, label),
    el('p', { class: 'stat__value', 'data-tone': tone ?? undefined }, String(value)),
    footnote ? el('p', { class: 'stat__footnote', title: footnote }, footnote) : null,
  );
}

/**
 * The next timed event that hasn't started, or the one running now. All-day
 * events are skipped: they are context, not something to be somewhere for.
 */
export function nextEventStat(agenda: Pick<Agenda, 'events'>, now: Date): JSX.Element {
  const timed = agenda.events
    .filter((event) => !/^\d{4}-\d{2}-\d{2}$/.test(event.start ?? ''))
    .map((event) => ({ event, start: new Date(event.start ?? '').getTime(), end: eventEnd(event) }))
    .filter((entry) => entry.end > now.getTime())
    .sort((a, b) => a.start - b.start);
  const next = timed[0];
  if (!next) return stat('Next event', 'None today', null, null);
  if (next.start <= now.getTime()) return stat('Next event', 'Now', null, next.event.title);
  const minutes = Math.round((next.start - now.getTime()) / 60_000);
  return stat('Next event', `in ${formatDuration(Math.max(minutes, 1))}`, null, next.event.title);
}

/** An event's end in ms, assuming the same half hour `agenda.ts` gives an open-ended one. */
function eventEnd(event: ResolvedItem): number {
  const start = new Date(event.start ?? '').getTime();
  const end = event.end ? new Date(event.end).getTime() : NaN;
  return Number.isFinite(end) && end > start ? end : start + 30 * 60_000;
}
