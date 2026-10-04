/**
 * Today before the first brief: what is left to tell the morning agent, one step
 * at a time, ending with the button that writes the first brief.
 *
 * A new store used to open on a red "No brief yet" and an empty list, with the
 * way forward in a document somewhere else. This is the way forward on the page
 * itself. Each step says whether it is done, and the ones the dashboard can do
 * for you are a click: choosing the CLI it found, turning off a board you don't
 * use. It goes once a brief exists, and everything in it stays on the settings
 * page.
 */

import type { JSX } from 'preact';

import type { DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { objectiveForm } from './settings.ts';
import type { Handlers } from './types.ts';

const CLI_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function SetupCard({ state, handlers }: { state: DashboardState; handlers: Handlers }): JSX.Element {
  const setup = state.setup;
  const agent = state.agentRun;
  const running = agent.last?.status === 'running';

  return el(
    'section',
    { class: 'setup', id: 'setup', 'aria-labelledby': 'setup-title' },
    el('h2', { class: 'setup__title', id: 'setup-title' }, 'Set up your morning brief'),
    el(
      'p',
      { class: 'setup__lede' },
      'Each morning an agent reads your mail, calendar, pull requests and the rest, and writes a short brief of what ' +
        'needs you today. A few things to tell it first. Everything here can be changed later in ',
      el('button', { type: 'button', class: 'link-button', onClick: () => handlers.openSettings() }, 'Settings'),
      '.',
    ),
    el(
      'ol',
      { class: 'setup__steps' },

      step(
        setup.profileChosen,
        'What should it brief?',
        setup.profileChosen
          ? el('p', null, setup.profile === 'personal' ? 'Your personal life.' : 'Your work.')
          : [
              el(
                'p',
                null,
                'Work, or home: mail, family calendars, reminders and messages. Run a second dashboard for the other one.',
              ),
              el(
                'div',
                { class: 'setup__choices' },
                el(
                  'button',
                  { type: 'button', class: 'button button--primary', onClick: () => handlers.chooseSettings({ DAILY_FOCUS_PROFILE: 'work' }) },
                  'Work',
                ),
                el(
                  'button',
                  { type: 'button', class: 'button', onClick: () => handlers.chooseSettings({ DAILY_FOCUS_PROFILE: 'personal' }) },
                  'Personal life',
                ),
              ),
            ],
      ),

      step(
        Boolean(state.focus?.objective),
        'What are you trying to achieve?',
        state.focus?.objective
          ? el('p', null, state.focus.objective)
          : [
              el('p', null, 'The agent ranks the day against it. Leave it for now if nothing stands out.'),
              objectiveForm('', '', handlers),
            ],
      ),

      step(
        agent.cli !== null,
        'Who writes the brief?',
        agent.cli
          ? el(
              'p',
              null,
              `${CLI_LABEL[agent.cli]}, ${agent.schedule ? `each scheduled morning at ${agent.schedule.at}` : 'when you press refresh'}. ` +
                'It has to be logged in; the first run says if it is not.',
            )
          : agentChoice(state, handlers),
      ),

      step(
        setup.sources.exists && setup.sources.placeholders === 0,
        'Where should it look?',
        [
          el(
            'p',
            null,
            !setup.sources.exists
              ? 'Your name as others write it, your accounts, calendars and the documents worth re-reading. It starts from a template with what gh and git know about you filled in.'
              : setup.sources.placeholders > 0
                ? `Your source list still has ${setup.sources.placeholders} of the template's placeholders.`
                : 'Your source list is written.',
          ),
          el(
            'button',
            { type: 'button', class: setup.sources.exists ? 'button' : 'button button--primary', onClick: () => handlers.openSettings('sources') },
            setup.sources.exists ? 'Edit your source list' : 'Write your source list',
          ),
        ],
      ),

      step(null, 'What else to show', boards(state, handlers)),

      step(
        null,
        'Write your first brief',
        [
          el(
            'p',
            null,
            running
              ? 'The morning agent is writing it now. Click the banner above to watch.'
              : 'It takes a few minutes. When it is done, click "updated … ago" at the top to read its report: what it found, and anything it could not reach.',
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'button button--primary',
              disabled: !agent.enabled || running || state.restart === 'waiting',
              title: agent.enabled ? undefined : 'Choose who writes the brief first',
              onClick: () => handlers.runAgent(),
            },
            running ? 'Writing…' : 'Write my first brief',
          ),
        ],
      ),
    ),
  );
}

