/**
 * The settings page: your objective, where the agent looks, and every setting.
 *
 * Built from what the server says about each setting (`src/settings.ts`), so a
 * setting added there appears here with nothing to write. Changes collect in a
 * draft until Save, because saving restarts the dashboard and a restart per
 * keystroke would be absurd. The two files in your words are saved on their own,
 * since saving them restarts nothing.
 */

import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';

import type { SettingView } from '../src/settings.ts';
import type { DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import type { CalendarName, Handlers, TextEditor, TextName, UiState, View } from './types.ts';

/** The views Settings can return to, by the names their tabs carry. */
const VIEW_NAME: Readonly<Record<View, string>> = {
  today: 'Today',
  board: 'Pull requests',
  tickets: 'Jira tickets',
  settings: 'Settings',
};

export function SettingsView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element {
  // Loaded when first looked at, not with the page: most visits never come here.
  useEffect(() => {
    if (!ui.settings.peek()) handlers.loadSettings();
    for (const name of ['focus', 'sources'] as const) if (!ui.texts.peek()[name]) handlers.loadText(name);
  }, []);

  const page = ui.settings.value;
  const draft = ui.settingsDraft.value;

  return el(
    'div',
    { class: 'settings' },
    el(
      'div',
      { class: 'settings__head' },
      el('h2', { class: 'settings__title' }, 'Settings'),
      el('button', { type: 'button', class: 'button', onClick: () => handlers.closeSettings() }, `Back to ${VIEW_NAME[ui.settingsReturn.value]}`),
    ),
    page?.error ? el('p', { class: 'settings__problem', role: 'alert' }, page.error) : null,
    objectiveCard(state, ui, handlers),
    sourcesCard(state, ui, handlers),
    page
      ? page.groups.map((group) => {
          const settings = page.settings.filter((setting) => setting.group === group.id);
          const plain = settings.filter((setting) => !setting.advanced);
          const advanced = settings.filter((setting) => setting.advanced);
          return el(
            'section',
            { class: 'settings-card', id: `settings-${group.id}`, key: group.id, 'aria-labelledby': `settings-${group.id}-title` },
            el('h3', { class: 'settings-card__title', id: `settings-${group.id}-title` }, group.title),
            plain.map((setting) => field(setting, draft, handlers)),
            group.id === 'calendar' ? calendarPicker(state, ui, handlers, page.settings) : null,
            advanced.length > 0
              ? el(
                  'details',
                  { class: 'settings-card__more' },
                  el('summary', null, 'More'),
                  advanced.map((setting) => field(setting, draft, handlers)),
                )
              : null,
          );
        })
      : el('p', { class: 'empty' }, 'Loading the settings…'),
    saveBar(ui, handlers),
  );
}

/* ---------- the objective ---------- */

function objectiveCard(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  const focus = state.focus;
  return el(
    'section',
    { class: 'settings-card', id: 'settings-objective', 'aria-labelledby': 'settings-objective-title' },
    el('h3', { class: 'settings-card__title', id: 'settings-objective-title' }, 'Your objective'),
    el(
      'p',
      { class: 'settings-card__help' },
      'The one thing you are trying to achieve right now. It sits at the top of Today, and the morning agent ranks ' +
        'the whole day against it, so a next move ("get staging working again") gives it more to go on than a project.',
    ),
    objectiveForm(focus?.objective ?? '', focus?.blocker ?? '', handlers),
    el(
      'details',
      { class: 'settings-card__more' },
      el('summary', null, 'Edit the whole of focus.md'),
      el(
        'p',
        { class: 'settings-card__help' },
        'Prose under the frontmatter is shown under the objective. Everything after the ',
        el('code', null, '<!-- agent-only -->'),
        ' line is read by the agent and never shown on the board.',
      ),
      textEditor('focus', ui.texts.value.focus, handlers, 'focus.md'),
    ),
  );
}

/**
 * The objective and its blocker, as a form of its own. Keyed by what is saved, so
 * a save from elsewhere refills it, while a state push that changes nothing leaves
 * whatever is being typed alone.
 */
export function objectiveForm(objective: string, blocker: string, handlers: Handlers, label = 'Save objective'): JSX.Element {
  return el(
    'form',
    {
      class: 'objective-form',
      key: `${objective}\n${blocker}`,
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        handlers.saveObjective(String(data.get('objective') ?? ''), String(data.get('blocker') ?? ''));
      },
    },
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, 'Objective'),
      el('input', {
        class: 'field__input',
        name: 'objective',
        defaultValue: objective,
        placeholder: 'For example: get the staging path working again',
        autocomplete: 'off',
      }),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, 'Blocked on (optional)'),
      el('input', { class: 'field__input', name: 'blocker', defaultValue: blocker, placeholder: 'What is in the way today, if anything', autocomplete: 'off' }),
    ),
    el('div', { class: 'objective-form__actions' }, el('button', { type: 'submit', class: 'button button--primary' }, label)),
  );
}

