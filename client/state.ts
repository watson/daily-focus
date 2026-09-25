/**
 * The client's state: the server's last payload, and the page's own view state.
 *
 * Both are signals. A render reads them and is rerun when they change, which is
 * the whole mechanism: nothing calls "render" after a change, and nothing has
 * to remember to.
 */

import { batch, signal } from '@preact/signals';

import type {
  AgentRun,
  BoardRow,
  DashboardState,
  InProgressTicket,
  ResolvedItem,
  TicketRow,
} from '../src/types.ts';
import type { UiState, UiValues, View } from './types.ts';

/**
 * The panels, by name. Each name is also the id of its panel element, which is
 * what the keyboard's scan of visible rows depends on, and what the stylesheet
 * keys `body[data-view]` off.
 */
export const VIEWS: readonly View[] = ['today', 'board', 'tickets'];

/**
 * The panel opens on rows by their id, and on a run of the morning agent by
 * its id under this prefix: the two share the one panel, and never an id.
 */
export const RUN_PREFIX = 'run:';

export const VIEW_KEY = 'daily-focus:view';
export const UNATTENDED_SEEN_KEY = 'daily-focus:unattended-seen';
export const AGENT_RUN_SEEN_KEY = 'daily-focus:agent-run-seen';
export const FOCUS_MODE_KEY = 'daily-focus:focus-mode';
/**
 * Which row the panel is open on, by item id. Persisted per tab in
 * sessionStorage rather than localStorage: it should survive the self-reload a
 * code change triggers mid-conversation, and not much else.
 */
export const DETAIL_KEY = 'daily-focus:detail-for';

/** The server's last word. Null until the first reply, which is when the page is empty. */
export const state = signal<DashboardState | null>(null);

/** A fresh set of view state. Every fact starts at its default unless `initial` says otherwise. */
export function createUi(initial: Partial<UiValues> = {}): UiState {
  return {
    selectedId: signal(initial.selectedId ?? null),
    pending: signal(initial.pending ?? new Set<string>()),
    menuFor: signal(initial.menuFor ?? null),
    statusFor: signal(initial.statusFor ?? null),
    detailFor: signal(initial.detailFor ?? null),
    noteDraft: signal(initial.noteDraft ?? ''),
    assistantDraft: signal(initial.assistantDraft ?? ''),
    focusField: signal(initial.focusField ?? null),
    openDrawers: signal(initial.openDrawers ?? new Set<string>()),
    ticketMode: signal(initial.ticketMode ?? 'sync'),
    unattendedSeen: signal(initial.unattendedSeen ?? null),
    agentReportSeen: signal(initial.agentReportSeen ?? null),
    messageOpen: signal(initial.messageOpen ?? new Map<string, boolean>()),
    view: signal(initial.view ?? 'today'),
    focusMode: signal(initial.focusMode ?? false),
    theme: signal(initial.theme ?? 'system'),
    toast: signal(initial.toast ?? null),
    connectionError: signal(initial.connectionError ?? null),
    clock: signal(initial.clock ?? Date.now()),
  };
}

function isView(value: unknown): value is View {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

/** What this browser remembered. Nothing, where there is no storage to ask. */
function remembered(): Partial<UiValues> {
  try {
    const view = localStorage.getItem(VIEW_KEY);
    return {
      view: isView(view) ? view : 'today',
      unattendedSeen: localStorage.getItem(UNATTENDED_SEEN_KEY),
      agentReportSeen: localStorage.getItem(AGENT_RUN_SEEN_KEY),
      focusMode: localStorage.getItem(FOCUS_MODE_KEY) === '1',
      detailFor: sessionStorage.getItem(DETAIL_KEY),
    };
  } catch {
    return {};
  }
}

/** The page's own view state. */
export const ui: UiState = createUi(remembered());

/**
 * Open the panel on a row, or close it. Only one is open at a time.
 *
 * The drafts belong to the row they were typed for, so moving the panel to
 * another row is what drops them. A state push never does: the fields keep
 * their element, and the element keeps its text.
 */
export function setDetailFor(target: UiState, id: string | null): void {
  batch(() => {
    if (target.detailFor.value !== id) {
      target.noteDraft.value = '';
      target.assistantDraft.value = '';
    }
    target.detailFor.value = id;
  });
  try {
    if (id) sessionStorage.setItem(DETAIL_KEY, id);
    else sessionStorage.removeItem(DETAIL_KEY);
  } catch {
    // No storage, no memory of the panel: the next load opens closed.
  }
}

/**
 * The views this instance offers. A switched-off board has nothing to show but a
 * line saying so, so its tab goes too — a personal instance with no Jira shouldn't
 * carry a Jira tab around.
 */
export function availableViews(current: DashboardState | null | undefined): View[] {
  const views: View[] = ['today'];
  if (current?.board?.enabled) views.push('board');
  if (current?.tickets?.enabled) views.push('tickets');
  return views;
}

/** Anything the panel can be open on, other than a run. */
export type DetailRow = ResolvedItem | BoardRow | TicketRow | InProgressTicket;

/**
 * The row the panel is open on, whichever list it is in.
 *
 * The showing view's list is asked first: the same id can be a brief item and a
 * board row, and the panel describes whichever the user is looking at. The others
 * are asked after, so the panel survives a change of tab. Null once the row is
 * gone from everywhere, which is when the panel has nothing left to show.
 */
export function detailRow(current: DashboardState, target: UiState): DetailRow | null {
  const id = target.detailFor.value;
  if (!id || id.startsWith(RUN_PREFIX)) return null;
  const tickets = current.tickets?.rows ?? [];
  const inProgress = current.tickets?.inProgress ?? [];
  const lists: Record<View, readonly DetailRow[]> = {
    today: current.items,
    board: current.board?.rows ?? [],
    tickets: target.ticketMode.value === 'working' ? [...inProgress, ...tickets] : [...tickets, ...inProgress],
  };
  const view = target.view.value;
  for (const candidate of [view, ...VIEWS.filter((other) => other !== view)]) {
    const hit = lists[candidate].find((row) => row.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * The run of the morning agent the panel is open on, if it is open on one. Null
 * once the run has dropped off the list the server sends, which is when the
 * panel has nothing left to show.
 */
export function detailRun(current: DashboardState, target: UiState): AgentRun | null {
  const id = target.detailFor.value;
  if (!id?.startsWith(RUN_PREFIX)) return null;
  const runId = id.slice(RUN_PREFIX.length);
  return (current.agentRun?.runs ?? []).find((run) => run.id === runId) ?? null;
}
