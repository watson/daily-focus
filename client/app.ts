/**
 * The page. One component describes all of it, and Preact keeps the document
 * matching: a state push reruns this, and only what changed is touched.
 *
 * Only the showing view is built. The other panels are left empty rather than
 * hidden, so switching tabs builds a view the moment it's looked at, and never
 * for a panel nobody can see.
 */

import { h, type JSX } from 'preact';

import { renderAgenda } from './agenda.ts';
import { renderBanners } from './banners.ts';
import { BoardView } from './board.ts';
import { Header, HelpDialog, Tabs } from './chrome.ts';
import { el } from './el.ts';
import { Flyout } from './flyout.ts';
import { detailRow, detailRun, state } from './state.ts';
import { TicketsView } from './tickets.ts';
import { Timer } from './timer.ts';
import { TodayView } from './today.ts';
import type { Handlers, UiState } from './types.ts';

export function App({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element[] {
  const current = state.value;
  const view = ui.view.value;
  const run = current ? detailRun(current, ui) : null;
  const row = current && !run ? detailRow(current, ui) : null;

  return [
    el('a', { class: 'skip-link', href: '#main' }, 'Skip to content'),
    h(Header, { state: current, ui, handlers }),
    h(Tabs, { state: current, ui, handlers }),
    current ? h(Timer, { state: current, ui, handlers }) : el('div', { class: 'timer', id: 'timer', hidden: true }),
    el('div', { id: 'banners', class: 'banners' }, current ? renderBanners(current, ui, handlers) : null),
    el(
      'main',
      { id: 'main', class: 'layout' },
      el(
        'div',
        { class: 'layout__main' },
        el(
          'div',
          { id: 'today', role: 'tabpanel', 'aria-labelledby': 'tab-today' },
          current && view === 'today' ? h(TodayView, { state: current, ui, handlers }) : null,
        ),
        el(
          'div',
          { id: 'board', role: 'tabpanel', 'aria-labelledby': 'tab-board' },
          current && view === 'board' ? h(BoardView, { state: current, ui, handlers }) : null,
        ),
        el(
          'div',
          { id: 'tickets', role: 'tabpanel', 'aria-labelledby': 'tab-tickets' },
          current && view === 'tickets' ? h(TicketsView, { state: current, ui, handlers }) : null,
        ),
      ),
      el(
        'aside',
        { class: 'layout__side', 'aria-label': "Today's agenda" },
        el('div', { id: 'agenda' }, current && view === 'today' ? renderAgenda(current) : null),
      ),
      current
        ? h(Flyout, { row, run, state: current, ui, handlers })
        : el('aside', { class: 'flyout', id: 'flyout', 'aria-label': 'Item details', hidden: true }),
    ),
    h(Toast, { ui, handlers }),
    h(HelpDialog, {}),
  ];
}

/** The one-line notice at the foot of the page, with its Undo when there is one. */
function Toast({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element {
  const toast = ui.toast.value;
  return el(
    'div',
    { class: 'toast', id: 'toast', role: 'status', 'aria-live': 'polite', hidden: !toast },
    toast?.message,
    toast?.onUndo
      ? el(
          'button',
          {
            type: 'button',
            onClick: () => {
              handlers.hideToast();
              toast.onUndo?.();
            },
          },
          'Undo',
        )
      : null,
  );
}
