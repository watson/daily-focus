/**
 * The setup screen: the whole page, until a new store is set up.
 *
 * One question at a time, in a thread that grows downward. Answered questions
 * fold into a sentence with a Change beside it; the open one is a card with the
 * likely answer already ticked; what is left is a line under it, with what the
 * CLI is already looking into for the next one. The questions, the ticks and
 * the sentences all come from the server (`src/questions.ts`); this draws them
 * and keeps what the user has changed until they answer.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { DashboardState, OnboardingChoice, OnboardingField, OnboardingState, OnboardingStep } from '../src/types.ts';
import { el } from './el.ts';
import type { Handlers, SetupDraft, UiState } from './types.ts';

type Chosen = SetupDraft['answer'];

/** Roughly how long a question takes to answer, for the time left. */
const SECONDS_PER_STEP = 20;

export function OnboardingView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element {
  const flow = state.onboarding!;
  const open = flow.steps.filter((step) => step.status === 'open');
  const editing = ui.setupEditing.value;
  // Looking for the CLIs runs programs on the user's behalf, so it waits for
  // the screen to be open; and again after a restart, which forgets it.
  useEffect(() => {
    if (!flow.detected) handlers.detectSetup();
  }, [flow.detected]);
  return el(
    'div',
    { class: 'onboarding' },
    el(
      'header',
      { class: 'onboarding__bar' },
      el('span', { class: 'onboarding__name' }, 'Daily Focus'),
      progress(flow),
    ),
    el(
      'main',
      { class: 'onboarding__column', id: 'main' },
      flow.steps.length > 0 && flow.steps.every((step) => step.status === 'open') && flow.steps[0]!.id === flow.current
        ? el(
            'p',
            { class: 'onboarding__lede' },
            'Each morning an agent reads your mail, calendar, pull requests and the rest, and writes a short brief of what ' +
              'needs doing today. A few questions get it ready; most are answered already, so confirm or change them.',
          )
        : null,
      el(
        'ol',
        { class: 'onboarding__thread' },
        flow.steps.map((step) => {
          if (step.id === flow.current || step.id === editing) {
            return el('li', { key: step.id }, h(StepCard, { step, ui, handlers, current: step.id === flow.current }));
          }
          if (step.status === 'open') return null;
          return el('li', { key: step.id }, doneRow(step, handlers, ui.setupBusy.value !== null));
        }),
        flow.current === null ? el('li', { key: 'finish' }, h(FinishCard, { flow, ui, handlers })) : ahead(flow, open),
      ),
    ),
  );
}

