/**
 * Everything the page does: the handlers the renderers call, the optimistic
 * actions, the live state feed, the clock and the toast.
 *
 * Nothing here renders. A handler writes state and view signals, and the
 * components that read them are rerun by Preact.
 */

import { batch } from '@preact/signals';

import type { ActionType, ActiveSession, BoardRow, DashboardState, ItemStatus, TicketRow } from '../src/types.ts';
import * as api from './api.ts';
import {
  AGENT_RUN_SEEN_KEY,
  FOCUS_MODE_KEY,
  RUN_PREFIX,
  UNATTENDED_SEEN_KEY,
  VIEW_KEY,
  availableViews,
  setDetailFor,
  state,
  ui,
} from './state.ts';
import { applyTheme, nextTheme } from './theme.ts';
import { remainingSeconds } from './timer.ts';
import type { ActionExtra, FocusField, Handlers, SettingsPage, TextEditor, TextName, TicketMode, View } from './types.ts';

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

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, onUndo: (() => void) | null = null): void {
  ui.toast.value = { message, onUndo };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

export function hideToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  ui.toast.value = null;
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
  });
  startLocalTick();
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
    showToast('A new version of the dashboard is ready', () => location.reload());
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
};

/** Last completed action, for the `u` shortcut. */
let lastAction: { id: string; action: ActionType } | null = null;

/**
 * What a brief item was before the board parked the same id.
 *
 * The log is shared and last-action-wins, so parking a pull request the brief had
 * already marked done turns that done into a snooze. Unparking it with a plain
 * reopen would then leave the brief item open — a finished task resurrected by a
 * gesture on another tab. So unpark restores what the park replaced. Kept in
 * memory only: after a reload the plain reopen is the best that can be done.
 */
const parkedFrom = new Map<string, 'done' | 'dismiss'>();

/** The action that takes a park back: the status it replaced, or a plain reopen. */
function unpark(id: string): Promise<void> {
  const restore = parkedFrom.get(id);
  parkedFrom.delete(id);
  return applyAction(id, restore ?? 'reopen');
}

/** Take back the last action, for the `u` key. A reopen has nothing to take back. */
export function undoLast(): void {
  if (lastAction && lastAction.action !== 'reopen') void unpark(lastAction.id);
}

/** The state as it will read once the server agrees, which it almost always does. */
function optimistic(current: DashboardState, id: string, action: Exclude<ActionType, 'note'>, extra: ActionExtra): DashboardState {
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
    // The board only ever parks and unparks. The same id may be a brief item too,
    // and the log is shared, so a park from the board is a snooze on that item as
    // well — deliberately, so the agent leaves the PR alone until the date. What
    // the park replaces is remembered so unparking can put it back.
    const row =
      current.board?.rows.find((candidate) => candidate.id === id) ??
      current.tickets?.rows.find((candidate) => candidate.id === id);
    if (row && action === 'snooze' && item && (item.status === 'done' || item.status === 'dismissed')) {
      parkedFrom.set(id, item.status === 'done' ? 'done' : 'dismiss');
    }
    if (action !== 'note') state.value = optimistic(current, id, action, extra);
  });

  try {
    state.value = await api.postAction({ id, action, ...extra });
    removePending(id);

    // A note is append-only and can't be taken back, and "undoing" it with a
    // reopen would rewrite the status of whatever else shares the id. So notes
    // get no Undo and don't become the target of `u`.
    if (action === 'note') {
      showToast(PAST_TENSE[action]);
      return;
    }
    lastAction = { id, action };
    if (action === 'reopen') {
      showToast(PAST_TENSE[action]);
    } else {
      showToast(PAST_TENSE[action], () => void unpark(id));
    }
  } catch (err) {
    removePending(id);
    await refresh();
    showToast(`Could not save: ${(err as Error).message}`);
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
  } catch (err) {
    showToast(`Could not refresh: ${(err as Error).message}`);
  }
}

/** The same, for Jira. Three searches through a CLI, so this one really does wait. */
async function refreshTickets(): Promise<void> {
  if (!state.value?.tickets?.enabled || state.value.tickets.fetching) return;
  try {
    adoptState(await api.postTicketsRefresh());
  } catch (err) {
    showToast(`Could not refresh: ${(err as Error).message}`);
  }
}

