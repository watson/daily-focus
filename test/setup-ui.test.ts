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
  const card = mount(h(SetupCard, { state: stateWith(), ui: uiWith(), handlers: handlersWith() }));
  assert.deepEqual(steps(card), [
    ['What should it brief?', 'false'],
    ['What are you trying to achieve?', 'false'],
    ['Which agent writes the brief?', 'false'],
    ['Who are you, and where should it look?', 'false'],
    ['What else should the dashboard show?', null],
    ['Your first brief', null],
  ]);

  const done = mount(
    h(SetupCard, {
      state: stateWith({
        setup: { profileChosen: true, sources: { exists: true, placeholders: 0 } },
        focus: { objective: 'Ship the reliability fix', blocker: null, note: null },
        agentRun: { enabled: true, cli: 'claude', schedule: { at: '07:00', nextRunAt: null }, last: null, runs: [] },
      }),
      ui: uiWith(),
      handlers: handlersWith(),
    }),
  );
  assert.deepEqual(
    steps(done).slice(0, 4).map(([, state]) => state),
    ['true', 'true', 'true', 'true'],
  );
  assert.match(done.textContent!, /Claude Code\. After the first brief, it runs by itself each scheduled morning at 07:00/);
});

test('the choices are a click: the profile, the CLI it found, and turning off a board', () => {
  const chosen: Record<string, string | null>[] = [];
  const card = mount(h(SetupCard, { state: stateWith(), ui: uiWith(), handlers: handlersWith({ chooseSettings: (values) => void chosen.push(values) }) }));
  const click = (label: string) => [...card.querySelectorAll('button')].find((button) => button.textContent === label)!.click();

  assert.ok(buttonLabels(card).includes('Use Claude Code'));
  assert.ok(!buttonLabels(card).includes('Use Codex'), 'only what is installed is offered');
  click('Personal life');
  click('Use Claude Code');
  click('Turn off the pull request board');
  assert.deepEqual(chosen, [{ DAILY_FOCUS_PROFILE: 'personal' }, { DAILY_FOCUS_AGENT: 'claude' }, { DAILY_FOCUS_GITHUB: 'off' }]);
});

test('with no CLI installed, the step says what to install instead of offering nothing', () => {
  const card = mount(h(SetupCard, { state: stateWith({ setup: { clis: { claude: null, codex: null } } }), ui: uiWith(), handlers: handlersWith() }));
  assert.ok(!buttonLabels(card).some((label) => label.startsWith('Use ')));
  assert.match(card.textContent!, /Install Claude Code or the Codex CLI/);
});

test('the first brief waits for the agent to be chosen, and a source list with placeholders is not done', () => {
  const runs: string[] = [];
  const card = mount(
    h(SetupCard, {
      state: stateWith({ setup: { sources: { exists: true, placeholders: 3 } } }),
      ui: uiWith(),
      handlers: handlersWith({ runAgent: () => void runs.push('run') }),
    }),
  );
  const write = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Run the morning agent now')!;
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

test('a choice draws its answers alike, so none looks like the one to pick', () => {
  const card = mount(h(SetupCard, { state: stateWith({ setup: { clis: { claude: '/bin/claude', codex: '/bin/codex' } } }), ui: uiWith(), handlers: handlersWith() }));
  for (const group of byClass(card, 'setup__choices')) {
    const buttons = [...group.querySelectorAll('button')];
    assert.ok(buttons.length > 1);
    assert.ok(buttons.every((button) => button.className === 'button'), buttons.map((button) => button.className).join(', '));
  }
});

test('the source list is written in its step, not on another page', () => {
  const calls: string[] = [];
  const handlers = handlersWith({
    loadText: (name) => void calls.push(`load:${name}`),
    toggleDrawer: (key, open) => void calls.push(`${key}:${open}`),
    openSettings: () => void calls.push('settings'),
  });
  const closed = mount(h(SetupCard, { state: stateWith(), ui: uiWith(), handlers }));
  [...closed.querySelectorAll('button')].find((button) => button.textContent === 'Write it')!.click();
  assert.deepEqual(calls, ['load:sources', 'setup:sources:true'], 'it opens here, and loads the template');

  const editor = {
    saved: null,
    version: 'absent',
    template: '# Sources\n',
    draft: '# Sources\n',
    conflict: null,
    saving: false,
  };
  const open = mount(
    h(SetupCard, { state: stateWith(), ui: uiWith({ openDrawers: new Set(['setup:sources']), texts: { sources: editor } }), handlers }),
  );
  assert.equal(byClass(open, 'text-editor').length, 1);
  assert.ok(open.querySelector('textarea[aria-label="sources.md"]'));
});

test('each board says how it is doing the same way: a mark, and words in one colour', () => {
  const card = mount(
    h(SetupCard, {
      state: stateWith({
        board: { enabled: true, fetchedAt: null, reason: null },
        tickets: { enabled: true, fetchedAt: '2026-10-04T08:00:00Z', reason: null },
      }),
      ui: uiWith(),
      handlers: handlersWith(),
    }),
  );
  const rows = byClass(card, 'setup__board').map((row) => [row.dataset.health, row.querySelector('.setup__board-text')!.textContent]);
  assert.deepEqual(rows, [
    ['checking', 'Checking GitHub through gh…'],
    ['ok', 'Connected, through acli.'],
  ]);
});

test('a source list still holding placeholders holds the first run back; none at all does not', () => {
  const agent = { enabled: true, cli: 'claude', schedule: null, last: null, runs: [] };
  const run = (root: HTMLElement) => [...root.querySelectorAll('button')].find((button) => button.textContent === 'Run the morning agent now')!;

  const template = mount(h(SetupCard, { state: stateWith({ agentRun: agent, setup: { sources: { exists: true, placeholders: 2 } } }), ui: uiWith(), handlers: handlersWith() }));
  assert.equal(run(template).disabled, true);
  assert.match(template.textContent!, /Replace the source list's placeholders first/);

  const none = mount(h(SetupCard, { state: stateWith({ agentRun: agent }), ui: uiWith(), handlers: handlersWith() }));
  assert.equal(run(none).disabled, false);
  assert.match(none.textContent!, /Without a source list it briefs from what it can reach/);
});
