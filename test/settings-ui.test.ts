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
      source: 'environment',
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
      source: 'dotenv',
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
  const agent = root.querySelector<HTMLSelectElement>('#setting-DAILY_FOCUS_AGENT')!;
  assert.equal(agent.value, 'claude');
  assert.equal(agent.options[0]!.textContent, 'Default: Off');
  assert.ok(root.querySelector('details #setting-DAILY_FOCUS_AGENT_BIN'), 'a path is folded away under More');
  assert.equal(root.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_AGENT_BIN')!.placeholder, 'Found on PATH');
});

test('a value from the environment is shown but locked; one from .env says where it came from', () => {
  const root = render();
  const start = root.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_WORK_START')!;
  assert.equal(start.disabled, true);
  assert.equal(start.value, '10');
  assert.match(start.closest('.field')!.textContent!, /Set in the environment/);
  const free = root.querySelector<HTMLSelectElement>('#setting-DAILY_FOCUS_FREE_WINDOWS')!;
  assert.equal(free.value, 'off', '"false" in .env reads as off');
  assert.match(free.closest('.field')!.textContent!, /From the \.env file/);
});

test('a change goes to the draft, and the bar offers to save it', () => {
  const edits: [string, string | null][] = [];
  const root = render({}, handlersWith({ editSetting: (key, value) => void edits.push([key, value]) }));
  assert.equal(root.querySelector<HTMLElement>('.settings__bar')!.hidden, true, 'nothing to save yet');
  const agent = root.querySelector<HTMLSelectElement>('#setting-DAILY_FOCUS_AGENT')!;
  agent.value = '';
  agent.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(edits, [['DAILY_FOCUS_AGENT', null]], 'the empty choice means back to the default');

  const drafted = render({ settingsDraft: new Map([['DAILY_FOCUS_AGENT', 'off']]) });
  assert.equal(drafted.querySelector<HTMLElement>('.settings__bar')!.hidden, false);
  assert.match(drafted.querySelector('.settings__bar')!.textContent!, /1 unsaved change\. Saving restarts the dashboard to apply it\./);
  assert.equal(drafted.querySelector('[data-changed="true"] select')?.id, 'setting-DAILY_FOCUS_AGENT');

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
