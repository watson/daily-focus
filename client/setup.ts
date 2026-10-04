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
import { objectiveForm, textEditor } from './settings.ts';
import type { Handlers, UiState } from './types.ts';

const CLI_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

/** How the calendar helper is built from a checkout. */
const CALENDAR_BUILD = 'npm run build:calendar';

export function SetupCard({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element {
  const setup = state.setup;
  const agent = state.agentRun;
  const running = agent.last?.status === 'running';
  // A source list still holding the template's placeholders sends the agent
  // looking for `Your Name`, which is worse than no list at all; no list is fine,
  // the agent briefs from what it can reach and says what it missed.
  const placeholders = setup.sources.exists && setup.sources.placeholders > 0;

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
              // A choice, so neither answer is drawn as the one to pick.
              choices([
                ['Work', () => handlers.chooseSettings({ DAILY_FOCUS_PROFILE: 'work' })],
                ['Personal life', () => handlers.chooseSettings({ DAILY_FOCUS_PROFILE: 'personal' })],
              ]),
            ],
      ),

      step(
        Boolean(state.focus?.objective),
        'What are you trying to achieve?',
        state.focus?.objective
          ? el('p', null, state.focus.objective)
          : [
              el('p', null, 'The agent ranks the day against it. Leave it for now if nothing stands out.'),
              objectiveForm('', '', handlers, 'Set objective'),
            ],
      ),

      step(
        agent.cli !== null,
        'Which agent writes the brief?',
        agent.cli
          ? el(
              'p',
              null,
              `${CLI_LABEL[agent.cli]}. ` +
                (agent.schedule
                  ? `After the first brief, it runs by itself each scheduled morning at ${agent.schedule.at}. `
                  : 'It runs when you press refresh. ') +
                'It has to be logged in; the first run says if it is not.',
            )
          : agentChoice(state, handlers),
      ),

      step(setup.sources.exists && setup.sources.placeholders === 0, 'Who are you, and where should it look?', sourcesStep(state, ui, handlers)),

      step(null, 'What else should the dashboard show?', boards(state, handlers)),

      step(
        null,
        'Your first brief',
        [
          el(
            'p',
            null,
            running
              ? 'The morning agent is writing it now. Click the banner above to watch.'
              : 'The morning agent writes it now, which takes a few minutes, and from then on by itself every scheduled ' +
                  'morning. When it is done, click "updated … ago" at the top to read its report: what it found, and ' +
                  'anything it could not reach.' +
                  (setup.sources.exists ? '' : ' Without a source list it briefs from what it can reach on its own, and says what it missed.'),
          ),
          placeholders
            ? el('p', { class: 'setup__note setup__note--todo' }, "Replace the source list's placeholders first, or the agent goes looking for them.")
            : null,
          el(
            'button',
            {
              type: 'button',
              class: 'button button--primary',
              disabled: !agent.enabled || running || state.restart === 'waiting' || placeholders,
              title: !agent.enabled ? 'Choose the agent first' : placeholders ? "Replace the source list's placeholders first" : undefined,
              onClick: () => handlers.runAgent(),
            },
            running ? 'Running…' : 'Run the morning agent now',
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

/** Answers to pick one of, drawn alike: none of them is the one to pick. */
function choices(options: readonly (readonly [string, () => void, string?])[]): JSX.Element {
  return el(
    'div',
    { class: 'setup__choices' },
    options.map(([label, onClick, title]) => el('button', { type: 'button', class: 'button', key: label, title, onClick }, label)),
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
    choices(
      found.map(
        (cli) => [`Use ${CLI_LABEL[cli]}`, () => handlers.chooseSettings({ DAILY_FOCUS_AGENT: cli }), state.setup.clis[cli] ?? undefined] as const,
      ),
    ),
  ];
}

/** Where the source list's editor opens in its step, and stays open while it is being written. */
const SOURCES_EDITOR = 'setup:sources';

/**
 * The source list, written in the step itself rather than on another page. It is
 * the one step that takes thought, so it is also the one that most needs to stay
 * where the rest of the steps are.
 */
function sourcesStep(state: DashboardState, ui: UiState, handlers: Handlers): (JSX.Element | null)[] {
  const sources = state.setup.sources;
  const open = ui.openDrawers.value.has(SOURCES_EDITOR);
  const toggle = () => {
    if (!open && !ui.texts.value.sources) handlers.loadText('sources');
    handlers.toggleDrawer(SOURCES_EDITOR, !open);
  };
  return [
    el(
      'p',
      null,
      'A short list the agent reads every morning. First who you are: your name as meeting notes write it, your email ' +
        "and your GitHub login, so it can tell your to-dos from everyone else's. Then where to look: which calendars, " +
        'mailboxes and documents are yours.',
    ),
    sources.exists
      ? el(
          'p',
          { class: sources.placeholders > 0 ? 'setup__note setup__note--todo' : 'setup__note' },
          sources.placeholders > 0
            ? `It still has ${sources.placeholders} of the template's placeholders. Replace them, or delete what doesn't apply.`
            : 'Written.',
        )
      : el('p', { class: 'setup__note' }, 'It starts from a template, with what gh and git know about you already filled in.'),
    el(
      'button',
      { type: 'button', class: 'button', 'aria-expanded': String(open), onClick: toggle },
      open ? 'Close' : sources.exists ? 'Edit it' : 'Write it',
    ),
    open ? el('div', { class: 'setup__editor' }, textEditor('sources', ui.texts.value.sources, handlers, 'sources.md')) : null,
  ];
}

type BoardHealth = 'ok' | 'checking' | 'problem' | 'todo';

const HEALTH_MARK: Record<BoardHealth, string> = { ok: '✓', checking: '…', problem: '!', todo: '○' };
const HEALTH_LABEL: Record<BoardHealth, string> = {
  ok: 'Connected',
  checking: 'Checking',
  problem: 'Not working',
  todo: 'To do',
};

/** How a board is doing, in the same words for each: connected, checking, or the reason it isn't. */
function boardHealth(board: { fetchedAt: string | null; reason: { message: string } | null }, via: string, service: string): [BoardHealth, string] {
  if (board.reason) return ['problem', board.reason.message];
  if (board.fetchedAt) return ['ok', `Connected, through ${via}.`];
  return ['checking', `Checking ${service} through ${via}…`];
}

/** The boards and the live agenda: each says how it is doing, and can be turned off here. */
function boards(state: DashboardState, handlers: Handlers): JSX.Element {
  const rows: JSX.Element[] = [];
  const off = (key: string, label: string) =>
    el('button', { type: 'button', class: 'button', onClick: () => handlers.chooseSettings({ [key]: 'off' }) }, `Turn off ${label}`);

  if (state.board.enabled) {
    rows.push(boardRow('Pull requests', ...boardHealth(state.board, 'gh', 'GitHub'), off('DAILY_FOCUS_GITHUB', 'the pull request board')));
  }
  if (state.tickets.enabled) {
    rows.push(boardRow('Jira tickets', ...boardHealth(state.tickets, 'acli', 'Jira'), off('DAILY_FOCUS_JIRA', 'the Jira board')));
  }
  const calendar = state.setup.calendar;
  if (calendar.supported && state.agendaSource) {
    const live = state.agendaSource.live;
    const [health, text]: [BoardHealth, string] = !calendar.built
      ? ['todo', `Needs the calendar helper: run ${CALENDAR_BUILD} once. Until then the agenda uses the brief.`]
      : calendar.chosen === 0
        ? ['todo', 'No calendars chosen yet. Choose them, and the agenda follows them live.']
        : live
          ? ['ok', `Connected, reading ${calendar.chosen} ${calendar.chosen === 1 ? 'calendar' : 'calendars'} from Calendar.app.`]
          : state.agendaSource.problem
            ? ['problem', state.agendaSource.problem]
            : ['checking', 'Checking Calendar.app…'];
    rows.push(
      boardRow(
        'Calendar',
        health,
        text,
        calendar.built && calendar.chosen === 0
          ? el('button', { type: 'button', class: 'button', onClick: () => handlers.openSettings('calendar') }, 'Choose calendars')
          : off('DAILY_FOCUS_CALENDAR', 'the live agenda'),
      ),
    );
  }
  if (rows.length === 0) return el('p', null, 'Nothing else is switched on. The boards can be turned on in Settings.');
  return el('ul', { class: 'setup__boards' }, rows);
}

function boardRow(name: string, health: BoardHealth, text: string, action: JSX.Element): JSX.Element {
  return el(
    'li',
    { class: 'setup__board', 'data-health': health, key: name },
    el('span', { class: 'setup__board-mark', 'aria-label': HEALTH_LABEL[health], title: HEALTH_LABEL[health] }, HEALTH_MARK[health]),
    el('span', { class: 'setup__board-name' }, name),
    el('span', { class: 'setup__board-text' }, text),
    action,
  );
}