/* ---------- where the agent looks ---------- */

function sourcesCard(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  const placeholders = state.setup?.sources.placeholders ?? 0;
  return el(
    'section',
    { class: 'settings-card', id: 'settings-sources', 'aria-labelledby': 'settings-sources-title' },
    el('h3', { class: 'settings-card__title', id: 'settings-sources-title' }, 'Where the agent looks'),
    el(
      'p',
      { class: 'settings-card__help' },
      'Your name as others write it, your accounts and calendars, and the documents worth re-reading each morning. ' +
        'The morning prompt says what to gather; this says who you are and where to find it. Replace the placeholders ' +
        'and delete whatever does not apply: a section that is wrong is worse than one that is missing.',
    ),
    placeholders > 0
      ? el(
          'p',
          { class: 'settings-card__warning' },
          `${placeholders} of the template's placeholders ${placeholders === 1 ? 'is' : 'are'} still in the saved list.`,
        )
      : null,
    textEditor('sources', ui.texts.value.sources, handlers, 'sources.md'),
  );
}

/* ---------- the editors ---------- */

/** One of the two files, whole, with its save and what to do when it changed on disk meanwhile. */
export function textEditor(name: TextName, editor: TextEditor | undefined, handlers: Handlers, file: string): JSX.Element {
  if (!editor) return el('p', { class: 'empty' }, `Opening ${file}…`);
  const unchangedTemplate = editor.saved === null && editor.draft === editor.template;
  const dirty = editor.saved === null ? !unchangedTemplate : editor.draft !== editor.saved;
  const status =
    editor.saved === null
      ? unchangedTemplate
        ? `${file} doesn't exist yet. This is what it starts as.`
        : 'Not saved yet.'
      : dirty
        ? 'Unsaved changes.'
        : 'Saved.';
  return el(
    'div',
    { class: 'text-editor' },
    el('textarea', {
      class: 'text-editor__area',
      'aria-label': file,
      spellcheck: false,
      rows: name === 'sources' ? 24 : 14,
      value: editor.draft,
      onInput: (event: InputEvent) => handlers.editText(name, (event.currentTarget as HTMLTextAreaElement).value),
    }),
    editor.conflict
      ? el(
          'div',
          { class: 'text-editor__conflict', role: 'alert' },
          el(
            'p',
            null,
            editor.conflict.text === null
              ? `${file} was deleted since you opened it.`
              : `${file} changed on disk since you opened it, so it wasn't saved.`,
          ),
          el('button', { type: 'button', class: 'button', onClick: () => handlers.reloadText(name) }, 'Load the new version'),
          el('button', { type: 'button', class: 'button', onClick: () => handlers.saveText(name, true) }, 'Save mine over it'),
        )
      : null,
    el(
      'div',
      { class: 'text-editor__bar' },
      el('span', { class: 'text-editor__status' }, status),
      el(
        'button',
        {
          type: 'button',
          class: 'button button--primary',
          disabled: !dirty || editor.saving,
          onClick: () => handlers.saveText(name),
        },
        editor.saving ? 'Saving…' : `Save ${file}`,
      ),
    ),
  );
}

/* ---------- one setting ---------- */

/** What the field shows: the draft if there is one, otherwise whatever is in effect but a default. */
function shownValue(setting: SettingView, draft: ReadonlyMap<string, string | null>): string {
  if (draft.has(setting.key)) return draft.get(setting.key) ?? '';
  return setting.source === 'default' ? '' : (setting.value ?? '');
}

/** On, off, or the default, from any of the spellings `config.ts` accepts. */
function flagValue(raw: string): string {
  if (raw === '') return '';
  return ['off', 'false', '0', 'no'].includes(raw.trim().toLowerCase()) ? 'off' : 'on';
}

