/** The refresh control both boards put in the page header. */

import type { JSX } from 'preact';

import { el } from './el.ts';
import { formatTime } from './format.ts';

export interface RefreshControl {
  source: string;
  fetchedAt: string | null;
  status: string;
  fetching: boolean;
  stale: boolean;
  action: string;
  onRefresh: () => void;
}

/**
 * Which source a board reads and when it last did, then an icon that spins
 * while a read is in flight, with the rest of the status in its tooltip.
 *
 * The source is named in words because the slot is shared. The header's right
 * side belongs to whichever tab is showing — the brief's age on Today — and an
 * unlabelled icon there reads as refreshing everything, when it only ever asks
 * the one source behind this tab.
 *
 * The button is never `disabled`, because a disabled button swallows the hover
 * that carries the detail; a click mid-read is ignored instead.
 */
export function refreshControl({ source, fetchedAt, status, fetching, stale, action, onRefresh }: RefreshControl): JSX.Element[] {
  const label = `${status} — ${action}`;
  // The last good read stays on screen during a new one; the icon says it is
  // reading. Only a board with nothing read yet has no time to show.
  const when = fetchedAt ? formatTime(fetchedAt) : fetching ? 'reading…' : 'not read yet';
  return [
    el(
      'span',
      {
        class: 'refresh-label',
        'data-stale': String(stale),
        // The button's label says all of this and more; read once, not twice.
        'aria-hidden': 'true',
      },
      `${source} · ${when}`,
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button refresh-button',
        title: label,
        'aria-label': label,
        'aria-busy': String(fetching),
        'data-fetching': String(fetching),
        'data-stale': String(stale),
        onClick: () => {
          if (!fetching) onRefresh();
        },
      },
      // Drawn by the stylesheet as a mask, so the same icon serves every board.
      el('span', { class: 'refresh-button__icon', 'aria-hidden': 'true' }),
    ),
  ];
}
