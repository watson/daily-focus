/** The keys, as the help dialog lists them. */

import { batch } from '@preact/signals';

import type { BoardRow, InProgressTicket, ResolvedItem, TicketRow } from '../src/types.ts';
import { afterRender, undoLast } from './actions.ts';
import { localDateKey } from './format.ts';
import { setDetailFor, state, ui } from './state.ts';
import type { Handlers } from './types.ts';

/**
 * Ids of the items currently on screen, in visual order. Only the showing view
 * counts, and a row in a closed drawer is not on screen: `j` stepping into one
 * would move the selection somewhere nobody can see it.
 */
function visibleItemIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${ui.view.value} .item`)]
    .filter((node) => !node.closest('details:not([open])'))
    .map((node) => node.dataset.id ?? '');
}

function moveSelection(delta: number): void {
  const ids = visibleItemIds();
  if (ids.length === 0) return;
  const current = ids.indexOf(ui.selectedId.value ?? '');
  const next = current === -1 ? (delta > 0 ? 0 : ids.length - 1) : current + delta;
  ui.selectedId.value = ids[Math.max(0, Math.min(ids.length - 1, next))] ?? null;
  // Scoped to the showing view: the same id can be a row in both lists, and the
  // hidden one comes first in the document.
  afterRender(() =>
    document.querySelector(`#${ui.view.value} .item[data-selected="true"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
}

type Selectable = ResolvedItem | BoardRow | TicketRow | InProgressTicket;

/**
 * The selected brief item or board row. Rows carry `court`, items carry `kind`.
 * An in-progress ticket carries neither, and no `status` — so it takes a note and
 * opens, and every key that needs an open status passes it over.
 */
function selectedItem(): Selectable | null {
  const current = state.value;
  const id = ui.selectedId.value;
  if (!current || id === null) return null;
  const view = ui.view.value;
  const list: readonly Selectable[] =
    view === 'board'
      ? (current.board?.rows ?? [])
      : view === 'tickets'
        ? ui.ticketMode.value === 'working'
          ? (current.tickets?.inProgress ?? [])
          : (current.tickets?.rows ?? [])
        : current.items;
  return list.find((entry) => entry.id === id) ?? null;
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

export function installKeyboard(handlers: Handlers): void {
  document.addEventListener('keydown', (event) => {
    const help = document.getElementById('help') as HTMLDialogElement | null;

    if (event.key === 'Escape') {
      if (ui.menuFor.value || ui.statusFor.value) {
        batch(() => {
          ui.menuFor.value = null;
          ui.statusFor.value = null;
        });
      } else if (ui.detailFor.value) {
        // Second press: the panel is closed only once the smaller things are.
        setDetailFor(ui, null);
      }
      return;
    }

    // Never steal keys from a field the user is typing in.
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('input, textarea, select')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (help?.open) return;

    switch (event.key) {
      case 'j':
        event.preventDefault();
        moveSelection(1);
        return;
      case 'k':
        event.preventDefault();
        moveSelection(-1);
        return;
      case 'f':
        // Focus mode only affects Today; toggling it from the board would change
        // nothing on screen and arm a collapsed view for the next visit.
        if (ui.view.value !== 'today') return;
        event.preventDefault();
        handlers.setFocusMode(!ui.focusMode.value);
        return;
      case '1':
        event.preventDefault();
        handlers.setView('today');
        return;
      case '2':
        event.preventDefault();
        handlers.setView('board');
        return;
      case '3':
        event.preventDefault();
        handlers.setView('tickets');
        return;
      case 'w':
        if (ui.view.value !== 'tickets') return;
        event.preventDefault();
        handlers.setTicketMode(ui.ticketMode.value === 'working' ? 'sync' : 'working');
        return;
      case 'r':
        if (ui.view.value === 'board') {
          event.preventDefault();
          handlers.refreshBoard();
        } else if (ui.view.value === 'tickets') {
          event.preventDefault();
          handlers.refreshTickets();
        }
        return;
      case '?':
        event.preventDefault();
        handlers.openHelp();
        return;
      case 'u':
        event.preventDefault();
        undoLast();
        return;
    }

    const item = selectedItem();
    if (!item) return;
    // A board row — pull request or ticket — can be parked and annotated, but not
    // done, dismissed or timed. Both show what is still true upstream, and neither
    // is put right from here.
    const boardRow = ui.view.value !== 'today';
    const status = 'status' in item ? item.status : null;
    const kind = 'kind' in item ? item.kind : null;

    switch (event.key) {
      case 'e':
        event.preventDefault();
        if (!boardRow && status === 'open') handlers.onAction(item.id, 'done');
        break;
      case 's':
        event.preventDefault();
        if (status === 'open') handlers.onAction(item.id, 'snooze', { until: tomorrow() });
        break;
      case 'x':
        event.preventDefault();
        if (!boardRow && status === 'open') handlers.onAction(item.id, 'dismiss');
        break;
      case 'n':
        event.preventDefault();
        handlers.openDetail(item.id, 'note');
        break;
      case 'a':
        if (!state.value?.assistant?.enabled) break;
        event.preventDefault();
        handlers.openDetail(item.id, 'assistant');
        break;
      case 'p':
        event.preventDefault();
        if (boardRow) break;
        if (state.value?.session.active?.id === item.id) handlers.stopSession();
        else if (status === 'open' && kind === 'task') handlers.startSession(item.id);
        break;
      case 'o':
        if (item.url) {
          event.preventDefault();
          window.open(item.url, '_blank', 'noopener');
        }
        break;
    }
  });
}
