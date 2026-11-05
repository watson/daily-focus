/**
 * Everything the page does: the handlers the renderers call, the optimistic
 * actions, the live state feed and the toast.
 *
 * Nothing here renders. A handler writes state and view signals, and the
 * components that read them are rerun by Preact.
 */

import { batch } from '@preact/signals';

import type {
  ActionType,
  BoardRow,
  CalendarProvider,
  DashboardState,
  ItemStatus,
  MergeRoute,
  OnboardingAnswer,
  Service,
  TicketRow,
} from '../src/types.ts';
import * as api from './api.ts';
import { HELPER_LABEL, MERGE_VERB, helperLabel } from './board.ts';
import { checkPending } from './donecheck.ts';
import {
  AGENT_RUN_SEEN_KEY,
  BOARD_ORDER_KEY,
  PROJECT_KEY,
  RUN_PREFIX,
  VIEW_KEY,
  WARNINGS_SEEN_KEY,
  WRITE_FAILURES_KEY,
  availableViews,
  setDetailFor,
  state,
  ticketByKey,
  ui,
} from './state.ts';
import { applyTheme } from './theme.ts';
import type {
  ActionExtra,
  FocusField,
  Handlers,
  SettingsPage,
  SetupDraft,
  TextEditor,
  TextName,
  TicketMode,
  Toast,
  View,
  WriteFailure,
  WriteRetry,
} from './types.ts';
import { FAILURE_ATTR, NOTE_CARD, failureMoot } from './writefailure.ts';

/* ---------- small things ---------- */

/**
 * Run `fn` once the document reflects the signals written so far.
 *
 * A signal write schedules Preact's render on a microtask; an animation frame
 * comes after every microtask and before the next paint, so this is the earliest
 * moment a selector can find the element a write just asked for.
 */
export function afterRender(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // No storage: the choice holds for this page and no longer, which is fine.
  }
}

function closeMenus(): void {
  ui.menuFor.value = null;
  ui.statusFor.value = null;
}

function addPending(id: string): void {
  ui.pending.value = new Set([...ui.pending.value, id]);
}

function removePending(id: string): void {
  if (!ui.pending.value.has(id)) return;
  const next = new Set(ui.pending.value);
  next.delete(id);
  ui.pending.value = next;
}

/* ---------- toast ---------- */

/** How long a toast that isn't an error stays, unless the pointer or the keyboard is on it. */
export const TOAST_MS = 6000;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** An error a passing toast covered, shown again once that toast goes: closing it is the only way it goes. */
let parked: Toast | null = null;

function startToastTimer(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = ui.toast.value && !ui.toast.value.sticky ? setTimeout(hideToast, TOAST_MS) : null;
}

function setToast(next: Toast): void {
  const current = ui.toast.value;
  if (next.sticky) parked = null;
  else if (current?.sticky) parked = current;
  ui.toast.value = next;
  startToastTimer();
}

/** A notice that goes after a few seconds, with a button when `onUndo` is given: Undo, unless `label` says otherwise. */
export function showToast(message: string, onUndo: (() => void) | null = null, label = 'Undo'): void {
  setToast({ message, action: onUndo ? { label, run: onUndo } : null, error: false, sticky: false, key: null });
}

/**
 * Something that went wrong. It stays until it is closed, rather than going
 * after a few seconds: an error read in passing, or not at all, can't be read
 * again. A notice meanwhile shows over it, and it comes back when that goes.
 * `key` names what failed, so that the same thing working later takes it away
 * (`settleError`) rather than leave it contradicting the page.
 */
export function showError(message: string, key: string | null = null): void {
  setToast({ message, action: null, error: true, sticky: true, key });
}

/** What `key` names worked this time: an error it left is no longer true. */
function settleError(key: string): void {
  if (parked?.key === key) parked = null;
  if (ui.toast.value?.key === key) hideToast();
}

/** Put the toast away. An error a passing toast covered comes back. */
export function hideToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  const back = ui.toast.value?.sticky ? null : parked;
  parked = null;
  ui.toast.value = back;
}

/** Keep the toast while the pointer or the keyboard is on it; its time starts again once they leave. */
function holdToast(held: boolean): void {
  if (held) {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  } else {
    startToastTimer();
  }
}

/* ---------- writes that failed, on their rows ---------- */

function keepFailures(next: ReadonlyMap<string, WriteFailure>): void {
  ui.writeFailures.value = next;
  try {
    if (next.size === 0) sessionStorage.removeItem(WRITE_FAILURES_KEY);
    else sessionStorage.setItem(WRITE_FAILURES_KEY, JSON.stringify([...next]));
  } catch {
    // No storage: the notes last as long as the page, which is most of the point.
  }
}

