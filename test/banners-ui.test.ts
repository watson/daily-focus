import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mount, mountOne, uiWith } from './dom.ts';
import { renderBanners } from '../client/banners.ts';
import { Header } from '../client/chrome.ts';
import type { UiValues } from '../client/types.ts';
import type { DashboardState } from '../src/types.ts';

function render(brief: Record<string, unknown>, problem: string | null = null): HTMLElement {
  const state = {
    brief: { generatedAt: '2026-09-10T06:30:00Z', ageHours: 24, ...brief },
    schedule: { runsToday: true },
    problem,
    warnings: [],
  } as unknown as DashboardState;
  return mount(h('div', null, renderBanners(state, uiWith(), handlersWith())));
}

test('the refresh grace period explains the wait without a warning', () => {
  const container = render({ refreshPending: true, stale: false });
  assert.equal(byClass(container, 'banner--info').length, 1);
  assert.equal(byClass(container, 'banner--warning').length, 0);
  assert.match(container.textContent!, /The morning agent may still be preparing today's brief\./);
});

test('after the grace period the missed-run warning returns', () => {
  const container = render({ refreshPending: false, stale: true });
  assert.equal(byClass(container, 'banner--warning').length, 1);
  assert.match(container.textContent!, /24 hours old\. The morning agent may not have run\./);
});

test('a broken brief takes precedence over refresh reassurance', () => {
  const container = render({ refreshPending: true, stale: false }, 'Cannot read the brief');
  assert.equal(byClass(container, 'banner--critical').length, 1);
  assert.equal(byClass(container, 'banner--info').length, 0);
});

function renderWithRun(last: Record<string, unknown> | null, brief: Record<string, unknown> = {}, ui: Partial<UiValues> = {}) {
  const calls: string[] = [];
  const handlers = handlersWith({
    runAgent: () => void calls.push('run'),
    stopAgent: () => void calls.push('stop'),
    dismissAgentRun: () => void calls.push('dismiss'),
    openRun: (id) => void calls.push(`open ${id}`),
  });
  const state = {
    now: '2026-09-24T12:00:00Z',
    brief: { generatedAt: '2026-09-23T06:30:00Z', ageHours: 30, refreshPending: false, stale: false, ...brief },
    schedule: { runsToday: true },
    problem: null,
    warnings: [],
    agentRun: { enabled: true, cli: 'codex', last },
  } as unknown as DashboardState;
  const container = mount(h('div', null, renderBanners(state, uiWith(ui), handlers)));
  return { container, calls };
}

const RUN = { id: 'r1', cli: 'codex', trigger: 'hand', sessionId: null, startedAt: '2026-09-24T11:50:00Z', endedAt: null, error: null, turns: [] };

test('a stale brief offers to run the agent when the dashboard may', () => {
  const { container } = renderWithRun(null, { stale: true });
  assert.match(container.textContent!, /may not have run/);
  assert.match(container.textContent!, /Run it now/);
});

test('a running agent replaces the guesses about when the brief comes, in one line with Stop', () => {
  const { container, calls } = renderWithRun(
    { ...RUN, status: 'running', report: '**Reading** the calendar', messages: ['**Reading** the calendar'] },
    { stale: true },
  );
  assert.doesNotMatch(container.textContent!, /may not have run/);
  assert.match(container.textContent!, /writing a new brief/);
  // What it is saying belongs to the panel, not the strip.
  assert.doesNotMatch(container.textContent!, /Reading the calendar/);
  assert.deepEqual(buttonLabels(container), ['Stop']);
  // The strip itself is the way into the panel; its button is not.
  const strip = byClass(container, 'banner--link')[0]!;
  strip.click();
  byTag(strip, 'button')[0]!.click();
  assert.deepEqual(calls, ['open r1', 'stop']);
});

test('a finished run needs no banner at all', () => {
  const done = { ...RUN, status: 'done', trigger: 'schedule', endedAt: '2026-09-24T11:58:00Z', report: 'Wrote 6 items.' };
  const { container } = renderWithRun(done);
  assert.equal(byClass(container, 'banner').length, 0);
});

test('a failed run is a warning that says why, offers another go, and opens its panel until dismissed', () => {
  const failed = { ...RUN, status: 'failed', endedAt: '2026-09-24T11:51:00Z', report: '', error: 'codex exited with code 2' };
  const { container, calls } = renderWithRun(failed);
  assert.equal(byClass(container, 'banner--warning').length, 1);
  assert.match(container.textContent!, /code 2/);
  assert.deepEqual(buttonLabels(container), ['Run it now', 'Dismiss']);
  byClass(container, 'banner--link')[0]!.click();
  assert.deepEqual(calls, ['open r1']);
  assert.equal(byClass(renderWithRun(failed, {}, { agentReportSeen: 'r1' }).container, 'banner').length, 0);
  const lastWeek = { ...failed, startedAt: '2026-09-17T11:50:00Z' };
  assert.equal(byClass(renderWithRun(lastWeek).container, 'banner').length, 0);
});

test('a lost connection is a header pill, not a banner', () => {
  const header = (error: Error | null) =>
    byClass(mountOne(h(Header, { state: null, ui: uiWith({ connectionError: error }), handlers: handlersWith() })), 'connection')[0]!;

  const down = header(new Error('lost connection to the server'));
  assert.equal(down.hidden, false);
  assert.match(down.title, /lost connection to the server/);

  assert.equal(header(null).hidden, true);

  // And the banners no longer hear about it at all: the pill is the one place.
  const container = render({ refreshPending: false, stale: false });
  assert.doesNotMatch(container.textContent!, /connection/i);
});
