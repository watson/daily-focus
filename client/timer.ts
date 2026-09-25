/** The focus session: the strip under the header, and the arithmetic the rows share. */

import type { JSX } from 'preact';

import type { ActiveSession, DashboardState, UnattendedClose } from '../src/types.ts';
import { el } from './el.ts';
import { formatDuration, formatTime } from './format.ts';
import type { Handlers, UiState } from './types.ts';

/** mm:ss, counting up once the target has passed. */
export function clock(seconds: number): string {
  const total = Math.abs(seconds);
  const mm = Math.floor(total / 60);
  const ss = Math.floor(total % 60);
  return `${seconds < 0 ? '+' : ''}${mm}:${String(ss).padStart(2, '0')}`;
}

/**
 * Seconds left in the session at `nowMs`, negative once the target has passed.
 *
 * Derived from the server's `endsAt` and a wall clock, never accumulated: a
 * background tab gets its timers throttled, so counting ticks would drift badly
 * over 25 minutes while reading a wall clock stays exact.
 */
export function remainingSeconds(active: Pick<ActiveSession, 'endsAt'>, nowMs: number): number {
  return Math.round((new Date(active.endsAt).getTime() - nowMs) / 1000);
}

/**
 * Own up to a session the dashboard stopped by itself.
 *
 * This is the whole reason the auto-stop is safe to have: the failure it replaces
 * wasn't really "the timer kept running", it was "something silently wrote down a
 * number nobody checked". So say what was recorded, say where it stopped, and make
 * the correction one keypress away — coming back to the desk is exactly the moment
 * they can still remember what actually happened.
 */
function unattendedNotice(closed: UnattendedClose, handlers: Handlers): JSX.Element {
  const stoppedAt = formatTime(closed.endedAt);
  const headline =
    closed.reason === 'away'
      ? `Timer stopped at ${stoppedAt} — nothing had touched the machine since.`
      : `Timer stopped at ${stoppedAt} — it had been left running.`;

  return el(
    'div',
    { class: 'timer__away', role: 'status' },
    el(
      'span',
      { class: 'timer__away-body' },
      el('span', { class: 'timer__away-text' }, headline),
      el(
        'span',
        { class: 'timer__away-detail' },
        `${formatDuration(closed.actualMinutes)} logged on “${closed.title}”. `,
        closed.reason === 'away'
          ? 'The time you were away is not in the record.'
          : 'Treat that as an upper bound, not a measurement.',
      ),
    ),
    el('button', { type: 'button', class: 'button', onClick: () => handlers.startSession(closed.id) }, 'Pick it back up'),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': 'Dismiss',
        onClick: () => handlers.dismissUnattended(closed.endedAt),
      },
      '✕',
    ),
  );
}

/**
 * The running session, pinned under the header so it survives focus mode.
 *
 * Shown when something is running, or when there's a tally worth seeing. Hidden
 * entirely on a day with neither, since an idle timer is just furniture. A
 * component of its own so that the clock, which ticks every second, reruns this
 * and nothing else.
 */
export function Timer({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element {
  const { active, completedToday, minutesToday, unattendedClose } = state.session;
  const closed =
    unattendedClose && ui.unattendedSeen.value !== unattendedClose.endedAt ? unattendedClose : null;

  if (!active && completedToday === 0 && !closed) {
    return el('div', { class: 'timer', id: 'timer', hidden: true });
  }

  const tally =
    completedToday > 0
      ? `${completedToday} session${completedToday === 1 ? '' : 's'} today · ${formatDuration(minutesToday)}`
      : null;

  if (!active) {
    return el(
      'div',
      { class: 'timer', id: 'timer', hidden: false, 'data-state': closed ? 'stopped' : 'idle' },
      closed ? unattendedNotice(closed, handlers) : null,
      tally ? el('span', { class: 'timer__tally' }, tally) : null,
    );
  }

  const remaining = remainingSeconds(active, ui.clock.value);
  const overrun = remaining < 0;
  return el(
    'div',
    { class: 'timer', id: 'timer', hidden: false, 'data-state': overrun ? 'overrun' : 'running' },
    el('span', { class: 'timer__clock' }, clock(remaining)),
    el(
      'span',
      { class: 'timer__title' },
      active.title,
      overrun ? el('span', { class: 'timer__note' }, ` · ${active.minutes} min in, still counting`) : null,
      // The one thing a kitchen timer can't tell you.
      active.collidesWithNextEvent && !overrun
        ? el('span', { class: 'timer__note timer__note--warn' }, ` · runs into ${formatTime(active.nextEventAt)}`)
        : null,
    ),
    tally ? el('span', { class: 'timer__tally' }, tally) : null,
    el('button', { type: 'button', class: 'button', onClick: () => handlers.stopSession() }, 'Stop'),
  );
}