const sameRetry = (a: WriteRetry, b: WriteRetry): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The copies of row `id`'s note that are showing: the same row can be on a card and in the panel at once. */
function visibleNotes(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${FAILURE_ATTR}]`)].filter(
    (note) => note.getAttribute(FAILURE_ATTR) === id && note.getClientRects().length > 0,
  );
}

/** Whether any of `note` is inside the window: focusing it there moves nothing. */
function inView(note: HTMLElement): boolean {
  const rect = note.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight);
}

/**
 * Put the keyboard on row `id`'s new note, where that loses nobody their place:
 * when the keyboard was on that card, or on nothing, and a copy of the note is
 * already in the window. A button disabled while its write was on its way drops
 * the focus to the page, and Safari never gives a clicked button focus at all,
 * so "nothing" is common, and only the window says the user is still there. The
 * panel's copy first when the panel is open, since it sits over the board's.
 * Never scrolls. Says whether it did; when it didn't, a toast says what failed.
 */
function focusNewNote(id: string): boolean {
  const active = document.activeElement;
  const idle = !active || active === document.body;
  const notes = visibleNotes(id).filter(inView);
  const target = idle
    ? (notes.find((note) => note.closest('#flyout')) ?? notes[0])
    : notes.find((note) => note.closest(NOTE_CARD)?.contains(active));
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/**
 * Keep a write that failed on row `id`, for its card. `what` says what was
 * tried, given who it was for: "add it to the merge queue". The keyboard goes
 * to the note when it was on that card; otherwise a toast says what failed,
 * and its Show brings the note into view. The note stays after the toast goes.
 */
function failWrite(id: string, ref: string, what: (who: string) => string, message: string, retry: WriteRetry): void {
  const before = ui.writeFailures.value.get(id);
  const failure: WriteFailure = {
    headline: `Couldn’t ${what('it')}`,
    message,
    at: new Date().toISOString(),
    attempts: before && sameRetry(before.retry, retry) ? before.attempts + 1 : 1,
    retry,
  };
  keepFailures(new Map([...ui.writeFailures.value, [id, failure]]));
  afterRender(() => {
    if (focusNewNote(id)) return;
    setToast({
      message: `Couldn’t ${what(ref)}. The reason is on its card.`,
      action: { label: 'Show', run: () => revealFailure(id) },
      error: true,
      sticky: false,
      key: null,
    });
  });
}

/** Forget the failures kept on rows `ids`: the write went through. */
function clearFailures(ids: readonly string[]): void {
  if (!ids.some((id) => ui.writeFailures.value.has(id))) return;
  const next = new Map(ui.writeFailures.value);
  for (const id of ids) next.delete(id);
  keepFailures(next);
}

function dismissWriteFailure(id: string): void {
  clearFailures([id]);
}

/** Failures the state now shows have happened anyway, which their notes would contradict. */
function pruneFailures(next: DashboardState): void {
  const moot = [...ui.writeFailures.value].filter(([id, failure]) => failureMoot(id, failure, next)).map(([id]) => id);
  if (moot.length > 0) clearFailures(moot);
}

/** Whether the reader asked for less motion: a jump, then, rather than a glide. */
function lessMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Scroll to the first copy of row `id`'s note showing, put the keyboard on it and mark it for a moment. */
function revealNote(id: string): boolean {
  const note = visibleNotes(id)[0];
  if (!note) return false;
  note.scrollIntoView?.({ block: 'center', behavior: lessMotion() ? 'auto' : 'smooth' });
  note.focus({ preventScroll: true });
  note.classList.remove('write-failure--revealed');
  void note.offsetWidth;
  note.classList.add('write-failure--revealed');
  return true;
}

/**
 * The toast's Show: bring row `id`'s note into view. When no copy of it is
 * showing, go where the row lives first, the board or the ticket board, with
 * the fold that holds it open, and look again; when it is on neither, say so.
 * The toast's button has put the toast away already, and with it brought back
 * any error it covered, which must stay: this doesn't hide it again.
 */
function revealFailure(id: string): void {
  if (revealNote(id)) return;
  const row = pullRow(id);
  const key = id.startsWith('jira:') ? id.slice('jira:'.length) : null;
  const tickets = state.value?.tickets;
  const flagged = key ? tickets?.rows?.find((each) => each.key === key) : undefined;
  const working = key ? tickets?.inProgress?.find((each) => each.key === key) : undefined;
  const open = (fold: string) => {
    if (ui.drawers.value.get(fold) !== true) ui.drawers.value = new Map(ui.drawers.value).set(fold, true);
  };
  if (row) {
    setView('board');
    open(row.status === 'snoozed' ? 'board:snoozed' : row.court === 'reviewers' && row.nudgedAt ? 'board:nudged' : `board:${row.court}`);
  } else if (flagged || working) {
    setView('tickets');
    setTicketMode(flagged ? 'sync' : 'working');
    if (flagged?.status === 'snoozed') open('tickets:snoozed');
  }
  afterRender(() => {
    if (!revealNote(id)) showToast('Its card isn’t on the page any more, so its note can’t be shown.');
  });
}

/** Ask again for the write that failed on row `id`, through the same handler its button uses. */
function retryWrite(id: string): void {
  const failure = ui.writeFailures.value.get(id);
  if (!failure) return;
  const retry = failure.retry;
  switch (retry.kind) {
    case 'merge':
      return void mergePull(id, retry.route);
    case 'stack':
      return void mergeStack(id);
    case 'ready':
      return void markReady(id);
    case 'draft':
      return void markDraft(id);
    case 'move': {
      // Undo goes back to where it is now, which may not be where it was then.
      const now = state.value ? ticketByKey(state.value, retry.key) : null;
      return void moveTicket(retry.key, retry.status, now?.workflowStatus ?? retry.from);
    }
  }
}

/* ---------- state ---------- */

/**
 * Take a state the server built on its own clock, not in reply to a click.
 *
 * Such a state may predate an action still in flight, so anything pending keeps
 * its optimistic status until that action's own reply lands. The SSE push and the
 * board refresh both arrive this way; a reply to an action does not, since it was
 * built after the action was appended.
 */
export function adoptState(next: DashboardState): void {
  const current = state.value;
  for (const id of ui.pending.value) {
    const optimistic = current?.items.find((item) => item.id === id);
    const incoming = next.items.find((item) => item.id === id);
    if (optimistic && incoming) incoming.status = optimistic.status;
    const optimisticPull = current?.board?.rows.find((row) => row.id === id);
    const incomingPull = next.board?.rows.find((row) => row.id === id);
    if (optimisticPull && incomingPull) incomingPull.status = optimisticPull.status;
    const optimisticTicket = current?.tickets?.rows.find((row) => row.id === id);
    const incomingTicket = next.tickets?.rows.find((row) => row.id === id);
    if (optimisticTicket && incomingTicket) incomingTicket.status = optimisticTicket.status;
  }
  batch(() => {
    state.value = next;
    ui.connectionError.value = null;
    pruneFailures(next);
  });
  checkStore(next.storeId);
  checkAssetVersion(next.assetVersion);
}

export async function refresh(): Promise<void> {
  try {
    const next = await api.fetchState();
    checkStore(next.storeId);
    checkAssetVersion(next.assetVersion);
    batch(() => {
      state.value = next;
      ui.connectionError.value = null;
      pruneFailures(next);
    });
  } catch (err) {
    ui.connectionError.value = err as Error;
  }
}

/* ---------- self-reload when the UI changes ---------- */

/**
 * The SSE stream carries state, never code. Without this, editing a renderer
 * leaves this tab showing fresh data through stale markup — indistinguishable
 * from the change not working, and easily missed for days on a pinned tab.
 */
let loadedAssetVersion: string | null = null;

function checkAssetVersion(next: string | undefined): void {
  if (!next) return;
  if (loadedAssetVersion === null) {
    loadedAssetVersion = next;
    return;
  }
  if (next === loadedAssetVersion) return;

  // Never yank the page out from under a half-typed note. Offer instead, and
  // try again on the next push.
  const typing = document.activeElement?.matches?.('input, textarea');
  if (typing) {
    showToast('A new version of the dashboard is ready', () => location.reload(), 'Reload');
    return;
  }
  location.reload();
}

/**
 * The live feed reconnects to whatever dashboard is next on this address, and
 * that may be one on another store: stop one, start another on a different
 * store. Everything this tab holds would then be the old store's — the
 * settings it loaded, a draft, a fold left open — shown against the new one's
 * state, so a new store gets a fresh page. Without a prompt, half-typed or not:
 * nothing typed for the old store belongs in the new one.
 */
let loadedStore: string | null = null;

function checkStore(next: string | undefined): void {
  if (!next) return;
  loadedStore ??= next;
  if (next !== loadedStore) location.reload();
}

/* ---------- actions ---------- */

const PAST_TENSE: Record<ActionType, string> = {
  done: 'Marked done',
  dismiss: 'Dismissed',
  snooze: 'Snoozed',
  reopen: 'Restored',
  note: 'Note saved',
  nudge: 'Nudged, back tomorrow',
};

/** Last completed action, for the `u` shortcut. */
let lastAction: { id: string; action: ActionType } | null = null;

/**
 * What a brief item was before the board snoozed the same id.
 *
 * The log is shared and last-action-wins, so snoozing a pull request on the board
 * that the brief had already marked done turns that done into a snooze. Taking
 * the snooze back with a plain reopen would then leave the brief item open — a
 * finished task resurrected by a gesture on another tab. So `undo` restores what
 * the snooze replaced. Kept in memory only: after a reload the plain reopen is
 * the best that can be done.
 */
const snoozedFrom = new Map<string, 'done' | 'dismiss'>();

/** The action that takes one back: the status a board snooze replaced, or a plain reopen. */
function undo(id: string): Promise<void> {
  const restore = snoozedFrom.get(id);
  snoozedFrom.delete(id);
  return applyAction(id, restore ?? 'reopen');
}

/** Take back the last action, for the `u` key. A reopen has nothing to take back. */
export function undoLast(): void {
  if (lastAction && lastAction.action !== 'reopen') void undo(lastAction.id);
}

/** A note or a nudge: something said about an item, which leaves its status alone. */
type Remark = 'note' | 'nudge';

function isRemark(action: ActionType): action is Remark {
  return action === 'note' || action === 'nudge';
}

/** The state as it will read once the server agrees, which it almost always does. */
function optimistic(current: DashboardState, id: string, action: Exclude<ActionType, Remark>, extra: ActionExtra): DashboardState {
  const status: ItemStatus =
    action === 'reopen' ? 'open' : action === 'dismiss' ? 'dismissed' : action === 'done' ? 'done' : 'snoozed';
  const statusAt = new Date().toISOString();
  const rowStatus = action === 'snooze' ? 'snoozed' : 'open';
  const rowUntil = action === 'snooze' ? extra.until : undefined;
  const patchRows = <R extends BoardRow | TicketRow>(rows: R[]): R[] =>
    rows.map((row) => (row.id === id ? ({ ...row, status: rowStatus, snoozedUntil: rowUntil } as R) : row));
  return {
    ...current,
    items: current.items.map((item) =>
      item.id === id ? { ...item, status, statusAt, ...(action === 'snooze' ? { snoozedUntil: extra.until } : {}) } : item,
    ),
    board: current.board ? { ...current.board, rows: patchRows(current.board.rows) } : current.board,
    tickets: current.tickets ? { ...current.tickets, rows: patchRows(current.tickets.rows) } : current.tickets,
  };
}

/**
 * Apply an action optimistically, then reconcile with the server.
 *
 * The click is the whole point of this dashboard, so it must feel instant; the
 * server response replaces the guess a moment later. On failure we refetch rather
 * than trying to invert the guess, since the log is the only source of truth.
 */
async function applyAction(id: string, action: ActionType, extra: ActionExtra = {}): Promise<void> {
  const current = state.value;
  batch(() => {
    closeMenus();
    addPending(id);
    if (!current) return;
    const item = current.items.find((candidate) => candidate.id === id);
    // The board only ever snoozes and unsnoozes. The same id may be a brief item
    // too, and the log is shared, so a snooze from the board is a snooze on that
    // item as well — deliberately, so the agent leaves the PR alone until the date.
    // What the snooze replaces is remembered so unsnoozing can put it back.
    const row =
      current.board?.rows.find((candidate) => candidate.id === id) ??
      current.tickets?.rows.find((candidate) => candidate.id === id);
    if (row && action === 'snooze' && item && (item.status === 'done' || item.status === 'dismissed')) {
      snoozedFrom.set(id, item.status === 'done' ? 'done' : 'dismiss');
    }
    // A remark is left to the server, which alone knows what a nudge does to a row.
    if (!isRemark(action)) state.value = optimistic(current, id, action, extra);
  });

  try {
    state.value = await api.postAction({ id, action, ...extra });
    removePending(id);

    // A note or a nudge is append-only and can't be taken back, and "undoing" it
    // with a reopen would rewrite the status of whatever else shares the id. So
    // neither gets an Undo or becomes the target of `u`.
    if (isRemark(action)) {
      showToast(PAST_TENSE[action]);
      return;
    }
    lastAction = { id, action };
    if (action === 'reopen') {
      showToast(PAST_TENSE[action]);
    } else {
      showToast(PAST_TENSE[action], () => void undo(id));
    }
  } catch (err) {
    removePending(id);
    await refresh();
    showError(`Could not save: ${(err as Error).message}`);
  }
}

/* ---------- the boards ---------- */

/**
 * Ask GitHub now rather than at the next poll.
 *
 * The server answers once the fetch has landed, so this can take a few seconds;
 * the board says "refreshing" in the meantime because the fetch start is
 * broadcast over SSE like any other change.
 */
async function refreshBoard(): Promise<void> {
  // A held key repeats at keyboard rate; one fetch in flight is all there is to want.
  if (!state.value?.board?.enabled || state.value.board.fetching) return;
  try {
    adoptState(await api.postBoardRefresh());
    settleError('refresh:board');
  } catch (err) {
    showError(`Could not refresh GitHub: ${(err as Error).message}`, 'refresh:board');
  }
}

/** Connect GitHub or Jira, or stop connecting. Its progress arrives over the live feed. */
async function connect(service: Service, start: boolean, again = false): Promise<void> {
  try {
    adoptState(await (start ? api.postConnect(service, again) : api.postConnectCancel(service)));
  } catch (err) {
    showError(`Could not ${start ? 'connect' : 'stop connecting'}: ${(err as Error).message}`);
  }
}

/** The same, for Jira. Three searches through a CLI, so this one really does wait. */
async function refreshTickets(): Promise<void> {
  if (!state.value?.tickets?.enabled || state.value.tickets.fetching) return;
  try {
    adoptState(await api.postTicketsRefresh());
    settleError('refresh:tickets');
  } catch (err) {
    showError(`Could not refresh Jira: ${(err as Error).message}`, 'refresh:tickets');
  }
}

/** The projects being read open now, so a second ask for one joins the first rather than sending another. */
const openingProjects = new Set<string>();

/**
 * Zoom the Projects view into a project, and read it. The server answers at
 * once when it read that project within the last minute, and otherwise once
 * it has read it again, which takes a few seconds of acli; the view says it is
 * reading in the meantime, since the read's start is broadcast.
 */
async function openProject(key: string): Promise<void> {
  const wanted = key.trim().toUpperCase();
  if (!wanted) return;
  if (ui.projectKey.value !== wanted) {
    batch(() => {
      ui.projectKey.value = wanted;
      ui.selectedId.value = null;
      closeMenus();
    });
    remember(PROJECT_KEY, wanted);
    // Zooming from a card far down the page lands at the top of the view, where
    // the new project's name appears: it may still be being read.
    afterRender(() => document.querySelector('#tickets .ticket-toolbar')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
  }
  if (!state.value?.projects?.enabled || openingProjects.has(wanted)) return;
  openingProjects.add(wanted);
  try {
    adoptState(await api.postProjectOpen(wanted));
    settleError(`read:${wanted}`);
  } catch (err) {
    showError(`Could not read ${wanted}: ${(err as Error).message}`, `read:${wanted}`);
  } finally {
    openingProjects.delete(wanted);
  }
}

/**
 * Ask everything the Projects view is made of now: Jira for the epics and the
 * projects kept open, and the two boards for where the user's pull requests
 * stand, since a stage is only as fresh as the oldest of the three.
 */
async function refreshProjects(): Promise<void> {
  const projects = state.value?.projects;
  if (!projects?.enabled) return;
  void refreshTickets();
  void refreshBoard();
  if (projects.fetching) return;
  try {
    adoptState(await api.postProjectsRefresh());
    settleError('refresh:projects');
  } catch (err) {
    showError(`Could not refresh the projects: ${(err as Error).message}`, 'refresh:projects');
  }
}

/** The same, for the calendar: only ever asked for by the agenda's Retry, so only while a read is failing. */
async function refreshCalendar(): Promise<void> {
  if (state.value?.agendaSource?.failure?.retrying) return;
  try {
    adoptState(await api.postCalendarRefresh());
    settleError('refresh:calendar');
  } catch (err) {
    showError(`Could not refresh the calendar: ${(err as Error).message}`, 'refresh:calendar');
  }
}

/**
 * Move a ticket to another status, in Jira.
 *
 * The one thing this dashboard does that changes something outside it, so it is
 * deliberately not optimistic: the row only moves once Jira has accepted it and
 * the server has read the board back. Guessing here would show a status Jira
 * might have refused, which on the one tab whose whole job is "your statuses are
 * wrong" would be a lie of exactly the kind it exists to catch.
 *
 * The undo is a transition back rather than a rollback, and says so: Jira's
 * history keeps both moves. That is the honest offer — the alternative is
 * pretending a write can be taken back.
 */
async function moveTicket(key: string, status: string, from: string | null): Promise<void> {
  const id = `jira:${key}`;
  if (ui.pending.value.has(id)) return;
  batch(() => {
    ui.statusFor.value = null;
    addPending(id);
  });

  try {
    adoptState(await api.postTicketTransition(key, status));
    clearFailures([id]);
    showToast(`${key} moved to ${status}`, from ? () => void moveTicket(key, from, null) : null);
    // Projects read Jira on their own clock; read the open ones again so the card moves too.
    if (state.value?.projects?.enabled && Object.keys(state.value.projects.open ?? {}).length > 0) void refreshProjects();
  } catch (err) {
    // Jira refusing the move is the expected failure, not an exception: the board
    // offers the statuses it has seen, never the transitions the workflow allows.
    // Its words go on the ticket's card, until put away.
    failWrite(id, key, (who) => `move ${who} to ${status}`, (err as Error).message, { kind: 'move', key, status, from });
    await refresh();
  } finally {
    removePending(id);
  }
}

/**
 * Check now whether a ticket's pull requests finish it. Pending under its own
 * key rather than the row's, so the row's status menu stays usable while the
 * request goes; the check itself shows on the row as running, then its verdict.
 */
async function checkTicket(key: string): Promise<void> {
  const id = checkPending(key);
  if (ui.pending.value.has(id)) return;
  addPending(id);
  try {
    adoptState(await api.postTicketCheck(key));
  } catch (err) {
    showError(`Could not check ${key}: ${(err as Error).message}`);
  } finally {
    removePending(id);
  }
}

/* ---------- changing a pull request on GitHub ---------- */

/** The way a click on the row's merge goes when it doesn't say: the first the row offers. */
function firstRoute(row: BoardRow): MergeRoute | null {
  return row.offers?.find((offer): offer is MergeRoute => offer === 'helper' || offer === 'queue' || offer === 'merge') ?? null;
}

/**
 * What Merge asks before it does anything: which pull request, into which
 * branch, and how. GitHub's merge beside the merge helper says it skips the
 * queue, which can't be taken back either.
 */
export function mergeQuestion(row: BoardRow, route: MergeRoute | null = firstRoute(row)): string {
  const ref = `${row.repo} #${row.number}`;
  if (route === 'helper') {
    const label = helperLabel(row);
    return label === HELPER_LABEL ? `Add ${ref} to the merge queue?` : `${label}: ${ref}?`;
  }
  if (route === 'queue') return `Add ${ref} to the merge queue for ${row.baseRef}?`;
  const past = row.offers?.includes('helper') ? ' on GitHub, without the merge queue' : '';
  return `${MERGE_VERB[row.mergeMethod ?? 'MERGE']} ${ref} into ${row.baseRef}${past}?`;
}

