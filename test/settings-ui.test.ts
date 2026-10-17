import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { byClass, handlersWith, mount, uiWith } from './dom.ts';
import { SettingsView, textEditor } from '../client/settings.ts';
import type { SettingsPage, TextEditor } from '../client/types.ts';
import type { DashboardState } from '../src/types.ts';

const state = {
  focus: { objective: 'Ship the reliability fix', blocker: null, note: null },
  setup: { sources: { exists: true, placeholders: 0 }, calendar: { supported: false, built: false, chosen: 0 } },
} as unknown as DashboardState;

const page: SettingsPage = {
  groups: [
    { id: 'agent', title: 'Morning agent' },
    { id: 'day', title: 'Working day' },
  ],
  settings: [
    {
      key: 'DAILY_FOCUS_AGENT',
      group: 'agent',
      label: 'Write the brief with',
      help: 'The CLI.',
      kind: 'choice',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'claude', label: 'Claude Code' },
      ],
      advanced: false,
      value: 'claude',
      source: 'settings',
      fallback: 'Off',
    },
    {
      key: 'DAILY_FOCUS_AGENT_BIN',
      group: 'agent',
      label: 'Path to the CLI',
      help: 'Rarely needed.',
      kind: 'text',
      choices: null,
      advanced: true,
      value: null,
      source: 'default',
      fallback: 'Found on PATH',
    },
    {
      key: 'DAILY_FOCUS_WORK_START',
      group: 'day',
      label: 'Working day starts at',
      help: 'Hour.',
      kind: 'number',
      choices: null,
      advanced: false,
      value: '10',
      source: 'fixed',
      fallback: '9',
    },
    {
      key: 'DAILY_FOCUS_FREE_WINDOWS',
      group: 'day',
      label: 'Show free time',
      help: 'Windows.',
      kind: 'flag',
      choices: null,
      advanced: false,
      value: 'false',
      source: 'settings',
      fallback: 'On',
    },
  ],
  error: null,
  restart: null,
};

function render(overrides: Parameters<typeof uiWith>[0] = {}, handlers = handlersWith()) {
  return mount(h(SettingsView, { state, ui: uiWith({ settings: page, texts: {}, ...overrides }), handlers }));
}

