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
import type { UiState, UiValues, View, WarningsSeen, WriteFailure, WriteRetry } from './types.ts';

/**
 * The panels, by name. Each name is also the id of its panel element, which is
 * what the keyboard's scan of visible rows depends on, and what the stylesheet
 * keys `body[data-view]` off.
 */
export const VIEWS: readonly View[] = ['today', 'board', 'tickets', 'settings'];

/**
 * The panel opens on rows by their id, and on a run of the morning agent by
 * its id under this prefix: the two share the one panel, and never an id.
 */
export const RUN_PREFIX = 'run:';

/**
 * A menu opened from the panel is open on its row's id under this prefix. The
 * row's card offers the same buttons, and the stylesheet hangs a menu from the
 * one expanded button, so the card's copy must stay closed while the panel's is
 * open — and the card's menu must not open beside it.
 */
export const PANEL_PREFIX = 'panel:';

export const VIEW_KEY = 'daily-focus:view';
export const AGENT_RUN_SEEN_KEY = 'daily-focus:agent-run-seen';
export const WARNINGS_SEEN_KEY = 'daily-focus:warnings-seen';
/** The project the Projects view is zoomed into, by key. */
export const PROJECT_KEY = 'daily-focus:project';
/**
 * Which row the panel is open on, by item id. Persisted per tab in
 * sessionStorage rather than localStorage: it should survive the self-reload a
 * code change triggers mid-conversation, and not much else.
 */
export const DETAIL_KEY = 'daily-focus:detail-for';
/** The writes that failed on rows, for their cards. Per tab, in sessionStorage, for `DETAIL_KEY`'s reason. */
export const WRITE_FAILURES_KEY = 'daily-focus:write-failures';

/** The server's last word. Null until the first reply, which is when the page is empty. */
export const state = signal<DashboardState | null>(null);

/** A fresh set of view state. Every fact starts at its default unless `initial` says otherwise. */
export function createUi(initial: Partial<UiValues> = {}): UiState {
  return {
    selectedId: signal(initial.selectedId ?? null),
    clickedId: signal(initial.clickedId ?? null),
    pending: signal(initial.pending ?? new Set<string>()),
    menuFor: signal(initial.menuFor ?? null),
    statusFor: signal(initial.statusFor ?? null),
    detailFor: signal(initial.detailFor ?? null),
    noteDraft: signal(initial.noteDraft ?? ''),
    assistantDraft: signal(initial.assistantDraft ?? ''),
    focusField: signal(initial.focusField ?? null),
    drawers: signal(initial.drawers ?? new Map<string, boolean>()),
    ticketMode: signal(initial.ticketMode ?? 'sync'),
    projectKey: signal(initial.projectKey ?? null),
    agentReportSeen: signal(initial.agentReportSeen ?? null),
    warningsSeen: signal(initial.warningsSeen ?? null),
    messageOpen: signal(initial.messageOpen ?? new Map<string, boolean>()),
    view: signal(initial.view ?? 'today'),
    theme: signal(initial.theme ?? 'system'),
    toast: signal(initial.toast ?? null),
    writeFailures: signal(initial.writeFailures ?? new Map<string, WriteFailure>()),
    connectionError: signal(initial.connectionError ?? null),
    settingsReturn: signal(initial.settingsReturn ?? 'today'),
    settings: signal(initial.settings ?? null),
    settingsDraft: signal(initial.settingsDraft ?? new Map<string, string | null>()),
    settingsError: signal(initial.settingsError ?? null),
    settingsSaving: signal(initial.settingsSaving ?? false),
    texts: signal(initial.texts ?? {}),
    calendars: signal(initial.calendars ?? null),
    setupDrafts: signal(initial.setupDrafts ?? new Map()),
    setupEditing: signal(initial.setupEditing ?? null),
    setupConfirm: signal(initial.setupConfirm ?? null),
    setupBusy: signal(initial.setupBusy ?? null),
    setupError: signal(initial.setupError ?? null),
    setupTell: signal(initial.setupTell ?? new Map()),
    setupSources: signal(initial.setupSources ?? null),
    organizationReview: signal(initial.organizationReview ?? null),
  };
}

function isView(value: unknown): value is View {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

/** The warnings put away, as remembered; null for nothing, or for anything that isn't what was written. */
export function readWarningsSeen(raw: string | null): WarningsSeen | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WarningsSeen> | null;
    if (typeof value?.brief !== 'string' || !Array.isArray(value.warnings)) return null;
    return { brief: value.brief, warnings: value.warnings.filter((w): w is string => typeof w === 'string') };
  } catch {
    return null;
  }
}

const RETRY_KINDS = new Set(['merge', 'stack', 'ready', 'draft', 'move']);

function isRetry(value: unknown): value is WriteRetry {
  const retry = value as Partial<Record<string, unknown>> | null;
  if (typeof retry !== 'object' || retry === null || !RETRY_KINDS.has(retry.kind as string)) return false;
  if (retry.kind === 'merge') return typeof retry.route === 'string';
  if (retry.kind === 'move') return typeof retry.key === 'string' && typeof retry.status === 'string';
  return true;
}