/** The rows a stack merge from `row` would land, bottom first, as the page shows them; null when one isn't there. */
export function stackRows(row: BoardRow): BoardRow[] | null {
  const rows = state.value?.board?.rows ?? [];
  const chain = (row.stack ?? []).map((id) => rows.find((candidate) => candidate.id === id));
  return chain.length >= 2 && chain.every((member) => member !== undefined) ? (chain as BoardRow[]) : null;
}

/** What Merge stack asks: how many pull requests, and the order they merge in. */
export function stackQuestion(chain: readonly BoardRow[]): string {
  return `Merge this stack of ${chain.length} pull requests from the bottom: ${chain.map((member) => `#${member.number}`).join(', ')}?`;
}

/** What a pull request write says when it fails: what it tried, and how to try it again. */
interface Failing {
  /** The row it was asked from, which the failure is kept on: the top of a stack. */
  id: string;
  ref: string;
  /** What it tried, given who for: "add it to the merge queue". */
  what: (who: string) => string;
  retry: WriteRetry;
}

/**
 * Change a pull request on GitHub from its row.
 *
 * Not optimistic, for the reason `moveTicket` gives: the row moves once GitHub,
 * or the merge helper, has accepted the change and the server has read the board
 * back. The rows are pending meanwhile, which disables their buttons, so a
 * second click can't send the same write twice. A refusal is an expected outcome
 * — a push since the board looked makes GitHub refuse a merge — so its words go
 * on the row's card, where they stay until put away, and a toast points to
 * them. `done` is what the toast says on success, unless the merge helper said
 * something of its own.
 */
