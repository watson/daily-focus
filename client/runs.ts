/**
 * The panel, open on one run of the morning agent.
 *
 * The same panel the rows use, since it is the same shape of thing: what
 * happened, and a conversation about it. The report at the top is the agent's
 * own account of the run — what it wrote, what it dropped as handled, what it
 * could not reach — and the field at the foot resumes the run's session, so
 * "why did you drop this" is answered by the agent that dropped it. The other
 * runs are folded away at the end: the newest is the one that matters, and
 * the rest are there for the day something needs explaining.
 */

import { h, type RefObject, type JSX } from 'preact';
import { useRef } from 'preact/hooks';

import type { AgentRun, AgentRunState, DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { firstLine, formatDay, formatDuration, formatShortDay, formatTime, parseDate, relativeDay, relativeTime } from './format.ts';
import { renderMarkdownBlocks } from './markdown.ts';
import { usePanel } from './panel.ts';
import type { Handlers, UiState } from './types.ts';

/** "scheduled" / "by hand", and what became of it. */
const RUN_STATUS: Readonly<Record<string, string>> = {
  running: 'running',
  done: 'finished',
  failed: 'failed',
  aborted: 'stopped',
};

export function RunPanel({ run, state, ui, handlers }: { run: AgentRun; state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  const askInput = useRef<HTMLTextAreaElement>(null);
  const { body, onScroll } = usePanel(ui, { assistant: askInput });

  const now = new Date(state.now);
  const agent = state.agentRun ?? null;
  const runs = agent?.runs ?? [];
  const busy = runs.some((candidate) => candidate.status === 'running' || candidate.turns?.some((turn) => turn.status === 'running'));
  const answering = run.turns.some((turn) => turn.status === 'running');

  return [
    runHeader(run, now, handlers),
    el(
      'div',
      { class: 'flyout__body', ref: body, onScroll },
      runStatus(run, now, handlers),
      runReport(run, ui, handlers),
      run.status === 'running' ? null : runConversation(run, busy, answering, ui, handlers, askInput),
      runList(run, runs, now, agent, handlers),
    ),
  ];
}

function runHeader(run: AgentRun, now: Date, handlers: Handlers): JSX.Element {
  return el(
    'div',
    { class: 'flyout__header' },
    el(
      'div',
      { class: 'flyout__where' },
      el('span', { class: 'item__source' }, 'Morning agent'),
      el('span', null, `· ${run.trigger === 'schedule' ? 'scheduled' : 'by hand'}`),
      el('span', null, `· ${RUN_STATUS[run.status] ?? run.status}`),
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
    el('p', { class: 'flyout__title' }, `Run ${describeWhen(run.startedAt, now)}`),
  );
}

/** "today at 06:30", "yesterday at 06:30", "Mon 21 Sep at 06:30". */
function describeWhen(value: string, now: Date): string {
  const day = relativeDay(value, now);
  const date = parseDate(value);
  const named = day === 'today' || day === 'tomorrow' || day === 'yesterday';
  return `${named ? day : date && date.getFullYear() === now.getFullYear() ? formatShortDay(value) : formatDay(value)} at ${formatTime(value)}`;
}

/**
 * The report, and how the agent got there.
 *
 * Finished, the report stands on its own and the messages before it fold away
 * beneath, each under its first line. Running, there is no report yet: the
 * latest message is open, since it is what the agent is doing now, and the
 * earlier ones fold away the same way. The reader's own folding wins over the
 * default, and survives the re-render every new message brings.
 */
function runReport(run: AgentRun, ui: UiState, handlers: Handlers): JSX.Element {
  const messages = run.messages ?? (run.report ? [run.report] : []);
  const running = run.status === 'running';
  // The report is the last message when the CLI has no final result of its own;
  // when it has one, the last message is usually the same text. Either way it
  // is not listed twice.
  const earlier = !running && messages.length && messages.at(-1) === run.report ? messages.slice(0, -1) : messages;
  const list = earlier.length
    ? el(
        'div',
        { class: 'agent-run__messages' },
        earlier.map((message, index) => {
          const key = `${run.id}:${index}`;
          const latest = running && index === earlier.length - 1;
          const open = ui.messageOpen.value.has(key) ? ui.messageOpen.value.get(key) : latest;
          return el(
            'details',
            {
              key,
              class: 'agent-run__message',
              open,
              // A fold created open fires a toggle too, so only a toggle away
              // from the default is the reader's; one back to it is forgotten,
              // or the fold would stick where a message no longer is.
              onToggle: (event: Event) => {
                const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                handlers.toggleMessage(key, isOpen === latest ? null : isOpen);
              },
            },
            // Closed, the first line stands for the message; open, a short
            // label stands in for it instead, so a one-line message isn't
            // read twice. The stylesheet swaps the two.
            el(
              'summary',
              null,
              el('span', { class: 'agent-run__message-line' }, firstLine(message) || `Message ${index + 1}`),
              el('span', { class: 'agent-run__message-index' }, `Message ${index + 1} of ${earlier.length}`),
            ),
            el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(message)),
          );
        }),
      )
    : null;

  if (running) {
    return el(
      'section',
      { class: 'flyout__section' },
      el('h3', { class: 'flyout__label' }, 'What it is doing'),
      list ?? el('p', { class: 'flyout__empty' }, 'Nothing yet.'),
    );
  }
  return el(
    'section',
    { class: 'flyout__section' },
    el('h3', { class: 'flyout__label' }, run.status === 'done' ? 'Its report' : 'What it said last'),
    run.report
      ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(run.report))
      : el('p', { class: 'flyout__empty' }, 'It said nothing.'),
    list
      ? el(
          'details',
          { class: 'agent-run__list' },
          el('summary', null, `How it got there, in ${earlier.length} ${earlier.length === 1 ? 'message' : 'messages'}`),
          list,
        )
      : null,
  );
}

/** The one line under the header that says how the run went, and Stop while it goes. */
function runStatus(run: AgentRun, now: Date, handlers: Handlers): JSX.Element {
  if (run.status === 'running') {
    return el(
      'p',
      { class: 'agent-run__status' },
      `Writing a new brief, started ${relativeTime(run.startedAt, now)}. `,
      el('button', { type: 'button', class: 'button', onClick: () => handlers.stopAgent() }, 'Stop'),
    );
  }
  const took = runDuration(run);
  if (run.status === 'done') {
    return el('p', { class: 'agent-run__status' }, `Finished at ${formatTime(run.endedAt)}${took ? `, in ${took}` : ''}.`);
  }
  return el(
    'p',
    { class: 'agent-run__status agent-run__status--bad' },
    `${run.status === 'aborted' ? 'Stopped' : 'Failed'} at ${formatTime(run.endedAt)}${took ? `, after ${took}` : ''}: ${run.error}.`,
  );
}

/** "40 s", "7 min", "1 h 12 min": how long a finished run took. Empty while it hasn't. */
function runDuration(run: AgentRun): string {
  const from = parseDate(run.startedAt);
  const to = parseDate(run.endedAt);
  if (!from || !to || to < from) return '';
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  return seconds < 60 ? `${seconds} s` : formatDuration(Math.round(seconds / 60));
}

/**
 * The questions asked of the run and the answers, and the field for the next.
 * A run that can't be continued says why in place of the field.
 */
function runConversation(
  run: AgentRun,
  busy: boolean,
  answering: boolean,
  ui: UiState,
  handlers: Handlers,
  inputRef: RefObject<HTMLTextAreaElement>,
): JSX.Element {
  const turns = run.turns.length
    ? el(
        'div',
        { class: 'assistant__turns' },
        run.turns.map((turn) =>
          el(
            'div',
            { class: 'assistant__turn', 'data-status': turn.status },
            el('p', { class: 'assistant__request' }, turn.question),
            turn.reply ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(turn.reply)) : null,
            turn.status === 'running'
              ? el('p', { class: 'assistant__status' }, 'Working…')
              : turn.status === 'failed'
                ? el('p', { class: 'assistant__status assistant__status--bad' }, `Failed: ${turn.error}`)
                : turn.status === 'aborted'
                  ? el('p', { class: 'assistant__status' }, `Stopped: ${turn.error}`)
                  : null,
          ),
        ),
      )
    : null;

  const foot = run.resumable
    ? h(RunComposer, { run, busy, answering, ui, handlers, inputRef })
    : el(
        'p',
        { class: 'flyout__empty' },
        run.sessionId
          ? 'This run was made by another CLI, so it cannot be asked anything now.'
          : 'This run left no session behind, so there is nothing to ask.',
      );

  return el(
    'section',
    { class: 'flyout__section assistant', 'data-running': String(answering) },
    el('h3', { class: 'flyout__label' }, 'Ask it'),
    turns,
    busy && !answering ? el('p', { class: 'flyout__empty' }, 'The morning agent is busy with another run.') : null,
    foot,
  );
}

