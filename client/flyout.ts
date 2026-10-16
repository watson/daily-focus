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
import { useEffect, useRef, useState } from 'preact/hooks';

import type { AgentRun, AssistantItemState, AssistantQuickAction, AssistantStep, AssistantTurn, DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { durationBetween, formatClock, parseDate, relativeTime } from './format.ts';
import { SOURCE_LABEL, githubRepo, sourceColor } from './items.ts';
import { renderMarkdown, renderMarkdownBlocks } from './markdown.ts';
import { usePanel } from './panel.ts';
import { RunPanel } from './runs.ts';
import { RUN_PREFIX, type DetailRow } from './state.ts';
import { renderTicketControls, typeColor } from './tickets.ts';
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

function RowPanel({ row, state, ui, handlers }: { row: DetailRow; state: DashboardState; ui: UiState; handlers: Handlers }): (JSX.Element | null)[] {
  const noteInput = useRef<HTMLInputElement>(null);
  const askInput = useRef<HTMLTextAreaElement>(null);
  const { body, onScroll } = usePanel(ui, { note: noteInput, assistant: askInput });

  const facts = describeRow(row);
  const now = new Date(state.now);
  const enabled = Boolean(state.assistant?.enabled);
  const entry: AssistantItemState = state.assistant?.items?.[row.id] ?? { running: false, sessionId: null, turns: [] };

  return [
    flyoutHeader(facts, rowControls(row, state, ui, handlers), handlers),
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
      entry.turns.length ? renderAssistantSection(state, entry, enabled, handlers) : null,
    ),
    enabled ? renderAssistantFooter(facts, state, entry, ui, handlers, askInput, row) : null,
  ];
}

interface RowFacts {
  ref: string | null;
  title: string;
  url: string | null;
  source: string;
  color: string;
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
    people: row.people ?? [],
    detail: row.detail ?? null,
  };
}

/**
 * What the row's card lets you do to it, where the panel offers it too: a
 * ticket's status and park. The status lives there rather than beside the
 * source, since on a ticket it is the control that changes it.
 */