async function writePull(
  ids: readonly string[],
  send: () => Promise<api.Landed>,
  done: string,
  failing: Failing,
  undo: (() => void) | null = null,
): Promise<void> {
  if (ids.some((id) => ui.pending.value.has(id))) return;
  batch(() => {
    closeMenus();
    for (const id of ids) addPending(id);
  });
  try {
    const { state: next, notice } = await send();
    adoptState(next);
    clearFailures([failing.id, ...ids]);
    showToast(notice || done, undo);
  } catch (err) {
    failWrite(failing.id, failing.ref, failing.what, (err as Error).message, failing.retry);
    await refresh();
  } finally {
    for (const id of ids) removePending(id);
  }
}

function pullRow(id: string): BoardRow | undefined {
  return state.value?.board?.rows.find((row) => row.id === id);
}

/** Mark a draft ready for review. It doesn't ask: the toast's Undo turns it back into a draft. */
async function markReady(id: string): Promise<void> {
  const row = pullRow(id);
  if (!row) return;
  const ref = `${row.repo}#${row.number}`;
  const send = async () => ({ state: await api.postPullReady(id), notice: null });
  const failing: Failing = { id, ref, what: (who) => `mark ${who} ready for review`, retry: { kind: 'ready' } };
  await writePull([id], send, `${ref} is ready for review`, failing, () => void markDraft(id));
}

