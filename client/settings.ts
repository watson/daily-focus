/**
 * The settings page: your objective, where the agent looks, and every setting.
 *
 * Built from what the server says about each setting (`src/settings.ts`), so a
 * setting added there appears here with nothing to write. Changes collect in a
 * draft until Save, because saving restarts the dashboard and a restart per
 * keystroke would be absurd. The two files in your words are saved on their own,
 * since saving them restarts nothing.
 */

import { h, type ComponentChild, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { SettingView } from '../src/settings.ts';
import type { DashboardState, Service } from '../src/types.ts';
import { el } from './el.ts';
import { connectionView } from './connect.ts';
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
  const sections: Section[] = [
    { id: 'objective', title: 'Your objective' },
    { id: 'sources', title: 'Where the agent looks' },
    ...(page?.groups ?? []),
  ];

  return el(
    'div',
    { class: 'settings' },
    el(
      'div',
      { class: 'settings__head' },
      el('h2', { class: 'settings__title' }, 'Settings'),
      el('button', { type: 'button', class: 'button', onClick: () => handlers.closeSettings() }, `Back to ${VIEW_NAME[ui.settingsReturn.value]}`),
    ),
    h(SectionIndex, { sections }),
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
            plain.map((setting) => settingField(setting, draft, handlers)),
            group.id === 'calendar' ? calendarPicker(state, ui, handlers, page.settings) : null,
            group.id === 'github' || group.id === 'jira' ? serviceAccount(group.id, state, handlers) : null,
            advanced.length > 0
              ? el(
                  'details',
                  { class: 'settings-card__more' },
                  el('summary', null, 'More'),
                  advanced.map((setting) => settingField(setting, draft, handlers)),
                )
              : null,
          );
        })
      : el('p', { class: 'empty' }, 'Loading the settings…'),
    saveBar(ui, handlers),
  );
}

/* ---------- the index ---------- */

interface Section {
  id: string;
  title: string;
}

/**
 * The groups, listed beside the page, with the one in view marked. Each entry
 * is a link to `#settings-<id>`, which `followLocation` turns into a scroll to
 * the card and nothing more, so the links need no handler of their own. Which
 * is in view is read off the document as the page scrolls: the last card whose
 * top has passed the band.
 */
