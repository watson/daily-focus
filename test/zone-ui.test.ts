/**
 * The browser's half of the dashboard's zone: when it tells the dashboard where
 * it is, and when the header says the page's times are somewhere else.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { handlersWith, mountOne, uiWith } from './dom.ts';
import { Header } from '../client/chrome.ts';
import { setCalendarZone } from '../client/format.ts';
import { browserZone, sameZone, watchZone } from '../client/zone.ts';
import type { DashboardState } from '../src/types.ts';

afterEach(() => setCalendarZone(undefined));

/** A browser and a dashboard whose zones the test moves, and what was sent. */
function setup(here: string, there: string | undefined, visible = true) {
  const world = { here, there, visible, sent: [] as string[] };
  const watch = watchZone({
    browserZone: () => world.here,
    dashboardZone: () => world.there,
    visible: () => world.visible,
    send: async (zone) => {
      world.sent.push(zone);
      world.there = zone;
    },
  });
  return { world, watch };
}

const settle = () => new Promise((done) => setImmediate(done));

test('a look tells the dashboard only when it is somewhere else', async () => {
  const { world, watch } = setup('America/New_York', 'Europe/Copenhagen');
  watch.look();
  await settle();
  assert.deepEqual(world.sent, ['America/New_York']);
  watch.look();
  await settle();
  assert.deepEqual(world.sent, ['America/New_York'], 'already there');
});

test('nothing is said before the first state has arrived', async () => {
  const { world, watch } = setup('America/New_York', undefined);
  watch.look();
  await settle();
  assert.deepEqual(world.sent, []);
});

test("the timer doesn't take the zone back for a tab left open at home", async () => {
  // A tab in Copenhagen, after the laptop in New York has had its say.
  const { world, watch } = setup('Europe/Copenhagen', 'America/New_York');
  for (let i = 0; i < 3; i++) watch.check();
  await settle();
  assert.deepEqual(world.sent, []);
});

test("a browser whose own zone changes says so, even in a hidden tab", async () => {
  const { world, watch } = setup('Europe/Copenhagen', 'Europe/Copenhagen', false);
  world.here = 'America/New_York';
  watch.check();
  await settle();
  assert.deepEqual(world.sent, ['America/New_York']);
});

test('a hidden tab says nothing on a load or a reconnect', async () => {
  const { world, watch } = setup('Europe/Copenhagen', 'America/New_York', false);
  watch.look();
  await settle();
  assert.deepEqual(world.sent, []);
  world.visible = true;
  watch.look();
  await settle();
  assert.deepEqual(world.sent, ['Europe/Copenhagen']);
});

test('a reconnect and a focus at once send the zone once', async () => {
  let release!: () => void;
  const sent: string[] = [];
  const watch = watchZone({
    browserZone: () => 'America/New_York',
    dashboardZone: () => 'Europe/Copenhagen',
    visible: () => true,
    send: (zone) => {
      sent.push(zone);
      return new Promise((done) => (release = done));
    },
  });
  watch.look();
  watch.look();
  assert.deepEqual(sent, ['America/New_York']);
  release();
});

test('two spellings of one zone are the same place', () => {
  assert.ok(sameZone('Asia/Calcutta', 'Asia/Kolkata'));
  assert.ok(!sameZone('Europe/Copenhagen', 'Europe/Oslo'));
  assert.ok(!sameZone('Europe/Copenhagen', 'Not/A_Zone'));
});

function header(timeZone: string): HTMLElement {
  setCalendarZone(timeZone);
  const state = {
    now: '2026-10-08T02:30:00Z',
    timeZone,
    brief: { date: '2026-10-07', generatedAt: null },
    agentRun: { schedule: { at: '07:00' }, enabled: true },
  } as unknown as DashboardState;
  return mountOne(Header({ state, ui: uiWith(), handlers: handlersWith() }));
}

test("the header names the page's zone only when it isn't this browser's", () => {
  assert.equal(header(browserZone()).querySelector('#header-zone'), null);
  const elsewhere = sameZone(browserZone(), 'Pacific/Kiritimati') ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
  assert.equal(header(elsewhere).querySelector('#header-zone')?.textContent, `Times in ${elsewhere} · Morning agent at 07:00`);
});