/** Turn a pull request back into a draft. It doesn't ask either: the toast's Undo marks it ready again. */
async function markDraft(id: string): Promise<void> {
  const row = pullRow(id);
  if (!row) return;
  const ref = `${row.repo}#${row.number}`;
  const send = async () => ({ state: await api.postPullDraft(id), notice: null });
  const failing: Failing = { id, ref, what: (who) => `turn ${who} back into a draft`, retry: { kind: 'draft' } };
  await writePull([id], send, `${ref} is a draft again`, failing, () => void markReady(id));
}

/** What a merge by `route` tries, given who for, as a failure says it. */
function mergeWhat(row: BoardRow, route: MergeRoute): (who: string) => string {
  if (route === 'helper') {
    return helperLabel(row) === HELPER_LABEL ? (who) => `add ${who} to the merge queue` : (who) => `hand ${who} to your merge helper`;
  }
  if (route === 'queue') return (who) => `add ${who} to the merge queue`;
  const verb = MERGE_VERB[row.mergeMethod ?? 'MERGE'].toLowerCase();
  return (who) => `${verb} ${who}`;
}

/**
 * Merge a pull request, queue it, or hand it to the merge helper, by `route`,
 * the button clicked, once the user has said yes: a merge can't be taken back.
 */
async function mergePull(id: string, asked?: MergeRoute): Promise<void> {
  const row = pullRow(id);
  if (!row || ui.pending.value.has(id)) return;
  const route = asked ?? firstRoute(row);
  if (!route || !row.offers?.includes(route)) return;
  // The commit being asked about: a poll while the question is open may move
  // the row on, and the server merges only if it is still this one.
  const head = row.headSha;
  if (!head) return;
  if (!window.confirm(mergeQuestion(row, route))) return;
  const ref = `${row.repo}#${row.number}`;
  const send = () => api.postPullMerge(id, head, route);
  const failing: Failing = { id, ref, what: mergeWhat(row, route), retry: { kind: 'merge', route } };
  const done = route === 'helper' ? `${ref} went to your merge helper` : route === 'queue' ? `${ref} added to the merge queue` : `${ref} merged into ${row.baseRef}`;
  await writePull([id], send, done, failing);
}

/**
 * Have the merge helper merge the stack a row tops, bottom first, once the user
 * has said yes to the pull requests it names, in the order they merge. Sends the
 * head commit of each as the page showed it, so the server merges only what was
 * asked about.
 */
async function mergeStack(id: string): Promise<void> {
  const row = pullRow(id);
  if (!row || !row.offers?.includes('stack')) return;
  const chain = stackRows(row);
  if (!chain || chain.some((member) => !member.headSha || ui.pending.value.has(member.id))) return;
  const heads = Object.fromEntries(chain.map((member) => [member.id, member.headSha!]));
  if (!window.confirm(stackQuestion(chain))) return;
  const ref = `${row.repo}#${row.number}`;
  await writePull(
    chain.map((member) => member.id),
    () => api.postPullMergeStack(id, heads),
    `${ref} and the ${chain.length - 1} under it went to your merge helper`,
    { id, ref, what: (who) => (who === 'it' ? 'merge the stack it tops' : `merge the stack up to ${who}`), retry: { kind: 'stack' } },
  );
}

/* ---------- the assistant ---------- */

/**
 * Send a request to the assistant. Not optimistic: the reply is the server's
 * to stream, and the panel shows "working" from the moment the reply to this
 * says so. The draft is cleared on success and kept on failure, since a message
 * that didn't go is one the user will want to send again.
 */
async function ask(id: string, body: { action?: string; text?: string }): Promise<void> {
  if (state.value?.assistant?.items?.[id]?.running) return;
  try {
    const next = await api.postAssistantAsk({ id, ...body });
    ui.assistantDraft.value = '';
    adoptState(next);
  } catch (err) {
    showError(`Could not ask: ${(err as Error).message}`);
  }
}

async function stopAssistant(id: string): Promise<void> {
  try {
    adoptState(await api.postAssistantStop(id));
  } catch (err) {
    showError(`Could not stop: ${(err as Error).message}`);
  }
}

/**
 * The clipboard API wants a secure context, which a dashboard reached by its
 * address on the network is not; the old way still works there.
 */
async function copy(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('the browser would not copy');
    }
    showToast('Copied');
  } catch (err) {
    showError(`Could not copy: ${(err as Error).message}`);
  }
}

/* ---------- the morning agent ---------- */

/**
 * Start the morning agent. Asked first, because it is the one button here that
 * costs a quarter of an hour of a model's time and replaces what is on screen —
 * and it sits beside the brief's age, where a stray click is easy.
 */
async function runAgent(): Promise<void> {
  if (!state.value?.agentRun?.enabled || state.value.agentRun.last?.status === 'running') return;
  const ok = window.confirm(
    'Run the morning agent now? It rewrites the brief from scratch, which takes a while. ' +
      'What you have marked done, snoozed or noted is kept.',
  );
  if (!ok) return;
  try {
    adoptState(await api.postAgentRun());
  } catch (err) {
    showError(`Could not start the morning agent: ${(err as Error).message}`);
  }
}

async function stopAgent(): Promise<void> {
  try {
    adoptState(await api.postAgentStop());
  } catch (err) {
    showError(`Could not stop the morning agent: ${(err as Error).message}`);
  }
}

/**
 * Ask a finished run a question, in its own session. The reply streams in over
 * SSE. The draft is kept until the server has taken it, as the assistant's is.
 */
async function askAgent(run: string, text: string): Promise<void> {
  try {
    const next = await api.postAgentAsk(run, text);
    ui.assistantDraft.value = '';
    adoptState(next);
  } catch (err) {
    showError(`Could not ask the morning agent: ${(err as Error).message}`);
  }
}

/* ---------- views ---------- */

/** Which panel shows is decided by `body[data-view]` in the stylesheet, and nowhere else. */
function showView(view: View): void {
  if (ui.view.value === view) return;
  // The number keys reach every view, including one whose tab is hidden.
  if (state.value && !availableViews(state.value).includes(view)) return;
  if (view === 'settings') ui.settingsReturn.value = ui.view.value;
  batch(() => {
    ui.view.value = view;
    // The selection belongs to the list it was made in. The panel does not: it
    // is pinned to its row, and follows to whichever tab that row is on.
    ui.selectedId.value = null;
    closeMenus();
  });
  // Settings is a page to visit, not one a pinned tab should reopen on.
  remember(VIEW_KEY, view === 'settings' ? ui.settingsReturn.value : view);
}

/** Marks the history entry Settings added, as against one a link arrived on. */
const SETTINGS_ENTRY = 'dailyFocusSettings';

function settingsEntry(): boolean {
  try {
    return Boolean((history.state as Record<string, unknown> | null)?.[SETTINGS_ENTRY]);
  } catch {
    return false;
  }
}