/** The failed writes kept for this tab; an empty map for nothing, and an entry that isn't what was written is left out. */
export function readWriteFailures(raw: string | null): Map<string, WriteFailure> {
  const out = new Map<string, WriteFailure>();
  if (!raw) return out;
  try {
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const failure = entry[1] as Partial<WriteFailure> | null;
      if (typeof failure?.headline !== 'string' || typeof failure.message !== 'string' || typeof failure.at !== 'string' || !isRetry(failure.retry)) continue;
      out.set(entry[0], {
        headline: failure.headline,
        message: failure.message,
        at: failure.at,
        attempts: typeof failure.attempts === 'number' && failure.attempts >= 1 ? failure.attempts : 1,
        retry: failure.retry,
      });
    }
  } catch {
    // Not what was written: nothing kept.
  }
  return out;
}

/** What this browser remembered. Nothing, where there is no storage to ask. */
function remembered(): Partial<UiValues> {
  try {
    const view = localStorage.getItem(VIEW_KEY);
    return {
      // Settings is a page to visit, so a reload returns to the view underneath.
      view: isView(view) && view !== 'settings' ? view : 'today',
      agentReportSeen: localStorage.getItem(AGENT_RUN_SEEN_KEY),
      warningsSeen: readWarningsSeen(localStorage.getItem(WARNINGS_SEEN_KEY)),
      projectKey: localStorage.getItem(PROJECT_KEY),
      detailFor: sessionStorage.getItem(DETAIL_KEY),
      writeFailures: readWriteFailures(sessionStorage.getItem(WRITE_FAILURES_KEY)),
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
 * their element, and the element keeps its text. The cursor a click brought
 * with the panel goes with it too.
 */
export function setDetailFor(target: UiState, id: string | null): void {
  batch(() => {
    if (target.detailFor.value !== id) {
      target.noteDraft.value = '';
      target.assistantDraft.value = '';
      const clicked = target.clickedId.value;
      if (clicked !== null && target.selectedId.value === clicked) target.selectedId.value = null;
      target.clickedId.value = null;
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
 * carry a Jira tab around. Settings is always there, behind the header's gear
 * rather than a tab.
 */
export function availableViews(current: DashboardState | null | undefined): View[] {
  const views: View[] = ['today'];
  if (current?.board?.enabled) views.push('board');
  if (current?.tickets?.enabled) views.push('tickets');
  views.push('settings');
  return views;
}

/**
 * A ticket only an open project shows, as the panel shows it: what a ticket
 * board row would carry for the header, the status and the notes, and whether
 * it is the user's, since only the user's own get the status menu.
 */
export interface ProjectTicketRow {
  id: string;
  key: string;
  summary: string;
  workflowStatus: string;
  issueType: string;
  url: string | null;
  notes: { text: string; at: string }[];
  mine: boolean;
}

/** Anything the panel can be open on, other than a run. */
export type DetailRow = ResolvedItem | BoardRow | TicketRow | InProgressTicket | ProjectTicketRow;

/** The id a project's ticket goes by: the ticket board's, so a note or a conversation is one thing wherever it shows. */
export function projectTicketId(key: string): string {
  return `jira:${key}`;
}

/** A ticket in a project kept open, for the panel, by its id. */
function projectTicketRow(current: DashboardState, id: string): ProjectTicketRow | null {
  const wanted = id.trim().toLowerCase();
  for (const entry of Object.values(current.projects?.open ?? {})) {
    const ticket = entry.read?.tickets.find((each) => projectTicketId(each.key).toLowerCase() === wanted);
    if (ticket) {
      const { key, summary, workflowStatus, issueType, url, mine } = ticket;
      return { id: projectTicketId(key), key, summary, workflowStatus, issueType, url, mine, notes: ticket.notes ?? [] };
    }
  }
  return null;
}

/** A ticket by key, wherever the page has it: the ticket board, then a project kept open. */
export function ticketByKey(current: DashboardState, key: string): TicketRow | InProgressTicket | ProjectTicketRow | null {
  const tickets = current.tickets;
  return (
    tickets?.rows?.find((row) => row.key === key) ??
    tickets?.inProgress?.find((row) => row.key === key) ??
    projectTicketRow(current, projectTicketId(key))
  );
}

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
    settings: [],
  };
  const view = target.view.value;
  for (const candidate of [view, ...VIEWS.filter((other) => other !== view)]) {
    const hit = lists[candidate].find((row) => row.id === id);
    if (hit) return hit;
  }
  // A ticket the ticket board doesn't list, opened from Projects: not started,
  // say, or a teammate's.
  return projectTicketRow(current, id);
}

/**
 * Whether the panel opens inside a project rather than in the page's side
 * column: Projects is showing one that has been read, so the panel can sit
 * beside its list, under its headline and strip.
 */
export function panelInProject(current: DashboardState, target: UiState): boolean {
  const key = target.projectKey.value;
  return target.view.value === 'tickets' && target.ticketMode.value === 'projects' && key !== null && Boolean(current.projects?.open?.[key]?.read);
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