/** One step: done, to do, or neither when it is information rather than a task. */
function step(done: boolean | null, title: string, body: JSX.Element | (JSX.Element | null)[]): JSX.Element {
  return el(
    'li',
    { class: 'setup__step', 'data-done': done === null ? undefined : String(done) },
    el(
      'span',
      { class: 'setup__mark', 'aria-label': done === null ? undefined : done ? 'Done' : 'To do' },
      done === null ? '·' : done ? '✓' : '○',
    ),
    el('div', { class: 'setup__body' }, el('h3', { class: 'setup__step-title' }, title), body),
  );
}

/** The CLIs found on this machine, a click each; or what to install when there are none. */
function agentChoice(state: DashboardState, handlers: Handlers): JSX.Element[] {
  const found = (['claude', 'codex'] as const).filter((cli) => state.setup.clis[cli]);
  if (found.length === 0) {
    return [
      el(
        'p',
        null,
        'The brief is written by a coding-agent CLI you already use. Install ',
        el('a', { href: 'https://code.claude.com/docs', target: '_blank', rel: 'noopener' }, 'Claude Code'),
        ' or the ',
        el('a', { href: 'https://developers.openai.com/codex/cli', target: '_blank', rel: 'noopener' }, 'Codex CLI'),
        ', log in, and restart the dashboard; it looks for both each time it starts.',
      ),
    ];
  }
  return [
    el('p', null, 'The dashboard runs a coding-agent CLI you already use, headless, each morning. Found on this machine:'),
    el(
      'div',
      { class: 'setup__choices' },
      found.map((cli, index) =>
        el(
          'button',
          {
            type: 'button',
            key: cli,
            class: index === 0 ? 'button button--primary' : 'button',
            title: state.setup.clis[cli] ?? undefined,
            onClick: () => handlers.chooseSettings({ DAILY_FOCUS_AGENT: cli }),
          },
          `Use ${CLI_LABEL[cli]}`,
        ),
      ),
    ),
  ];
}

/** The boards and the live agenda: each says how it is doing, and can be turned off here. */
function boards(state: DashboardState, handlers: Handlers): JSX.Element {
  const rows: JSX.Element[] = [];
  const off = (key: string, label: string) =>
    el('button', { type: 'button', class: 'button', onClick: () => handlers.chooseSettings({ [key]: 'off' }) }, `Turn off ${label}`);

  if (state.board.enabled) {
    rows.push(
      boardRow(
        'Pull requests',
        state.board.fetchedAt ? 'Reading your open pull requests through gh.' : (state.board.reason?.message ?? 'Reading through gh…'),
        state.board.fetchedAt !== null,
        off('DAILY_FOCUS_GITHUB', 'the pull request board'),
      ),
    );
  }
  if (state.tickets.enabled) {
    rows.push(
      boardRow(
        'Jira tickets',
        state.tickets.fetchedAt ? 'Reading your tickets through acli.' : (state.tickets.reason?.message ?? 'Reading through acli…'),
        state.tickets.fetchedAt !== null,
        off('DAILY_FOCUS_JIRA', 'the Jira board'),
      ),
    );
  }
  const calendar = state.setup.calendar;
  if (calendar.supported && state.agendaSource) {
    const live = state.agendaSource.live;
    const text = !calendar.built
      ? `The live agenda needs the calendar helper: run ${calendar.buildCommand} once. Until then it uses the brief.`
      : calendar.chosen === 0
        ? 'Choose which calendars to show, and the agenda follows them live.'
        : live
          ? `Reading ${calendar.chosen} ${calendar.chosen === 1 ? 'calendar' : 'calendars'} from Calendar.app.`
          : (state.agendaSource.problem ?? 'Reading Calendar.app…');
    rows.push(
      boardRow(
        'Calendar',
        text,
        live,
        calendar.built && calendar.chosen === 0
          ? el('button', { type: 'button', class: 'button', onClick: () => handlers.openSettings('calendar') }, 'Choose calendars')
          : off('DAILY_FOCUS_CALENDAR', 'the live agenda'),
      ),
    );
  }
  if (rows.length === 0) return el('p', null, 'Nothing else is switched on. The boards can be turned on in Settings.');
  return el('ul', { class: 'setup__boards' }, rows);
}

function boardRow(name: string, text: string, ok: boolean, action: JSX.Element): JSX.Element {
  return el(
    'li',
    { class: 'setup__board', 'data-ok': String(ok), key: name },
    el('span', { class: 'setup__board-name' }, name),
    el('span', { class: 'setup__board-text' }, text),
    action,
  );
}