/** The address without `#settings`, in place, for leaving Settings without Back. */
function clearSettingsHash(): void {
  try {
    if (location.hash.startsWith('#settings')) history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    // No history to speak of; the view still changes.
  }
}

/**
 * Switch to `view`. Settings is a page of its own as far as the browser goes:
 * opening it adds a history entry, so Back returns to where it was opened from.
 * Leaving it any other way, by its button, Escape or a tab, goes back through
 * that entry rather than leaving it behind for Back to land on again. Arrived at
 * by a link, it has no entry of its own, and leaving it only tidies the address,
 * so Back never takes anyone out of the dashboard.
 */
function setView(view: View): void {
  if (view === 'settings') {
    openSettings();
    return;
  }
  if (ui.view.value === 'settings') {
    ui.settingsReturn.value = view;
    if (settingsEntry()) {
      history.back();
      return;
    }
    clearSettingsHash();
  }
  showView(view);
}

/**
 * Switch the ticket tab between its views. The selection and anything open go
 * with it, as they do between tabs: they belong to the list they were made in.
 */
function setTicketMode(mode: TicketMode): void {
  if (ui.ticketMode.value === mode) return;
  batch(() => {
    ui.ticketMode.value = mode;
    ui.selectedId.value = null;
    closeMenus();
  });
}

/* ---------- settings ---------- */

/** Say what a save did: restarted, or waiting for the agent to finish first, or waiting for a hand. */
function restartToast(page: SettingsPage): void {
  if (page.restart === 'manual') showToast('Saved. Restart the dashboard to apply it.');
  else if (page.restart === 'waiting' && state.value?.agentRun?.last?.status === 'running') {
    showToast('Saved. The dashboard restarts to apply it once the morning agent finishes.');
  } else if (page.restart === 'waiting') showToast('Saved. Restarting the dashboard to apply it…');
  else showToast('Saved');
}

/**
 * Follow a restart until the dashboard is back with the new settings. The live
 * feed reconnects on its own, but only after a few seconds; asking every half
 * second lands the setup screen's finish on the first brief as soon as it starts.
 * Gives up after fifteen seconds, which only a restart waiting on the morning
 * agent takes, and the live feed carries on from there.
 */
async function followRestart(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((done) => setTimeout(done, 500));
    try {
      const next = await api.fetchState();
      adoptState(next);
      if (next.restart === null) {
        if (ui.settings.value) void loadSettings();
        showToast('Settings applied');
        return;
      }
    } catch {
      // Between the old dashboard closing and the new one listening.
    }
  }
}

async function loadSettings(): Promise<void> {
  try {
    ui.settings.value = await api.fetchSettings();
  } catch (err) {
    showError(`Could not load the settings: ${(err as Error).message}`);
  }
}

/** Save `values` from the settings page's draft. */
async function sendSettings(values: Record<string, string | null>): Promise<void> {
  if (ui.settingsSaving.value) return;
  batch(() => {
    ui.settingsSaving.value = true;
    ui.settingsError.value = null;
  });
  try {
    const page = await api.postSettings(values);
    batch(() => {
      ui.settings.value = page;
      // Only what was sent, and only where it hasn't been changed again since:
      // a field edited while the save was on its way keeps its new value.
      const draft = new Map(ui.settingsDraft.value);
      for (const [key, value] of Object.entries(values)) if (draft.get(key) === value) draft.delete(key);
      ui.settingsDraft.value = draft;
    });
    restartToast(page);
    if (page.restart === 'waiting') void followRestart();
  } catch (err) {
    ui.settingsError.value = (err as Error).message;
  } finally {
    ui.settingsSaving.value = false;
  }
}

function editSetting(key: string, value: string | null): void {
  const next = new Map(ui.settingsDraft.value);
  // Setting a field back to what is saved is no change at all, so it leaves the draft.
  const current = ui.settings.value?.settings.find((setting) => setting.key === key);
  const saved = current?.source === 'settings' ? current.value : null;
  if ((value ?? null) === saved) next.delete(key);
  else next.set(key, value);
  batch(() => {
    ui.settingsDraft.value = next;
    ui.settingsError.value = null;
  });
}

function patchText(name: TextName, patch: Partial<TextEditor>): void {
  const current = ui.texts.value[name];
  if (!current) return;
  ui.texts.value = { ...ui.texts.value, [name]: { ...current, ...patch } };
}

async function loadText(name: TextName): Promise<void> {
  try {
    const file = await api.fetchText(name);
    ui.texts.value = {
      ...ui.texts.value,
      [name]: {
        saved: file.text,
        version: file.version,
        template: file.template,
        draft: file.text ?? file.template,
        conflict: null,
        saving: false,
      },
    };
  } catch (err) {
    showError(`Could not open ${name === 'focus' ? 'focus.md' : 'sources.md'}: ${(err as Error).message}`);
  }
}

/**
 * Save an editor. A file changed on disk since it was opened is never written
 * over without asking: the editor keeps what was typed and offers the choice.
 */
async function saveText(name: TextName, overwrite = false): Promise<void> {
  const editor = ui.texts.value[name];
  if (!editor || editor.saving) return;
  const version = overwrite && editor.conflict ? editor.conflict.version : editor.version;
  patchText(name, { saving: true });
  try {
    const saved = await api.postText(name, editor.draft, version);
    const text = editor.draft.endsWith('\n') ? editor.draft : `${editor.draft}\n`;
    patchText(name, { saved: text, draft: text, version: saved.version, conflict: null, saving: false });
    showToast(name === 'focus' ? 'Objective saved' : 'Source list saved. The next brief reads it.');
  } catch (err) {
    const failure = err as Error & { status?: number; body?: { text?: string | null; version?: string } };
    if (failure.status === 409 && failure.body?.version) {
      patchText(name, { conflict: { text: failure.body.text ?? null, version: failure.body.version }, saving: false });
    } else {
      patchText(name, { saving: false });
      showError(`Could not save: ${failure.message}`);
    }
  }
}

async function saveObjective(objective: string, blocker: string): Promise<void> {
  try {
    adoptState(await api.postObjective(objective, blocker));
    // The editor, if it has been opened, now holds an older version of the file.
    // Reloaded only if nothing is typed in it: otherwise it keeps what is typed,
    // and saving it meets the changed file and offers the choice.
    const editor = ui.texts.value.focus;
    if (editor && editor.draft === (editor.saved ?? editor.template)) void loadText('focus');
    showToast(objective.trim() ? 'Objective saved' : 'Objective cleared');
  } catch (err) {
    showError(`Could not save the objective: ${(err as Error).message}`);
  }
}

async function listCalendars(): Promise<void> {
  ui.calendars.value = null;
  try {
    ui.calendars.value = (await api.postListCalendars()).calendars;
  } catch (err) {
    ui.calendars.value = (err as Error).message;
  }
}

/** Off to the provider's page; the callback page brings the browser back. */
async function connectCalendar(provider: CalendarProvider, returnTo: string, reconnect: string | null): Promise<void> {
  const { url } = await api.postCalendarConnect(provider, returnTo, reconnect);
  location.assign(url);
}