function rowControls(row: DetailRow, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element | null {
  return 'key' in row && 'summary' in row ? renderTicketControls(row, state, ui, handlers) : null;
}

function flyoutHeader(facts: RowFacts, controls: JSX.Element | null, handlers: Handlers): JSX.Element {
  const title: ComponentChild[] = facts.ref ? [el('span', { class: 'item__ref' }, facts.ref), ' ', facts.title] : [facts.title];
  return el(
    'div',
    { class: 'flyout__header' },
    el(
      'div',
      { class: 'flyout__where' },
      el('span', { class: 'item__dot', style: `background:${facts.color}`, 'aria-hidden': 'true' }),
      el('span', { class: 'item__source' }, SOURCE_LABEL[facts.source] ?? 'Other'),
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
    controls,
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
 * The conversation so far: each request, what the assistant did about it, and
 * its answer. The field to continue it is in the panel's foot, not here, so it
 * stays in reach however long this gets.
 *
 * The conversation belongs to the row, not to the setting: switching the
 * assistant off must not make a reply vanish from the panel that showed it.
 * Off, the section says why there is nowhere to ask, where the field would be.
 */
function renderAssistantSection(state: DashboardState, entry: AssistantItemState, enabled: boolean, handlers: Handlers): JSX.Element {
  const label = new Map((state.assistant?.quickActions ?? []).map((action) => [action.id, action]));
  return el(
    'section',
    { class: 'flyout__section assistant', 'data-running': String(entry.running) },
    el('h3', { class: 'flyout__label' }, 'Assistant'),
    el(
      'div',
      { class: 'assistant__turns' },
      entry.turns.map((turn) => renderAssistantTurn(turn, label, handlers)),
    ),
    enabled ? null : el('p', { class: 'flyout__empty' }, 'The assistant is switched off (DAILY_FOCUS_ASSISTANT), so nothing more can be asked here.'),
  );
}

/**
 * The panel's foot: the canned asks that fit this row's source, and the field.
 * Pinned under the scrolling body the way a chat's field is, so a follow-up is
 * never a scroll away from the answer it follows.
 */
function renderAssistantFooter(
  facts: RowFacts,
  state: DashboardState,
  entry: AssistantItemState,
  ui: UiState,
  handlers: Handlers,
  inputRef: RefObject<HTMLTextAreaElement>,
  row: DetailRow,
): JSX.Element {
  const actions = (state.assistant?.quickActions ?? []).filter(
    (action) => action.sources === null || (action.sources as readonly string[]).includes(facts.source),
  );
  return el(
    'div',
    { class: 'flyout__footer' },
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

/** The field at the foot of the panel. Its own component, for the reason `NoteForm` is. */
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
      placeholder: entry.turns.length ? 'Follow up…' : 'Ask the assistant about this…',
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

/**
 * One exchange: the request as it was asked, the work, and the answer or what
 * became of it. A finished answer ends in what can be done with it here: open
 * what the assistant created, or copy the answer.
 */
function renderAssistantTurn(turn: AssistantTurn, label: ReadonlyMap<string, AssistantQuickAction>, handlers: Handlers): JSX.Element {
  const action = turn.action ? label.get(turn.action) : null;
  // A quick action shows as its label, plus whatever was typed alongside it.
  const extra = action && turn.request.startsWith(action.request) ? turn.request.slice(action.request.length).trim() : null;
  const asked: ComponentChild[] = action ? [el('strong', null, action.label), extra ? ` — ${extra}` : ''] : [turn.request];
  if (turn.auto) asked.push(el('span', { class: 'assistant__auto', title: 'The dashboard asked this on its own, when the pull request started waiting on you.' }, ' · asked ahead'));
  const { body, created } = turn.status === 'done' ? splitCreated(turn.reply) : { body: turn.reply, created: [] };

  const status =
    turn.status === 'failed'
      ? el('p', { class: 'assistant__status assistant__status--bad' }, `Failed: ${turn.error}`)
      : turn.status === 'aborted'
        ? el('p', { class: 'assistant__status' }, `Stopped: ${turn.error}`)
        : null;

  return el(
    'div',
    { key: turn.id, class: 'assistant__turn', 'data-status': turn.status },
    el('p', { class: 'assistant__request' }, asked),
    renderWork(turn),
    body ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(body, { onCopy: (text) => handlers.copy(text) })) : null,
    status,
    turn.status === 'done' && (body || created.length)
      ? el(
          'div',
          { class: 'assistant__after' },
          created.map((link) =>
            el('a', { class: 'button', href: link.url, target: '_blank', rel: 'noopener noreferrer', title: link.url }, `${link.label} ↗`),
          ),
          body ? el('button', { type: 'button', class: 'button', onClick: () => handlers.copy(body) }, 'Copy reply') : null,
        )
      : null,
  );
}

/**
 * What the assistant did on the way to its answer.
 *
 * Running, it is the turn: a clock, and each call and remark as it comes, the
 * newest at the foot where the panel follows it. Over, it folds away under one
 * line that says how long it took and how much it did, since the answer is what
 * there is to read now; a failed turn's stays open, since the steps are the
 * likeliest place to see why.
 */
function renderWork(turn: AssistantTurn): JSX.Element | null {
  const steps = turn.steps ?? [];
  if (turn.status === 'running') {
    return el(
      'div',
      { class: 'assistant__work' },
      el('p', { class: 'assistant__status assistant__status--working' }, 'Working · ', h(Elapsed, { since: turn.startedAt })),
      steps.length ? renderSteps(steps) : null,
    );
  }
  const took = durationBetween(turn.startedAt, turn.endedAt);
  if (!steps.length) return took ? el('p', { class: 'assistant__took' }, `Answered in ${took}`) : null;
  const failed = steps.filter((step) => step.state === 'failed').length;
  const summary = [
    took ? `${turn.status === 'done' ? 'Worked' : 'Ran'} for ${took}` : null,
    `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`,
    failed ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return el('details', { class: 'assistant__work', open: turn.status === 'failed' }, el('summary', null, summary), renderSteps(steps));
}

function renderSteps(steps: readonly AssistantStep[]): JSX.Element {
  return el(
    'ol',
    { class: 'assistant__steps' },
    steps.map((step, index) =>
      step.kind === 'message'
        ? el('li', { key: index, class: 'assistant__step assistant__step--message' }, renderMarkdown(step.text.trim()))
        : el(
            'li',
            { key: index, class: 'assistant__step', 'data-state': step.state },
            el('span', { class: 'assistant__step-text' }, step.text),
            step.detail ? el('code', { class: 'assistant__step-detail', title: step.detail }, step.detail) : null,
          ),
    ),
  );
}

/** "1:42" since a turn started, ticking on its own: the page's state arrives once a minute. */
function Elapsed({ since }: { since: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = parseDate(since)?.getTime() ?? now;
  return el('span', { class: 'assistant__clock' }, formatClock((now - start) / 1000));
}

/** A link to something the assistant made, as its answer's last lines name it: `Created: [Gmail draft](https://…)`. */
export interface CreatedLink {
  label: string;
  url: string;
}

const CREATED = /^\s*(?:[-*]\s+)?Created:\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*\.?\s*$/i;

/**
 * The answer, less its `Created:` lines, and the links those lines name. The
 * prompt asks for one such line per thing created, so the panel can offer it
 * as a button rather than a link somewhere in the prose; an answer that doesn't
 * follow it keeps its links where it put them.
 */
export function splitCreated(reply: string): { body: string; created: CreatedLink[] } {
  const created: CreatedLink[] = [];
  const kept: string[] = [];
  for (const line of reply.split('\n')) {
    const match = CREATED.exec(line);
    if (match) created.push({ label: match[1]!.trim(), url: match[2]! });
    else kept.push(line);
  }
  return { body: created.length ? kept.join('\n').trim() : reply, created };
}
