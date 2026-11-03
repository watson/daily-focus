/**
 * The done check's line on a ticket: whether its pull requests finish it, as
 * the assistant judged, when, and Check now. On the ticket board's rows and on
 * the Projects view's cards alike. See `src/donecheck.ts`.
 *
 * Advice, in the quiet voice the answers asked ahead use: the line is all that
 * changes. The row isn't moved, hidden or marked, its status isn't touched, and
 * Move to Done stays a click on the status.
 */

import type { JSX } from 'preact';

import type { DoneCheckState, DoneCheckTicket, DoneVerdict } from '../src/types.ts';
import { el } from './el.ts';
import { formatTime, relativeTime } from './format.ts';
import type { Handlers, UiState } from './types.ts';

/** What a verdict says first, before its line. */
export const VERDICT_TEXT: Readonly<Record<DoneVerdict, string>> = {
  complete: 'Looks complete',
  'work-left': 'Work left',
  unclear: 'Can’t tell',
};

/** The pending key a Check now waits under: its own, so the row's other buttons stay live. */
export function checkPending(key: string): string {
  return `donecheck:${key.toUpperCase()}`;
}

/** What the line needs to offer Check now; null where nothing on the page may start one. */
export interface CheckControls {
  ui: UiState;
  handlers: Handlers;
}

/**
 * The line for one ticket, or null when the check has nothing to say about it:
 * it has no pull requests, or the server is older than the page.
 */
export function doneCheckLine(key: string, checks: DoneCheckState | undefined | null, now: Date, controls: CheckControls | null): JSX.Element | null {
  const entry = checks?.tickets?.[key.toUpperCase()];
  if (!checks || !entry) return null;
  const mark = el('span', { class: 'item__ahead-mark', 'aria-hidden': 'true' }, '✦');
  const button = checkButton(key, checks, entry, controls);

  if (entry.running) {
    return line('running', mark, [entry.running.by === 'click' ? 'Checking whether its pull requests finish it…' : 'Checking on its own whether its pull requests finish it…'], null, true);
  }

  if (entry.verdict) {
    const { verdict } = entry;
    const parts: (string | JSX.Element)[] = [
      el('strong', { class: 'item__check-verdict' }, VERDICT_TEXT[verdict.verdict]),
      verdict.line && verdict.verdict !== 'complete' ? `: ${verdict.line}` : '',
      ` · checked ${relativeTime(verdict.at, now)}`,
    ];
    if (!verdict.current) parts.push(' · from before the latest change');
    if (entry.failure && entry.failure.at > verdict.at) parts.push(el('span', { title: entry.failure.error }, ' · checking again failed'));
    else if (!verdict.current) parts.push(...settling(checks, entry));
    return line(verdict.verdict, mark, parts, button, false, verdict.current ? null : 'stale');
  }

  if (entry.failure) {
    return line('failed', mark, [`Couldn’t check whether its pull requests finish it: ${entry.failure.error}`, ` · ${relativeTime(entry.failure.at, now)}`], button, true);
  }

  if (!entry.checkable) return null;
  return line('none', mark, ['Not checked yet whether its pull requests finish it', ...settling(checks, entry)], button, true);
}

/** When it checks again on its own, or why it won't today. Nothing when it won't on its own at all. */
function settling(checks: DoneCheckState, entry: DoneCheckTicket): string[] {
  if (!checks.auto || !entry.dueAt) return [];
  if (checks.usedToday >= checks.limit) return [` · today’s ${checks.limit} checks are used`];
  return [` · checks on its own around ${formatTime(entry.dueAt)}, once it has settled`];
}

function checkButton(key: string, checks: DoneCheckState, entry: DoneCheckTicket, controls: CheckControls | null): JSX.Element | null {
  if (!controls || !checks.enabled || !entry.checkable || entry.running) return null;
  const pending = controls.ui.pending.value.has(checkPending(key));
  const again = entry.verdict !== null || entry.failure !== null;
  return el(
    'button',
    {
      type: 'button',
      class: 'link-button item__check-now',
      disabled: pending,
      title: `Have the assistant read ${key} and its pull requests now`,
      onClick: () => controls.handlers.checkTicket(key),
    },
    again ? 'Check again' : 'Check now',
  );
}

function line(
  status: string,
  mark: JSX.Element,
  parts: (string | JSX.Element)[],
  button: JSX.Element | null,
  quiet: boolean,
  age: 'stale' | null = null,
): JSX.Element {
  return el(
    'p',
    {
      class: `item__ahead item__check${quiet ? ' item__ahead--quiet' : ''}`,
      'data-status': status === 'running' ? 'running' : undefined,
      'data-verdict': status,
      'data-age': age ?? undefined,
    },
    mark,
    parts,
    button ? [' ', button] : null,
  );
}
