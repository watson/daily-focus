/**
 * Boot: mount the page, keep the body's attributes and the panel honest as the
 * state changes, then fetch the first state and listen for the rest.
 */

import { effect } from '@preact/signals';
import { h, render } from 'preact';

import { adoptState, handlers, refresh, startLocalTick } from './actions.ts';
import { subscribe } from './api.ts';
import { App } from './app.ts';
import { installKeyboard } from './keyboard.ts';
import { RUN_PREFIX, availableViews, detailRow, detailRun, setDetailFor, state, ui } from './state.ts';
import { stampedTheme } from './theme.ts';

// The stamp in index.html ran before first paint; the toggle's label starts
// from what it decided.
ui.theme.value = stampedTheme();

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app to render into');
render(h(App, { ui, handlers }), root);

/* ---------- what the stylesheet keys off the body ---------- */

effect(() => {
  document.body.dataset.view = ui.view.value;
});
effect(() => {
  document.body.dataset.focusMode = String(ui.focusMode.value);
});
effect(() => {
  document.body.dataset.offline = String(ui.connectionError.value !== null);
});
// Lets the stylesheet recede every row except the one being worked on.
effect(() => {
  document.body.dataset.sessionActive = String(state.value?.session.active != null);
});
effect(() => {
  const current = state.value;
  const open = current !== null && (detailRun(current, ui) !== null || detailRow(current, ui) !== null);
  document.body.dataset.flyout = open ? 'open' : 'closed';
});

/* ---------- what a new state means for the view ---------- */

// A persisted view whose board has since been switched off falls back to Today.
// Not written back, so switching the board on again returns to it.
effect(() => {
  const current = state.value;
  if (current && !availableViews(current).includes(ui.view.value)) ui.view.value = 'today';
});

// A run that has just started takes the panel with it, if the panel is open on
// a run at all: whoever is looking at the stopped one is looking for what
// happens next, and the clock's run should be as visible as a click's. Only on
// the change, so browsing an earlier run while one goes is left alone.
let runningRun: string | null = null;
effect(() => {
  const current = state.value;
  if (!current) return;
  const runningNow = current.agentRun?.last?.status === 'running' ? current.agentRun.last.id : null;
  if (runningNow && runningNow !== runningRun && ui.detailFor.peek()?.startsWith(RUN_PREFIX)) {
    setDetailFor(ui, `${RUN_PREFIX}${runningNow}`);
  }
  runningRun = runningNow;
});

// A row that has gone from everywhere takes the panel with it, rather than
// leaving one open on nothing; so does a run that has dropped off the list.
effect(() => {
  const current = state.value;
  if (!current || !ui.detailFor.value) return;
  if (!detailRun(current, ui) && !detailRow(current, ui)) setDetailFor(ui, null);
});

installKeyboard(handlers);

/* ---------- boot ---------- */

await refresh();
startLocalTick();

subscribe(
  // A server push is authoritative, but must not yank a row out from under an
  // in-flight click; adoptState keeps anything pending at its optimistic status.
  (next) => adoptState(next),
  (err) => {
    ui.connectionError.value = err;
  },
);