/** The same, for the calendar: only ever asked for by the agenda's Retry, so only while a read is failing. */
async function refreshCalendar(): Promise<void> {
  if (state.value?.agendaSource?.failure?.retrying) return;
  try {
    adoptState(await api.postCalendarRefresh());
  } catch (err) {
    showToast(`Could not refresh: ${(err as Error).message}`);
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
    showToast(`${key} moved to ${status}`, from ? () => void moveTicket(key, from, null) : null);
  } catch (err) {
    // Jira refusing the move is the expected failure, not an exception: the board
    // offers the statuses it has seen, never the transitions the workflow allows.
    showToast(`Jira would not move ${key} to ${status}: ${(err as Error).message}`);
    await refresh();
  } finally {
    removePending(id);
  }
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
    showToast(`Could not ask: ${(err as Error).message}`);
  }
}

async function stopAssistant(id: string): Promise<void> {
  try {
    adoptState(await api.postAssistantStop(id));
  } catch (err) {
    showToast(`Could not stop: ${(err as Error).message}`);
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
    showToast(`Could not start the morning agent: ${(err as Error).message}`);
  }
}

async function stopAgent(): Promise<void> {
  try {
    adoptState(await api.postAgentStop());
  } catch (err) {
    showToast(`Could not stop the morning agent: ${(err as Error).message}`);
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
    showToast(`Could not ask the morning agent: ${(err as Error).message}`);
  }
}

/* ---------- focus sessions ---------- */

async function changeSession(body: { action: 'start'; id: string } | { action: 'stop' }): Promise<void> {
  // Asking on a real click is the only time the browser will grant it.
  if (body.action === 'start' && 'Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
  try {
    state.value = await api.postSession(body);
    startLocalTick();
  } catch (err) {
    showToast(`Could not change the timer: ${(err as Error).message}`);
  }
}

/**
 * Tick the clock locally between server pushes.
 *
 * Everything is derived from the server's `endsAt`, never accumulated locally —
 * a background tab gets its timers throttled, so counting ticks would drift badly
 * over 25 minutes while reading a wall clock stays exact. The tick writes one
 * signal, and only the strip and the running row read it.
 */
let tickTimer: ReturnType<typeof setInterval> | null = null;
let announcedOverrunFor: string | null = null;

export function startLocalTick(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  tick();
}

function tick(): void {
  const active = state.value?.session.active;
  if (!active) {
    document.title = 'Daily Focus';
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    return;
  }

  const nowMs = Date.now();
  ui.clock.value = nowMs;
  const remaining = remainingSeconds(active, nowMs);

  // The tab strip is where this is read from, most of the time.
  const mm = Math.floor(Math.abs(remaining) / 60);
  const ss = String(Math.floor(Math.abs(remaining) % 60)).padStart(2, '0');
  document.title = `${remaining < 0 ? '+' : ''}${mm}:${ss} · ${active.title}`;

  if (remaining <= 0 && announcedOverrunFor !== active.startedAt) {
    announcedOverrunFor = active.startedAt;
    announceSessionEnd(active);
  }
}

/**
 * A check-in, not a finish line.
 *
 * "Session complete" invites you to stop something that might be going well.
 * The useful question at the target is whether you're still on the thing you
 * said you'd be on — which is the moment a wandering attention gets caught.
 */
function announceSessionEnd(active: ActiveSession): void {
  const label = active.minutes === 1 ? '1 minute' : `${active.minutes} minutes`;
  showToast(`${label} in — still on "${active.title}"?`, null);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Still on this?', {
      body: `${label} in on ${active.title}. Keep going, or stop and log it.`,
      tag: 'daily-focus-session',
    });
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
 * Switch the ticket tab between its two views. The selection and anything open
 * go with it, as they do between tabs: they belong to the list they were made in.
 */
function setTicketMode(mode: TicketMode): void {
  if (ui.ticketMode.value === mode) return;
  batch(() => {
    ui.ticketMode.value = mode;
    ui.selectedId.value = null;
    closeMenus();
  });
}

