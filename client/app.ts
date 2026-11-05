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
import { OnboardingView } from './onboarding.ts';
import { OrganizationReviewDialog } from './organization.ts';
import { SettingsView } from './settings.ts';
import { detailRow, detailRun, panelInProject, state } from './state.ts';
import { TicketsView } from './tickets.ts';
import { TodayView } from './today.ts';
import type { Handlers, UiState } from './types.ts';

export function App({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element[] {
  const current = state.value;
  const view = ui.view.value;
  const run = current ? detailRun(current, ui) : null;
  const row = current && !run ? detailRow(current, ui) : null;

  // A new store is the setup screen and nothing else, until it is set up.
  if (current?.onboarding) {
    return [h(OnboardingView, { state: current, ui, handlers }), h(OrganizationReviewDialog, { ui, handlers }), h(Toast, { ui, handlers })];
  }

  return [
    el('a', { class: 'skip-link', href: '#main' }, 'Skip to content'),
    // The band: the masthead's navy runs behind both, and on Today on behind
    // the objective below (see `.band` in the stylesheet).
    el('div', { class: 'band' }, h(Header, { state: current, ui, handlers }), h(Tabs, { state: current, ui, handlers })),
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
        el(
          'div',
          { id: 'settings', role: 'region', 'aria-label': 'Settings' },
          current && view === 'settings' ? h(SettingsView, { state: current, ui, handlers }) : null,
        ),
      ),
      el(
        'aside',
        { class: 'layout__side', 'aria-label': "Today's agenda" },
        el('div', { id: 'agenda' }, current && view === 'today' ? renderAgenda(current, ui, handlers) : null),
      ),
      // Inside a project, Projects places the panel itself, beside its list.
      current && panelInProject(current, ui)
        ? null
        : current
          ? h(Flyout, { row, run, state: current, ui, handlers })
          : el('aside', { class: 'flyout', id: 'flyout', 'aria-label': 'Item details', hidden: true }),
    ),
    h(OrganizationReviewDialog, { ui, handlers }),
    h(Toast, { ui, handlers }),
    h(HelpDialog, {}),
  ];
}

/**
 * The one-line notice at the foot of the page, with its one button when it has
 * one: Undo, or Show for a write that failed on a row. An error says so with
 * its mark and stays until closed; anything else goes after a few seconds,
 * unless the pointer or the keyboard is on it.
 *
 * What it says is spoken from two live regions that are always on the page and
 * never hidden, polite for a notice and an alert for an error: a region that
 * appears, or changes its role, as it fills is the one screen readers are
 * likeliest to miss. The pill itself is not a live region, so nothing is said
 * twice; its words stay readable beside its buttons.
 */
export function Toast({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element[] {
  const toast = ui.toast.value;
  return [
    el('div', { key: 'status', class: 'visually-hidden', role: 'status' }, toast && !toast.error ? toast.message : ''),
    el('div', { key: 'alert', class: 'visually-hidden', role: 'alert' }, toast?.error ? toast.message : ''),
    el(
      'div',
      {
        key: 'toast',
        class: 'toast',
        id: 'toast',
        'data-error': String(Boolean(toast?.error)),
        hidden: !toast,
        onMouseEnter: () => handlers.holdToast(true),
        onMouseLeave: () => handlers.holdToast(false),
        onFocusIn: () => handlers.holdToast(true),
        onFocusOut: () => handlers.holdToast(false),
      },
      toast?.error ? el('span', { class: 'toast__mark', 'aria-hidden': 'true' }, '!') : null,
      el('span', { class: 'toast__message' }, toast?.message),
      toast?.action
        ? el(
            'button',
            {
              type: 'button',
              class: 'toast__action',
              onClick: () => {
                handlers.hideToast();
                toast.action?.run();
              },
            },
            toast.action.label,
          )
        : null,
      toast?.sticky
        ? el(
            'button',
            { type: 'button', class: 'toast__close', title: 'Close', 'aria-label': 'Close this message', onClick: () => handlers.hideToast() },
            '×',
          )
        : null,
    ),
  ];
}
