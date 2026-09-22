/** Wiring: state, optimistic actions, keyboard, theme. */

import {
  fetchState,
  postAction,
  postBoardRefresh,
  postSession,
  postTicketTransition,
  postTicketsRefresh,
  subscribe,
} from './api.js';
import { localDateKey } from './format.js';
import {
  clock,
  renderAgenda,
  renderBanners,
  renderBoard,
  renderHeadline,
  renderHeader,
  renderObjective,
  renderTimer,
  renderSections,
  renderStats,
  renderTabs,
  renderTicketBoard,
} from './render.js';

let state = null;

/** Which view the page is on. Persisted: a pinned tab should come back where it was. */
const VIEW_KEY = 'daily-focus:view';

/**
 * The panels, by name. Each name is also the id of its panel element, which is
 * what `visibleItemIds` and the scroll-into-view selector depend on, and what the
 * stylesheet keys `body[data-view]` off.
 */
const VIEWS = ['today', 'board', 'tickets'];

/**
 * Which self-closed session has already been acknowledged, by its end time.
 *
 * In localStorage rather than the store: whether a notice has been read is a fact
 * about this browser, and the store is a contract with the agent — not somewhere to
 * keep the dashboard's own bookkeeping.
 */
const UNATTENDED_SEEN_KEY = 'daily-focus:unattended-seen';

