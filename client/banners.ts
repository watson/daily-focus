/** The strips under the tabs: what is wrong with the brief, and what the morning agent is doing. */

import type { ComponentChildren, JSX } from 'preact';

import type { AgentRun, AgentRunState, DashboardState } from '../src/types.ts';
import { el, type Props } from './el.ts';
import { daysFromToday, formatTime, formatWeekday, localDateKey, parseDate, relativeDay, relativeTime } from './format.ts';
import type { Handlers, UiState } from './types.ts';

export function renderBanners(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const banners: JSX.Element[] = [];
  const agent = state.agentRun;
  const running = agent?.last?.status === 'running';

  if (state.problem) {
    banners.push(banner('critical', '!', state.problem));
  }
  if (running && agent?.last) {
    // Supersedes the three below: each is a guess about when the next brief
    // comes, and this one is on its way.
    banners.push(agentRunBanner(agent.last, state, handlers));
  } else if (state.brief.stale && !state.problem) {
    banners.push(
      banner(
        'warning',
        '!',
        `This brief is ${state.brief.ageHours} hours old. The morning agent may not have run.`,
        agent?.enabled ? runNowButton(handlers) : null,
      ),
    );
  } else if (state.brief.refreshPending && !state.problem) {
    banners.push(banner('info', 'i', "The morning agent may still be preparing today's brief."));
  } else if (!state.problem && isHeldOverDayOff(state)) {
    // Not a warning: nothing has gone wrong. No run was scheduled today, so the
    // answer to "why is this yesterday's?" is the schedule, and saying so is the
    // difference between a board you trust and one you second-guess.
    //
    // Both day names come from the resolved schedule rather than from an assumption
    // about which days the weekend is — on a Sun–Thu week this reads "still
    // Thursday's brief" and "arrives Sunday".
    banners.push(
      banner(
        'info',
        'i',
        `The morning agent isn't scheduled to run today, so this is still ${formatWeekday(
          state.brief.date ?? state.brief.generatedAt,
        )}'s brief${nextRunPhrase(state)}.`,
      ),
    );
  }
  // A run that went wrong today, until it is put away. A run that finished
  // needs no banner: the brief it wrote is the page, and "updated just now" in
  // the header is the way to its report.
  if (
    !running &&
    agent?.last &&
    agent.last.status !== 'done' &&
    agent.last.id !== ui.agentReportSeen.value &&
    localDateKey(parseDate(agent.last.startedAt) ?? new Date(0)) === localDateKey(new Date(state.now))
  ) {
    banners.push(agentRunBanner(agent.last, state, handlers));
  }
  for (const warning of state.warnings) {
    banners.push(banner('warning', '!', warning));
  }

  return banners;
}

function runNowButton(handlers: Handlers): JSX.Element {
  return el('button', { type: 'button', class: 'button banner__action', onClick: () => handlers.runAgent() }, 'Run it now');
}

/**
 * A run of the morning agent: going, or gone wrong and not yet put away.
 *
 * The banner is the way into the run's panel, as a card is the way into an
 * item's: click it anywhere. What the agent is saying stays in the panel, so
 * the banner is one line and its one button is Stop.
 */
function agentRunBanner(run: AgentRun, state: DashboardState, handlers: Handlers): JSX.Element {
  const now = new Date(state.now);
  const open = (): void => handlers.openRun(run.id);
  const strip: Props = {
    role: 'button',
    tabIndex: 0,
    title: 'Open the run',
    // The buttons are their own targets; a click on one must not also open the panel.
    onClick: (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('button')) return;
      open();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    },
  };
  if (run.status === 'running') {
    return bannerNode(
      'info',
      'i',
      `The morning agent is writing a new brief, started ${relativeTime(run.startedAt, now)}.`,
      [el('button', { type: 'button', class: 'button banner__action', onClick: () => handlers.stopAgent() }, 'Stop')],
      strip,
    );
  }
  const ended = run.endedAt ? formatTime(run.endedAt) : '';
  return bannerNode(
    'warning',
    '!',
    run.status === 'aborted'
      ? `The morning agent was stopped at ${ended}: ${run.error}.`
      : `The morning agent failed at ${ended}: ${run.error}.`,
    [
      runNowButton(handlers),
      el(
        'button',
        { type: 'button', class: 'button banner__action', onClick: () => handlers.dismissAgentRun(run.id) },
        'Dismiss',
      ),
    ],
    strip,
  );
}

/**
 * True when the brief is from an earlier day and today is a day the agent was never
 * going to run. A brief written *today* needs no explaining, even on a day off, and
 * neither does one read on a scheduled day — that one's the stale warning's job.
 */
function isHeldOverDayOff(state: DashboardState): boolean {
  if (state.brief.generatedAt === null || state.schedule.runsToday) return false;
  const today = localDateKey(new Date(state.now));
  const briefDate = state.brief.date ?? localDateKey(parseDate(state.brief.generatedAt) ?? new Date(state.now));
  return briefDate !== today;
}

/** ". It runs on its own at 06:30; next tomorrow 06:30", or nothing when the dashboard has no clock. */
export function nextRunPhraseFor(agent: AgentRunState | null | undefined): string {
  if (!agent?.schedule) return '';
  const next = agent.schedule.nextRunAt
    ? `; next ${relativeDay(agent.schedule.nextRunAt)} ${formatTime(agent.schedule.nextRunAt)}`
    : '';
  return `. It runs on its own at ${agent.schedule.at}${next}`;
}

/** " — the next one arrives Monday", or nothing if we can't say. */
function nextRunPhrase(state: DashboardState): string {
  const next = state.schedule.nextRunDate;
  if (!next) return '';
  const when = daysFromToday(next, new Date(state.now)) === 1 ? 'tomorrow' : formatWeekday(next);
  return ` — the next one arrives ${when}`;
}

/**
 * `text` may be a string or elements, which is how the two boards' warnings come
 * to carry links: theirs name a pull request or a ticket key and are written by
 * this repo, so they are handed over through `renderMarkdown`. The brief's
 * warnings are deliberately not — they quote titles and ids an LLM wrote, and a
 * stray bracket in one should read as the stray bracket it is rather than become
 * a link.
 */
export function banner(tone: string, icon: string, text: ComponentChildren, ...actions: ComponentChildren[]): JSX.Element {
  return bannerNode(tone, icon, text, actions, {});
}

/** A banner, plus whatever `extra` says about the strip itself: the link variant sets its role and listeners here. */
function bannerNode(tone: string, icon: string, text: ComponentChildren, actions: ComponentChildren[], extra: Props): JSX.Element {
  const link = Object.keys(extra).length > 0;
  return el(
    'div',
    { class: `banner banner--${tone}${link ? ' banner--link' : ''}`, role: 'status', ...extra },
    el('span', { class: 'banner__icon', 'aria-hidden': 'true' }, icon),
    el('span', { class: 'banner__text' }, text),
    actions,
  );
}