test('every setting is a field in its group, with its default as the empty choice', () => {
  const root = render();
  assert.deepEqual(
    byClass(root, 'settings-card__title').map((node) => node.textContent),
    ['Your objective', 'Where the agent looks', 'Morning agent', 'Working day'],
  );
  const agent = root.querySelector<HTMLElement>('#setting-DAILY_FOCUS_AGENT')!;
  const segments = [...agent.querySelectorAll('[role=radio]')];
  assert.deepEqual(segments.map((segment) => segment.textContent), ['Off', 'Claude Code'], 'the real answers, and no segment for the default');
  assert.equal(segments.find((segment) => segment.getAttribute('aria-checked') === 'true')!.textContent, 'Claude Code');

  // Nothing saved: the default answer is the one checked, and it says so.
  const unset = render({ settingsDraft: new Map([['DAILY_FOCUS_AGENT', null]]) });
  const checked = unset.querySelector('#setting-DAILY_FOCUS_AGENT [aria-checked=true]')!;
  assert.equal(checked.textContent, 'Offdefault');
  assert.equal(checked.querySelector('small')!.textContent, 'default');
  assert.ok(root.querySelector('details #setting-DAILY_FOCUS_AGENT_BIN'), 'a path is folded away under More');
  assert.equal(root.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_AGENT_BIN')!.placeholder, 'Found on PATH');
});

test('a fixed value is shown but locked, and says why; a saved one is just its value', () => {
  const root = render();
  const start = root.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_WORK_START')!;
  assert.equal(start.disabled, true);
  assert.equal(start.value, '10');
  assert.match(start.closest('.field')!.textContent!, /Fixed in the demo/);
  const free = root.querySelector<HTMLElement>('#setting-DAILY_FOCUS_FREE_WINDOWS')!;
  assert.equal(free.getAttribute('aria-disabled'), 'false');
  assert.equal(free.querySelector('[aria-checked=true]')!.textContent, 'Off', '"false" saved by hand reads as off');
  assert.equal(free.closest('.field')!.querySelector('.field__note'), null);
});

test('a change goes to the draft, and the bar offers to save it', () => {
  const edits: [string, string | null][] = [];
  const root = render({}, handlersWith({ editSetting: (key, value) => void edits.push([key, value]) }));
  assert.equal(root.querySelector<HTMLElement>('.settings__bar')!.hidden, true, 'nothing to save yet');
  const agent = root.querySelector<HTMLElement>('#setting-DAILY_FOCUS_AGENT')!;
  agent.querySelector<HTMLButtonElement>('[role=radio]')!.click();
  assert.deepEqual(edits, [['DAILY_FOCUS_AGENT', null]], 'picking the default answer means back to the default, not a value saved to restate it');

  const drafted = render({ settingsDraft: new Map([['DAILY_FOCUS_AGENT', 'off']]) });
  assert.equal(drafted.querySelector<HTMLElement>('.settings__bar')!.hidden, false);
  assert.match(drafted.querySelector('.settings__bar')!.textContent!, /1 unsaved change\. Saving restarts the dashboard to apply it\./);
  assert.equal(drafted.querySelector('[data-changed="true"] .segmented')?.id, 'setting-DAILY_FOCUS_AGENT');

  const refused = render({ settingsDraft: new Map([['DAILY_FOCUS_AGENT', 'off']]), settingsError: 'DAILY_FOCUS_AGENT must be off or one of claude, codex' });
  assert.match(refused.querySelector('.settings__bar-text--error')!.textContent!, /must be off or one of/);
});

test('an editor saves only a change, and a file changed on disk offers both ways out', () => {
  const editor = (patch: Partial<TextEditor>): TextEditor => ({
    saved: 'one\n',
    version: 'v1',
    template: 'template',
    draft: 'one\n',
    conflict: null,
    saving: false,
    ...patch,
  });
  const save = (root: HTMLElement) => [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save sources.md')!;

  assert.equal(save(mount(textEditor('sources', editor({}), handlersWith(), 'sources.md'))).disabled, true);
  assert.equal(save(mount(textEditor('sources', editor({ draft: 'two\n' }), handlersWith(), 'sources.md'))).disabled, false);

  const fresh = mount(textEditor('sources', editor({ saved: null, draft: 'template' }), handlersWith(), 'sources.md'));
  assert.equal(save(fresh).disabled, true, 'an untouched template is not worth saving');
  assert.match(fresh.textContent!, /doesn't exist yet/);

  const calls: string[] = [];
  const conflicted = mount(
    textEditor(
      'sources',
      editor({ draft: 'mine\n', conflict: { text: 'theirs\n', version: 'v2' } }),
      handlersWith({ reloadText: () => void calls.push('reload'), saveText: (_, overwrite) => void calls.push(`save:${overwrite}`) }),
      'sources.md',
    ),
  );
  assert.match(conflicted.textContent!, /changed on disk since you opened it/);
  for (const label of ['Load the new version', 'Save mine over it']) {
    [...conflicted.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
  }
  assert.deepEqual(calls, ['reload', 'save:true']);
});

test('leaving says where it goes: back to the view Settings was opened from', () => {
  let closed = 0;
  const root = render({ settingsReturn: 'tickets' }, handlersWith({ closeSettings: () => void closed++ }));
  const back = [...root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Back to'))!;
  assert.equal(back.textContent, 'Back to Jira tickets');
  back.click();
  assert.equal(closed, 1);
});

test('the gear is pressed while Settings is open, and a second press closes it', async () => {
  const { Header } = await import('../client/chrome.ts');
  const calls: string[] = [];
  const handlers = handlersWith({ openSettings: () => void calls.push('open'), closeSettings: () => void calls.push('close') });
  const gear = (view: 'today' | 'settings') => mount(h(Header, { state: null, ui: uiWith({ view }), handlers })).querySelector<HTMLButtonElement>('#settings-toggle')!;

  const off = gear('today');
  assert.equal(off.getAttribute('aria-pressed'), 'false');
  assert.ok(off.querySelector('svg'), 'drawn, not a character');
  off.click();
  const on = gear('settings');
  assert.equal(on.getAttribute('aria-pressed'), 'true');
  on.click();
  assert.deepEqual(calls, ['open', 'close']);
});

test('a calendar ticked because its name matches in another case can be unticked', () => {
  const edits: [string, string | null][] = [];
  const calendarPage: SettingsPage = {
    ...page,
    groups: [{ id: 'calendar', title: 'Calendar' }],
    settings: [
      {
        key: 'DAILY_FOCUS_CALENDARS',
        group: 'calendar',
        label: 'Calendars',
        help: 'Names.',
        kind: 'list',
        choices: null,
        advanced: false,
        value: 'work',
        source: 'settings',
        fallback: 'None',
      },
    ],
  };
  const calendarState = {
    ...state,
    setup: { ...state.setup, calendar: { supported: true, built: true, chosen: 1, buildCommand: 'npm run build:calendar' } },
  } as unknown as DashboardState;
  const root = mount(
    h(SettingsView, {
      state: calendarState,
      ui: uiWith({ settings: calendarPage, texts: {}, calendars: [{ title: 'Work', source: 'iCloud' }] }),
      handlers: handlersWith({ editSetting: (key, value) => void edits.push([key, value]) }),
    }),
  );
  const box = root.querySelector<HTMLInputElement>('.calendar-picker input[type=checkbox]')!;
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(edits, [['DAILY_FOCUS_CALENDARS', null]]);
});
