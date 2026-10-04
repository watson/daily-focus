/**
 * A read that keeps failing, as both boards and the agenda show it.
 *
 * One line, as it always was, and behind a click what lay under it: how long it
 * has been failing, how old what's on screen is, when the poller tries again by
 * itself, and what the error actually said — with a way to try now. A fold
 * rather than more lines, so a failure costs the page nothing more until
 * somebody asks.
 *
 * Whether it is open is kept with the drawers', under `fold`, for the reason a
 * drawer's is: the retry it offers can rebuild the element while the answer is
 * on its way, and an answer that lands folded shut has to be asked for twice.
 */

import type { JSX } from 'preact';

import type { ReadFailure } from '../src/types.ts';
import { el } from './el.ts';
import { daysFromToday, formatShortDay, formatTime } from './format.ts';
import type { Handlers, UiState } from './types.ts';

export interface FailureNoticeOptions {
  /** The key its open state is kept under. Stable across attempts. */
  fold: string;
  /** The strip's own classes: a banner's, or the agenda note's. */
  className: string;
  /** The banner's icon. The agenda's notes have none. */
  icon?: string;
  /** When the last good read was, which is how old what's on screen is. Null when there has never been one. */
  lastGood: string | null;
  now: Date;
  onRetry: () => void;
}

export function failureNotice(
  failure: ReadFailure,
  { fold, className, icon, lastGood, now, onRetry }: FailureNoticeOptions,
  ui: UiState,
  handlers: Handlers,
): JSX.Element {
  return el(
    'details',
    {
      class: `${className} failure`,
      open: ui.openDrawers.value.has(fold),
      onToggle: (event: Event) => handlers.toggleDrawer(fold, (event.currentTarget as HTMLDetailsElement).open),
    },
    el(
      'summary',
      { class: 'failure__summary', title: 'Show what went wrong' },
      icon ? el('span', { class: 'banner__icon', 'aria-hidden': 'true' }, icon) : null,
      // Plain text, never Markdown: it quotes what GitHub, acli and macOS said.
      el('span', { class: 'failure__message' }, failure.message),
    ),
    el(
      'div',
      { class: 'failure__body' },
      el(
        'p',
        { class: 'failure__facts' },
        el('span', null, failureFacts(failure, lastGood, now)),
        el(
          'button',
          {
            type: 'button',
            class: 'button failure__retry',
            'aria-busy': String(failure.retrying),
            // Not disabled, as the refresh button isn't: a click mid-attempt is ignored instead.
            onClick: () => {
              if (!failure.retrying) onRetry();
            },
          },
          failure.retrying ? 'Retrying…' : 'Retry now',
        ),
      ),
      failure.detail ? el('pre', { class: 'failure__detail' }, failure.detail) : null,
    ),
  );
}

/** "Failing since 09:14 · 4 attempts · last good read 09:12 · next try 10:30". */
export function failureFacts(failure: ReadFailure, lastGood: string | null, now: Date): string {
  const bits =
    failure.attempts > 1
      ? [`Failing since ${when(failure.since, now)}`, `${failure.attempts} attempts`]
      : [`Failed at ${when(failure.since, now)}`];
  bits.push(lastGood ? `last good read ${when(lastGood, now)}` : 'nothing read yet');
  if (failure.retrying) bits.push('trying again now');
  else if (failure.retryAt) bits.push(`next try ${when(failure.retryAt, now)}`);
  return bits.join(' · ');
}

/** A time, with its day when that isn't today: an outage can outlast one. */
function when(value: string, now: Date): string {
  const days = daysFromToday(value, now);
  if (days === 0) return formatTime(value);
  return `${days === -1 ? 'yesterday' : days === 1 ? 'tomorrow' : formatShortDay(value)} ${formatTime(value)}`;
}