/** The field for the next question. Its own component so a keystroke reruns only it. */
function RunComposer({
  run,
  busy,
  answering,
  ui,
  handlers,
  inputRef,
}: {
  run: AgentRun;
  busy: boolean;
  answering: boolean;
  ui: UiState;
  handlers: Handlers;
  inputRef: RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  const submit = (): void => {
    const text = ui.assistantDraft.value.trim();
    if (!text || busy) return;
    handlers.askAgent(run.id, text);
  };
  return el(
    'form',
    {
      class: 'assistant__form',
      'data-running': String(answering),
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
      placeholder: run.turns.length ? 'Follow up…' : 'Ask why it did what it did, or to look again…',
      'aria-label': 'Ask the morning agent about this run',
      disabled: busy,
      onInput: (event: Event) => {
        ui.assistantDraft.value = (event.currentTarget as HTMLTextAreaElement).value;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      },
    }),
    answering
      ? el('button', { type: 'button', class: 'button flyout__submit', onClick: () => handlers.stopAgent() }, 'Stop')
      : el('button', { type: 'submit', class: 'button button--primary flyout__submit', disabled: busy }, 'Send'),
  );
}

/**
 * Every other run the server sent, newest first, folded away, plus when the
 * next one is due. Each is a way to move the panel onto it.
 */