/** Transient view state that never round-trips to the server. */
const ui = {
  selectedId: null,
  pending: new Set(),
  menuFor: null,
  /** Which ticket has its status menu open. Separate from `menuFor`, so the park
   *  menu and the status menu can never be open on the same row at once. */
  statusFor: null,
  noteFor: null,
  /** Text typed into the open note form but not saved yet. See `discardNote`. */
  noteDraft: '',
  connectionError: null,
  /** Mirror the running session so item rows can show their own state. */
  activeSessionId: null,
  sessionOverrun: false,
  unattendedSeen: localStorage.getItem(UNATTENDED_SEEN_KEY),
  view: VIEWS.includes(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : 'today',
};

/** Last completed action, for the `u` shortcut. */
let lastAction = null;

/**
 * What a brief item was before the board parked the same id.
 *
 * The log is shared and last-action-wins, so parking a pull request the brief had
 * already marked done turns that done into a snooze. Unparking it with a plain
 * reopen would then leave the brief item open — a finished task resurrected by a
 * gesture on another tab. So unpark restores what the park replaced. Kept in
 * memory only: after a reload the plain reopen is the best that can be done.
 */
const parkedFrom = new Map();

/** The action that takes a park back: the status it replaced, or a plain reopen. */
function unpark(id) {
  const restore = parkedFrom.get(id);
  parkedFrom.delete(id);
  return applyAction(id, restore ?? 'reopen');
}

/**
 * Close the note form and drop whatever was half-written in it.
 *
 * The draft lives in `ui` precisely so it survives the re-renders that land while
 * it's being typed — which means it no longer disappears on its own, and every
 * path that closes the form has to say so, or the next note opens with the last
 * one's text still in it.
 */
function discardNote() {
  ui.noteFor = null;
  ui.noteDraft = '';
}

const handlers = {
  onAction: (id, action, extra) => void applyAction(id, action, extra),
  onSelect: (id) => {
    ui.selectedId = id;
    render();
  },
  toggleMenu: (id) => {
    ui.menuFor = ui.menuFor === id ? null : id;
    ui.statusFor = null;
    discardNote();
    render();
  },
  toggleStatus: (id) => {
    ui.statusFor = ui.statusFor === id ? null : id;
    ui.menuFor = null;
    discardNote();
    render();
  },
  moveTicket: (key, status, from) => void moveTicket(key, status, from),
  toggleNote: (id) => {
    const opening = ui.noteFor !== id;
    discardNote();
    ui.noteFor = opening ? id : null;
    ui.menuFor = null;
    ui.statusFor = null;
    render();
  },
  // Deliberately doesn't render: the field is already showing the character that
  // was just typed, and re-rendering per keystroke would fight the caret.
  onNoteDraft: (text) => {
    ui.noteDraft = text;
  },
  closeNote: () => {
    discardNote();
    render();
  },
  startSession: (id) => void changeSession({ action: 'start', id }),
  stopSession: () => void changeSession({ action: 'stop' }),
  dismissUnattended: (endedAt) => {
    ui.unattendedSeen = endedAt;
    localStorage.setItem(UNATTENDED_SEEN_KEY, endedAt);
    render();
  },
  // A nudge on Slack is invisible to GitHub, so it's recorded as a note: the agent
  // reads it as free text, and the board's nudge timer starts over from it.
  nudge: (id) => void applyAction(id, 'note', { text: 'Nudged reviewers' }),
  unpark: (id) => void unpark(id),
  refreshBoard: () => void refreshBoard(),
  refreshTickets: () => void refreshTickets(),
};

function render() {
  if (!state) return;
  ui.activeSessionId = state.session?.active?.id ?? null;
  ui.sessionOverrun = state.session?.active?.overrun === true;
  // Lets the stylesheet recede every row except the one being worked on.
  document.body.dataset.sessionActive = String(ui.activeSessionId !== null);
  document.body.dataset.view = ui.view;
  renderTabs(state, ui);
  renderTimer(state, ui, handlers);
  renderHeader(state);
  renderBanners(state, ui.connectionError);
  // Only the showing view is built. setView renders again after switching, so the
  // other one is rebuilt the moment it's looked at, and never for a hidden panel.
  if (ui.view === 'board') {
    renderBoard(state, ui, handlers);
  } else if (ui.view === 'tickets') {
    renderTicketBoard(state, ui, handlers);
  } else {
    renderObjective(state);
    renderStats(state);
    renderHeadline(state);
    renderSections(state, ui, handlers);
    renderAgenda(state);
  }
}

/* ---------- views ---------- */

/** Which panel shows is decided by `body[data-view]` in the stylesheet, and nowhere else. */
function setView(view) {
  if (ui.view === view) return;
  ui.view = view;
  localStorage.setItem(VIEW_KEY, view);
  // The selection belongs to the list it was made in.
  ui.selectedId = null;
  ui.menuFor = null;
  ui.statusFor = null;
  discardNote();
  render();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}
// Before the first state arrives, so the right panel is the one that's empty.
document.body.dataset.view = ui.view;

/**
 * Ask GitHub now rather than at the next poll.
 *
 * The server answers once the fetch has landed, so this can take a few seconds;
 * the board says "refreshing" in the meantime because the fetch start is
 * broadcast over SSE like any other change.
 */
async function refreshBoard() {
  // A held key repeats at keyboard rate; one fetch in flight is all there is to want.
  if (!state?.board?.enabled || state.board.fetching) return;
  try {
    adoptState(await postBoardRefresh());
  } catch (err) {
    showToast(`Could not refresh: ${err.message}`);
  }
}

/** The same, for Jira. Three searches through a CLI, so this one really does wait. */
async function refreshTickets() {
  if (!state?.tickets?.enabled || state.tickets.fetching) return;
  try {
    adoptState(await postTicketsRefresh());
  } catch (err) {
    showToast(`Could not refresh: ${err.message}`);
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
async function moveTicket(key, status, from) {
  const id = `jira:${key}`;
  if (ui.pending.has(id)) return;
  ui.statusFor = null;
  ui.pending.add(id);
  render();

  try {
    adoptState(await postTicketTransition(key, status));
    showToast(`${key} moved to ${status}`, from ? () => void moveTicket(key, from, null) : null);
  } catch (err) {
    // Jira refusing the move is the expected failure, not an exception: the board
    // offers the statuses it has seen, never the transitions the workflow allows.
    showToast(`Jira would not move ${key} to ${status}: ${err.message}`);
    await refresh();
  } finally {
    ui.pending.delete(id);
    render();
  }
}

/**
 * Take a state the server built on its own clock, not in reply to a click.
 *
 * Such a state may predate an action still in flight, so anything pending keeps
 * its optimistic status until that action's own reply lands. The SSE push and the
 * board refresh both arrive this way; a reply to an action does not, since it was
 * built after the action was appended.
 */
function adoptState(next) {
  for (const id of ui.pending) {
    const optimistic = state?.items.find((item) => item.id === id);
    const incoming = next.items.find((item) => item.id === id);
    if (optimistic && incoming) Object.assign(incoming, { status: optimistic.status });
    for (const rows of ['board', 'tickets']) {
      const optimisticRow = state?.[rows]?.rows.find((row) => row.id === id);
      const incomingRow = next[rows]?.rows.find((row) => row.id === id);
      if (optimisticRow && incomingRow) Object.assign(incomingRow, { status: optimisticRow.status });
    }
  }
  state = next;
  ui.connectionError = null;
  render();
  startLocalTick();
  checkAssetVersion(next.assetVersion);
}

/* ---------- actions ---------- */

const PAST_TENSE = {
  done: 'Marked done',
  dismiss: 'Dismissed',
  snooze: 'Snoozed',
  reopen: 'Restored',
  note: 'Note saved',
};

/**
 * Apply an action optimistically, then reconcile with the server.
 *
 * The click is the whole point of this dashboard, so it must feel instant; the
 * server response replaces the guess a moment later. On failure we refetch rather
 * than trying to invert the guess, since the log is the only source of truth.
 */
async function applyAction(id, action, extra = {}) {
  ui.menuFor = null;
  ui.statusFor = null;
  discardNote();
  ui.pending.add(id);

  const item = state?.items.find((candidate) => candidate.id === id);
  // The board only ever parks and unparks. The same id may be a brief item too,
  // and the log is shared, so a park from the board is a snooze on that item as
  // well — deliberately, so the agent leaves the PR alone until the date. What
  // the park replaces is remembered so unparking can put it back.
  const row =
    state?.board?.rows.find((candidate) => candidate.id === id) ??
    state?.tickets?.rows.find((candidate) => candidate.id === id);
  if (row && action === 'snooze' && item && (item.status === 'done' || item.status === 'dismissed')) {
    parkedFrom.set(id, item.status === 'done' ? 'done' : 'dismiss');
  }
  if (item && action !== 'note') {
    item.status = action === 'reopen' ? 'open' : action === 'dismiss' ? 'dismissed' : action === 'done' ? 'done' : 'snoozed';
    item.statusAt = new Date().toISOString();
    if (action === 'snooze') item.snoozedUntil = extra.until;
  }
  if (row && action !== 'note') {
    row.status = action === 'snooze' ? 'snoozed' : 'open';
    row.snoozedUntil = action === 'snooze' ? extra.until : undefined;
  }
  render();

  try {
    state = await postAction({ id, action, ...extra });
    ui.pending.delete(id);
    render();

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
    ui.pending.delete(id);
    await refresh();
    showToast(`Could not save: ${err.message}`);
  }
}

async function refresh() {
  try {
    state = await fetchState();
    checkAssetVersion(state.assetVersion);
    ui.connectionError = null;
  } catch (err) {
    ui.connectionError = err;
  }
  render();
}

/* ---------- focus sessions ---------- */

async function changeSession(body) {
  // Asking on a real click is the only time the browser will grant it.
  if (body.action === 'start' && 'Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
  try {
    state = await postSession(body);
    render();
    startLocalTick();
  } catch (err) {
    showToast(`Could not change the timer: ${err.message}`);
  }
}

/**
 * Tick the clock locally between server pushes.
 *
 * Everything is derived from the server's `endsAt`, never accumulated locally —
 * a background tab gets its timers throttled, so counting ticks would drift badly
 * over 25 minutes while reading a wall clock stays exact.
 */
let tickTimer = null;
let announcedOverrunFor = null;

function startLocalTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  tick();
}

function tick() {
  const active = state?.session?.active;
  if (!active) {
    document.title = 'Daily Focus';
    clearInterval(tickTimer);
    tickTimer = null;
    return;
  }

  const remaining = Math.round((new Date(active.endsAt).getTime() - Date.now()) / 1000);
  active.remainingSeconds = remaining;
  active.overrun = remaining < 0;

  // The tab strip is where this is read from, most of the time.
  const mm = Math.floor(Math.abs(remaining) / 60);
  const ss = String(Math.floor(Math.abs(remaining) % 60)).padStart(2, '0');
  document.title = `${remaining < 0 ? '+' : ''}${mm}:${ss} · ${active.title}`;

  if (remaining <= 0 && announcedOverrunFor !== active.startedAt) {
    announcedOverrunFor = active.startedAt;
    announceSessionEnd(active);
  }

  // Tick the row's badge in place. Re-rendering the whole list every second
  // would drop hover states and close any open menu mid-use.
  const rowClock = document.querySelector('.item__running-clock');
  if (rowClock) rowClock.textContent = clock(remaining);
  const row = document.querySelector('.item[data-running="true"]');
  if (row) row.dataset.overrun = String(remaining < 0);

  renderTimer(state, ui, handlers);
}

/**
 * A check-in, not a finish line.
 *
 * "Session complete" invites you to stop something that might be going well.
 * The useful question at the target is whether you're still on the thing you
 * said you'd be on — which is the moment a wandering attention gets caught.
 */
function announceSessionEnd(active) {
  const label = active.minutes === 1 ? '1 minute' : `${active.minutes} minutes`;
  showToast(`${label} in — still on "${active.title}"?`, null);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`Still on this?`, {
      body: `${label} in on ${active.title}. Keep going, or stop and log it.`,
      tag: 'daily-focus-session',
    });
  }
}

/* ---------- toast ---------- */

let toastTimer = null;

function showToast(message, onUndo) {
  const toast = document.getElementById('toast');
  toast.replaceChildren(document.createTextNode(message));

  if (onUndo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Undo';
    button.addEventListener('click', () => {
      hideToast();
      onUndo();
    });
    toast.append(button);
  }

  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast').hidden = true;
}

/* ---------- keyboard ---------- */

/** Ids of the items currently on screen, in visual order. Only the showing view counts. */
function visibleItemIds() {
  return [...document.querySelectorAll(`#${ui.view} .item`)].map((node) => node.dataset.id);
}

function moveSelection(delta) {
  const ids = visibleItemIds();
  if (ids.length === 0) return;
  const current = ids.indexOf(ui.selectedId);
  const next = current === -1 ? (delta > 0 ? 0 : ids.length - 1) : current + delta;
  ui.selectedId = ids[Math.max(0, Math.min(ids.length - 1, next))];
  render();
  // Scoped to the showing view: the same id can be a row in both lists, and the
  // hidden one comes first in the document.
  document
    .querySelector(`#${ui.view} .item[data-selected="true"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The selected brief item or board row. Rows carry `court`, items carry `kind`. */
function selectedItem() {
  if (!state || ui.selectedId === null) return null;
  const list =
    ui.view === 'board'
      ? (state.board?.rows ?? [])
      : ui.view === 'tickets'
        ? (state.tickets?.rows ?? [])
        : state.items;
  return list.find((entry) => entry.id === ui.selectedId) ?? null;
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

document.addEventListener('keydown', (event) => {
  const help = document.getElementById('help');

  if (event.key === 'Escape') {
    if (ui.menuFor || ui.statusFor || ui.noteFor) {
      ui.menuFor = null;
      ui.statusFor = null;
      discardNote();
      render();
    }
    return;
  }

  // Never steal keys from a field the user is typing in.
  const target = event.target;
  if (target instanceof HTMLElement && target.matches('input, textarea, select')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (help.open) return;

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
      if (ui.view !== 'today') return;
      event.preventDefault();
      setFocusMode(document.body.dataset.focusMode !== 'true');
      return;
    case '1':
      event.preventDefault();
      setView('today');
      return;
    case '2':
      event.preventDefault();
      setView('board');
      return;
    case '3':
      event.preventDefault();
      setView('tickets');
      return;
    case 'r':
      if (ui.view === 'board') {
        event.preventDefault();
        void refreshBoard();
      } else if (ui.view === 'tickets') {
        event.preventDefault();
        void refreshTickets();
      }
      return;
    case '?':
      event.preventDefault();
      help.showModal();
      return;
    case 'u':
      if (lastAction && lastAction.action !== 'reopen') {
        event.preventDefault();
        void unpark(lastAction.id);
      }
      return;
  }

  const item = selectedItem();
  if (!item) return;
  // A board row — pull request or ticket — can be parked and annotated, but not
  // done, dismissed or timed. Both show what is still true upstream, and neither
  // is put right from here.
  const boardRow = ui.view !== 'today';

  switch (event.key) {
    case 'e':
      event.preventDefault();
      if (!boardRow && item.status === 'open') void applyAction(item.id, 'done');
      break;
    case 's':
      event.preventDefault();
      if (item.status === 'open') void applyAction(item.id, 'snooze', { until: tomorrow() });
      break;
    case 'x':
      event.preventDefault();
      if (!boardRow && item.status === 'open') void applyAction(item.id, 'dismiss');
      break;
    case 'n':
      event.preventDefault();
      handlers.toggleNote(item.id);
      break;
    case 'p':
      event.preventDefault();
      if (boardRow) break;
      if (ui.activeSessionId === item.id) handlers.stopSession();
      else if (item.status === 'open' && item.kind === 'task') handlers.startSession(item.id);
      break;
    case 'o':
      if (item.url) {
        event.preventDefault();
        window.open(item.url, '_blank', 'noopener');
      }
      break;
  }
});

// Click-away closes the snooze menu. The toggle button is excluded so its own
// click doesn't immediately undo itself as the event bubbles up here.
document.addEventListener('click', (event) => {
  if (!ui.menuFor && !ui.statusFor) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.closest('.menu') || target.closest('[aria-expanded]'))) return;
  ui.menuFor = null;
  ui.statusFor = null;
  render();
});

/* ---------- self-reload when the UI changes ---------- */

/**
 * The SSE stream carries state, never code. Without this, editing a renderer
 * leaves this tab showing fresh data through stale markup — indistinguishable
 * from the change not working, and easily missed for days on a pinned tab.
 */
let loadedAssetVersion = null;

function checkAssetVersion(next) {
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

/* ---------- focus mode ---------- */

/**
 * Collapse the page to the objective, the single top-ranked item and the agenda.
 * Persisted, because the point is to still be in it after you come back from the
 * thing that distracted you.
 */
function setFocusMode(on) {
  document.body.dataset.focusMode = String(on);
  document.getElementById('focus-bar').hidden = !on;
  if (on) localStorage.setItem('daily-focus:focus-mode', '1');
  else localStorage.removeItem('daily-focus:focus-mode');
}

setFocusMode(localStorage.getItem('daily-focus:focus-mode') === '1');
document.getElementById('focus-exit').addEventListener('click', () => setFocusMode(false));

/* ---------- theme ---------- */

/**
 * Cycle system → light → dark.
 *
 * There was a toggle here once, and it was removed for two reasons that both had
 * to be answered before it could come back.
 *
 * The first was a bug. It stored light or dark and offered no way back, and the
 * page re-stamped that choice before every paint — so a machine set to follow the
 * clock stayed pinned to whichever mode had been chosen once, months earlier. The
 * answer is that "system" is a state in the cycle and the default, so handing the
 * decision back to the OS is one press rather than a storage edit. It clears the
 * stored value instead of recording itself, which is also what a browser that has
 * never been told does, and the stylesheet reaches it through
 * `color-scheme: light dark`, which re-evaluates itself when the OS flips.
 *
 * The second was that a three-state cycle has a press that changes nothing on
 * screen, because "system" renders identically to whichever mode the OS is
 * already in — and a button that appears dead gets pressed again. So the button
 * reports the state as well as changing it: one glyph per state, and a label
 * naming both where you are and where the next press goes. That makes it the
 * icon's job to be legible in all three, which is why `system` is the sliced
 * sun-and-moon rather than a third shade of the same shape.
 *
 * Nothing here listens to `prefers-color-scheme`. The old version had to, to keep
 * a label reading "switch to dark" honest while the OS flipped underneath it; a
 * label naming the state rather than the rendering has nothing to keep up with.
 */

const THEME_KEY = 'daily-focus:theme';
const THEME_CYCLE = ['system', 'light', 'dark'];

/** The action the next press performs, and the state you are in now. */
const THEME_NEXT = {
  system: 'Follow the system theme',
  light: 'Switch to light mode',
  dark: 'Switch to dark mode',
};
const THEME_NOW = {
  system: 'now following the system',
  light: 'now light',
  dark: 'now dark',
};

const themeToggle = document.getElementById('theme-toggle');

function currentTheme() {
  const stamped = document.documentElement.dataset.theme;
  return THEME_CYCLE.includes(stamped) ? stamped : 'system';
}

function nextTheme(mode) {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
}

function describeTheme() {
  const mode = currentTheme();
  const label = `${THEME_NEXT[nextTheme(mode)]} (${THEME_NOW[mode]})`;
  themeToggle.title = label;
  themeToggle.setAttribute('aria-label', label);
}

themeToggle.addEventListener('click', () => {
  const mode = nextTheme(currentTheme());
  document.documentElement.dataset.theme = mode;
  // Storing `system` would render the same, but leaving nothing behind is what
  // makes it the same state a browser that has never been told is already in.
  if (mode === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
  describeTheme();
});

describeTheme();

document.getElementById('help-toggle').addEventListener('click', () => {
  document.getElementById('help').showModal();
});

/* ---------- boot ---------- */

await refresh();
startLocalTick();

subscribe(
  // A server push is authoritative, but must not yank a row out from under an
  // in-flight click; adoptState keeps anything pending at its optimistic status.
  (next) => adoptState(next),
  (err) => {
    ui.connectionError = err;
    render();
  },
);
