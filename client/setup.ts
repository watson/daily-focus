/**
 * Today before the first brief, once setup is over: the first run, as it goes.
 *
 * The setup screen (`onboarding.ts`) asks everything and starts the run. This is
 * what the page shows until the brief lands: that it is being written, how to
 * watch, and what to do when it didn't work. A store that skipped the agent
 * gets the way to choose one instead.
 */

import type { JSX } from 'preact';

import type { DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import type { Handlers } from './types.ts';

export function FirstBriefCard({ state, handlers }: { state: DashboardState; handlers: Handlers }): JSX.Element {
  const agent = state.agentRun;
  const last = agent.last;
  const running = last?.status === 'running';
  const restarting = state.restart === 'waiting';

  let title: string;
  let text: string;
  let actions: JSX.Element[];
  if (restarting) {
    title = 'Saving your settings';
    text = 'The dashboard restarts to apply them, then starts on your first brief.';
    actions = [];
  } else if (!agent.enabled) {
    title = 'Choose who writes your brief';
    text = 'Each morning a coding-agent CLI you already use writes it: Claude Code or Codex. The boards work meanwhile.';
    actions = [el('button', { type: 'button', class: 'button button--primary', onClick: () => handlers.openSettings('agent') }, 'Choose in Settings')];
  } else if (running) {
    title = 'Writing your first brief';
    text = 'The morning agent is reading your mail, calendar and the rest. It takes a few minutes; the brief appears here when it is done.';
    actions = [el('button', { type: 'button', class: 'button', onClick: () => handlers.openRun(last.id) }, 'Watch it work')];
  } else if (last && last.status !== 'done') {
    title = 'Your first brief didn’t finish';
    text =
      last.status === 'aborted'
        ? 'It was stopped before it wrote a brief.'
        : last.error
          ? `The run failed: ${last.error}.`
          : 'The run stopped before it wrote a brief.';
    actions = [
      el('button', { type: 'button', class: 'button button--primary', onClick: () => handlers.runAgent() }, 'Try again'),
      el('button', { type: 'button', class: 'button', onClick: () => handlers.openRun(last.id) }, 'Read its report'),
    ];
  } else if (last) {
    title = 'Your first brief didn’t arrive';
    text = 'The run finished without a brief this dashboard could read. Its report says why.';
    actions = [
      el('button', { type: 'button', class: 'button button--primary', onClick: () => handlers.runAgent() }, 'Run it again'),
      el('button', { type: 'button', class: 'button', onClick: () => handlers.openRun(last.id) }, 'Read its report'),
    ];
  } else {
    title = 'Write your first brief';
    text = 'It takes a few minutes. After that it runs by itself each scheduled morning.';
    actions = [el('button', { type: 'button', class: 'button button--primary', onClick: () => handlers.runAgent() }, 'Write it now')];
  }

  return el(
    'section',
    { class: 'first-brief', id: 'first-brief', 'aria-labelledby': 'first-brief-title', 'data-state': running ? 'running' : 'idle' },
    el('h2', { class: 'first-brief__title', id: 'first-brief-title' }, title),
    el('p', { class: 'first-brief__text' }, text),
    actions.length ? el('div', { class: 'first-brief__actions' }, actions) : null,
  );
}
