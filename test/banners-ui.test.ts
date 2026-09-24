import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StubElement, byClass, byTag } from './dom-stub.ts';

const { renderBanners, renderConnection } = await import('../public/render.js');

function render(brief: Record<string, unknown>, problem: string | null = null) {
  const container = new StubElement('div');
  container.replaceChildren = (...children: StubElement[]) => { container.childNodes = children; };
  Object.assign((globalThis as unknown as { document: object }).document, { getElementById: () => container });
  renderBanners({
    brief: { generatedAt: '2026-09-10T06:30:00Z', ageHours: 24, ...brief },
    schedule: { runsToday: true },
    problem,
    warnings: [],
  });
  return container;
}

test('the refresh grace period explains the wait without a warning', () => {
  const container = render({ refreshPending: true, stale: false });
  assert.equal(byClass(container, 'banner--info').length, 1);
  assert.equal(byClass(container, 'banner--warning').length, 0);
  assert.match(container.textContent, /The morning agent may still be preparing today's brief\./);
});

test('after the grace period the missed-run warning returns', () => {
  const container = render({ refreshPending: false, stale: true });
  assert.equal(byClass(container, 'banner--warning').length, 1);
  assert.match(container.textContent, /24 hours old\. The morning agent may not have run\./);
});

test('a broken brief takes precedence over refresh reassurance', () => {
  const container = render({ refreshPending: true, stale: false }, 'Cannot read the brief');
  assert.equal(byClass(container, 'banner--critical').length, 1);
  assert.equal(byClass(container, 'banner--info').length, 0);
});

function renderWithRun(last: Record<string, unknown> | null, brief: Record<string, unknown> = {}, ui = {}) {
  const container = new StubElement('div');
  container.replaceChildren = (...children: StubElement[]) => { container.childNodes = children; };
  Object.assign((globalThis as unknown as { document: object }).document, { getElementById: () => container });
  const calls: string[] = [];
  const handlers = { runAgent: () => calls.push('run'), stopAgent: () => calls.push('stop'), dismissAgentRun: () => calls.push('dismiss') };
  renderBanners(
    {
      now: '2026-09-24T12:00:00Z',
      brief: { generatedAt: '2026-09-23T06:30:00Z', ageHours: 30, refreshPending: false, stale: false, ...brief },
      schedule: { runsToday: true },
      problem: null,
      warnings: [],
      agentRun: { enabled: true, cli: 'codex', last },
    },
    ui,
    handlers,
  );
  return { container, calls };
}

const RUN = { id: 'r1', cli: 'codex', sessionId: null, startedAt: '2026-09-24T11:50:00Z', endedAt: null, error: null };

test('a stale brief offers to run the agent when the dashboard may', () => {
  const { container } = renderWithRun(null, { stale: true });
  assert.match(container.textContent, /may not have run/);
  assert.match(container.textContent, /Run it now/);
});

test('a running agent replaces the guesses about when the brief comes', () => {
  const { container } = renderWithRun({ ...RUN, status: 'running', report: '**Reading** the calendar' }, { stale: true });
  assert.doesNotMatch(container.textContent, /may not have run/);
  assert.match(container.textContent, /writing a new brief/);
  assert.match(container.textContent, /Reading the calendar/);
  assert.match(container.textContent, /Stop/);
});

test("a finished run shows today's report until it is dismissed", () => {
  const done = { ...RUN, status: 'done', endedAt: '2026-09-24T11:58:00Z', report: 'Wrote 6 items.' };
  assert.match(renderWithRun(done).container.textContent, /Wrote 6 items\./);
  assert.doesNotMatch(renderWithRun(done, {}, { agentReportSeen: 'r1' }).container.textContent, /Wrote 6 items/);
  // Opened, it stays open through the next state push, which rebuilds the banner.
  const open = renderWithRun(done, {}, { agentReportOpen: 'r1' }).container;
  assert.equal(byTag(open, 'DETAILS')[0]!.open, true);
  const lastWeek = { ...done, startedAt: '2026-09-17T11:50:00Z' };
  assert.doesNotMatch(renderWithRun(lastWeek).container.textContent, /Wrote 6 items/);
});

test('a failed run is a warning that says why and offers another go', () => {
  const failed = { ...RUN, status: 'failed', endedAt: '2026-09-24T11:51:00Z', report: '', error: 'codex exited with code 2' };
  const { container } = renderWithRun(failed);
  assert.equal(byClass(container, 'banner--warning').length, 1);
  assert.match(container.textContent, /code 2/);
  assert.match(container.textContent, /Run it now/);
});

test('a lost connection is a header pill, not a banner', () => {
  const pill = new StubElement('span');
  const body = new StubElement('body');
  Object.assign((globalThis as unknown as { document: object }).document, {
    getElementById: () => pill,
    body,
  });

  renderConnection(new Error('lost connection to the server'));
  assert.equal(pill.hidden, false);
  assert.equal(body.dataset.offline, 'true');
  assert.match(String(pill.title), /lost connection to the server/);

  renderConnection(null);
  assert.equal(pill.hidden, true);
  assert.equal(body.dataset.offline, 'false');

  // And the banners no longer hear about it at all: the pill is the one place.
  const container = render({ refreshPending: false, stale: false });
  assert.doesNotMatch(container.textContent, /connection/i);
});