function progress(flow: OnboardingState): JSX.Element {
  const total = flow.steps.length + 1;
  const left = flow.steps.filter((step) => step.status === 'open').length;
  const seconds = left * SECONDS_PER_STEP;
  const text =
    flow.current === null ? 'Ready when you are' : seconds < 60 ? 'Under a minute left' : seconds < 120 ? 'About a minute left' : `About ${Math.round(seconds / 60)} minutes left`;
  const done = total - left - (flow.current === null ? 0 : 1);
  return el(
    'div',
    { class: 'onboarding__progress' },
    el(
      'div',
      { class: 'onboarding__track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done, 'aria-label': 'Setup' },
      el('i', { style: { width: `${Math.round((done / total) * 100)}%` } }),
    ),
    el('span', null, text),
  );
}

/** An answered question, as the sentence it adds up to. */
function doneRow(step: OnboardingStep, handlers: Handlers, busy: boolean): JSX.Element {
  return el(
    'div',
    { class: 'onboarding__done', 'data-status': step.status, 'data-step': step.id },
    el('span', { class: 'onboarding__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'onboarding__summary' }, step.status === 'later' ? `${step.topic[0]!.toUpperCase()}${step.topic.slice(1)}: decide later.` : step.summary),
    step.locked
      ? el('span', { class: 'onboarding__locked', title: 'Set in the environment the dashboard was started with' }, 'Set by the environment')
      : el('button', { type: 'button', class: 'onboarding__change', disabled: busy, onClick: () => handlers.editSetupStep(step.id) }, 'Change'),
  );
}

/** What is left after the open question: the next one the CLI is already on, then the rest by name. */
function ahead(flow: OnboardingState, open: OnboardingStep[]): JSX.Element | null {
  const rest = open.filter((step) => step.id !== flow.current);
  const looking = rest.find((step) => step.proposal?.status === 'working');
  const topics = rest.filter((step) => step !== looking).map((step) => step.topic);
  // The next few by name; a long list reads as a chore.
  const later = topics.length > 4 ? [...topics.slice(0, 3), `${topics.length - 3} more`] : topics;
  return el(
    'li',
    { key: 'ahead', class: 'onboarding__ahead' },
    looking
      ? el(
          'div',
          { class: 'onboarding__next' },
          el('span', { class: 'onboarding__dot onboarding__dot--looking', 'aria-hidden': 'true' }),
          el('p', null, `Next, ${looking.topic}. It's already looking:`),
          steps(looking),
        )
      : null,
    el(
      'p',
      { class: 'onboarding__then' },
      el('span', { class: 'onboarding__dot onboarding__dot--later', 'aria-hidden': 'true' }),
      later.length ? `Then ${listed([...later, 'your first brief'])}.` : 'Then your first brief.',
    ),
  );
}

/** The last few things a CLI did, the newest last. */
function steps(step: OnboardingStep, count = 3): JSX.Element | null {
  const shown = (step.proposal?.steps ?? []).filter((s) => s.kind === 'tool').slice(-count);
  // Its last call done is not it done: it still has to write its answer, which
  // can take a few seconds, and a list of ticks alone reads as stuck.
  const waiting = step.proposal?.status === 'working' && !shown.some((s) => s.state === 'running');
  return el(
    'ul',
    { class: 'onboarding__steps' },
    shown.map((s, index) => el('li', { key: index, 'data-state': s.state, title: s.detail ?? undefined }, s.text)),
    waiting ? el('li', { key: 'waiting', 'data-state': 'running' }, shown.length ? 'Writing its answer…' : 'Starting…') : null,
  );
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/* ---------- the open question ---------- */

/** The answer the card starts from: the one given, when the question is reopened, or what the card ticks. */
function baseAnswer(step: OnboardingStep): Chosen {
  if (step.answer && step.answer.later !== true) return step.answer;
  return {
    choices: Object.fromEntries(step.card.choices.map((choice) => [choice.id, choice.selected])),
    fields: Object.fromEntries(step.card.fields.map((field) => [field.id, field.value])),
  };
}

function StepCard({ step, ui, handlers, current }: { step: OnboardingStep; ui: UiState; handlers: Handlers; current: boolean }): JSX.Element {
  const saved = ui.setupDrafts.value.get(step.id);
  const draft = saved?.answer ?? baseAnswer(step);
  const stale = saved !== undefined && saved.version !== step.card.version;
  const busy = ui.setupBusy.value !== null;
  const error = ui.setupError.value?.step === step.id ? ui.setupError.value.message : null;
  const editing = ui.setupEditing.value === step.id;
  const proposal = step.proposal;
  const looking = proposal?.status === 'working';
  const edit = (next: Chosen) => handlers.editSetupDraft(step.id, next, saved?.version ?? step.card.version);
  const tell = ui.setupTell.value.get(step.id) ?? '';
  const empty = step.card.choices.every((choice) => choice.options.length === 0) && step.card.fields.length === 0;
  const conversation = proposal?.conversation ?? [];
  // Working on something the user just asked for: their words are on screen already.
  const revising = conversation.at(-1)?.from === 'you';

  return el(
    'section',
    { class: 'onboarding__card', 'data-current': String(current), 'data-step': step.id, 'aria-labelledby': `setup-${step.id}` },
    el('span', { class: 'onboarding__dot onboarding__dot--open', 'aria-hidden': 'true' }),
    el('h2', { id: `setup-${step.id}`, tabIndex: -1 }, step.title),
    conversation.length
      ? el(
          'ol',
          { class: 'onboarding__talk' },
          conversation.map((line, index) =>
            line.from === 'it'
              ? el('li', { key: index, class: 'onboarding__why' }, sparkle(), el('span', null, line.text))
              : el('li', { key: index, class: 'onboarding__said' }, line.text),
          ),
        )
      : step.card.why && !(looking && empty)
        ? el('p', { class: 'onboarding__why' }, sparkle(), el('span', null, step.card.why))
        : null,
    looking
      ? el(
          'div',
          { class: 'onboarding__looking', role: 'status' },
          revising
            ? null
            : el('p', null, empty ? `Looking into ${step.topic}…` : 'Still looking. You can answer now, or wait for its pick.'),
          steps(step),
        )
      : null,
    // Under what it said, so a reply reads as one, and what comes back lands here too.
    step.card.revisable && !looking
      ? el(
          'form',
          {
            class: 'onboarding__tell',
            onSubmit: (event: Event) => {
              event.preventDefault();
              if (tell.trim() && !busy) handlers.reviseSetup(step.id, tell, draft);
            },
          },
          el('input', {
            type: 'text',
            value: tell,
            'aria-label': 'Tell it what to change',
            placeholder: 'Tell it what to change',
            onInput: (event: Event) => handlers.editSetupTell(step.id, (event.currentTarget as HTMLInputElement).value),
          }),
          el('button', { type: 'submit', class: 'button', disabled: busy || tell.trim() === '' }, 'Send'),
        )
      : null,
    proposal?.status === 'failed'
      ? el(
          'p',
          { class: 'onboarding__note' },
          `It couldn't look into this: ${proposal.error}. `,
          el('button', { type: 'button', class: 'link-button', disabled: busy, onClick: () => handlers.retrySetup(step.id) }, 'Try again'),
        )
      : null,
    stale
      ? el(
          'p',
          { class: 'onboarding__note' },
          'It has a new suggestion since you started changing this. ',
          el('button', { type: 'button', class: 'link-button', onClick: () => handlers.editSetupDraft(step.id, null, 0) }, 'Use it'),
        )
      : null,
    step.card.problem?.blocking ? problem(step, busy, handlers) : null,
    el(
      'form',
      {
        class: 'onboarding__form',
        onSubmit: (event: Event) => {
          event.preventDefault();
          if (!busy) handlers.answerSetup(step.id, draft);
        },
      },
      // Fields first: a card with both asks for the few words before the list.
      step.card.fields.length
        ? el(
            'div',
            { class: 'onboarding__fields' },
            step.card.fields.map((field) =>
              fieldView(field, draft.fields[field.id] ?? '', (value) => edit({ ...draft, fields: { ...draft.fields, [field.id]: value } })),
            ),
          )
        : null,
      step.card.choices.map((choice) =>
        h(ChoiceView, {
          choice,
          picked: draft.choices[choice.id] ?? [],
          onPick: (values: string[]) => edit({ ...draft, choices: { ...draft.choices, [choice.id]: values } }),
        }),
      ),
      step.card.problem && !step.card.problem.blocking ? problem(step, busy, handlers) : null,
      error ? el('p', { class: 'onboarding__error', role: 'alert' }, error) : null,
      el(
        'div',
        { class: 'onboarding__actions' },
        el(
          'button',
          { type: 'submit', class: 'button button--primary', disabled: busy || (empty && (looking || step.card.problem?.blocking === true)) },
          ui.setupBusy.value === step.id ? 'Saving…' : 'Continue',
        ),
        step.card.deferrable
          ? el(
              'button',
              { type: 'button', class: 'button onboarding__quiet', disabled: busy, onClick: () => handlers.answerSetup(step.id, { later: true }) },
              'Decide later',
            )
          : null,
        editing
          ? el('button', { type: 'button', class: 'button onboarding__quiet', onClick: () => handlers.editSetupStep(null) }, 'Cancel')
          : null,
      ),
    ),
  );
}

/**
 * Something to fix outside the dashboard, with the command that fixes it and a
 * way to look again. Above the card when nothing can be answered until it is
 * fixed; below it, quieter, when the answer stands without it.
 */
function problem(step: OnboardingStep, busy: boolean, handlers: Handlers): JSX.Element {
  const found = step.card.problem!;
  return el(
    'div',
    { class: 'onboarding__problem', 'data-blocking': String(found.blocking) },
    el('p', null, found.message),
    found.links?.length
      ? el(
          'p',
          { class: 'onboarding__links' },
          found.links.map((link) => el('a', { key: link.url, href: link.url, target: '_blank', rel: 'noopener' }, link.label)),
        )
      : null,
    found.command ? el('pre', null, el('code', null, found.command)) : null,
    el('button', { type: 'button', class: 'button', disabled: busy, onClick: () => handlers.retrySetup(step.id) }, 'Check again'),
  );
}

function sparkle(): JSX.Element {
  return el(
    'svg',
    { class: 'onboarding__sparkle', width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
    el('path', { d: 'M7 0l1.6 5.4L14 7l-5.4 1.6L7 14l-1.6-5.4L0 7l5.4-1.6z', fill: 'currentColor' }),
  );
}

/**
 * One choice: a list to tick when there is more to say about each option or
 * more than one may be picked, otherwise a row of pills. A value of the user's
 * own is added at the foot, or as a pill, and kept with the rest.
 */
function ChoiceView({ choice, picked, onPick }: { choice: OnboardingChoice; picked: string[]; onPick: (values: string[]) => void }): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const known = new Set(choice.options.map((option) => option.value));
  const own = picked.filter((value) => !known.has(value));
  const toggle = (value: string) => {
    if (!choice.multiple) return onPick([value]);
    onPick(picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value]);
  };
  const add = () => {
    const value = typed.trim();
    if (value) onPick(choice.multiple ? [...picked.filter((v) => v !== value), value] : [value]);
    setTyped('');
    setAdding(false);
  };
  const adder = choice.custom
    ? adding
      ? el(
          'div',
          { class: 'onboarding__add' },
          el('input', {
            type: 'text',
            value: typed,
            placeholder: choice.custom,
            'aria-label': choice.custom,
            ref: (input: HTMLInputElement | null) => input?.focus(),
            onInput: (event: Event) => setTyped((event.currentTarget as HTMLInputElement).value),
            onKeyDown: (event: KeyboardEvent) => {
              // Enter adds this, rather than answering the whole card.
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
              if (event.key === 'Escape') setAdding(false);
            },
          }),
          el('button', { type: 'button', class: 'button', onClick: add }, 'Add'),
        )
      : el('button', { type: 'button', class: 'onboarding__add-button', onClick: () => setAdding(true) }, choice.multiple ? choice.custom : 'Other…')
    : null;

  const label = choice.label ? el('legend', { class: 'onboarding__legend' }, choice.label) : null;
  const rows = choice.multiple || choice.options.some((option) => option.detail);
  if (!rows) {
    return el(
      'fieldset',
      { class: 'onboarding__choice' },
      label,
      el(
        'div',
        { class: 'onboarding__pills', role: 'radiogroup' },
        [...choice.options, ...own.map((value) => ({ value, label: value, detail: null, group: null }))].map((option) =>
          el(
            'button',
            {
              type: 'button',
              key: option.value,
              role: 'radio',
              class: 'onboarding__pill',
              'aria-checked': String(picked.includes(option.value)),
              onClick: () => toggle(option.value),
            },
            option.label,
          ),
        ),
        adder,
      ),
    );
  }

  // Grouped by account, in the order the groups first appear.
  const groups = new Map<string | null, typeof choice.options>();
  for (const option of choice.options) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  if (own.length) groups.set('Added by you', own.map((value) => ({ value, label: value, detail: null, group: 'Added by you' })));
  return el(
    'fieldset',
    { class: 'onboarding__choice' },
    label,
    el(
      'div',
      { class: 'onboarding__list' },
      [...groups].map(([group, options]) =>
        el(
          'div',
          { class: 'onboarding__group', key: group ?? '' },
          group ? el('p', { class: 'onboarding__group-name' }, group) : null,
          options.map((option) =>
            el(
              'label',
              { class: 'onboarding__option', key: option.value },
              el('input', {
                type: choice.multiple ? 'checkbox' : 'radio',
                name: choice.id,
                checked: picked.includes(option.value),
                onChange: () => toggle(option.value),
              }),
              el('span', { class: 'onboarding__box', 'data-kind': choice.multiple ? 'check' : 'radio', 'aria-hidden': 'true' }),
              el('span', { class: 'onboarding__option-text' }, option.label, option.detail ? el('small', null, option.detail) : null),
            ),
          ),
        ),
      ),
      choice.options.length === 0 && own.length === 0 && !choice.custom ? el('p', { class: 'onboarding__none' }, 'Nothing to choose from.') : null,
      adder ? el('div', { class: 'onboarding__adder' }, adder) : null,
    ),
  );
}

function fieldView(field: OnboardingField, value: string, onInput: (value: string) => void): JSX.Element {
  return el(
    'label',
    { class: 'onboarding__field', key: field.id },
    el('span', { class: 'onboarding__field-label' }, field.label),
    el('input', {
      type: 'text',
      value,
      placeholder: field.placeholder ?? undefined,
      onInput: (event: Event) => onInput((event.currentTarget as HTMLInputElement).value),
    }),
    field.help ? el('small', null, field.help) : null,
  );
}

/* ---------- the finish ---------- */

function FinishCard({ flow, ui, handlers }: { flow: OnboardingState; ui: UiState; handlers: Handlers }): JSX.Element {
  const writes = flow.steps.find((step) => step.id === 'cli')?.status === 'answered';
  const busy = ui.setupBusy.value !== null;
  const error = (ui.setupError.value?.step === 'finish' ? ui.setupError.value.message : null) ?? flow.error;
  const sources = ui.setupSources.value;
  return el(
    'section',
    { class: 'onboarding__card onboarding__finish', 'data-current': 'true', 'aria-labelledby': 'setup-finish' },
    el('span', { class: 'onboarding__dot onboarding__dot--open', 'aria-hidden': 'true' }),
    el('h2', { id: 'setup-finish', tabIndex: -1 }, writes ? 'Ready for your first brief' : 'Ready to finish'),
    el(
      'p',
      { class: 'onboarding__why' },
      writes
        ? 'It takes a few minutes, and you can watch it work. After that it runs by itself, and everything here can be changed in Settings.'
        : 'Without an agent there is no brief to write yet. Choose one in Settings when you are ready; the boards work meanwhile.',
    ),
    el(
      'details',
      {
        class: 'onboarding__preview',
        onToggle: (event: Event) => {
          if ((event.currentTarget as HTMLDetailsElement).open && sources === null) handlers.loadSetupSources();
        },
      },
      el('summary', null, 'What the morning agent reads each morning'),
      sources === null || sources === 'loading'
        ? el('p', null, 'Loading…')
        : 'error' in sources
          ? el('p', null, `Could not show it: ${sources.error}`)
          : sources.kept
            ? el('p', null, 'Your source list is already written, and setup leaves it as it is.')
            : sources.text
              ? el('pre', null, sources.text)
              : el('p', null, 'Nothing yet: the agent briefs from what it can reach, and says what it missed.'),
    ),
    error ? el('p', { class: 'onboarding__error', role: 'alert' }, error) : null,
    el(
      'div',
      { class: 'onboarding__actions' },
      el(
        'button',
        { type: 'button', class: 'button button--primary', disabled: busy, onClick: () => handlers.finishSetup() },
        ui.setupBusy.value === 'finish' ? 'Saving…' : writes ? 'Write my first brief' : 'Finish setup',
      ),
    ),
  );
}
