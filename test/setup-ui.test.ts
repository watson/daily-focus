/**
 * The setup screen and what Today shows after it, rendered.
 *
 * What is worth holding: a new store is the setup screen and nothing else;
 * answered questions fold into their sentence; the open one starts from what
 * its card ticks, keeps what the user changed when a proposal lands under them,
 * and answers with what the card holds; and between the finish and the first
 * brief, Today says where the brief is. All invented people and calendars.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mount, settle, uiWith } from './dom.ts';
import { App } from '../client/app.ts';
import { renderBanners } from '../client/banners.ts';
import { OnboardingView } from '../client/onboarding.ts';
import { FirstBriefCard } from '../client/setup.ts';
import { state as stateSignal } from '../client/state.ts';
import { TodayView } from '../client/today.ts';
import type { DashboardState, OnboardingAnswer, OnboardingState, OnboardingStep } from '../src/types.ts';

function stateWith(overrides: Partial<DashboardState> = {}): DashboardState {
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
    board: { enabled: true, fetchedAt: '2026-10-04T08:00:00Z', reason: null, rows: [], counts: { you: 0 } },
    tickets: { enabled: false, fetchedAt: null, reason: null, rows: [], inProgress: [] },
    agentRun: { enabled: true, cli: 'claude', schedule: null, last: null, runs: [] },
    setup: {
      needed: true,
      profile: 'work',
      sources: { exists: true, placeholders: 0 },
      clis: { claude: '/usr/local/bin/claude', codex: null },
      calendar: { supported: false, built: false, chosen: 0, buildCommand: 'daily-focus build-calendar' },
    },
    onboarding: null,
    ...overrides,
  } as unknown as DashboardState;
}

function step(id: string, overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    id,
    title: `Question ${id}?`,
    topic: `topic ${id}`,
    status: 'open',
    summary: null,
    locked: false,
    card: { version: 0, why: null, choices: [], fields: [], problem: null, revisable: false, deferrable: true },
    proposal: null,
    answer: null,
    ...overrides,
  };
}

const CLI = step('cli', {
  title: 'Which agent should write your brief?',
  status: 'answered',
  summary: 'Claude Code writes your brief.',
  answer: { choices: { cli: ['claude'] }, fields: {} },
});

const CALENDARS = step('calendars', {
  title: 'Which calendars belong in your work brief?',
  topic: 'your calendars',
  card: {
    version: 1,
    why: 'These are on your work account.',
    choices: [
      {
        id: 'calendars',
        label: null,
        multiple: true,
        options: [
          { value: 'live:work:Robin Lark', label: 'Robin Lark', detail: 'Your primary calendar', group: 'robin@northwind.example' },
          { value: 'live:icloud:Family', label: 'Family', detail: null, group: 'iCloud' },
        ],
        selected: ['live:work:Robin Lark'],
        custom: 'Add a calendar by name',
      },
    ],
    fields: [],
    problem: null,
    revisable: true,
    deferrable: false,
  },
  proposal: { status: 'ready', conversation: [{ from: 'it', text: 'These are on your work account.' }], steps: [], error: null },
});

function flow(steps: OnboardingStep[], current: string | null): OnboardingState {
  return { detected: true, steps, current, error: null };
}

test('a new store is the setup screen and nothing else', () => {
  const state = stateWith({ onboarding: flow([CLI, CALENDARS], 'calendars') });
  stateSignal.value = state;
  const page = mount(h(App, { ui: uiWith(), handlers: handlersWith() }));
  assert.equal(byClass(page, 'onboarding').length, 1);
  assert.equal(byClass(page, 'tabs').length, 0, 'no tabs to wander off to');
  assert.equal(byClass(page, 'banners').length, 0);
  stateSignal.value = null;
});

test('answered questions fold into their sentence with a Change, and the open one is a card', () => {
  const changed: (string | null)[] = [];
  const page = mount(
    h(OnboardingView, {
      state: stateWith({ onboarding: flow([CLI, CALENDARS, step('objective')], 'calendars') }),
      ui: uiWith(),
      handlers: handlersWith({ editSetupStep: (id) => void changed.push(id) }),
    }),
  );
  const done = byClass(page, 'onboarding__done');
  assert.deepEqual(done.map((row) => row.querySelector('.onboarding__summary')!.textContent), ['Claude Code writes your brief.']);
  byTag(done[0]!, 'button')[0]!.click();
  assert.deepEqual(changed, ['cli']);

  const card = byClass(page, 'onboarding__card')[0]!;
  assert.equal(card.dataset.step, 'calendars');
  assert.equal(card.querySelector('h2')!.textContent, 'Which calendars belong in your work brief?');
  assert.match(card.querySelector('.onboarding__why')!.textContent!, /work account/);
  assert.deepEqual(
    byClass(card, 'onboarding__group-name').map((group) => group.textContent),
    ['robin@northwind.example', 'iCloud'],
    'grouped by account',
  );
  const boxes = byTag(card, 'input').filter((input) => (input as HTMLInputElement).type === 'checkbox') as HTMLInputElement[];
  assert.deepEqual(boxes.map((box) => box.checked), [true, false], "the card's own ticks");
  assert.ok(!buttonLabels(card).includes('Decide later'), 'a list can be left unticked; there is nothing to put off');
  assert.ok(page.querySelector('.onboarding__tell input'), 'a card with a proposal behind it can be told what to change');
  assert.match(byClass(page, 'onboarding__then')[0]!.textContent!, /Then topic objective and your first brief\./);
});

test('Continue answers with what the card holds, and Decide later puts it off', async () => {
  const answers: [string, OnboardingAnswer][] = [];
  const handlers = handlersWith({ answerSetup: (id, answer) => void answers.push([id, answer]) });
  const deferrable = { ...CALENDARS, card: { ...CALENDARS.card, deferrable: true } };
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([deferrable], 'calendars') }), ui: uiWith(), handlers }));
  (page.querySelector('form.onboarding__form') as HTMLFormElement).requestSubmit();
  byTag(page, 'button').find((button) => button.textContent === 'Decide later')!.click();
  assert.deepEqual(answers, [
    ['calendars', { choices: { calendars: ['live:work:Robin Lark'] }, fields: {} }],
    ['calendars', { later: true }],
  ]);
});

test("a tick changed is kept as a draft; a proposal landing under it is offered, not forced", async () => {
  const drafts: unknown[] = [];
  const ui = uiWith();
  const handlers = handlersWith({
    editSetupDraft: (id, answer, version) => {
      drafts.push([id, answer, version]);
      const next = new Map(ui.setupDrafts.value);
      if (answer) next.set(id, { version, answer });
      else next.delete(id);
      ui.setupDrafts.value = next;
    },
  });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([CALENDARS], 'calendars') }), ui, handlers }));
  const boxes = (root: HTMLElement) => byTag(root, 'input').filter((input) => (input as HTMLInputElement).type === 'checkbox') as HTMLInputElement[];
  boxes(page)[1]!.click();
  await settle();
  assert.deepEqual(drafts[0], ['calendars', { choices: { calendars: ['live:work:Robin Lark', 'live:icloud:Family'] }, fields: {} }, 1]);
  assert.equal(boxes(page)[1]!.checked, true);

  // The CLI comes back with a new version while the draft stands.
  const newer = { ...CALENDARS, card: { ...CALENDARS.card, version: 2 } };
  const again = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([newer], 'calendars') }), ui, handlers }));
  assert.match(again.textContent!, /new suggestion/);
  assert.equal(boxes(again)[1]!.checked, true, 'the draft stays until the user takes the suggestion');
});

test('a value of the user’s own is added to the list and kept ticked', async () => {
  const ui = uiWith();
  const handlers = handlersWith({
    editSetupDraft: (id, answer, version) => {
      ui.setupDrafts.value = new Map([[id, { version, answer: answer! }]]);
    },
  });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([CALENDARS], 'calendars') }), ui, handlers }));
  byTag(page, 'button').find((button) => button.textContent === 'Add a calendar by name')!.click();
  await settle();
  const input = page.querySelector('.onboarding__add input') as HTMLInputElement;
  input.value = 'On-call rota';
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await settle();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(ui.setupDrafts.value.get('calendars')!.answer.choices.calendars, ['live:work:Robin Lark', 'On-call rota']);
  assert.ok(byClass(page, 'onboarding__group-name').some((group) => group.textContent === 'Added by you'));
});

test('while the CLI is still looking, the card says so and shows what it is doing', () => {
  const looking = step('identity', {
    title: 'Is this you?',
    topic: 'who you are',
    card: { ...step('x').card, fields: [{ id: 'name', label: 'Your name', value: 'Robin Lark', placeholder: null, help: null }] },
    proposal: { status: 'working', conversation: [], steps: [{ kind: 'tool', text: 'Look up the GitHub login', detail: 'gh api user', state: 'running' }], error: null },
  });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([looking], 'identity') }), ui: uiWith(), handlers: handlersWith() }));
  assert.match(byClass(page, 'onboarding__looking')[0]!.textContent!, /Still looking\. You can answer now/);
  assert.match(byClass(page, 'onboarding__looking')[0]!.textContent!, /Look up the GitHub login/);
  assert.equal(page.querySelector('.onboarding__tell'), null, 'nothing to tell it until it has answered');
});

test('what the CLI is already looking into next is shown under the open question', () => {
  const next = step('calendars', { topic: 'your calendars', proposal: { status: 'working', conversation: [], steps: [], error: null } });
  const page = mount(
    h(OnboardingView, { state: stateWith({ onboarding: flow([step('schedule'), next, step('objective')], 'schedule') }), ui: uiWith(), handlers: handlersWith() }),
  );
  assert.match(byClass(page, 'onboarding__next')[0]!.textContent!, /Next, your calendars\. It's already looking/);
});

test('a problem that blocks the card holds Continue back; one that does not sits under the list', () => {
  const blocked = step('cli', { card: { ...step('x').card, problem: { message: 'Install Claude Code or Codex.', command: null, blocking: true } } });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([blocked], 'cli') }), ui: uiWith(), handlers: handlersWith() }));
  assert.equal((byTag(page, 'button').find((b) => b.textContent === 'Continue') as HTMLButtonElement).disabled, true);
  assert.ok(buttonLabels(page).includes('Check again'));

  const note = { ...CALENDARS, card: { ...CALENDARS.card, problem: { message: 'Build the helper.', command: 'daily-focus build-calendar', blocking: false } } };
  const other = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([note], 'calendars') }), ui: uiWith(), handlers: handlersWith() }));
  assert.equal((byTag(other, 'button').find((b) => b.textContent === 'Continue') as HTMLButtonElement).disabled, false);
  const form = other.querySelector('form.onboarding__form')!;
  assert.ok(form.querySelector('.onboarding__problem[data-blocking="false"]'), 'inside the form, after the list');
});

test('with every question answered, the finish offers the first brief, and the source list behind a fold', () => {
  let loads = 0;
  let finishes = 0;
  const handlers = handlersWith({ loadSetupSources: () => void loads++, finishSetup: () => void finishes++ });
  const ui = uiWith({ setupSources: { text: '# Sources\n\n## Identity\n', kept: false } });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([CLI], null) }), ui, handlers }));
  assert.equal(page.querySelector('#setup-finish')!.textContent, 'Ready for your first brief');
  assert.match(page.querySelector('.onboarding__preview pre')!.textContent!, /## Identity/);
  byTag(page, 'button').find((button) => button.textContent === 'Write my first brief')!.click();
  assert.equal(finishes, 1);

  const later = step('cli', { status: 'later' });
  const without = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([later], null) }), ui: uiWith(), handlers }));
  assert.ok(buttonLabels(without).includes('Finish setup'), 'no brief to write without an agent');
  assert.match(byClass(without, 'onboarding__done')[0]!.textContent!, /Topic cli: decide later\./);
});

test('between the finish and the first brief, Today says where the brief is', () => {
  const today = (overrides: Partial<DashboardState>) =>
    mount(h('div', null, h(TodayView, { state: stateWith(overrides), ui: uiWith(), handlers: handlersWith() })));
  assert.equal(byClass(today({}), 'first-brief').length, 1);
  assert.equal(byClass(today({}), 'stats').length, 0);

  const card = (overrides: Partial<DashboardState>) =>
    mount(h(FirstBriefCard, { state: stateWith(overrides), handlers: handlersWith() })).querySelector('h2')!.textContent;
  const run = (status: string, error: string | null = null) => ({
    enabled: true,
    cli: 'claude',
    schedule: null,
    last: { id: 'r1', status, error, startedAt: '2026-10-16T07:00:00Z', endedAt: null },
    runs: [],
  });
  assert.equal(card({ restart: 'waiting' }), 'Saving your settings');
  assert.equal(card({ agentRun: run('running') as never }), 'Writing your first brief');
  assert.equal(card({ agentRun: run('failed', 'claude is not logged in') as never }), 'Your first brief didn’t finish');
  assert.equal(card({ agentRun: { enabled: false, cli: null, schedule: null, last: null, runs: [] } as never }), 'Choose who writes your brief');
  assert.equal(card({}), 'Write your first brief');

  // The missing brief isn't an alarm until setup is behind it.
  const banners = mount(h('div', null, renderBanners(stateWith(), uiWith(), handlersWith())));
  assert.equal(byClass(banners, 'banner--critical').length, 0);
});

test('the screen asks for the CLIs to be looked for when it opens, and not again once they have been', async () => {
  let asked = 0;
  const handlers = handlersWith({ detectSetup: () => void asked++ });
  const looking = step('cli', {
    title: 'Which agent should write your brief?',
    topic: 'your coding agent',
    proposal: { status: 'working', conversation: [], steps: [{ kind: 'tool', text: 'Look for Codex and Claude Code', detail: null, state: 'running' }], error: null },
  });
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: { ...flow([looking], 'cli'), detected: false } }), ui: uiWith(), handlers }));
  // Effects run after the paint, which happy-dom stands in for with a timer.
  for (let i = 0; i < 50 && asked === 0; i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(asked, 1);
  assert.match(byClass(page, 'onboarding__looking')[0]!.textContent!, /Looking into your coding agent…Look for Codex and Claude Code/);
  assert.equal((byTag(page, 'button').find((b) => b.textContent === 'Continue') as HTMLButtonElement).disabled, true);

  mount(h(OnboardingView, { state: stateWith({ onboarding: flow([CLI, CALENDARS], 'calendars') }), ui: uiWith(), handlers }));
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(asked, 1, 'already looked');
});

test('with no CLI ready, the card links to the installers and takes a path', () => {
  const answers: [string, OnboardingAnswer][] = [];
  const none = step('cli', {
    title: 'Which agent should write your brief?',
    card: {
      ...step('x').card,
      problem: {
        message: "Codex isn't installed. Claude Code isn't installed. Install one, log in once in a terminal, then check again.",
        command: null,
        blocking: true,
        links: [
          { label: 'Install Codex', url: 'https://developers.openai.com/codex/cli' },
          { label: 'Install Claude Code', url: 'https://code.claude.com/docs' },
        ],
      },
      fields: [{ id: 'path', label: 'Its path', value: '', placeholder: '/opt/homebrew/bin/codex', help: null }],
    },
  });
  const page = mount(
    h(OnboardingView, {
      state: stateWith({ onboarding: flow([none], 'cli') }),
      ui: uiWith({ setupDrafts: new Map([['cli', { version: 0, answer: { choices: {}, fields: { path: '/opt/tools/codex' } } }]]) }),
      handlers: handlersWith({ answerSetup: (id, answer) => void answers.push([id, answer]) }),
    }),
  );
  assert.deepEqual(byTag(page, 'a').map((a) => [a.textContent, a.getAttribute('href')]), [
    ['Install Codex', 'https://developers.openai.com/codex/cli'],
    ['Install Claude Code', 'https://code.claude.com/docs'],
  ]);
  const continueButton = byTag(page, 'button').find((b) => b.textContent === 'Continue') as HTMLButtonElement;
  assert.equal(continueButton.disabled, false, 'a path is something to answer with');
  (page.querySelector('form.onboarding__form') as HTMLFormElement).requestSubmit();
  assert.deepEqual(answers, [['cli', { choices: {}, fields: { path: '/opt/tools/codex' } }]]);
});

test('what it said and what the user told it read as one conversation, with the reply box under it', () => {
  const talked = {
    ...CALENDARS,
    proposal: {
      status: 'ready' as const,
      conversation: [
        { from: 'it' as const, text: 'These are on your work account.' },
        { from: 'you' as const, text: 'Also the on-call rota' },
        { from: 'it' as const, text: 'Added the on-call rota from the same account.' },
      ],
      steps: [],
      error: null,
    },
  };
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([talked], 'calendars') }), ui: uiWith(), handlers: handlersWith() }));
  const card = byClass(page, 'onboarding__card')[0]!;
  assert.deepEqual(
    [...card.querySelectorAll('.onboarding__talk > li')].map((line) => [line.className, line.textContent]),
    [
      ['onboarding__why', 'These are on your work account.'],
      ['onboarding__said', 'Also the on-call rota'],
      ['onboarding__why', 'Added the on-call rota from the same account.'],
    ],
  );
  const order = [...card.children].map((child) => child.className.split(' ')[0]);
  assert.ok(order.indexOf('onboarding__talk') < order.indexOf('onboarding__tell'), 'the reply box under the conversation');
  assert.ok(order.indexOf('onboarding__tell') < order.indexOf('onboarding__form'), 'and above the answer it changes');
  assert.equal(byTag(card, 'button').find((b) => b.textContent === 'Send')?.textContent, 'Send');
});

test('while it works on a change, the user sees their words, its steps, and that it is still writing once they are done', () => {
  const working = {
    ...CALENDARS,
    proposal: {
      status: 'working' as const,
      conversation: [
        { from: 'it' as const, text: 'These are on your work account.' },
        { from: 'you' as const, text: 'Also the on-call rota' },
      ],
      steps: [{ kind: 'tool' as const, text: 'Calendar: list calendars', detail: null, state: 'done' as const }],
      error: null,
    },
  };
  const page = mount(h(OnboardingView, { state: stateWith({ onboarding: flow([working], 'calendars') }), ui: uiWith(), handlers: handlersWith() }));
  const looking = byClass(page, 'onboarding__looking')[0]!;
  assert.equal(looking.querySelector('p'), null, 'no "still looking": their words say what it is doing');
  assert.deepEqual(
    [...looking.querySelectorAll('li')].map((li) => [li.textContent, li.getAttribute('data-state')]),
    [
      ['Calendar: list calendars', 'done'],
      ['Writing its answer…', 'running'],
    ],
  );
  assert.equal(page.querySelector('.onboarding__tell'), null, 'nothing more to say until it answers');
});

test('reopening one answer leaves Change on the others', () => {
  const identity = step('identity', { status: 'answered', summary: "You're Robin Lark.", answer: { choices: {}, fields: { name: 'Robin Lark' } } });
  const page = mount(
    h(OnboardingView, {
      state: stateWith({ onboarding: flow([CLI, identity, CALENDARS], 'calendars') }),
      ui: uiWith({ setupEditing: 'cli' }),
      handlers: handlersWith(),
    }),
  );
  const changes = byClass(page, 'onboarding__change') as HTMLButtonElement[];
  assert.deepEqual(changes.map((button) => [button.closest('.onboarding__done')!.getAttribute('data-step'), button.disabled]), [['identity', false]]);
  assert.equal(byClass(page, 'onboarding__card').length, 2, 'the one reopened, and the one still open');
});