function SectionIndex({ sections }: { sections: readonly Section[] }): JSX.Element {
  const [current, setCurrent] = useState<string | null>(sections[0]?.id ?? null);
  useEffect(() => {
    const look = (): void => {
      let seen: string | null = sections[0]?.id ?? null;
      for (const section of sections) {
        const card = document.getElementById(`settings-${section.id}`);
        if (card && card.getBoundingClientRect().top <= 120) seen = section.id;
      }
      setCurrent(seen);
    };
    look();
    window.addEventListener('scroll', look, { passive: true });
    return () => window.removeEventListener('scroll', look);
  }, [sections.map((section) => section.id).join(' ')]);
  return el(
    'nav',
    { class: 'settings__nav', 'aria-label': 'Settings sections' },
    sections.map((section) =>
      el('a', { key: section.id, href: `#settings-${section.id}`, 'aria-current': section.id === current ? 'true' : undefined }, section.title),
    ),
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
function objectiveForm(objective: string, blocker: string, handlers: Handlers): JSX.Element {
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
    el('div', { class: 'objective-form__actions' }, el('button', { type: 'submit', class: 'button button--primary' }, 'Save objective')),
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

/** How many answers fit a segmented control; more than this is a dropdown. */
const SEGMENTS = 4;

/** On, off, or the default, from any of the spellings `config.ts` accepts. */
function flagValue(raw: string): string {
  if (raw === '') return '';
  return ['off', 'false', '0', 'no'].includes(raw.trim().toLowerCase()) ? 'off' : 'on';
}

/** One setting's field, editing the draft. */
function settingField(setting: SettingView, draft: ReadonlyMap<string, string | null>, handlers: Handlers): JSX.Element {
  const id = `setting-${setting.key}`;
  const locked = setting.source === 'fixed';
  const value = shownValue(setting, draft);
  const onChange = (event: Event) => {
    const next = (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
    handlers.editSetting(setting.key, next.trim() === '' ? null : next);
  };

  let input: JSX.Element;
  if (setting.kind === 'choice' || setting.kind === 'flag') {
    const choices = setting.kind === 'flag' ? [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] : (setting.choices ?? []);
    const current = setting.kind === 'flag' ? flagValue(value) : value;
    // A yes/no or a short list is a segmented control of the real answers and
    // nothing else: a two-answer question shows two. The default is one of them,
    // found by the label the server describes it with; picking it means "use the
    // default", so the page never saves a value only to restate one, and while
    // the default is what is in force its segment says so. A longer list, or a
    // default that is none of the answers, stays a dropdown with the default as
    // its first entry.
    const fallback = choices.find((choice) => choice.label.toLowerCase() === setting.fallback.toLowerCase());
    input =
      choices.length <= SEGMENTS && fallback
        ? el(
            'div',
            { class: 'segmented', id, role: 'radiogroup', 'aria-label': setting.label, 'aria-disabled': String(locked) },
            choices.map((choice) => {
              const isDefault = choice.value === fallback.value;
              const checked = current === '' ? isDefault : current === choice.value;
              return el(
                'button',
                {
                  type: 'button',
                  key: choice.value,
                  role: 'radio',
                  class: 'segmented__option',
                  'aria-checked': String(checked),
                  disabled: locked,
                  title: isDefault ? 'The default' : undefined,
                  onClick: () => handlers.editSetting(setting.key, isDefault ? null : choice.value),
                },
                choice.label,
                checked && current === '' ? el('small', null, 'default') : null,
              );
            }),
          )
        : el(
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

  return el(
    'div',
    { class: 'field', key: setting.key, 'data-changed': String(draft.has(setting.key)) },
    el('label', { class: 'field__label', for: id }, setting.label),
    input,
    el('p', { class: 'field__help' }, setting.help),
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
    if (calendar.macApp) {
      return el(
        'p',
        { class: 'field__note' },
        'The live agenda needs the calendar helper, which comes with ',
        el('a', { href: calendar.macApp, target: '_blank', rel: 'noopener' }, 'the Mac app'),
        '. Without the app, build it once with ',
        el('code', null, calendar.buildCommand),
        ', and allow calendar access when macOS asks.',
      );
    }
    return el(
      'p',
      { class: 'field__note' },
      'The live agenda needs the calendar helper. Build it once with ',
      el('code', null, calendar.buildCommand),
      ', and allow calendar access when macOS asks.',
    );
  }
  const setting = settings.find((entry) => entry.key === 'DAILY_FOCUS_CALENDARS');
  if (!setting) return null;
  const chosen = shownValue(setting, ui.settingsDraft.value)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const listed = ui.calendars.value;
  // Case-insensitive throughout, as the server matches the names: a saved `work`
  // shows `Work` ticked, so it has to be able to untick it too.
  const toggle = (title: string, on: boolean) => {
    const others = chosen.filter((name) => name.toLowerCase() !== title.toLowerCase());
    const next = on ? [...others, title] : others;
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

/* ---------- GitHub and Jira ---------- */

/**
 * Which copy of a service's CLI is in use, for the line above its button. The
 * rule is the same in each case, said from where the user stands: one they
 * installed is used, and Daily Focus has its own only for want of one. One of
 * their own they also sign in themselves, with `command`: signing it in again
 * from here would switch its account and replace its token under them.
 */
const WHERE: Record<Service, { missing: string; fetched: string; own: string; signIn: string; command: string }> = {
  github: {
    missing: 'If you install the GitHub CLI yourself, Daily Focus uses it. Otherwise it gets its own copy when you connect.',
    fetched: 'Daily Focus uses its own copy of the GitHub CLI. If you install it yourself, it uses yours instead.',
    own: 'Daily Focus uses the GitHub CLI you already have installed.',
    signIn: 'To sign in again or as another account, run',
    command: 'gh auth login',
  },
  jira: {
    missing: 'If you install the Atlassian CLI yourself, Daily Focus uses it. Otherwise it gets its own copy when you connect.',
    fetched: 'Daily Focus uses its own copy of the Atlassian CLI. If you install it yourself, it uses yours instead.',
    own: 'Daily Focus uses the Atlassian CLI you already have installed.',
    signIn: 'To sign in again or as another account, run',
    command: 'acli jira auth login --web',
  },
};

/**
 * Who the board reads a service as, and a way to connect it or sign in again.
 * The page signs in again only for a CLI Daily Focus fetched, which has no
 * terminal to do it in; one of the user's own is theirs to sign in, and the note
 * says how. Connecting stays for both while nobody is signed in.
 */
function serviceAccount(service: Service, state: DashboardState, handlers: Handlers): JSX.Element | null {
  // Absent from a server older than the page.
  const connection = state.connections?.[service];
  if (!connection) return null;
  const accounts =
    service === 'github'
      ? state.board.accounts.filter((account) => account.ok).map((account) => account.login)
      : state.tickets.account && !state.tickets.reason
        ? [state.tickets.account]
        : [];
  const where = WHERE[service];
  const own = connection.cli.found && !connection.cli.fetched;
  const signedIn = accounts.length > 0;
  return el(
    'div',
    { class: 'service-account' },
    el(
      'p',
      { class: 'field__note' },
      signedIn ? ['Signed in as ', ...accountNames(service, accounts), '. '] : null,
      !connection.cli.found ? where.missing : connection.cli.fetched ? where.fetched : where.own,
      own && signedIn ? [' ', where.signIn, ' ', el('code', null, where.command), '.'] : null,
    ),
    own && signedIn ? null : connectionView(service, connection, handlers, signedIn ? { label: 'Sign in again', again: true } : {}),
  );
}

/** The accounts, set apart from the words around them: a GitHub login as GitHub writes it, with an @. */
function accountNames(service: Service, accounts: readonly string[]): ComponentChild[] {
  return accounts.flatMap((account, i) => [
    i === 0 ? '' : i === accounts.length - 1 ? ' and ' : ', ',
    el('strong', { class: 'service-account__name', key: account }, service === 'github' ? `@${account}` : account),
  ]);
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
