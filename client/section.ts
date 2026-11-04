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
 * A list that folds, closed until somebody opens it, or with `open`, open until
 * somebody closes it.
 *
 * Whether it is open is kept in `ui.drawers` under `key`, and the element is
 * told so on every render. The element would remember on its own now that a
 * render keeps it, but a drawer that came and went — snoozed rows appearing after
 * a refresh — would come back as it started, and the keyboard's scan of visible
 * rows reads the same fact off the element. One place to keep it is the page's.
 */
export function drawer<T extends { id: string }>(
  key: string,
  title: string,
  items: readonly T[],
  state: DashboardState,
  ui: UiState,
  handlers: Handlers,
  row: RowRenderer<T>,
  { open: byDefault = false }: { open?: boolean } = {},
): JSX.Element {
  const open = ui.drawers.value.get(key) ?? byDefault;
  // Headed as a section is, its count beside its name, and ruled across to a
  // verb that says what a click does: folded, it is still plainly something to open.
  return el(
    'details',
    {
      class: 'drawer',
      open,
      // A drawer rendered open says so with a toggle too. Only a click changes
      // anything: what the render set is already what the page has.
      onToggle: (event: Event) => {
        const shown = (event.currentTarget as HTMLDetailsElement).open;
        if (shown !== open) handlers.toggleDrawer(key, shown);
      },
    },
    el(
      'summary',
      null,
      el('span', { class: 'drawer__title' }, title),
      el('span', { class: 'drawer__count' }, String(items.length)),
      el('span', { class: 'drawer__rule', 'aria-hidden': 'true' }),
      // The element says whether it is open; the verb is for the eye.
      el('span', { class: 'drawer__verb', 'aria-hidden': 'true' }, open ? 'Hide' : 'Show'),
    ),
    el(
      'ul',
      { class: 'list' },
      items.map((item) => row(item, state, ui, handlers)),
    ),
  );
}