async function disconnectCalendar(id: string): Promise<void> {
  try {
    adoptState(await api.postCalendarDisconnect(id));
    // What was listed came partly from the account just gone.
    ui.calendars.value = null;
    showToast('Calendar account disconnected');
  } catch (err) {
    showError(`Could not disconnect: ${(err as Error).message}`);
  }
}

/* ---------- the setup screen ---------- */

/** One request about a setup step at a time; its buttons wait for it. */
async function setupRequest(step: string, send: () => Promise<DashboardState>): Promise<boolean> {
  if (ui.setupBusy.value) return false;
  batch(() => {
    ui.setupBusy.value = step;
    ui.setupError.value = null;
  });
  try {
    adoptState(await send());
    return true;
  } catch (err) {
    ui.setupError.value = { step, message: (err as Error).message };
    return false;
  } finally {
    ui.setupBusy.value = null;
  }
}

function forgetDraft(step: string): void {
  if (!ui.setupDrafts.value.has(step)) return;
  const next = new Map(ui.setupDrafts.value);
  next.delete(step);
  ui.setupDrafts.value = next;
}

async function answerSetup(step: string, answer: OnboardingAnswer): Promise<void> {
  if (!(await setupRequest(step, () => api.postSetupAnswer(step, answer)))) return;
  batch(() => {
    forgetDraft(step);
    if (ui.setupEditing.value === step) ui.setupEditing.value = null;
    if (ui.setupConfirm.value === step) ui.setupConfirm.value = null;
    // The source list it would write has changed with the answer.
    ui.setupSources.value = null;
  });
  // The next question takes the place of this one: bring it into view, and the
  // keyboard to its heading, so a screen reader reads the question out.
  afterRender(() => {
    const heading = document.querySelector<HTMLElement>('.onboarding__card[data-current="true"] h2');
    heading?.focus({ preventScroll: true });
    heading?.closest('.onboarding__card')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

async function reviseSetup(step: string, text: string, draft: SetupDraft['answer']): Promise<void> {
  if (!(await setupRequest(step, () => api.postSetupRevise(step, text, draft)))) return;
  batch(() => {
    // What it comes back with starts from this draft, so the draft gives way to it.
    forgetDraft(step);
    if (ui.setupConfirm.value === step) ui.setupConfirm.value = null;
    const tell = new Map(ui.setupTell.value);
    tell.delete(step);
    ui.setupTell.value = tell;
  });
}

async function loadSetupSources(): Promise<void> {
  ui.setupSources.value = 'loading';
  try {
    ui.setupSources.value = await api.fetchSetupSources();
  } catch (err) {
    ui.setupSources.value = { error: (err as Error).message };
  }
}

/* ---------- organization setups ---------- */

/** Open an organization's setup for review. What it would do comes from the server on its own, never with the state. */
async function reviewOrganization(org: string): Promise<void> {
  ui.organizationReview.value = { org, review: 'loading', busy: false, error: null };
  let review: NonNullable<typeof ui.organizationReview.value>['review'];
  try {
    review = await api.fetchOrganizationReview(org);
  } catch (err) {
    review = { error: (err as Error).message };
  }
  const open = ui.organizationReview.value;
  if (open?.org === org) ui.organizationReview.value = { ...open, review };
}

/**
 * One of the review's buttons, or the settings page's. The review closes once
 * the server agrees, and says why not when it doesn't; with no review open,
 * a toast does.
 */
async function organizationRequest(send: () => Promise<DashboardState>, done: string): Promise<boolean> {
  const open = ui.organizationReview.value;
  if (open?.busy) return false;
  if (open) ui.organizationReview.value = { ...open, busy: true, error: null };
  try {
    adoptState(await send());
  } catch (err) {
    const current = ui.organizationReview.value;
    if (current) ui.organizationReview.value = { ...current, busy: false, error: (err as Error).message };
    else showError(`That didn’t work: ${(err as Error).message}`);
    return false;
  }
  ui.organizationReview.value = null;
  showToast(done);
  if (state.value?.restart === 'waiting') void followRestart();
  return true;
}

function openSettings(section: string | null = null): void {
  if (ui.view.value !== 'settings') {
    try {
      history.pushState({ [SETTINGS_ENTRY]: true }, '', '#settings');
    } catch {
      // No history to speak of; the view still changes.
    }
    showView('settings');
  }
  loadSettingsPage(section);
}

function loadSettingsPage(section: string | null): void {
  const loading = ui.settings.value ? Promise.resolve() : loadSettings();
  for (const name of ['focus', 'sources'] as const) if (!ui.texts.value[name]) void loadText(name);
  // Most sections are the server's setting groups, which exist only once the
  // settings have loaded: scrolling before then would find nothing to scroll to.
  if (section) {
    void loading.then(() =>
      afterRender(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })),
    );
  }
}

/**
 * Follow the address: Back and Forward, and a link to `#settings`, or to one
 * section of it such as `#settings-sources`, which is how the menu bar app opens
 * Settings. Called on load and on every history move.
 */
export function followLocation(): void {
  const linked = /^#settings(?:-([a-z]+))?$/.exec(location.hash);
  if (linked) {
    if (ui.view.value !== 'settings') showView('settings');
    loadSettingsPage(linked[1] ?? null);
    // A link names a section only to scroll to it; the page is just Settings.
    if (linked[1]) {
      try {
        history.replaceState(history.state, '', '#settings');
      } catch {
        // Fine either way.
      }
    }
    return;
  }
  if (ui.view.value === 'settings') showView(ui.settingsReturn.value);
}

/* ---------- the handlers ---------- */

export const handlers: Handlers = {
  onAction: (id, action, extra) => void applyAction(id, action, extra),
  // A click on a card: the cursor goes to it, and the panel opens on it — or
  // closes, if it was already open on this one. The card is the one way in with
  // a mouse; `n` and `a` are the ways in from the keyboard. A cursor the click
  // brought leaves with the panel, however that is closed.
  onSelect: (id) =>
    batch(() => {
      const opening = ui.detailFor.value !== id;
      ui.selectedId.value = id;
      setDetailFor(ui, opening ? id : null);
      if (opening) ui.clickedId.value = id;
      ui.focusField.value = null;
      closeMenus();
    }),
  toggleMenu: (id) =>
    batch(() => {
      ui.menuFor.value = ui.menuFor.value === id ? null : id;
      ui.statusFor.value = null;
    }),
  toggleStatus: (id) =>
    batch(() => {
      ui.statusFor.value = ui.statusFor.value === id ? null : id;
      ui.menuFor.value = null;
    }),
  moveTicket: (key, status, from) => void moveTicket(key, status, from),
  checkTicket: (key) => void checkTicket(key),
  openDetail: (id, field: FocusField | null = null) =>
    batch(() => {
      setDetailFor(ui, id);
      ui.focusField.value = field;
      closeMenus();
    }),
  closeDetail: () => setDetailFor(ui, null),
  openRun: (id = null) => {
    const run = id ?? state.value?.agentRun?.last?.id;
    if (!run) return;
    batch(() => {
      setDetailFor(ui, `${RUN_PREFIX}${run}`);
      ui.focusField.value = null;
      closeMenus();
    });
  },
  saveNote: (id, text) => {
    ui.noteDraft.value = '';
    void applyAction(id, 'note', { text });
  },
  toggleDrawer: (key, open) => {
    if (ui.drawers.value.get(key) === open) return;
    ui.drawers.value = new Map(ui.drawers.value).set(key, open);
  },
  orderBoard: (key, order) => {
    const next = new Map(ui.boardOrder.value);
    // The board's own order is the absence of one, so it is never written down.
    if (order === 'waiting') next.delete(key);
    else next.set(key, order);
    ui.boardOrder.value = next;
    remember(BOARD_ORDER_KEY, next.size > 0 ? JSON.stringify(Object.fromEntries(next)) : null);
  },
  setTicketMode,
  openProject: (key) => void openProject(key),
  refreshProjects: () => void refreshProjects(),
  closeProject: () => {
    batch(() => {
      ui.projectKey.value = null;
      ui.selectedId.value = null;
      closeMenus();
    });
    remember(PROJECT_KEY, null);
  },
  setView,
  // From the flag on a Working on row: over to Out of sync, with that ticket's
  // row selected and on screen, so the jump lands on the thing it named.
  jumpToTicket: (id) => {
    setTicketMode('sync');
    ui.selectedId.value = id;
    ui.clickedId.value = null;
    afterRender(() =>
      document.querySelector('#tickets .item[data-selected="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
  },
  // A nudge on Slack is invisible to GitHub, so it's recorded: the board's nudge
  // timer starts over from it, and the agent reads that the user asked.
  nudge: (id) => void applyAction(id, 'nudge'),
  unsnooze: (id) => void undo(id),
  markReady: (id) => void markReady(id),
  markDraft: (id) => void markDraft(id),
  mergePull: (id, route) => void mergePull(id, route),
  mergeStack: (id) => void mergeStack(id),
  refreshBoard: () => void refreshBoard(),
  refreshTickets: () => void refreshTickets(),
  refreshCalendar: () => void refreshCalendar(),
  connect: (service, again) => void connect(service, true, again),
  cancelConnect: (service) => void connect(service, false),
  chooseConnect: (service, choice) =>
    void api.postConnectChoose(service, choice).then(adoptState, (err: unknown) => showError(`Could not choose ${choice}: ${(err as Error).message}`)),
  ask: (id, body) => void ask(id, body),
  stopAssistant: (id) => void stopAssistant(id),
  copy: (text) => void copy(text),
  runAgent: () => void runAgent(),
  stopAgent: () => void stopAgent(),
  askAgent: (run, text) => void askAgent(run, text),
  dismissAgentRun: (id) => {
    ui.agentReportSeen.value = id;
    remember(AGENT_RUN_SEEN_KEY, id);
  },
  dismissWarning: (brief, text) => {
    const seen = ui.warningsSeen.value;
    // Another brief's are dropped here, so the list never outgrows one brief's warnings.
    const warnings = seen?.brief === brief ? [...seen.warnings, text] : [text];
    ui.warningsSeen.value = { brief, warnings };
    remember(WARNINGS_SEEN_KEY, JSON.stringify({ brief, warnings }));
  },
  toggleMessage: (key, open) => {
    const next = new Map(ui.messageOpen.value);
    if (open === null) next.delete(key);
    else next.set(key, open);
    ui.messageOpen.value = next;
  },
  setTheme: (mode) =>
    batch(() => {
      applyTheme(mode);
      ui.theme.value = mode;
      closeMenus();
    }),
  openHelp: () => (document.getElementById('help') as HTMLDialogElement | null)?.showModal(),
  hideToast,
  holdToast,
  retryWrite: (id) => retryWrite(id),
  dismissWriteFailure,
  openSettings,
  closeSettings: () => setView(ui.settingsReturn.value),
  loadSettings: () => void loadSettings(),
  editSetting,
  discardSettings: () =>
    batch(() => {
      ui.settingsDraft.value = new Map();
      ui.settingsError.value = null;
    }),
  saveSettings: () => void sendSettings(Object.fromEntries(ui.settingsDraft.value)),
  loadText: (name) => void loadText(name),
  editText: (name, text) => patchText(name, { draft: text }),
  saveText: (name, overwrite) => void saveText(name, overwrite),
  reloadText: (name) => void loadText(name),
  saveObjective: (objective, blocker) => void saveObjective(objective, blocker),
  listCalendars: () => void listCalendars(),
  connectCalendar,
  disconnectCalendar: (id) => void disconnectCalendar(id),
  answerSetup: (step, answer) => void answerSetup(step, answer),
  editSetupDraft: (step, answer, version) => {
    if (answer === null) return forgetDraft(step);
    const next = new Map(ui.setupDrafts.value);
    next.set(step, { version, answer });
    ui.setupDrafts.value = next;
  },
  editSetupStep: (step) =>
    batch(() => {
      ui.setupEditing.value = step;
      ui.setupError.value = null;
    }),
  confirmSetup: (step) => {
    ui.setupConfirm.value = step;
  },
  editSetupTell: (step, text) => {
    const next = new Map(ui.setupTell.value);
    next.set(step, text);
    ui.setupTell.value = next;
  },
  reviseSetup: (step, text, draft) => void reviseSetup(step, text, draft),
  retrySetup: (step) => void setupRequest(step, () => api.postSetupRetry(step)),
  detectSetup: () => void setupRequest('detect', () => api.postSetupDetect()),
  finishSetup: () =>
    void setupRequest('finish', () => api.postSetupFinish()).then((finished) => {
      if (finished && state.value?.restart === 'waiting') void followRestart();
    }),
  loadSetupSources: () => void loadSetupSources(),
  reviewOrganization: (org) => void reviewOrganization(org),
  closeOrganizationReview: () => {
    if (!ui.organizationReview.value?.busy) ui.organizationReview.value = null;
  },
  adoptOrganization: (org, commit) => {
    const name = reviewName(org);
    void organizationRequest(() => api.postOrganizationAdopt(org, commit), `Using ${name}’s Daily Focus settings. Restarting the dashboard to apply them…`);
  },
  dismissOrganization: (org, commit) => {
    const name = reviewName(org);
    void organizationRequest(() => api.postOrganizationDismiss(org, commit), `${name}’s Daily Focus settings are put off until they change. The settings page still lists them.`);
  },
  leaveOrganization: () => {
    const name = state.value?.organization?.adopted?.name ?? 'the organization';
    void organizationRequest(() => api.postOrganizationLeave(), `Stopped using ${name}’s Daily Focus settings. Restarting the dashboard…`);
  },
  checkOrganizations: () => void organizationRequest(() => api.postOrganizationCheck(), 'Looked again for your organizations’ Daily Focus settings'),
};

/** What the setup under review calls itself, for a toast. */
function reviewName(org: string): string {
  const review = ui.organizationReview.value?.review;
  if (review && typeof review === 'object' && 'name' in review) return review.name;
  return state.value?.organization?.offers.find((offer) => offer.org === org)?.name ?? org;
}
