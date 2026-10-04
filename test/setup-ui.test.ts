import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, handlersWith, mount, uiWith } from './dom.ts';
import { renderBanners } from '../client/banners.ts';
import { SetupCard } from '../client/setup.ts';
import { TodayView } from '../client/today.ts';
import type { DashboardState, SetupState } from '../src/types.ts';

function stateWith(overrides: { setup?: Partial<SetupState>; [key: string]: unknown } = {}): DashboardState {
  const { setup, ...rest } = overrides;
  return {
    brief: { generatedAt: null, ageHours: null, stale: false, refreshPending: false },
    schedule: { runsToday: true },
    problem: 'No brief yet — nothing has written /tmp/store/items.json',
    warnings: [],
    setupWarnings: [],
    restart: null,
    focus: null,
    items: [],
    agendaSource: { live: false, problem: null },
    board: { enabled: true, fetchedAt: '2026-10-04T08:00:00Z', reason: null },
    tickets: { enabled: false, fetchedAt: null, reason: null },
    agentRun: { enabled: false, cli: null, schedule: null, last: null, runs: [] },
    setup: {
      needed: true,
      profile: 'work',
      profileChosen: false,
      sources: { exists: false, placeholders: 0 },
      clis: { claude: '/usr/local/bin/claude', codex: null },
      calendar: { supported: false, built: false, chosen: 0 },
      ...setup,
    },
    ...rest,
  } as unknown as DashboardState;
}

const steps = (root: HTMLElement) =>
  byClass(root, 'setup__step').map((step) => [step.querySelector('h3')!.textContent, step.dataset.done ?? null]);

test('a new store opens on the setup steps, not an empty list and an alarm', () => {
  const state = stateWith();
  const page = mount(h('div', null, h(TodayView, { state, ui: uiWith(), handlers: handlersWith() })));
  assert.equal(byClass(page, 'setup').length, 1);
  assert.equal(byClass(page, 'stats').length, 0);

  const banners = mount(h('div', null, renderBanners(state, uiWith(), handlersWith())));
  assert.equal(byClass(banners, 'banner--critical').length, 0, 'no red "No brief yet" while setting up');

  // Once setup is over, a missing brief is an alarm again.
  const later = mount(h('div', null, renderBanners(stateWith({ setup: { needed: false } }), uiWith(), handlersWith())));
  assert.equal(byClass(later, 'banner--critical').length, 1);
});

test('each step says whether it is done', () => {
  const card = mount(h(SetupCard, { state: stateWith(), handlers: handlersWith() }));
  assert.deepEqual(steps(card), [
    ['What should it brief?', 'false'],
    ['What are you trying to achieve?', 'false'],
    ['Who writes the brief?', 'false'],
    ['Where should it look?', 'false'],
    ['What else to show', null],
    ['Write your first brief', null],
  ]);

  const done = mount(
    h(SetupCard, {
      state: stateWith({
        setup: { profileChosen: true, sources: { exists: true, placeholders: 0 } },
        focus: { objective: 'Ship the reliability fix', blocker: null, note: null },
        agentRun: { enabled: true, cli: 'claude', schedule: { at: '07:00', nextRunAt: null }, last: null, runs: [] },
      }),
      handlers: handlersWith(),
    }),
  );
  assert.deepEqual(
    steps(done).slice(0, 4).map(([, state]) => state),
    ['true', 'true', 'true', 'true'],
  );
  assert.match(done.textContent!, /Claude Code, each scheduled morning at 07:00/);
});

test('the choices are a click: the profile, the CLI it found, and turning off a board', () => {
  const chosen: Record<string, string | null>[] = [];
  const card = mount(h(SetupCard, { state: stateWith(), handlers: handlersWith({ chooseSettings: (values) => void chosen.push(values) }) }));
  const click = (label: string) => [...card.querySelectorAll('button')].find((button) => button.textContent === label)!.click();

  assert.ok(buttonLabels(card).includes('Use Claude Code'));
  assert.ok(!buttonLabels(card).includes('Use Codex'), 'only what is installed is offered');
  click('Personal life');
  click('Use Claude Code');
  click('Turn off the pull request board');
  assert.deepEqual(chosen, [{ DAILY_FOCUS_PROFILE: 'personal' }, { DAILY_FOCUS_AGENT: 'claude' }, { DAILY_FOCUS_GITHUB: 'off' }]);
});

test('with no CLI installed, the step says what to install instead of offering nothing', () => {
  const card = mount(h(SetupCard, { state: stateWith({ setup: { clis: { claude: null, codex: null } } }), handlers: handlersWith() }));
  assert.ok(!buttonLabels(card).some((label) => label.startsWith('Use ')));
  assert.match(card.textContent!, /Install Claude Code or the Codex CLI/);
});

test('the first brief waits for someone to write it, and a source list with placeholders is not done', () => {
  const runs: string[] = [];
  const card = mount(
    h(SetupCard, {
      state: stateWith({ setup: { sources: { exists: true, placeholders: 3 } } }),
      handlers: handlersWith({ runAgent: () => void runs.push('run') }),
    }),
  );
  const write = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Write my first brief')!;
  assert.equal(write.disabled, true, 'nothing to run it with yet');
  assert.match(card.textContent!, /still has 3 of the template's placeholders/);
  assert.equal(steps(card)[3]![1], 'false');
});

test('a restart waiting on saved settings is said, and so is one nobody can do for you', () => {
  const waiting = mount(h('div', null, renderBanners(stateWith({ restart: 'waiting', setup: { needed: false }, problem: null }), uiWith(), handlersWith())));
  assert.match(waiting.textContent!, /Settings saved\. The dashboard restarts to apply them/);
  const manual = mount(h('div', null, renderBanners(stateWith({ restart: 'manual', setup: { needed: false }, problem: null }), uiWith(), handlersWith())));
  assert.match(manual.textContent!, /Restart the dashboard to apply them/);
});