/**
 * Collapse the page to the objective, the single top-ranked item and the agenda.
 * Persisted, because the point is to still be in it after you come back from the
 * thing that distracted you.
 */
function setFocusMode(on: boolean): void {
  ui.focusMode.value = on;
  remember(FOCUS_MODE_KEY, on ? '1' : null);
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
 * second makes a setup step tick over as soon as its choice has taken effect.
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
    showToast(`Could not load the settings: ${(err as Error).message}`);
  }
}

/** Save `values`, which is the draft for the page's Save, or a setup step's one choice. */
async function sendSettings(values: Record<string, string | null>, fromDraft: boolean): Promise<void> {
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
      if (fromDraft) {
        const draft = new Map(ui.settingsDraft.value);
        for (const [key, value] of Object.entries(values)) if (draft.get(key) === value) draft.delete(key);
        ui.settingsDraft.value = draft;
      }
    });
    restartToast(page);
    if (page.restart === 'waiting') void followRestart();
  } catch (err) {
    if (fromDraft) ui.settingsError.value = (err as Error).message;
    else showToast(`Could not save: ${(err as Error).message}`);
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
    showToast(`Could not open ${name === 'focus' ? 'focus.md' : 'sources.md'}: ${(err as Error).message}`);
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
      showToast(`Could not save: ${failure.message}`);
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
    showToast(`Could not save the objective: ${(err as Error).message}`);
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
    if (ui.openDrawers.value.has(key) === open) return;
    const next = new Set(ui.openDrawers.value);
    if (open) next.add(key);
    else next.delete(key);
    ui.openDrawers.value = next;
  },
  setTicketMode,
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
  startSession: (id) => void changeSession({ action: 'start', id }),
  stopSession: () => void changeSession({ action: 'stop' }),
  dismissUnattended: (endedAt) => {
    ui.unattendedSeen.value = endedAt;
    remember(UNATTENDED_SEEN_KEY, endedAt);
  },
  // A nudge on Slack is invisible to GitHub, so it's recorded as a note: the agent
  // reads it as free text, and the board's nudge timer starts over from it.
  nudge: (id) => void applyAction(id, 'note', { text: 'Nudged reviewers' }),
  unpark: (id) => void unpark(id),
  refreshBoard: () => void refreshBoard(),
  refreshTickets: () => void refreshTickets(),
  refreshCalendar: () => void refreshCalendar(),
  ask: (id, body) => void ask(id, body),
  stopAssistant: (id) => void stopAssistant(id),
  runAgent: () => void runAgent(),
  stopAgent: () => void stopAgent(),
  askAgent: (run, text) => void askAgent(run, text),
  dismissAgentRun: (id) => {
    ui.agentReportSeen.value = id;
    remember(AGENT_RUN_SEEN_KEY, id);
  },
  toggleMessage: (key, open) => {
    const next = new Map(ui.messageOpen.value);
    if (open === null) next.delete(key);
    else next.set(key, open);
    ui.messageOpen.value = next;
  },
  toggleTheme: () => {
    const mode = nextTheme(ui.theme.value);
    applyTheme(mode);
    ui.theme.value = mode;
  },
  setFocusMode,
  openHelp: () => (document.getElementById('help') as HTMLDialogElement | null)?.showModal(),
  hideToast,
  openSettings,
  closeSettings: () => setView(ui.settingsReturn.value),
  loadSettings: () => void loadSettings(),
  editSetting,
  discardSettings: () =>
    batch(() => {
      ui.settingsDraft.value = new Map();
      ui.settingsError.value = null;
    }),
  saveSettings: (keys) =>
    void sendSettings(Object.fromEntries([...ui.settingsDraft.value].filter(([key]) => !keys || keys.includes(key))), true),
  chooseSettings: (values) => void sendSettings(values, false),
  loadText: (name) => void loadText(name),
  editText: (name, text) => patchText(name, { draft: text }),
  saveText: (name, overwrite) => void saveText(name, overwrite),
  reloadText: (name) => void loadText(name),
  saveObjective: (objective, blocker) => void saveObjective(objective, blocker),
  listCalendars: () => void listCalendars(),
};
