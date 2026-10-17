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

import { h, type ComponentChild, type RefObject, type JSX } from 'preact';
import { useRef } from 'preact/hooks';

import type { AgentRun, AgentRunState, AgentStep, DashboardState } from '../src/types.ts';
import { briefLanded } from './banners.ts';
import { el } from './el.ts';
import { durationBetween, firstLine, formatDay, formatShortDay, formatTime, parseDate, relativeDay, relativeTime } from './format.ts';
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
  // The log outlives the setting: runs made while the agent was on are still
  // read once it is off, and the panel says so rather than blaming the run.
  const enabled = agent?.enabled ?? true;

  return [
    runHeader(run, now, handlers),
    el(
      'div',
      { class: 'flyout__body', ref: body, onScroll },
      run.status === 'running' ? null : runStatus(run, now, handlers),
      runReport(run, { landed: briefLanded(run, state.brief?.generatedAt), now }, ui, handlers),
      run.status === 'running' ? null : runConversation(run, busy, answering, enabled, ui, handlers, askInput),
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

/** What a running run's section needs to say besides its steps: the phase it is in, and how long it has been going. */
interface Live {
  /** The brief on the page landed during this run, so it is checking it and writing its report. */
  landed: boolean;
  now: Date;
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
function runReport(run: AgentRun, live: Live, ui: UiState, handlers: Handlers): JSX.Element {
  if (run.steps?.length) return runWork(run, live, ui, handlers);
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
    // Only its words are kept, so between them it is always composing the next.
    const latest = earlier.at(-1);
    const summary = `${latest ? firstLine(latest) : 'Starting'} · ${earlier.length} ${earlier.length === 1 ? 'message' : 'messages'}`;
    return liveSection(run, live, summary, [list, el('ol', { class: 'assistant__steps agent-run__steps' }, waitingLine(earlier.length > 0))], ui, handlers);
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

/**
 * The report, and how the agent got there, for a run that kept its steps:
 * everything it said and every call it made, in order, and each part of the
 * work it handed to a subagent, with what the subagent did folded under it.
 * Running, that is what it is doing, and a subagent at work is open. Finished,
 * the report stands on its own and the way there folds away beneath it, less
 * the report itself.
 */
function runWork(run: AgentRun, live: Live, ui: UiState, handlers: Handlers): JSX.Element {
  const running = run.status === 'running';
  if (running) return liveSection(run, live, workSummary(run), runSteps(run, run.steps, null, true, ui, handlers), ui, handlers);
  const last = run.steps.findLast((step) => step.by === null && step.kind === 'message');
  const steps = last && sameWords(last.text, run.report) ? run.steps.filter((step) => step !== last) : run.steps;
  const handoffs = steps.filter((step) => step.subagent).length;
  return el(
    'section',
    { class: 'flyout__section' },
    el('h3', { class: 'flyout__label' }, run.status === 'done' ? 'Its report' : 'What it said last'),
    run.report
      ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(run.report))
      : el('p', { class: 'flyout__empty' }, 'It said nothing.'),
    steps.length
      ? el(
          'details',
          { class: 'agent-run__list' },
          el(
            'summary',
            null,
            `How it got there, in ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` +
              (handoffs ? `, with ${handoffs} ${handoffs === 1 ? 'subagent' : 'subagents'}` : ''),
          ),
          runSteps(run, steps, null, false, ui, handlers),
        )
      : null,
  );
}

/**
 * The section a running run has in place of its report: the phase it is in as
 * the heading, and one row under it with the fold of its work and Stop. One
 * section rather than a status line above a section, since the header already
 * says the run is going and when it started, and the heading and the fold line
 * between them say the rest. Once the brief has landed the run is past writing
 * it: what is left is the prompt's check of the file and the report, and the
 * heading says so rather than claim a brief already on the page is still being
 * written.
 */
function liveSection(run: AgentRun, live: Live, summary: string, content: ComponentChild, ui: UiState, handlers: Handlers): JSX.Element {
  const phase = live.landed ? 'The brief is in; checking it and writing its report' : 'Writing a new brief';
  return el(
    'section',
    { class: 'flyout__section' },
    el('h3', { class: 'flyout__label' }, `${phase}, started ${relativeTime(run.startedAt, live.now)}`),
    el(
      'div',
      { class: 'agent-run__live' },
      workFold(run, summary, content, ui, handlers),
      el('button', { type: 'button', class: 'button', onClick: () => handlers.stopAgent() }, 'Stop'),
    ),
  );
}

/**
 * The fold a running run's work sits under, closed until somebody opens it.
 *
 * Open, the list ran to the foot of the panel and kept growing, which is what
 * a transcript does; the panel's job while a run goes is to say what the agent
 * is on and that it is still at it, which one line does. The line names what it
 * is doing now and how much it has done, and carries a spinner. The reader's
 * toggle is kept with the message folds', under `<run>:work`, so it survives
 * each new step; a toggle back to closed is forgotten, as theirs are.
 */
function workFold(run: AgentRun, summary: string, content: ComponentChild, ui: UiState, handlers: Handlers): JSX.Element {
  const key = `${run.id}:work`;
  return el(
    'details',
    {
      class: 'agent-run__list agent-run__list--working',
      open: ui.messageOpen.value.get(key) ?? false,
      onToggle: (event: Event) => {
        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
        handlers.toggleMessage(key, isOpen ? true : null);
      },
    },
    el('summary', null, summary),
    content,
  );
}

/**
 * The fold's one line while a run that keeps its steps goes: what the run's
 * own agent is on, and how much the run has done. "Waiting on gmail, calendar
 * · 29 steps" while its call in flight is a handoff, since the subagents are
 * then the whole of what is happening; "Run a command · 12 steps, 1 subagent
 * at work" while it is on a call of its own.
 */
function workSummary(run: AgentRun): string {
  const own = run.steps.filter((step) => step.by === null);
  const inFlight = own.findLast((step) => step.kind === 'tool' && step.state === 'running');
  const latest = own.at(-1);
  const working = run.steps.filter((step) => step.subagent && step.state === 'running');
  const count = `${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'}`;
  if (inFlight?.subagent) {
    return `Waiting on ${working.map((step) => step.detail ?? 'a subagent').join(', ') || 'a subagent'} · ${count}`;
  }
  const doing = inFlight ? inFlight.text : latest ? (latest.kind === 'message' ? firstLine(latest.text) : latest.text) : 'Starting';
  const helping = working.length;
  return `${doing} · ${count}${helping ? `, ${helping} ${helping === 1 ? 'subagent' : 'subagents'} at work` : ''}`;
}

/**
 * The line under an agent's steps while it is at work and no call is in
 * flight: between calls it is composing, which no step records, and a list
 * that ends on a tick reads as stuck. The last such gap is the longest, when
 * the brief is written and checked.
 */
function waitingLine(begun: boolean): JSX.Element {
  return el(
    'li',
    { class: 'assistant__step assistant__step--waiting', 'data-state': 'running' },
    el('span', { class: 'assistant__step-text' }, begun ? 'Thinking…' : 'Starting…'),
  );
}

/** How deep subagents of subagents are drawn. Codex lets a subagent start its own. */
const NESTING = 4;

/**
 * The steps taken by one agent, `by`: the run's own when null, else a
 * subagent's. `active` says the agent is still at work, which is what earns it
 * a waiting line when none of its calls is in flight.
 */
function runSteps(run: AgentRun, steps: readonly AgentStep[], by: string | null, active: boolean, ui: UiState, handlers: Handlers, depth = 0): JSX.Element {
  const own = steps.filter((step) => step.by === by);
  const inFlight = own.some((step) => step.state === 'running');
  return el(
    'ol',
    { class: 'assistant__steps agent-run__steps' },
    own.length || active ? null : el('li', { class: 'assistant__step assistant__step--message' }, 'Nothing yet.'),
    own.map((step, index) => {
      if (step.kind === 'message') {
        return el('li', { key: index, class: 'agent-run__said' }, renderMarkdownBlocks(step.text));
      }
      if (step.subagent && depth < NESTING) return runHandoff(run, steps, step, ui, handlers, depth, index);
      return el(
        'li',
        { key: index, class: 'assistant__step', 'data-state': step.state },
        el('span', { class: 'assistant__step-text' }, step.text),
        step.detail ? el('code', { class: 'assistant__step-detail', title: step.detail }, step.detail) : null,
      );
    }),
    active && !inFlight ? waitingLine(own.length > 0) : null,
  );
}

/**
 * A part of the work handed to a subagent: its name, and what it is doing now
 * or how much it did, over a fold of its own steps. Closed until the reader
 * opens it, as the run's own work is; the reader's choice survives each new
 * step, and closing it again is forgotten.
 */
function runHandoff(run: AgentRun, steps: readonly AgentStep[], step: AgentStep, ui: UiState, handlers: Handlers, depth: number, index: number): JSX.Element {
  const id = step.subagent!;
  const own = steps.filter((candidate) => candidate.by === id);
  const latest = own.at(-1);
  const calls = own.filter((candidate) => candidate.kind === 'tool').length;
  const doing =
    step.state === 'running'
      ? latest
        ? latest.kind === 'message'
          ? firstLine(latest.text)
          : latest.text
        : 'starting'
      : `${calls} ${calls === 1 ? 'step' : 'steps'}`;
  const key = `${run.id}:${id}`;
  const open = ui.messageOpen.value.get(key) ?? false;
  return el(
    'li',
    { key: index, class: 'assistant__step agent-run__handoff', 'data-state': step.state },
    el(
      'details',
      {
        open,
        // As the message folds do: a toggle back to the default is forgotten.
        onToggle: (event: Event) => {
          const isOpen = (event.currentTarget as HTMLDetailsElement).open;
          handlers.toggleMessage(key, isOpen ? true : null);
        },
      },
      el(
        'summary',
        null,
        el('span', { class: 'assistant__step-text' }, `Subagent: ${step.detail ?? 'unnamed'}`),
        el('span', { class: 'assistant__step-detail' }, doing),
      ),
      runSteps(run, steps, id, step.state === 'running', ui, handlers, depth + 1),
    ),
  );
}

/** The same text but for spacing: how a CLI's final result compares with the message it repeats. */
function sameWords(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** The one line under the header that says how a finished run went. A running one has `liveSection` instead. */
function runStatus(run: AgentRun, now: Date, handlers: Handlers): JSX.Element {
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
  return durationBetween(run.startedAt, run.endedAt);
}

/**
 * The questions asked of the run and the answers, and the field for the next.
 * A run that can't be continued says why in place of the field.
 */
function runConversation(
  run: AgentRun,
  busy: boolean,
  answering: boolean,
  enabled: boolean,
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
        !enabled
          ? 'The morning agent is switched off (DAILY_FOCUS_AGENT), so this run cannot be asked anything now.'
          : run.sessionId
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
  const next =
    agent && !agent.enabled
      ? el('p', { class: 'flyout__empty' }, 'The morning agent is switched off (DAILY_FOCUS_AGENT), so the dashboard starts no runs now.')
      : schedule
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
