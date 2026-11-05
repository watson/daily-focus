/**
 * A write that a row's button asked for and didn't get, as a note on the row's
 * card.
 *
 * The note stays where the click was made, on the card the write was for,
 * wherever that card is drawn: the board, the ticket board, a project's card or
 * Do next, and the panel. It says what couldn't be done, when, and why, in the
 * words of whoever said no, then offers to try again or put it away. It goes by
 * itself once the write goes through, or once the row shows that what it tried
 * has happened anyway: in the merge queue, no longer a draft, already in that
 * status. A toast points to it when it isn't where the keyboard already is.
 */

import { h, type JSX } from 'preact';
import { useId } from 'preact/hooks';

import type { BoardRow, DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { when } from './failure.ts';
import { ticketByKey } from './state.ts';
import { canMoveTo } from './tickets.ts';
import type { Handlers, UiState, WriteFailure } from './types.ts';

/** The pull request row a failure is kept under, while the board shows it. */
function pullRow(id: string, state: DashboardState): BoardRow | undefined {
  return state.board?.rows?.find((row) => row.id === id);
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether the row now shows that what failed has happened all the same: the
 * write landed though the answer was lost, or it was done another way. Then the
 * note would contradict the card, and it goes.
 */
export function failureMoot(id: string, failure: WriteFailure, state: DashboardState): boolean {
  const retry = failure.retry;
  if (retry.kind === 'move') {
    const ticket = ticketByKey(state, retry.key);
    return ticket !== null && same(ticket.workflowStatus, retry.status);
  }
  const row = pullRow(id, state);
  if (!row) return false;
  if (retry.kind === 'ready') return !row.isDraft;
  if (retry.kind === 'draft') return row.isDraft;
  return Boolean(row.inMergeQueue || row.helperQueued);
}

/**
 * Whether the card would still offer what failed, so Try again asks only for
 * what its own button or menu would: the row still offers that merge, or the
 * status menu still offers that status.
 */
export function retryOffered(id: string, failure: WriteFailure, state: DashboardState): boolean {
  const retry = failure.retry;
  if (retry.kind === 'move') {
    const ticket = ticketByKey(state, retry.key);
    return ticket !== null && canMoveTo(ticket, retry.status, state);
  }
  const row = pullRow(id, state);
  if (!row || row.status !== 'open') return false;
  const offers = row.offers ?? [];
  if (retry.kind === 'merge') return offers.includes(retry.route) && Boolean(row.headSha);
  if (retry.kind === 'stack') return offers.includes('stack');
  return offers.includes(retry.kind);
}

/** "at 09:46", or "3 attempts · last at 09:52" once it has failed more than once. */
export function attemptText(failure: WriteFailure, now: Date): string {
  const at = when(failure.at, now);
  return failure.attempts > 1 ? `${failure.attempts} attempts · last at ${at}` : `at ${at}`;
}

/** The attribute a note is found by, for the toast's Show and for the keyboard after a failure. */
export const FAILURE_ATTR = 'data-failure-for';

/** What a note sits in, for keeping the keyboard's place when it goes. */
export const NOTE_CARD = '[data-id], .project-pull, .next-step';

/**
 * The note on a card about the write that failed on row `id`, or null when
 * there is none, or it no longer holds.
 */
export function writeFailureNote(id: string, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element | null {
  const failure = ui.writeFailures.value.get(id);
  if (!failure || failureMoot(id, failure, state)) return null;
  return h(WriteFailureNote, {
    id,
    failure,
    now: new Date(state.now),
    pending: ui.pending.value.has(id),
    offered: retryOffered(id, failure, state),
    handlers,
  });
}

interface NoteProps {
  id: string;
  failure: WriteFailure;
  now: Date;
  pending: boolean;
  offered: boolean;
  handlers: Handlers;
}

function WriteFailureNote({ id, failure, now, pending, offered, handlers }: NoteProps): JSX.Element {
  // Per copy drawn: the same row can be on a card and in the panel at once.
  const own = useId();
  return el(
    'div',
    {
      class: 'write-failure',
      [FAILURE_ATTR]: id,
      // Where the keyboard goes after a failure, and from the toast's Show; not a tab stop.
      tabIndex: -1,
      role: 'group',
      'aria-labelledby': `${own}-head`,
      'aria-describedby': `${own}-why`,
    },
    el(
      'p',
      { class: 'write-failure__head', id: `${own}-head` },
      el('span', { class: 'write-failure__icon', 'aria-hidden': 'true' }, '!'),
      // One run of text, so a narrow card wraps it as a sentence.
      el(
        'span',
        { class: 'write-failure__title' },
        el('span', { class: 'write-failure__headline' }, failure.headline),
        ' ',
        el('span', { class: 'write-failure__when' }, attemptText(failure, now)),
      ),
    ),
    // The reason before the buttons, to the eye and to a screen reader alike.
    // Plain text, never Markdown: it quotes what GitHub, Jira or the helper said.
    el('p', { class: 'write-failure__message', id: `${own}-why` }, failure.message),
    el(
      'div',
      { class: 'write-failure__actions' },
      offered
        ? el(
            'button',
            {
              type: 'button',
              class: 'button',
              disabled: pending,
              'aria-busy': pending ? 'true' : undefined,
              onClick: () => handlers.retryWrite(id),
            },
            pending ? 'Trying…' : 'Try again',
          )
        : null,
      el(
        'button',
        {
          type: 'button',
          class: 'button write-failure__dismiss',
          title: 'Put this note away',
          onClick: (event: MouseEvent) => {
            // The button goes with the note; the card's own link keeps the place.
            const card = (event.currentTarget as Element).closest(NOTE_CARD);
            handlers.dismissWriteFailure(id);
            card?.querySelector<HTMLElement>('a[href]')?.focus();
          },
        },
        'Dismiss',
      ),
    ),
  );
}
