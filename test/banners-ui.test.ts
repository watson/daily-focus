import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StubElement, byClass } from './dom-stub.ts';

const { renderBanners } = await import('../public/render.js');

function render(brief: Record<string, unknown>, problem: string | null = null) {
  const container = new StubElement('div');
  container.replaceChildren = (...children: StubElement[]) => { container.childNodes = children; };
  Object.assign((globalThis as unknown as { document: object }).document, { getElementById: () => container });
  renderBanners({
    brief: { generatedAt: '2026-09-10T06:30:00Z', ageHours: 24, ...brief },
    schedule: { runsToday: true },
    problem,
    warnings: [],
  }, null);
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
