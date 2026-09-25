/** A titled list, and the folded kind. Shared by the brief and both boards. */

import type { JSX } from 'preact';

import type { DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { sourceColor } from './items.ts';
import type { Handlers, UiState } from './types.ts';

export type RowRenderer<T> = (row: T, state: DashboardState, ui: UiState, handlers: Handlers) => JSX.Element;

/** A titled list. `row` renders one entry: a brief item, a pull request, a ticket. */
export function section<T extends { id: string }>(
  title: string,
  items: readonly T[],
  state: DashboardState,
  ui: UiState,
  handlers: Handlers,
  source: string | null,
  row: RowRenderer<T>,
): JSX.Element {
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section__header' },
      source
        ? el('span', {
            class: 'section__dot',
            style: `background:${sourceColor(source)}`,
            'aria-hidden': 'true',
          })
        : null,
      el('h2', { class: 'section__title' }, title),
      el('span', { class: 'section__count' }, String(items.length)),
    ),
    el(
      'ul',
      { class: 'list' },
      items.map((item) => row(item, state, ui, handlers)),
    ),
  );
}

/**
 * A collapsed list, closed until somebody opens it.
 *
 * Whether it is open is kept in `ui.openDrawers` under `key`, and the element is
 * told so on every render. The element would remember on its own now that a
 * render keeps it, but a drawer that came and went — parked rows appearing after
 * a refresh — would come back shut, and the keyboard's scan of visible rows reads
 * the same fact off the element. One place to keep it is the page's.
 */
export function drawer<T extends { id: string }>(
  key: string,
  title: string,
  items: readonly T[],
  state: DashboardState,
  ui: UiState,
  handlers: Handlers,
  row: RowRenderer<T>,
): JSX.Element {
  return el(
    'details',
    {
      class: 'drawer',
      open: ui.openDrawers.value.has(key),
      onToggle: (event: Event) => handlers.toggleDrawer(key, (event.currentTarget as HTMLDetailsElement).open),
    },
    el('summary', null, title),
    el(
      'ul',
      { class: 'list' },
      items.map((item) => row(item, state, ui, handlers)),
    ),
  );
}
