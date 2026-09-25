/**
 * The panel beside the list: one row's notes and its conversation with the
 * assistant, and a field for each. Or, under `RUN_PREFIX`, one run of the
 * morning agent — see `runs.ts`.
 *
 * Beside the list rather than under the row, because the row is for deciding and
 * this is for reading. A transcript under a card pushed the rest of the list down
 * and a note form did the same in miniature; here the list stays where it was and
 * one panel holds what would otherwise be stuffed into every card in turn. It is
 * pinned to the row it was opened for — `j` and `k` move the cursor, not this —
 * and it stays open across the tabs, since the same id can be a row on more than
 * one of them and the notes and the conversation are the same wherever it is.
 */

import { h, type ComponentChild, type RefObject, type JSX } from 'preact';
import { useRef } from 'preact/hooks';

import type { AgentRun, AssistantItemState, AssistantQuickAction, AssistantTurn, DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { relativeTime } from './format.ts';
import { SOURCE_LABEL, githubRepo, sourceColor } from './items.ts';
import { renderMarkdown, renderMarkdownBlocks } from './markdown.ts';
import { usePanel } from './panel.ts';
import { RunPanel } from './runs.ts';
import { RUN_PREFIX, type DetailRow } from './state.ts';
import { typeColor } from './tickets.ts';
import type { Handlers, UiState } from './types.ts';

export interface FlyoutProps {
  /** The row the panel is open on, or null: nothing open, or the row it was open for has gone. */
  row: DetailRow | null;
  /** The run the panel is open on instead, if it is open on one. */
  run: AgentRun | null;
  state: DashboardState;
  ui: UiState;
  handlers: Handlers;
}

/**
 * The panel's frame. Its body is keyed by what it is open on, so moving it to
 * another row builds a fresh one — new fields, scrolled to the end — while a
 * state push on the same row leaves every element where it was.
 */
export function Flyout({ row, run, state, ui, handlers }: FlyoutProps): JSX.Element {
  const id = run ? `${RUN_PREFIX}${run.id}` : (row?.id ?? null);
  return el(
    'aside',
    { class: 'flyout', id: 'flyout', 'aria-label': 'Item details', hidden: id === null, 'data-id': id ?? undefined },
    run
      ? h(RunPanel, { key: id, run, state, ui, handlers })
      : row
        ? h(RowPanel, { key: id, row, state, ui, handlers })
        : null,
  );
}

function RowPanel({ row, state, ui, handlers }: { row: DetailRow; state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  const noteInput = useRef<HTMLInputElement>(null);
  const askInput = useRef<HTMLTextAreaElement>(null);
  const { body, onScroll } = usePanel(ui, { note: noteInput, assistant: askInput });

  const facts = describeRow(row);
  const now = new Date(state.now);
  const enabled = Boolean(state.assistant?.enabled);
  const entry: AssistantItemState = state.assistant?.items?.[row.id] ?? { running: false, sessionId: null, turns: [] };

  return [
    flyoutHeader(facts, handlers),
    el(
      'div',
      { class: 'flyout__body', ref: body, onScroll },
      facts.detail ? el('p', { class: 'flyout__detail' }, renderMarkdown(facts.detail)) : null,
      el(
        'section',
        { class: 'flyout__section' },
        el('h3', { class: 'flyout__label' }, 'Notes'),
        row.notes.length
          ? el(
              'div',
              { class: 'flyout__notes' },
              row.notes.map((note) =>
                el(
                  'p',
                  { class: 'flyout__note' },
                  `“${note.text}”`,
                  note.at ? el('span', { class: 'flyout__when' }, ` ${relativeTime(note.at, now)}`) : null,
                ),
              ),
            )
          : el('p', { class: 'flyout__empty' }, 'Nothing noted yet. A note goes to the morning agent as free text.'),
        h(NoteForm, { row, title: facts.title, ui, handlers, inputRef: noteInput }),
      ),
      enabled ? renderAssistantSection(row, facts, state, entry, ui, handlers, askInput) : null,
    ),
  ];
}

interface RowFacts {
  ref: string | null;
  title: string;
  url: string | null;
  source: string;
  color: string;
  status: string | null;
  people: readonly string[];
  detail: string | null;
}

/**
 * What the panel says at the top of every kind of row, in the row's own terms.
 * A ticket is its key and summary, a pull request its `repo#number`, a brief item
 * its title and whatever the agent wrote under it. Read off the fields rather
 * than off a type tag, since the rows have none.
 */
export function describeRow(row: DetailRow): RowFacts {
  if ('key' in row && 'summary' in row) {
    return {
      ref: row.key,
      title: row.summary,
      url: row.url ?? null,
      source: 'jira',
      color: typeColor(row.issueType),
      status: row.workflowStatus || null,
      people: [],
      detail: null,
    };
  }
  if ('number' in row && 'repo' in row) {
    return {
      ref: `${row.repo}#${row.number}`,
      title: row.title,
      url: row.url ?? null,
      source: 'github',
      color: sourceColor('github'),
      status: null,
      people: [],
      detail: null,
    };
  }
  return {
    ref: githubRepo(row),
    title: row.title,
    url: row.url ?? null,
    source: row.source,
    color: sourceColor(row.source),
    status: null,
    people: row.people ?? [],
    detail: row.detail ?? null,
  };
}

function flyoutHeader(facts: RowFacts, handlers: Handlers): JSX.Element {
  const title: ComponentChild[] = facts.ref ? [el('span', { class: 'item__ref' }, facts.ref), ' ', facts.title] : [facts.title];
  return el(
    'div',
    { class: 'flyout__header' },
    el(
      'div',
      { class: 'flyout__where' },
      el('span', { class: 'item__dot', style: `background:${facts.color}`, 'aria-hidden': 'true' }),
      el('span', { class: 'item__source' }, SOURCE_LABEL[facts.source] ?? 'Other'),
      facts.status ? el('span', null, `· ${facts.status}`) : null,
      facts.people.length ? el('span', null, `· ${facts.people.join(', ')}`) : null,
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button flyout__close',
        title: 'Close (Esc)',
        'aria-label': 'Close the panel',
        onClick: () => handlers.closeDetail(),
      },
      '×',
    ),
    el(
      'p',
      { class: 'flyout__title' },
      facts.url ? el('a', { href: facts.url, target: '_blank', rel: 'noopener noreferrer' }, ...title) : title,
    ),
  );
}

/**
 * One line, on purpose. A note is a sentence for the morning agent — "nudged
 * them", "waiting on legal" — appended to the action log and read back as free
 * text in tomorrow's brief. Anything with more shape than that is a conversation,
 * and the assistant's field below takes paragraphs.
 *
 * A component of its own so that a keystroke reruns this and nothing else.
 */
function NoteForm({
  row,
  title,
  ui,
  handlers,
  inputRef,
}: {
  row: DetailRow;
  title: string;
  ui: UiState;
  handlers: Handlers;
  inputRef: RefObject<HTMLInputElement>;
}): JSX.Element {
  return el(
    'form',
    {
      class: 'flyout__note-form',
      onSubmit: (event: Event) => {
        event.preventDefault();
        const text = ui.noteDraft.value.trim();
        if (text) handlers.saveNote(row.id, text);
      },
    },
    el('input', {
      type: 'text',
      class: 'flyout__note-input',
      ref: inputRef,
      value: ui.noteDraft.value,
      placeholder: 'Tell the agent what happened…',
      'aria-label': `Note for ${title}`,
      onInput: (event: Event) => {
        ui.noteDraft.value = (event.currentTarget as HTMLInputElement).value;
      },
    }),
    el('button', { type: 'submit', class: 'button button--primary flyout__submit' }, 'Save'),
  );
}

/**
 * The conversation so far, the canned asks that fit this row's source, and the
 * field, in that order — one section, with the field at its foot the way a chat
 * has one. All of it scrolls with the panel; `usePanel` keeps the end in view
 * while a reply grows.
 */
function renderAssistantSection(
  row: DetailRow,
  facts: RowFacts,
  state: DashboardState,
  entry: AssistantItemState,
  ui: UiState,
  handlers: Handlers,
  inputRef: RefObject<HTMLTextAreaElement>,
): JSX.Element {
  const source = 'source' in row ? row.source : 'github';
  const actions = (state.assistant?.quickActions ?? []).filter(
    (action) => action.sources === null || action.sources.includes(source),
  );
  const label = new Map((state.assistant?.quickActions ?? []).map((action) => [action.id, action]));

  return el(
    'section',
    { class: 'flyout__section assistant', 'data-running': String(entry.running) },
    el('h3', { class: 'flyout__label' }, 'Assistant'),
    entry.turns.length
      ? el(
          'div',
          { class: 'assistant__turns' },
          entry.turns.map((turn) => renderAssistantTurn(turn, label)),
        )
      : null,
    entry.running
      ? null
      : el(
          'div',
          { class: 'assistant__quick' },
          actions.map((action) =>
            el(
              'button',
              {
                type: 'button',
                class: 'pill pill--button',
                title: action.request,
                onClick: () => handlers.ask(row.id, { action: action.id }),
              },
              action.label,
            ),
          ),
        ),
    h(AssistantComposer, { row, title: facts.title, entry, ui, handlers, inputRef }),
  );
}

/** The field at the foot of the assistant section. Its own component, for the reason `NoteForm` is. */
function AssistantComposer({
  row,
  title,
  entry,
  ui,
  handlers,
  inputRef,
}: {
  row: DetailRow;
  title: string;
  entry: AssistantItemState;
  ui: UiState;
  handlers: Handlers;
  inputRef: RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  const submit = (): void => {
    const text = ui.assistantDraft.value.trim();
    if (!text || entry.running) return;
    handlers.ask(row.id, { text });
  };

  return el(
    'form',
    {
      class: 'assistant__form',
      'data-running': String(entry.running),
      onSubmit: (event: Event) => {
        event.preventDefault();
        submit();
      },
    },
    el('textarea', {
      class: 'assistant__input',
      rows: 2,
      ref: inputRef,
      value: ui.assistantDraft.value,
      placeholder: entry.turns.length ? 'Follow up…' : 'What do you need help with?',
      'aria-label': `Ask the assistant about ${title}`,
      disabled: entry.running,
      onInput: (event: Event) => {
        ui.assistantDraft.value = (event.currentTarget as HTMLTextAreaElement).value;
      },
      onKeyDown: (event: KeyboardEvent) => {
        // Enter sends; shift-enter is a new line, as in every chat box.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      },
    }),
    entry.running
      ? el('button', { type: 'button', class: 'button flyout__submit', onClick: () => handlers.stopAssistant(row.id) }, 'Stop')
      : el('button', { type: 'submit', class: 'button button--primary flyout__submit' }, 'Send'),
  );
}

/** One exchange: the request as it was asked, and the reply or what became of it. */
function renderAssistantTurn(turn: AssistantTurn, label: ReadonlyMap<string, AssistantQuickAction>): JSX.Element {
  const action = turn.action ? label.get(turn.action) : null;
  // A quick action shows as its label, plus whatever was typed alongside it.
  const extra = action && turn.request.startsWith(action.request) ? turn.request.slice(action.request.length).trim() : null;
  const asked: ComponentChild[] = action ? [el('strong', null, action.label), extra ? ` — ${extra}` : ''] : [turn.request];

  const status =
    turn.status === 'running'
      ? el('p', { class: 'assistant__status' }, 'Working…')
      : turn.status === 'failed'
        ? el('p', { class: 'assistant__status assistant__status--bad' }, `Failed: ${turn.error}`)
        : turn.status === 'aborted'
          ? el('p', { class: 'assistant__status' }, `Stopped: ${turn.error}`)
          : null;

  return el(
    'div',
    { class: 'assistant__turn', 'data-status': turn.status },
    el('p', { class: 'assistant__request' }, asked),
    turn.reply ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(turn.reply)) : null,
    status,
  );
}