function runList(current: AgentRun, runs: readonly AgentRun[], now: Date, agent: AgentRunState | null, handlers: Handlers): JSX.Element {
  const others = runs.filter((run) => run.id !== current.id);
  const schedule = agent?.schedule;
  const next = schedule
    ? el(
        'p',
        { class: 'flyout__empty' },
        `Runs on its own at ${schedule.at}${schedule.nextRunAt ? `; next ${describeWhen(schedule.nextRunAt, now)}` : ''}.`,
      )
    : el('p', { class: 'flyout__empty' }, 'Started by hand only; DAILY_FOCUS_AGENT_AT is off.');
  return el(
    'section',
    { class: 'flyout__section' },
    el('h3', { class: 'flyout__label' }, 'Earlier runs'),
    next,
    others.length
      ? el(
          'details',
          { class: 'agent-run__list' },
          el('summary', null, `${others.length} earlier ${others.length === 1 ? 'run' : 'runs'}`),
          el(
            'ul',
            { class: 'agent-run__runs' },
            others.map((run) =>
              el(
                'li',
                { key: run.id },
                el(
                  'button',
                  { type: 'button', class: 'agent-run__pick', onClick: () => handlers.openRun(run.id) },
                  el(
                    'span',
                    { class: 'agent-run__pick-when' },
                    `${describeWhen(run.startedAt, now)} · ${run.trigger === 'schedule' ? 'scheduled' : 'by hand'} · ${RUN_STATUS[run.status] ?? run.status}${runDuration(run) ? ` in ${runDuration(run)}` : ''}`,
                  ),
                  run.report || run.error
                    ? el('span', { class: 'agent-run__pick-line' }, firstLine(run.status === 'done' ? run.report : (run.error ?? run.report)))
                    : null,
                ),
              ),
            ),
          ),
        )
      : el('p', { class: 'flyout__empty' }, 'This is the only run so far.'),
  );
}