function field(setting: SettingView, draft: ReadonlyMap<string, string | null>, handlers: Handlers): JSX.Element {
  const id = `setting-${setting.key}`;
  const locked = setting.source === 'environment';
  const value = shownValue(setting, draft);
  const onChange = (event: Event) => {
    const next = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    handlers.editSetting(setting.key, next.trim() === '' ? null : next);
  };

  let input: JSX.Element;
  if (setting.kind === 'choice' || setting.kind === 'flag') {
    const choices = setting.kind === 'flag' ? [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] : (setting.choices ?? []);
    const current = setting.kind === 'flag' ? flagValue(value) : value;
    input = el(
      'select',
      { class: 'field__input', id, disabled: locked, value: current, onChange },
      el('option', { value: '' }, `Default: ${setting.fallback}`),
      choices.map((choice) => el('option', { value: choice.value, key: choice.value }, choice.label)),
    );
  } else {
    input = el('input', {
      class: 'field__input',
      id,
      type: 'text',
      inputmode: setting.kind === 'number' ? 'numeric' : undefined,
      disabled: locked,
      value,
      placeholder: setting.fallback,
      autocomplete: 'off',
      spellcheck: false,
      onInput: onChange,
    });
  }

  const note =
    setting.source === 'environment'
      ? 'Set in the environment this dashboard was started with, which wins over this page.'
      : setting.source === 'dotenv' && !draft.has(setting.key)
        ? 'From the .env file. Saving a value here takes its place.'
        : null;

  return el(
    'div',
    { class: 'field', key: setting.key, 'data-changed': String(draft.has(setting.key)) },
    el('label', { class: 'field__label', for: id }, setting.label),
    input,
    el('p', { class: 'field__help' }, setting.help),
    note ? el('p', { class: 'field__note' }, note) : null,
  );
}

/* ---------- calendars ---------- */

/**
 * The calendars on this Mac, to tick rather than type: Calendar.app's spelling
 * is the one that matters, and it is not always the one you would guess.
 */
function calendarPicker(state: DashboardState, ui: UiState, handlers: Handlers, settings: readonly SettingView[]): JSX.Element | null {
  const calendar = state.setup?.calendar;
  if (!calendar?.supported) return null;
  if (!calendar.built) {
    return el(
      'p',
      { class: 'field__note' },
      'The live agenda needs the calendar helper. Build it once with ',
      el('code', null, calendar.buildCommand),
      ', and allow calendar access when macOS asks.',
    );
  }
  const setting = settings.find((entry) => entry.key === 'DAILY_FOCUS_CALENDARS');
  if (!setting || setting.source === 'environment') return null;
  const chosen = shownValue(setting, ui.settingsDraft.value)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const listed = ui.calendars.value;
  const toggle = (title: string, on: boolean) => {
    const next = on ? [...chosen.filter((name) => name !== title), title] : chosen.filter((name) => name !== title);
    handlers.editSetting('DAILY_FOCUS_CALENDARS', next.length > 0 ? next.join(',') : null);
  };
  return el(
    'div',
    { class: 'calendar-picker' },
    el('button', { type: 'button', class: 'button', onClick: () => handlers.listCalendars() }, 'List the calendars on this Mac'),
    typeof listed === 'string' ? el('p', { class: 'settings-card__warning' }, listed) : null,
    Array.isArray(listed)
      ? el(
          'ul',
          { class: 'calendar-picker__list' },
          (listed as readonly CalendarName[]).map((entry) =>
            el(
              'li',
              { key: `${entry.title}\n${entry.source}` },
              el(
                'label',
                null,
                el('input', {
                  type: 'checkbox',
                  checked: chosen.some((name) => name.toLowerCase() === entry.title.toLowerCase()),
                  onChange: (event: Event) => toggle(entry.title, (event.currentTarget as HTMLInputElement).checked),
                }),
                ` ${entry.title}`,
                entry.source ? el('span', { class: 'calendar-picker__source' }, ` · ${entry.source}`) : null,
              ),
            ),
          ),
        )
      : null,
  );
}

/* ---------- saving ---------- */

function saveBar(ui: UiState, handlers: Handlers): JSX.Element {
  const count = ui.settingsDraft.value.size;
  const error = ui.settingsError.value;
  const saving = ui.settingsSaving.value;
  return el(
    'div',
    { class: 'settings__bar', hidden: count === 0 && !error, role: 'region', 'aria-label': 'Unsaved settings' },
    el(
      'p',
      { class: error ? 'settings__bar-text settings__bar-text--error' : 'settings__bar-text' },
      error ?? `${count} unsaved ${count === 1 ? 'change' : 'changes'}. Saving restarts the dashboard to apply ${count === 1 ? 'it' : 'them'}.`,
    ),
    el('button', { type: 'button', class: 'button', disabled: saving, onClick: () => handlers.discardSettings() }, 'Discard'),
    el(
      'button',
      { type: 'button', class: 'button button--primary', disabled: saving || count === 0, onClick: () => handlers.saveSettings() },
      saving ? 'Saving…' : 'Save',
    ),
  );
}
