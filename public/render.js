/**
 * Pure-ish rendering: state in, DOM out.
 *
 * Every render rebuilds its region from scratch. The lists are short enough that
 * this costs nothing, and it keeps the render a plain function of state — which is
 * also what makes swapping this file for React later a mechanical job.
 */

import {
  daysFromToday,
  formatDay,
  formatDuration,
  formatShortDay,
  formatTime,
  formatWeekday,
  localDateKey,
  parseDate,
  relativeDay,
  relativeTime,
  renderMarkdown,
} from './format.js';

// The user's own lists, `tasks` and `reminders`, sit right after the obligations that
// come with a deadline attached: every other source is a queue somebody else fills,
// and their own list ranking below everyone else's noise is how it ends up ignored.
const SOURCE_ORDER = [
  'workday',
  'eboks',
  'tasks',
  'reminders',
  'email',
  'messages',
  'github',
  'slack',
  'jira',
  'atlassian',
  'calendar',
  'other',
];

const SOURCE_LABEL = {
  workday: 'Workday',
  tasks: 'Tasks',
  email: 'Email',
  github: 'GitHub',
  slack: 'Slack',
  jira: 'Jira',
  atlassian: 'Atlassian',
  calendar: 'Calendar',
  reminders: 'Reminders',
  messages: 'Messages',
  eboks: 'e-Boks',
  other: 'Other',
};

/** Element factory. `props` maps to properties, except `class`/`dataset`/`aria-*`. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function replace(container, ...children) {
  container.replaceChildren(...children.flat().filter(Boolean));
}

function sourceColor(source) {
  return `var(--src-${SOURCE_ORDER.includes(source) ? source : 'other'})`;
}

/* ---------- header & banners ---------- */

export function renderHeader(state, handlers) {
  const dateEl = document.getElementById('header-date');
  const now = new Date(state.now);
  dateEl.textContent = formatDay(state.brief.date ?? state.now) || formatDay(now.toISOString());

  renderBriefRefresh(state, handlers);

  const freshness = document.getElementById('freshness');
  if (state.brief.generatedAt === null) {
    freshness.textContent = 'no brief yet';
    freshness.dataset.stale = 'true';
    return;
  }

  const hours = state.brief.ageHours ?? 0;
  const when = hours < 1 ? 'just now' : hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const by = state.brief.generatedBy ? ` by ${state.brief.generatedBy}` : '';
  freshness.textContent = `updated ${when}${by}`;
  freshness.dataset.stale = String(state.brief.stale);
}

/**
 * The refresh icon beside the brief's age, when the dashboard may start the
 * morning agent. The same icon the boards use, spinning for the same reason,
 * but no label of its own: "updated … ago" beside it already is one.
 */
function renderBriefRefresh(state, handlers) {
  const slot = document.getElementById('brief-refresh');
  if (!slot) return;
  const agent = state.agentRun;
  if (!agent?.enabled) {
    replace(slot);
    return;
  }
  const running = agent.last?.status === 'running';
  const label = running
    ? `The morning agent is writing a new brief, started ${formatTime(agent.last.startedAt)}`
    : 'Run the morning agent now, for a fresh brief';
  replace(
    slot,
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button refresh-button',
        title: label,
        'aria-label': label,
        'aria-busy': String(running),
        dataset: { fetching: String(running), stale: String(Boolean(state.brief.stale)) },
        onclick: () => {
          if (!running) handlers.runAgent();
        },
      },
      el('span', { class: 'refresh-button__icon', 'aria-hidden': 'true' }),
    ),
  );
}

/**
 * The live connection, as a pill in the header rather than a banner under the
 * tabs. It belongs to the page and not to whichever tab is showing, and it is a
 * state rather than a message: EventSource reconnects on its own, so there is
 * nothing to read and nothing to do, only something to know — that what is on
 * screen stopped moving at the last update. The error's own words go in the
 * tooltip, since "Failed to fetch" is for whoever is debugging, not the reader.
 */
export function renderConnection(connectionError) {
  const pill = document.getElementById('connection');
  pill.hidden = !connectionError;
  document.body.dataset.offline = String(Boolean(connectionError));
  if (!connectionError) return;
  pill.title = `${connectionError.message}. Showing the last update received; reconnecting on its own.`;
}

export function renderBanners(state, ui = {}, handlers = {}) {
  const container = document.getElementById('banners');
  const banners = [];
  const agent = state.agentRun;
  const running = agent?.last?.status === 'running';

  if (state.problem) {
    banners.push(banner('critical', '!', state.problem));
  }
  if (running) {
    // Supersedes the three below: each is a guess about when the next brief
    // comes, and this one is on its way.
    banners.push(agentRunBanner(agent.last, state, ui, handlers));
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
  // Today's only: put away in one browser, a report from last week shouldn't
  // turn up again in another.
  if (
    !running &&
    agent?.last &&
    agent.last.id !== ui.agentReportSeen &&
    localDateKey(parseDate(agent.last.startedAt) ?? new Date(0)) === localDateKey(new Date(state.now))
  ) {
    banners.push(agentRunBanner(agent.last, state, ui, handlers));
  }
  for (const warning of state.warnings) {
    banners.push(banner('warning', '!', warning));
  }

  replace(container, banners);
}

function runNowButton(handlers) {
  return el('button', { type: 'button', class: 'button banner__action', onclick: () => handlers.runAgent() }, 'Run it now');
}

/**
 * A run the dashboard started: going, or finished and not yet put away.
 *
 * The report is the agent's own account of the run — what it wrote, what it
 * dropped as handled, what it could not reach — which on a schedule nobody sees.
 * Folded away, because the brief it describes is already on the page; open, it
 * is the one place to learn that a source was down.
 */
function agentRunBanner(run, state, ui, handlers) {
  const now = new Date(state.now);
  if (run.status === 'running') {
    return banner(
      'info',
      'i',
      el(
        'span',
        { class: 'agent-run' },
        `The morning agent is writing a new brief, started ${relativeTime(run.startedAt, now)}.`,
        // The latest thing it said, which along the way is what it is doing now.
        run.report ? el('span', { class: 'agent-run__progress' }, firstLine(run.report)) : null,
      ),
      el('button', { type: 'button', class: 'button banner__action', onclick: () => handlers.stopAgent() }, 'Stop'),
    );
  }

  const ended = run.endedAt ? formatTime(run.endedAt) : '';
  const headline =
    run.status === 'done'
      ? `The morning agent finished at ${ended}.`
      : run.status === 'aborted'
        ? `The morning agent was stopped at ${ended}: ${run.error}.`
        : `The morning agent failed at ${ended}: ${run.error}.`;
  return banner(
    run.status === 'done' ? 'info' : 'warning',
    run.status === 'done' ? 'i' : '!',
    el(
      'span',
      { class: 'agent-run' },
      headline,
      run.report
        ? el(
            'details',
            {
              class: 'agent-run__report',
              // Every state push rebuilds the banners, so whether the report is
              // open has to outlive the element, or it would snap shut unread.
              open: ui.agentReportOpen === run.id,
              ontoggle: (event) => handlers.toggleAgentReport?.(run.id, event.currentTarget.open),
            },
            el('summary', {}, run.status === 'done' ? 'Its report' : 'What it said last'),
            el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(run.report)),
          )
        : null,
    ),
    run.status === 'done' ? null : runNowButton(handlers),
    el(
      'button',
      { type: 'button', class: 'button banner__action', onclick: () => handlers.dismissAgentRun(run.id) },
      'Dismiss',
    ),
  );
}

/** The first non-empty line, without the Markdown that would read as noise in one. */
function firstLine(text) {
  const line = String(text).split('\n').find((l) => l.trim() !== '') ?? '';
  return line.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim();
}

/**
 * True when the brief is from an earlier day and today is a day the agent was never
 * going to run. A brief written *today* needs no explaining, even on a day off, and
 * neither does one read on a scheduled day — that one's the stale warning's job.
 */
function isHeldOverDayOff(state) {
  if (state.brief.generatedAt === null || state.schedule.runsToday) return false;
  const today = localDateKey(new Date(state.now));
  const briefDate = state.brief.date ?? localDateKey(parseDate(state.brief.generatedAt) ?? new Date(state.now));
  return briefDate !== today;
}

/** " — the next one arrives Monday", or nothing if we can't say. */
function nextRunPhrase(state) {
  const next = state.schedule.nextRunDate;
  if (!next) return '';
  const when = daysFromToday(next, new Date(state.now)) === 1 ? 'tomorrow' : formatWeekday(next);
  return ` — the next one arrives ${when}`;
}

/**
 * `text` may be a string or a node, which is how the two boards' warnings come to
 * carry links: theirs name a pull request or a ticket key and are written by this
 * repo, so they are handed over through `renderMarkdown`. The brief's warnings are
 * deliberately not — they quote titles and ids an LLM wrote, and a stray bracket
 * in one should read as the stray bracket it is rather than become a link.
 */
function banner(tone, icon, text, ...actions) {
  return el(
    'div',
    { class: `banner banner--${tone}`, role: 'status' },
    el('span', { class: 'banner__icon', 'aria-hidden': 'true' }, icon),
    el('span', { class: 'banner__text' }, text),
    actions,
  );
}

/* ---------- focus sessions ---------- */

/** mm:ss, counting up once the target has passed. */
export function clock(seconds) {
  const total = Math.abs(seconds);
  const mm = Math.floor(total / 60);
  const ss = Math.floor(total % 60);
  return `${seconds < 0 ? '+' : ''}${mm}:${String(ss).padStart(2, '0')}`;
}

/**
 * The running session, pinned under the header so it survives focus mode.
 *
 * Shown when something is running, or when there's a tally worth seeing. Hidden
 * entirely on a day with neither, since an idle timer is just furniture.
 */
/**
 * Own up to a session the dashboard stopped by itself.
 *
 * This is the whole reason the auto-stop is safe to have: the failure it replaces
 * wasn't really "the timer kept running", it was "something silently wrote down a
 * number nobody checked". So say what was recorded, say where it stopped, and make
 * the correction one keypress away — coming back to the desk is exactly the moment
 * they can still remember what actually happened.
 */
function unattendedNotice(closed, handlers) {
  const stoppedAt = formatTime(closed.endedAt);
  const headline =
    closed.reason === 'away'
      ? `Timer stopped at ${stoppedAt} — nothing had touched the machine since.`
      : `Timer stopped at ${stoppedAt} — it had been left running.`;

  return el(
    'div',
    { class: 'timer__away', role: 'status' },
    el(
      'span',
      { class: 'timer__away-body' },
      el('span', { class: 'timer__away-text' }, headline),
      el(
        'span',
        { class: 'timer__away-detail' },
        `${formatDuration(closed.actualMinutes)} logged on “${closed.title}”. `,
        closed.reason === 'away'
          ? 'The time you were away is not in the record.'
          : 'Treat that as an upper bound, not a measurement.',
      ),
    ),
    el(
      'button',
      { type: 'button', class: 'button', onclick: () => handlers.startSession(closed.id) },
      'Pick it back up',
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': 'Dismiss',
        onclick: () => handlers.dismissUnattended(closed.endedAt),
      },
      '✕',
    ),
  );
}

export function renderTimer(state, ui, handlers) {
  const node = document.getElementById('timer');
  const { active, completedToday, minutesToday, unattendedClose } = state.session;
  const closed =
    unattendedClose && ui.unattendedSeen !== unattendedClose.endedAt ? unattendedClose : null;

  if (!active && completedToday === 0 && !closed) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }

  node.hidden = false;
  const tally =
    completedToday > 0
      ? `${completedToday} session${completedToday === 1 ? '' : 's'} today · ${formatDuration(minutesToday)}`
      : null;

  if (!active) {
    node.dataset.state = closed ? 'stopped' : 'idle';
    replace(
      node,
      closed ? unattendedNotice(closed, handlers) : null,
      tally ? el('span', { class: 'timer__tally' }, tally) : null,
    );
    return;
  }

  node.dataset.state = active.overrun ? 'overrun' : 'running';

  replace(
    node,
    el('span', { class: 'timer__clock' }, clock(active.remainingSeconds)),
    el(
      'span',
      { class: 'timer__title' },
      active.title,
      active.overrun
        ? el('span', { class: 'timer__note' }, ` · ${active.minutes} min in, still counting`)
        : null,
      // The one thing a kitchen timer can't tell you.
      active.collidesWithNextEvent && !active.overrun
        ? el('span', { class: 'timer__note timer__note--warn' }, ` · runs into ${formatTime(active.nextEventAt)}`)
        : null,
    ),
    tally ? el('span', { class: 'timer__tally' }, tally) : null,
    el('button', { type: 'button', class: 'button', onclick: () => handlers.stopSession() }, 'Stop'),
  );
}

/* ---------- standing objective ---------- */

/**
 * The one thing on this page that isn't about what arrived overnight. It sits
 * above the stats deliberately: the point is that you read it before you read
 * the list of things other people want.
 */
export function renderObjective(state) {
  const node = document.getElementById('objective');
  const focus = state.focus;

  // No focus.md at all means the feature is off, not forgotten: show nothing.
  if (!focus) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }

  node.hidden = false;
  node.classList.toggle('objective--empty', !focus.objective);

  // A blank objective is a normal stretch between objectives, not a failure, so
  // the reminder is quiet rather than a banner.
  if (!focus.objective) {
    node.replaceChildren(
      el('p', { class: 'objective__label' }, 'No current objective'),
      el(
        'p',
        { class: 'objective__note' },
        'Set ',
        el('code', {}, 'objective:'),
        ' in ',
        el('code', {}, 'focus.md'),
        ' in your store to have the day ranked against it.',
      ),
    );
    return;
  }

  replace(
    node,
    el('p', { class: 'objective__label' }, 'Current objective'),
    el('p', { class: 'objective__text' }, renderMarkdown(focus.objective)),
    focus.blocker
      ? el(
          'p',
          { class: 'objective__blocker' },
          el('span', { class: 'objective__blocker-label' }, 'Blocked on: '),
          renderMarkdown(focus.blocker),
        )
      : null,
    focus.note ? el('p', { class: 'objective__note' }, renderMarkdown(focus.note)) : null,
  );
}

/* ---------- stats ---------- */

export function renderStats(state) {
  const { open, completedToday, overdue } = state.stats;
  replace(
    document.getElementById('stats'),
    objectiveStat(state.objectiveProgress),
    focusTimeStat(state.agenda),
    stat('Needs action', open),
    stat('Overdue', overdue, overdue > 0 ? 'critical' : null),
    stat('Cleared today', completedToday, completedToday > 0 ? 'good' : null),
  );
}

/**
 * Unbooked time between now and the end of the working day.
 *
 * A list of open items reads identically whether six hours remain or forty
 * minutes, which is precisely when it misleads. This is the number that decides
 * whether today's plan is possible.
 */
function focusTimeStat(agenda) {
  const minutes = agenda.remainingFocusMinutes;
  const tone = minutes === 0 ? 'critical' : minutes < 60 ? 'critical' : null;
  return stat('Focus time left', minutes === 0 ? 'None' : formatDuration(minutes), tone, `Day ends ${agenda.dayEnd}`);
}

/**
 * Working days since the objective last moved — the one number here that isn't
 * about today's inbox. Only shown when focus.md sets an objective.
 */
function objectiveStat(progress) {
  if (!progress) return null;

  if (progress.workingDaysSince === null) {
    return stat('Since objective progress', '—', null, 'Nothing recorded yet');
  }

  const days = progress.workingDaysSince;
  const tone = days === 0 ? 'good' : days >= 3 ? 'critical' : null;
  const value = days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`;

  return stat('Since objective progress', value, tone, progress.lastTitle ?? undefined);
}

function stat(label, value, tone, footnote) {
  return el(
    'div',
    { class: 'stat' },
    el('p', { class: 'stat__label' }, label),
    el('p', { class: 'stat__value', dataset: tone ? { tone } : {} }, String(value)),
    footnote ? el('p', { class: 'stat__footnote', title: footnote }, footnote) : null,
  );
}

export function renderHeadline(state) {
  const node = document.getElementById('headline');
  if (!state.brief.headline) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren(renderMarkdown(state.brief.headline));
}

/* ---------- sections ---------- */

export function renderSections(state, ui, handlers) {
  const container = document.getElementById('sections');
  const actionable = state.items.filter((item) => item.kind !== 'event');

  const open = actionable.filter((item) => item.status === 'open');
  const priorities = open
    .filter((item) => item.priority !== undefined && item.kind === 'task')
    .sort((a, b) => a.priority - b.priority);
  const prioritised = new Set(priorities.map((item) => item.id));

  const sections = [];

  if (priorities.length > 0) {
    sections.push(section('Top priorities', priorities, state, ui, handlers, null));
  }

  const tasks = open.filter((item) => item.kind === 'task' && !prioritised.has(item.id));
  for (const source of SOURCE_ORDER) {
    const group = tasks.filter((item) => item.source === source);
    if (group.length > 0) {
      sections.push(section(SOURCE_LABEL[source], group, state, ui, handlers, source));
    }
  }

  const info = open.filter((item) => item.kind === 'info' && !prioritised.has(item.id));
  if (info.length > 0) {
    sections.push(section('Heads up', info, state, ui, handlers, null));
  }

  if (sections.length === 0) {
    sections.push(
      el(
        'p',
        { class: 'empty' },
        state.problem
          ? 'Nothing to show until a brief lands.'
          : state.items.length === 0
            ? 'The brief is empty — nothing needs you today.'
            : 'Everything here is handled. Enjoy the quiet.',
      ),
    );
  }

  const snoozed = actionable.filter((item) => item.status === 'snoozed');
  if (snoozed.length > 0) {
    sections.push(drawer('today:snoozed', `Snoozed (${snoozed.length})`, snoozed, state, ui, handlers));
  }

  const now = new Date(state.now);
  const cleared = actionable.filter(
    (item) =>
      (item.status === 'done' || item.status === 'dismissed') &&
      item.statusAt &&
      daysFromToday(item.statusAt, now) === 0,
  );
  if (cleared.length > 0) {
    sections.push(drawer('today:cleared', `Cleared today (${cleared.length})`, cleared, state, ui, handlers));
  }

  replace(container, sections);
}

/** A titled list. `row` renders one entry: a brief item by default, a pull request on the board. */
function section(title, items, state, ui, handlers, source, row = renderItem) {
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section__header' },
      source
        ? el('span', {
            class: 'section__dot',
            style: `background:${sourceColor(source)}`,
            'aria-hidden': 'true',
          })
        : null,
      el('h2', { class: 'section__title' }, title),
      el('span', { class: 'section__count' }, String(items.length)),
    ),
    el(
      'ul',
      { class: 'list' },
      items.map((item) => row(item, state, ui, handlers)),
    ),
  );
}

/**
 * A collapsed list, closed until somebody opens it.
 *
 * Whether it is open is kept in `ui.openDrawers` under `key`, not left to the
 * element, because every render rebuilds the element: state arrives on a
 * heartbeat, so a drawer that remembered for itself snapped shut within the
 * minute — or the moment a row inside it was clicked, since selecting renders.
 */
function drawer(key, title, items, state, ui, handlers, row = renderItem) {
  return el(
    'details',
    {
      class: 'drawer',
      open: ui.openDrawers?.has(key),
      ontoggle: (event) => handlers.toggleDrawer(key, event.currentTarget.open),
    },
    el('summary', {}, title),
    el(
      'ul',
      { class: 'list' },
      items.map((item) => row(item, state, ui, handlers)),
    ),
  );
}

/* ---------- one item ---------- */

/**
 * Path segments github.com spends on itself. `/orgs/acme/projects/5` is not a
 * repository called `acme` owned by `orgs`, and a row claiming it was would be
 * worse than a row that said nothing.
 */
const GITHUB_NON_OWNER = new Set([
  'account',
  'apps',
  'codespaces',
  'collections',
  'dashboard',
  'explore',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'users',
]);

/**
 * Which repository a GitHub row belongs to, read off its link.
 *
 * The title is prose an agent wrote, so it names the repository when it happens
 * to read well and not otherwise — and the organisation almost never, which is
 * the half that matters when two of them own a `web-ui`.
 *
 * Off the URL rather than off the id: the id's `github:pr:<owner>/<repo>#<n>`
 * shape is the prompt's to spell, and this file treats it as opaque on purpose.
 * A link naming no repository yields nothing rather than a guess, for the same
 * reason — the row can be quiet about where it lives, but it must not be wrong.
 */
function githubRepo(item) {
  if (item.source !== 'github' || !item.url) return null;

  let url;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }

  // github.com, or an enterprise host spelled github.<company>.com. A gist lives
  // on gist.github.com and its second segment is a hash, not a repository name.
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com' && !host.startsWith('github.')) return null;

  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo || GITHUB_NON_OWNER.has(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}

/** Exported for `test/items-ui.test.ts`, which renders one brief row against a DOM stub. */
export function renderItem(item, state, ui, handlers) {
  const now = new Date(state.now);
  const selected = ui.selectedId === item.id;

  // Ahead of the title and inside the link, which is where the board tab puts the
  // same fact. Always, even when the title says it too: a column you can run an
  // eye down is worth more than the odd repeated word.
  const repo = githubRepo(item);
  const title = item.url
    ? el(
        'a',
        { href: item.url, target: '_blank', rel: 'noopener noreferrer' },
        repo ? [el('span', { class: 'item__ref' }, repo), ' '] : null,
        item.title,
      )
    : item.title;

  const node = el(
    'li',
    {
      class: 'item',
      id: `item-${cssId(item.id)}`,
      dataset: {
        id: item.id,
        status: item.status,
        selected: String(selected),
        priority: String(item.priority !== undefined && item.status === 'open'),
        pending: String(ui.pending.has(item.id)),
        running: String(ui.activeSessionId === item.id),
        overrun: String(ui.activeSessionId === item.id && ui.sessionOverrun === true),
        detail: String(ui.detailFor === item.id),
      },
      onclick: (event) => {
        // Let links, buttons and inputs do their own thing. Anywhere else on the
        // card opens the panel on it: one way in, and the whole card is it.
        if (event.target.closest('a, button, input, textarea, summary')) return;
        handlers.onSelect(item.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      el('span', {
        class: 'item__dot',
        style: `background:${sourceColor(item.source)}`,
        'aria-hidden': 'true',
      }),
    ),
    el(
      'div',
      { class: 'item__body' },
      el('p', { class: 'item__title' }, title),
      renderMeta(item, state, now),
      item.detail ? el('p', { class: 'item__detail' }, renderMarkdown(item.detail)) : null,
    ),
    renderActions(item, state, ui, handlers),
    ui.menuFor === item.id ? renderSnoozeMenu(item, now, handlers) : null,
  );

  return node;
}

function renderMeta(item, state, now) {
  const pills = [];

  if (state.session?.active?.id === item.id) {
    pills.push(
      el(
        'span',
        { class: 'pill pill--running' },
        // Ticked in place by app.js rather than re-rendering the list every second.
        el('span', { class: 'item__running-clock' }, clock(state.session.active.remainingSeconds)),
        ' focusing',
      ),
    );
  }

  if (item.priority !== undefined && item.status === 'open') {
    pills.push(el('span', { class: 'pill pill--priority' }, `#${item.priority}`));
  }

  pills.push(...rowPills(item, state));

  // Marks the rows that actually move the objective, so they're findable at a glance
  // even when they aren't the top-ranked thing on the page.
  if (item.advancesObjective) {
    pills.push(el('span', { class: 'pill pill--objective' }, 'objective'));
  }

  if (item.due) {
    const diff = daysFromToday(item.due, now);
    if (diff !== null && diff < 0) {
      pills.push(el('span', { class: 'pill pill--overdue' }, `overdue ${relativeDay(item.due, now)}`));
    } else if (diff !== null && diff <= 7) {
      pills.push(el('span', { class: 'pill pill--due' }, `due ${relativeDay(item.due, now)}`));
    }
  }

  // Only nag once something has genuinely lingered.
  if (item.ageDays >= 2 && item.status === 'open') {
    pills.push(el('span', { class: 'pill pill--age' }, `${item.ageDays} days on the list`));
  }

  if (state.agenda.conflictIds.includes(item.id)) {
    pills.push(el('span', { class: 'pill pill--conflict' }, 'clashes'));
  }

  if (item.status === 'snoozed') {
    pills.push(
      el(
        'span',
        { class: 'pill' },
        item.snoozedUntil ? `snoozed until ${relativeDay(item.snoozedUntil, now)}` : 'snoozed',
      ),
    );
  }

  // The agent sometimes tags an item with a word the pills already say —
  // "objective" alongside the objective pill. Showing it twice is just noise.
  const alreadyShown = new Set(pills.map((pill) => pill.textContent.trim().toLowerCase()));
  for (const tag of item.tags ?? []) {
    if (alreadyShown.has(tag.trim().toLowerCase())) continue;
    pills.push(el('span', { class: 'pill pill--tag' }, tag));
  }

  return el(
    'div',
    { class: 'item__meta' },
    // The source name in text is what carries identity; the dot only reinforces it.
    el('span', { class: 'item__source' }, SOURCE_LABEL[item.source] ?? 'Other'),
    item.people?.length ? el('span', {}, `· ${item.people.join(', ')}`) : null,
    pills,
  );
}

/**
 * What every kind of row says about its panel: how many notes it carries, and
 * that the assistant is working on it. The notes themselves live in the panel,
 * and the card is the way there.
 */
function rowPills(row, state) {
  const pills = [];
  const count = row.notes?.length ?? 0;
  if (count > 0) {
    pills.push(el('span', { class: 'pill pill--notes' }, count === 1 ? '1 note' : `${count} notes`));
  }
  if (state.assistant?.items?.[row.id]?.running) {
    pills.push(el('span', { class: 'pill pill--assistant' }, 'assistant working…'));
  }
  return pills;
}

/* ---------- the item panel ---------- */

/**
 * The panel beside the list: one row's notes and its conversation with the
 * assistant, and a field for each.
 *
 * Beside the list rather than under the row, because the row is for deciding and
 * this is for reading. A transcript under a card pushed the rest of the list down
 * and a note form did the same in miniature; here the list stays where it was and
 * one panel holds what would otherwise be stuffed into every card in turn. It is
 * pinned to the row it was opened for — `j` and `k` move the cursor, not this —
 * and it stays open across the tabs, since the same id can be a row on more than
 * one of them and the notes and the conversation are the same wherever it is.
 *
 * `row` is null when nothing is open, or the row it was open for has gone.
 */
export function renderFlyout(row, state, ui, handlers) {
  const container = document.getElementById('flyout');
  if (!row) {
    container.hidden = true;
    replace(container);
    return;
  }

  const before = captureFlyout(container);
  const facts = describeRow(row);
  const now = new Date(state.now);
  const enabled = Boolean(state.assistant?.enabled);
  const entry = state.assistant?.items?.[row.id] ?? { running: false, turns: [] };

  container.hidden = false;
  replace(
    container,
    flyoutHeader(row, facts, handlers),
    el(
      'div',
      { class: 'flyout__body' },
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
        renderNoteForm(row, ui, handlers),
      ),
      enabled ? renderAssistantSection(row, state, entry, ui, handlers) : null,
    ),
  );
  restoreFlyout(container, row, ui, before);
}

/**
 * What the panel says at the top of every kind of row, in the row's own terms.
 * A ticket is its key and summary, a pull request its `repo#number`, a brief item
 * its title and whatever the agent wrote under it. Read off the fields rather
 * than off a type tag, since the rows have none.
 */
function describeRow(row) {
  if (typeof row.key === 'string' && typeof row.summary === 'string') {
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
  if (typeof row.number === 'number' && typeof row.repo === 'string') {
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

function flyoutHeader(row, facts, handlers) {
  const title = facts.ref ? [el('span', { class: 'item__ref' }, facts.ref), ' ', facts.title] : [facts.title];
  return el(
    'div',
    { class: 'flyout__header' },
    el(
      'div',
      { class: 'flyout__where' },
      el('span', { class: 'item__dot', style: `background:${facts.color}`, 'aria-hidden': 'true' }),
      el('span', { class: 'item__source' }, SOURCE_LABEL[facts.source] ?? 'Other'),
      facts.status ? el('span', {}, `· ${facts.status}`) : null,
      facts.people.length ? el('span', {}, `· ${facts.people.join(', ')}`) : null,
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button flyout__close',
        title: 'Close (Esc)',
        'aria-label': 'Close the panel',
        onclick: () => handlers.closeDetail(),
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
 */
function renderNoteForm(row, ui, handlers) {
  const input = el('input', {
    type: 'text',
    class: 'flyout__note-input',
    // The draft rather than an empty field: this input is thrown away and rebuilt
    // by every state push, and the text has to come back with it.
    value: ui.noteDraft,
    placeholder: 'Tell the agent what happened…',
    'aria-label': `Note for ${describeRow(row).title}`,
    oninput: () => handlers.onNoteDraft(input.value),
  });

  return el(
    'form',
    {
      class: 'flyout__note-form',
      onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) handlers.saveNote(row.id, text);
      },
    },
    input,
    el('button', { type: 'submit', class: 'button button--primary flyout__submit' }, 'Save'),
  );
}

/**
 * The conversation so far, the canned asks that fit this row's source, and the
 * field, in that order — one section, with the field at its foot the way a chat
 * has one. All of it scrolls with the panel; `restoreFlyout` keeps the end in
 * view while a reply grows.
 */
function renderAssistantSection(row, state, entry, ui, handlers) {
  const actions = (state.assistant?.quickActions ?? []).filter(
    (action) => action.sources === null || action.sources.includes(row.source ?? 'github'),
  );
  const label = new Map((state.assistant?.quickActions ?? []).map((action) => [action.id, action]));

  return el(
    'section',
    { class: 'flyout__section assistant', dataset: { running: String(entry.running) } },
    el('h3', { class: 'flyout__label' }, 'Assistant'),
    entry.turns.length
      ? el(
          'div',
          { class: 'assistant__turns' },
          entry.turns.map((turn) => renderAssistantTurn(turn, label, handlers)),
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
                onclick: () => handlers.ask(row.id, { action: action.id }),
              },
              action.label,
            ),
          ),
        ),
    renderAssistantComposer(row, entry, ui, handlers),
  );
}

/** The field at the foot of the assistant section. */
function renderAssistantComposer(row, entry, ui, handlers) {
  const input = el('textarea', {
    class: 'assistant__input',
    rows: 2,
    value: ui.assistantDraft,
    placeholder: entry.turns.length ? 'Follow up…' : 'What do you need help with?',
    'aria-label': `Ask the assistant about ${describeRow(row).title}`,
    disabled: entry.running,
    oninput: () => handlers.onAssistantDraft(input.value),
    onkeydown: (event) => {
      // Enter sends; shift-enter is a new line, as in every chat box.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
  });

  const submit = () => {
    const text = input.value.trim();
    if (!text || entry.running) return;
    handlers.ask(row.id, { text });
  };

  return el(
    'form',
    {
      class: 'assistant__form',
      dataset: { running: String(entry.running) },
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    input,
    entry.running
      ? el('button', { type: 'button', class: 'button flyout__submit', onclick: () => handlers.stopAssistant(row.id) }, 'Stop')
      : el('button', { type: 'submit', class: 'button button--primary flyout__submit' }, 'Send'),
  );
}

/**
 * Read the state of the panel on its way out.
 *
 * State arrives on a heartbeat, so a rebuild lands mid-sentence more often than
 * not, and it takes the field being typed into with it. The text survives in
 * `ui.noteDraft` and `ui.assistantDraft`, but the caret, the focus and how far
 * the panel was scrolled belong to elements that are about to be discarded —
 * the only place to get them is off them, just before they go.
 */
function captureFlyout(container) {
  if (container.hidden) return null;
  const id = container.dataset.id ?? null;
  const fields = { note: container.querySelector('.flyout__note-input'), assistant: container.querySelector('.assistant__input') };
  let field = null;
  for (const [kind, input] of Object.entries(fields)) {
    if (input && document.activeElement === input) {
      field = { kind, start: input.selectionStart, end: input.selectionEnd };
    }
  }
  const body = container.querySelector('.flyout__body');
  const scroll = body
    ? { top: body.scrollTop, atBottom: body.scrollHeight - body.scrollTop - body.clientHeight < 8 }
    : null;
  return { id, field, scroll };
}

/** Put focus, caret and scroll back on the elements that replaced the ones measured. */
function restoreFlyout(container, row, ui, before) {
  container.dataset.id = row.id;
  const same = before?.id === row.id;
  const body = container.querySelector('.flyout__body');

  // The same panel, rebuilt: back to where it was, unless it was reading the
  // newest reply, in which case it follows the reply as it grows. A panel just
  // opened starts at the end of its conversation, where the next thing happens.
  if (body) {
    if (same && before.scroll && !before.scroll.atBottom) body.scrollTop = before.scroll.top;
    else body.scrollTop = body.scrollHeight;
  }

  // Opened by hand, the field asked for takes the cursor. Opened by a reload that
  // remembered it, nothing does — nobody asked.
  const asked = ui.focusField;
  ui.focusField = null;
  if (asked) {
    const input = container.querySelector(asked === 'note' ? '.flyout__note-input' : '.assistant__input');
    if (input && !input.disabled) input.focus();
    return;
  }

  // Otherwise leave focus wherever it was — a heartbeat shouldn't pull the cursor
  // out of the address bar and into a note.
  if (!same || !before.field) return;
  const input = container.querySelector(before.field.kind === 'note' ? '.flyout__note-input' : '.assistant__input');
  if (!input || input.disabled) return;
  input.focus();
  input.setSelectionRange(before.field.start, before.field.end);
}

/** One exchange: the request as it was asked, and the reply or what became of it. */
function renderAssistantTurn(turn, label, handlers) {
  const action = turn.action ? label.get(turn.action) : null;
  // A quick action shows as its label, plus whatever was typed alongside it.
  const extra = action && turn.request.startsWith(action.request) ? turn.request.slice(action.request.length).trim() : null;
  const asked = action ? [el('strong', {}, action.label), extra ? ` — ${extra}` : ''] : turn.request;

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
    { class: 'assistant__turn', dataset: { status: turn.status } },
    el('p', { class: 'assistant__request' }, asked),
    turn.reply ? el('div', { class: 'assistant__reply' }, renderMarkdownBlocks(turn.reply)) : null,
    status,
  );
}

/**
 * Markdown with paragraphs, lists and fenced code, on top of the inline forms
 * `renderMarkdown` knows. The assistant writes whole answers; everything else on
 * the page is a sentence.
 */
export function renderMarkdownBlocks(text) {
  const out = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = el('pre', {});
      pre.textContent = code.join('\n');
      out.push(pre);
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // A quote: the assistant's habit for "the draft now says". Rendered by
    // recursion so a quoted list or paragraph break keeps its shape.
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(el('blockquote', {}, renderMarkdownBlocks(quoted.join('\n'))));
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      i++;
      out.push(el('hr', {}));
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && bullet.test(lines[i])) {
        let item = lines[i].replace(bullet, '');
        i++;
        // A wrapped bullet continues on indented lines.
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !bullet.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(el('li', {}, renderMarkdown(item)));
      }
      out.push(el(ordered ? 'ol' : 'ul', {}, items));
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !bullet.test(lines[i]) && !/^\s*(```|>)/.test(lines[i])) {
      paragraph.push(lines[i++]);
    }
    const joined = paragraph.join(' ');
    // A heading reads as a lead sentence: the panel is too narrow for hierarchy.
    const heading = /^#{1,6}\s+(.*)$/.exec(joined);
    out.push(heading ? el('p', {}, el('strong', {}, renderMarkdown(heading[1]))) : el('p', {}, renderMarkdown(joined)));
  }
  return out;
}

function renderActions(item, state, ui, handlers) {
  const buttons = [];
  const act = (id, action, extra) => () => handlers.onAction(id, action, extra);

  const running = ui.activeSessionId === item.id;

  if (item.status === 'open') {
    if (item.kind === 'task') {
      buttons.push(
        el(
          'button',
          {
            type: 'button',
            class: running ? 'button button--primary' : 'button',
            title: running ? 'Stop the focus session' : 'Start a focus session on this',
            onclick: () => (running ? handlers.stopSession() : handlers.startSession(item.id)),
          },
          running ? 'Stop' : 'Focus',
        ),
      );
      buttons.push(el('button', { type: 'button', class: 'button', onclick: act(item.id, 'done') }, 'Done'));
      buttons.push(
        el(
          'button',
          {
            type: 'button',
            class: 'button',
            'aria-expanded': String(ui.menuFor === item.id),
            onclick: () => handlers.toggleMenu(item.id),
          },
          'Snooze',
        ),
      );
    }
    buttons.push(
      el('button', { type: 'button', class: 'button', onclick: act(item.id, 'dismiss') }, 'Dismiss'),
    );
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onclick: act(item.id, 'reopen') }, 'Undo'));
  }

  return el('div', { class: 'item__actions' }, buttons);
}

/**
 * The snooze presets. `indefinite` offers "until the agent decides", which only
 * means something on the brief — the board has no agent deciding anything, so a
 * parked pull request always carries a date or is parked outright.
 */
/**
 * The park / snooze menu.
 *
 * `indefinite` offers "until the agent decides", which is a brief item's escape
 * hatch and deliberately not a board's: `foldActionLog` keeps a dateless snooze
 * parked forever, and a board row hidden forever with nothing to say so is the
 * failure these boards exist to avoid.
 *
 * `longRange` adds months and quarters, for the boards where something can
 * legitimately not be this month's problem. Both are calendar arithmetic from
 * today rather than jumps to the 1st, which keeps them consistent with the three
 * above — "Next week" is seven days, not next Monday — and avoids the collision
 * that "the start of next quarter" would hit every time the quarter is nearly
 * over: in late September it and "next month" would both be 1 October.
 */
function renderSnoozeMenu(item, now, handlers, { indefinite = true, longRange = false } = {}) {
  const presets = [
    ['Tomorrow', addDays(now, 1)],
    ['In 3 days', addDays(now, 3)],
    ['Next week', addDays(now, 7)],
  ];
  if (longRange) {
    presets.push(['Next month', addMonths(now, 1), true], ['Next quarter', addMonths(now, 3), true]);
  }

  const dateInput = el('input', { type: 'date', 'aria-label': 'Snooze until a specific date' });

  return el(
    'div',
    { class: 'menu', role: 'menu' },
    presets.map(([label, until, dated]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onclick: () => handlers.onAction(item.id, 'snooze', { until }),
        },
        label,
        // Only the long ones show the date they resolve to. You know what date
        // next Tuesday is; you do not know what date three months out is, and a
        // park that long is worth being sure about before clicking it.
        dated ? el('span', { class: 'menu__when' }, formatShortDay(until)) : null,
      ),
    ),
    indefinite
      ? el(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            onclick: () => handlers.onAction(item.id, 'snooze', {}),
          },
          'Until the agent decides',
        )
      : null,
    el(
      'div',
      { class: 'menu__date' },
      dateInput,
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          onclick: () => {
            if (dateInput.value) handlers.onAction(item.id, 'snooze', { until: dateInput.value });
          },
        },
        'Set',
      ),
    ),
  );
}

function addDays(from, days) {
  return localDateKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

/**
 * The same day some months ahead, clamped to the end of a short month.
 *
 * The clamp is the whole reason this isn't a one-liner: `new Date(y, m + 1, 31)`
 * for the 31st of January is the 3rd of March, because the day overflows February
 * and rolls on. A park set from the last day of a long month would quietly land
 * days into the month after the one it named.
 */
function addMonths(from, months) {
  const target = new Date(from.getFullYear(), from.getMonth() + months, 1);
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(from.getDate(), lastDay));
  return localDateKey(target);
}

/** CSS-safe id fragment — item ids contain ':', '#' and '/'. */
function cssId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ---------- agenda ---------- */

export function renderAgenda(state) {
  const now = new Date(state.now);
  const { events, conflictIds, freeWindows } = state.agenda;

  const rows = [];
  const entries = [
    ...events.map((event) => ({
      kind: 'event',
      at: new Date(event.start).getTime(),
      event,
    })),
    ...freeWindows.map((window) => ({
      kind: 'free',
      at: new Date(window.start).getTime(),
      window,
    })),
  ].sort((a, b) => a.at - b.at);

  let nowPlaced = false;
  for (const entry of entries) {
    if (!nowPlaced && entry.at > now.getTime()) {
      rows.push(nowRow(now));
      nowPlaced = true;
    }
    rows.push(entry.kind === 'event' ? eventRow(entry.event, now, conflictIds) : freeRow(entry.window));
  }
  if (!nowPlaced && entries.length > 0) rows.push(nowRow(now));

  replace(
    document.getElementById('agenda'),
    el(
      'div',
      { class: 'agenda' },
      el('h2', { class: 'agenda__title' }, 'Today'),
      agendaNotes(state.agendaSource),
      rows.length > 0
        ? el('ul', { class: 'agenda__list' }, rows)
        : el('p', { class: 'empty' }, 'No meetings today.'),
    ),
  );
}

/**
 * Why this agenda says what it says, when that isn't simply "the calendar".
 *
 * Kept inside the pane rather than in the page banners on purpose: it is about
 * these rows, and a global banner for a stale calendar would compete with the
 * ones about the brief. But it is never silent when the source isn't live — an
 * agenda quietly served from this morning looks exactly like a live one right up
 * to the meeting you cancelled still sitting on it.
 */
function agendaNotes(source) {
  if (!source) return [];
  const notes = [];
  if (source.problem) {
    notes.push(
      el('p', { class: `agenda__note agenda__note--${source.live ? 'warn' : 'stale'}` }, source.problem),
    );
  }
  for (const warning of source.warnings ?? []) {
    notes.push(el('p', { class: 'agenda__note agenda__note--warn' }, warning));
  }
  return notes;
}

export function eventRow(event, now, conflictIds) {
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  const past = (end ?? start).getTime() < now.getTime();
  const clashes = conflictIds.includes(event.id);
  // Only an explicit false frees the slot, which is the reading `agenda.ts` gives
  // the same field when it works out what the day has left.
  const blocking = event.blocking !== false;

  const name = event.url
    ? el('a', { href: event.url, target: '_blank', rel: 'noopener noreferrer' }, event.title)
    : event.title;

  // Said in words and not only in ink, for the reason the palette gives at the top
  // of the stylesheet. Folded into the "until" line rather than added beneath it: a
  // row that grows a third line to announce it wants less attention has taken more.
  const until = !allDay && end ? `until ${formatTime(event.end)}` : null;
  const sub = blocking ? until : [until, 'marked free'].filter(Boolean).join(' · ');

  return el(
    'li',
    { class: 'agenda__row', dataset: { past: String(past), blocking: String(blocking) } },
    el('span', { class: 'agenda__time' }, allDay ? 'all day' : formatTime(event.start)),
    el(
      'span',
      { class: 'agenda__name' },
      name,
      clashes ? el('span', { class: 'agenda__sub' }, '⚠ clashes with another meeting') : null,
      sub ? el('span', { class: 'agenda__sub' }, sub) : null,
    ),
  );
}

function freeRow(window) {
  return el(
    'li',
    { class: 'agenda__row agenda__row--free' },
    el('span', { class: 'agenda__time' }, formatTime(window.start)),
    el(
      'span',
      { class: 'agenda__name' },
      `Free · ${formatDuration(window.minutes)}`,
      el('span', { class: 'agenda__sub' }, `until ${formatTime(window.end)}`),
    ),
  );
}

function nowRow(now) {
  return el(
    'li',
    { class: 'agenda__row agenda__row--now', 'aria-hidden': 'true' },
    el('span', { class: 'agenda__now-label' }, formatTime(now.toISOString())),
    el('span', { class: 'agenda__now-line' }),
  );
}

/* ---------- tabs ---------- */

/**
 * The views this instance offers. A switched-off board has nothing to show but a
 * line saying so, so its tab goes too — a personal instance with no Jira shouldn't
 * carry a Jira tab around.
 */
export function availableViews(state) {
  const views = ['today'];
  if (state?.board?.enabled) views.push('board');
  if (state?.tickets?.enabled) views.push('tickets');
  return views;
}

/**
 * Three views, one page.
 *
 * Each badge says the one number its tab wants read from the others. The board's
 * is how many pull requests are waiting on you right now, which is urgent and
 * styled as such. The ticket board's is how many statuses look wrong, which never
 * is — nobody is blocked on a mislabelled ticket — so it is the whole flagged
 * count rather than a subset, and quiet rather than red.
 */
export function renderTabs(state, ui) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === ui.view));
  }
  const views = availableViews(state);
  document.getElementById('tab-board').hidden = !views.includes('board');
  document.getElementById('tab-tickets').hidden = !views.includes('tickets');
  const waiting = state.board?.enabled ? state.board.counts.you : 0;
  badge(
    'board-badge',
    waiting,
    `${waiting} ${waiting === 1 ? 'pull request is' : 'pull requests are'} waiting on you`,
  );

  const tickets = state.tickets;
  const flagged = tickets?.enabled ? tickets.rows.filter((row) => row.status === 'open').length : 0;
  badge(
    'tickets-badge',
    flagged,
    `${flagged} ${flagged === 1 ? 'ticket has a status that looks' : 'tickets have statuses that look'} wrong`,
  );
}

/** The label doubles as the hover tooltip, so a bare number can be decoded. */
function badge(id, count, label) {
  const node = document.getElementById(id);
  if (!node) return;
  node.hidden = count === 0;
  node.textContent = String(count);
  node.setAttribute('aria-label', label);
  node.title = label;
}

/* ---------- the pull request board ---------- */

const COURT_TITLE = {
  you: 'Waiting on you',
  ready: 'Ready to merge',
  reviewers: 'Waiting on reviewers',
  gate: 'Waiting on merge gate',
  blocked: 'Merge blocked by GitHub',
  checks: 'Waiting on checks',
  draft: 'Drafts',
};

const COURT_ORDER = ['you', 'ready', 'reviewers', 'gate', 'blocked', 'checks', 'draft'];

/** The courts whose rows carry a reason worth printing under the title. */
const COURTS_WITH_REASONS = new Set(['you', 'gate', 'checks']);

export function renderBoard(state, ui, handlers) {
  const container = document.getElementById('board');
  const board = state.board;
  const now = new Date(state.now);
  const parts = [];

  if (!board || !board.enabled) {
    replace(document.getElementById('board-refresh'));
    replace(
      container,
      el(
        'p',
        { class: 'empty' },
        'The pull request board is switched off (DAILY_FOCUS_GITHUB=off).',
      ),
    );
    return;
  }

  replace(document.getElementById('board-refresh'), boardStatus(board, now, handlers));

  if (board.reason) parts.push(banner('critical', '!', board.reason));
  for (const warning of board.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));

  const open = board.rows.filter((row) => row.status === 'open');
  for (const court of COURT_ORDER) {
    const rows = open.filter((row) => row.court === court);
    if (rows.length === 0) continue;
    parts.push(section(COURT_TITLE[court], rows, state, ui, handlers, null, renderPullRow));
  }

  if (open.length === 0 && !board.reason) {
    parts.push(
      el(
        'p',
        { class: 'empty' },
        board.fetchedAt === null
          ? board.fetching
            ? 'Asking GitHub…'
            : 'Nothing fetched yet.'
          : board.scope.length > 0
            ? `No open pull requests in ${board.scope.map((q) => q.replace(/^\w+:/, '')).join(', ')}.`
            : 'No open pull requests.',
      ),
    );
  }

  const parked = board.rows.filter((row) => row.status === 'snoozed');
  if (parked.length > 0) {
    parts.push(drawer('board:parked', `Parked (${parked.length})`, parked, state, ui, handlers, renderPullRow));
  }

  replace(container, parts);
}

/** "as of 10:42 · polling alice, bob every 5 min", on the refresh control. */
function boardStatus(board, now, handlers) {
  const polled = board.accounts.filter((account) => account.ok).map((account) => account.login);
  const bits = [];
  if (board.fetching) bits.push('refreshing…');
  else if (board.fetchedAt) bits.push(`as of ${formatTime(board.fetchedAt)}`);
  if (polled.length > 0) {
    bits.push(`polling ${polled.join(', ')} every ${board.pollMinutes} min`);
  }
  let stale = false;
  if (board.fetchedAt && !board.fetching) {
    const ageMinutes = Math.round((now.getTime() - new Date(board.fetchedAt).getTime()) / 60_000);
    // Older than two polls means the poller has been failing or paused; say so
    // rather than let an "as of" from this morning pass for current. The label
    // and icon turn red too, since the age itself is only on hover.
    stale = ageMinutes > board.pollMinutes * 2;
    if (stale) bits.push(`${relativeTime(board.fetchedAt, now)}`);
  }

  return refreshControl({
    source: 'GitHub',
    fetchedAt: board.fetchedAt,
    status: bits.join(' · ') || 'Not polled yet',
    fetching: board.fetching,
    stale,
    action: 'Ask GitHub now (r)',
    onRefresh: () => handlers.refreshBoard(),
  });
}

/**
 * The refresh control both boards put in the page header: which source it reads
 * and when it last did, then an icon that spins while a read is in flight, with
 * the rest of the status in its tooltip.
 *
 * The source is named in words because the slot is shared. The header's right
 * side belongs to whichever tab is showing — the brief's age on Today — and an
 * unlabelled icon there reads as refreshing everything, when it only ever asks
 * the one source behind this tab.
 *
 * The button is never `disabled`, because a disabled button swallows the hover
 * that carries the detail; a click mid-read is ignored instead.
 */
function refreshControl({ source, fetchedAt, status, fetching, stale, action, onRefresh }) {
  const label = `${status} — ${action}`;
  // The last good read stays on screen during a new one; the icon says it is
  // reading. Only a board with nothing read yet has no time to show.
  const when = fetchedAt ? formatTime(fetchedAt) : fetching ? 'reading…' : 'not read yet';
  return [
    el(
      'span',
      {
        class: 'refresh-label',
        dataset: { stale: String(stale) },
        // The button's label says all of this and more; read once, not twice.
        'aria-hidden': 'true',
      },
      `${source} · ${when}`,
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-button refresh-button',
        title: label,
        'aria-label': label,
        'aria-busy': String(fetching),
        dataset: { fetching: String(fetching), stale: String(stale) },
        onclick: () => {
          if (!fetching) onRefresh();
        },
      },
      // Drawn by the stylesheet as a mask, since `el()` builds HTML elements and
      // an SVG needs its own namespace.
      el('span', { class: 'refresh-button__icon', 'aria-hidden': 'true' }),
    ),
  ];
}

/** Exported for `test/board-ui.test.ts`, which renders one row against a DOM stub. */
export function renderPullRow(row, state, ui, handlers) {
  const now = new Date(state.now);
  const selected = ui.selectedId === row.id;

  const node = el(
    'li',
    {
      class: 'item item--pull',
      // Its own scheme: the same PR can be a brief row too, and two elements
      // with one id is invalid HTML and an ambiguous fragment target.
      id: `pull-${cssId(row.id)}`,
      dataset: {
        id: row.id,
        status: row.status,
        court: row.court,
        selected: String(selected),
        pending: String(ui.pending.has(row.id)),
        detail: String(ui.detailFor === row.id),
      },
      onclick: (event) => {
        if (event.target.closest('a, button, input, summary')) return;
        handlers.onSelect(row.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      el('span', { class: 'item__dot', style: `background:${sourceColor('github')}`, 'aria-hidden': 'true' }),
    ),
    el(
      'div',
      { class: 'item__body' },
      el(
        'p',
        { class: 'item__title' },
        el(
          'a',
          { href: row.url, target: '_blank', rel: 'noopener noreferrer' },
          el('span', { class: 'item__ref' }, `${row.repo}#${row.number}`),
          ' ',
          row.title,
        ),
      ),
      renderPullMeta(row, state, now),
      renderPullReasons(row, now),
      renderCancelledChecks(row),
    ),
    renderPullActions(row, state, ui, handlers),
    ui.menuFor === row.id ? renderSnoozeMenu(row, now, handlers, { indefinite: false }) : null,
  );
  return node;
}

function renderPullMeta(row, state, now) {
  const pills = [];

  // The server's reading of the reviews, so the pill and the bucket can't disagree.
  if (row.isDraft) pills.push(el('span', { class: 'pill pill--tag' }, 'draft'));
  if (row.decision === 'APPROVED') pills.push(el('span', { class: 'pill pill--good' }, 'approved'));
  if (row.decision === 'CHANGES_REQUESTED') pills.push(el('span', { class: 'pill pill--overdue' }, 'changes requested'));
  if (row.checks === 'failure') pills.push(el('span', { class: 'pill pill--overdue' }, 'CI failing'));
  else if (row.checks === 'pending') pills.push(el('span', { class: 'pill' }, 'checks running'));
  if (row.mergeable === 'CONFLICTING') pills.push(el('span', { class: 'pill pill--overdue' }, 'conflicts'));
  if (row.autoMerge) pills.push(el('span', { class: 'pill pill--good' }, 'auto-merge on'));
  if (row.nudge) pills.push(el('span', { class: 'pill pill--age' }, 'time to ask'));
  // How long the merge has been refused, which the section header leaves out.
  // A span rather than a point in time: "last touched" is about people, and the
  // thing holding these courts up is not a person.
  if (row.court === 'blocked') {
    pills.push(el('span', { class: 'pill' }, `blocked ${waitedFor(row.since, now)}`));
  } else if (row.court === 'gate' || row.court === 'checks') {
    pills.push(el('span', { class: 'pill' }, `waiting ${waitedFor(row.since, now)}`));
  }
  if (row.stale) pills.push(el('span', { class: 'pill pill--age' }, 'untouched for weeks'));
  if (row.status === 'snoozed') {
    pills.push(
      el('span', { class: 'pill' }, row.snoozedUntil ? `parked until ${relativeDay(row.snoozedUntil, now)}` : 'parked'),
    );
  }
  pills.push(...rowPills(row, state));

  const touched = row.lastActivityByOthers;
  const you = row.lastActivityByYou;
  let lastTouch;
  if (touched && (!you || touched.at > you)) {
    lastTouch = `@${touched.login} ${touched.kind === 'review' ? 'reviewed' : 'commented'} ${relativeTime(touched.at, now)}`;
  } else if (you) {
    lastTouch = `you, ${relativeTime(you, now)}`;
  }

  const waiting =
    row.court === 'reviewers' && row.requestedReviewers.length > 0
      ? `asked ${row.requestedReviewers.map((r) => `@${r}`).join(', ')}`
      : null;

  return el(
    'div',
    { class: 'item__meta' },
    el('span', { class: 'item__source' }, `opened ${relativeTime(row.createdAt, now)}`),
    lastTouch ? el('span', {}, `· last touched by ${lastTouch}`) : null,
    waiting ? el('span', {}, `· ${waiting}`) : null,
    pills,
  );
}

/**
 * Why the row sits where it does.
 *
 * A paragraph rather than a joined string, because the check-shaped reasons name
 * checks, and a check GitHub gave a link for should be clickable — that link is
 * the whole of what the board knows about a merge gate's internal policy.
 */
function renderPullReasons(row, now) {
  if (!COURTS_WITH_REASONS.has(row.court) || row.reasons.length === 0) return null;
  const parts = [];
  for (const reason of row.reasons) {
    // A kind this client doesn't know describes to nothing, and contributes no
    // separator either — a stray " · " is how a forward-compatible renderer
    // announces that it is out of date.
    const described = describeReason(reason, row, now);
    if (described.length === 0) continue;
    if (parts.length > 0) parts.push(' · ');
    parts.push(...described);
  }
  if (parts.length === 0) return null;
  const tone = row.court === 'you' ? '' : ' item__reason--waiting';
  return el('p', { class: `item__reason${tone}` }, parts);
}

/**
 * Cancelled checks, as a line of plain text under the reasons.
 *
 * Shown in every court, including ready, because it is a fact about the pull
 * request rather than a reason for where it sits — a cancelled run reached no
 * verdict, so it decides nothing, and the server keeps it out of the court
 * entirely. This line is what stops that silence from being invisible: it is the
 * whole compensation for a cancellation no longer reading as red.
 */
function renderCancelledChecks(row) {
  const cancelled = row.cancelledChecks ?? [];
  if (cancelled.length === 0) return null;
  return el('p', { class: 'item__reason item__reason--waiting' }, ['cancelled, no verdict: ', ...checkNames(cancelled)]);
}

/**
 * One reason, as an array of text and links. The server sends facts; the times are
 * relative and the wording belongs here.
 */
function describeReason(reason, row, now) {
  switch (reason.kind) {
    case 'changes-requested':
      return [`changes requested${reason.login ? ` by @${reason.login}` : ''}${reason.at ? ` ${relativeTime(reason.at, now)}` : ''}`];
    case 'ci-failing': {
      const names = row.failingChecks ?? [];
      if (names.length === 0) return ['CI is failing'];
      const shown = names.slice(0, 3).join(', ');
      return [`CI failing: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`];
    }
    case 'conflicts':
      return ['conflicts with the base branch'];
    case 'behind':
      return ['the branch is behind its base — update it to merge'];
    case 'activity':
      return [`@${reason.login} ${reason.activity === 'review' ? 'reviewed' : 'commented'} ${relativeTime(reason.at, now)}`];
    case 'merge-gate':
      // Deliberately says nothing about what the gate is waiting for. Its rules
      // are the repository's, not ours, and the link is where they are readable.
      return reason.checks?.length
        ? ['merge policy pending: ', ...checkNames(reason.checks)]
        : ['merge policy pending'];
    case 'checks-pending':
      return reason.checks?.length
        ? ['still running: ', ...checkNames(reason.checks)]
        : ['checks are still running'];
    case 'merge-blocked':
      return ['merge blocked by GitHub'];
    case 'mergeability-unknown':
      return ['GitHub is still determining mergeability'];
    default:
      return [];
  }
}

/**
 * How long a wait has run, as a span. The same thresholds `relativeTime` uses, so
 * "waiting 30 h" and "last touched 30 h ago" on one row can't disagree.
 */
function waitedFor(since, now) {
  const at = parseDate(since);
  const minutes = at ? Math.round((now.getTime() - at.getTime()) / 60_000) : 0;
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Pending check names, linked where GitHub gave somewhere to look. At most three. */
function checkNames(checks) {
  const parts = [];
  for (const check of checks.slice(0, 3)) {
    if (parts.length > 0) parts.push(', ');
    parts.push(
      check.detailsUrl
        ? el('a', { href: check.detailsUrl, target: '_blank', rel: 'noopener noreferrer' }, check.name)
        : check.name,
    );
  }
  if (checks.length > 3) parts.push(` and ${checks.length - 3} more`);
  return parts;
}

function renderPullActions(row, state, ui, handlers) {
  const buttons = [];
  const act = (id, action, extra) => () => handlers.onAction(id, action, extra);

  buttons.push(
    el(
      'a',
      { class: 'button', href: row.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open on GitHub' },
      'Open',
    ),
  );

  if (row.status === 'open') {
    // Nudging happens on Slack, where the board can't see it. This is how it's told:
    // a note, so the agent reads it too, and the nudge timer starts over.
    if (row.court === 'reviewers') {
      buttons.push(
        el(
          'button',
          { type: 'button', class: 'button', title: 'Record that you asked for a review', onclick: () => handlers.nudge(row.id) },
          'Nudged',
        ),
      );
    }
    buttons.push(
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          title: 'Park this until a date',
          'aria-expanded': String(ui.menuFor === row.id),
          onclick: () => handlers.toggleMenu(row.id),
        },
        'Park',
      ),
    );
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onclick: () => handlers.unpark(row.id) }, 'Unpark'));
  }

  return el('div', { class: 'item__actions' }, buttons);
}

/* ---------- the Jira ticket board ---------- */

/**
 * What each court claims, in the words the README uses for it.
 *
 * Each heading is the whole explanation, which is why there is no per-row reason
 * line here as there is on the pull request board: a ticket in `settled` has
 * exactly one thing wrong with it, and it is the heading.
 */
const TICKET_COURT_TITLE = {
  settled: 'No open pull requests left',
  started: 'Work has started, the ticket has not',
  idle: 'In flight with nothing linked',
};

const TICKET_COURT_ORDER = ['settled', 'started', 'idle'];

/** What to do about a row, under the heading that says what is wrong with it. */
const TICKET_COURT_HINT = {
  settled:
    'Every pull request Jira has for these is closed. Move them on, or say what is still to come — ' +
    'a pull request nobody has written yet is invisible from here.',
  started: 'A pull request is open, so the work has begun. The status still says it has not.',
  idle: 'Nothing in Jira links any code to these. Fine for work that is not code; worth a look otherwise.',
};

/**
 * Issue type as a colour, because on this board the dot has nothing else to say.
 *
 * Everywhere else the dot carries the source, which is what lets the palette's
 * lighter hues sit below 3:1 contrast — the source name is always in text beside
 * it. Here every row is Jira, so the dot repeats itself once per row and the
 * colour is free to mean something else.
 *
 * Which means this is the one place colour carries a cue on its own, so it is
 * kept to the thing that changes the *least* about what you do: the load-bearing
 * facts — key, summary, status — stay as text, every dot carries its type as an
 * `aria-label` and a hover title, and `typeLegend` names the ones on the board.
 *
 * Task keeps Jira's own amber so the ordinary row looks exactly as it did and the
 * exceptions are what stand out. The rest are drawn from the categorical hues and
 * deliberately avoid red and the accent blue: red is this palette's "something is
 * wrong" and blue is its "selected", and an issue type is neither.
 */
const TYPE_COLOR = {
  task: 'var(--src-jira)',
  bug: 'var(--src-atlassian)',
  'sub-task': 'var(--src-tasks)',
  subtask: 'var(--src-tasks)',
  story: 'var(--src-calendar)',
};

const TYPE_FALLBACK = 'var(--src-other)';

function typeColor(issueType) {
  return TYPE_COLOR[issueType.trim().toLowerCase()] ?? TYPE_FALLBACK;
}

/**
 * The key to the dots, built from the types actually on the board rather than from
 * the list above — so it never names a type this board isn't showing, and a type
 * nobody anticipated still gets a swatch and its own name rather than going
 * silently grey.
 */
export function typeLegend(rows) {
  const seen = [];
  for (const row of rows) {
    const label = row.issueType.trim();
    if (label !== '' && !seen.includes(label)) seen.push(label);
  }
  if (seen.length < 2) return null;
  return el(
    'p',
    { class: 'legend' },
    seen.sort((a, b) => a.localeCompare(b)).map((label) =>
      el(
        'span',
        { class: 'legend__entry' },
        el('span', { class: 'legend__dot', style: `background:${typeColor(label)}`, 'aria-hidden': 'true' }),
        label,
      ),
    ),
  );
}

/**
 * The two questions this tab answers, one at a time.
 *
 * "What here is out of sync with reality" is the one that asks for action, so it
 * is where the tab opens and what its badge counts. "What am I working on" is a
 * different frame of mind, looked for rather than acted on, and it used to sit in
 * a drawer under Parked — styled like Parked, read like overflow from the list
 * above it. So the two are separate views behind a switch, and neither is ever
 * scrolled past on the way to the other.
 */
const TICKET_MODES = ['sync', 'working'];

const TICKET_MODE_LABEL = {
  sync: 'Out of sync',
  working: 'Working on',
};

export function renderTicketBoard(state, ui, handlers) {
  const container = document.getElementById('tickets');
  const board = state.tickets;
  const parts = [];

  if (!board || !board.enabled) {
    replace(document.getElementById('tickets-refresh'));
    replace(container, el('p', { class: 'empty' }, 'The Jira ticket board is switched off (DAILY_FOCUS_JIRA=off).'));
    return;
  }

  // Absent from a server older than the page, which is what a tab sees between a
  // renderer changing on disk and the process behind it restarting.
  const inProgress = board.inProgress ?? [];
  const open = board.rows.filter((row) => row.status === 'open');
  const mode = ui.ticketMode === 'working' ? 'working' : 'sync';

  replace(document.getElementById('tickets-refresh'), ticketStatus(board, handlers, mode));
  // On the switch's line rather than beside the rows: it is a key, read once,
  // and a key repeated per court would be three copies of the same sentence.
  // Built from both views' rows, so it is the same key on either side of the
  // switch: one built per view vanished whenever a view held a single type, and
  // the line under it jumped as it came and went.
  const legend = typeLegend([...board.rows, ...inProgress]);
  parts.push(
    el(
      'div',
      { class: 'ticket-toolbar' },
      ticketModeSwitch(mode, { sync: open.length, working: inProgress.length }, handlers),
      legend,
    ),
  );

  // In both views: they are about whether the read can be trusted, and that is
  // as true of the list of work in progress as of the list of what is wrong.
  if (board.reason) parts.push(banner('critical', '!', board.reason));
  for (const warning of board.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));

  if (mode === 'working') parts.push(...workingOnView(board, inProgress, state, ui, handlers));
  else parts.push(...outOfSyncView(board, open, state, ui, handlers));

  replace(container, parts);
}

/** The switch between the two views, each with how many tickets it holds. */
function ticketModeSwitch(mode, counts, handlers) {
  return el(
    'div',
    { class: 'mode-switch', role: 'tablist', 'aria-label': 'Which tickets to show' },
    TICKET_MODES.map((option) =>
      el(
        'button',
        {
          type: 'button',
          class: 'mode-switch__option',
          role: 'tab',
          'aria-selected': String(option === mode),
          title: `${TICKET_MODE_LABEL[option]} (w switches)`,
          onclick: () => handlers.setTicketMode(option),
        },
        TICKET_MODE_LABEL[option],
        el('span', { class: 'mode-switch__count' }, String(counts[option])),
      ),
    ),
  );
}

/** Nothing on screen, said so as to tell an empty answer from no answer yet. */
function emptyTicketView(board, whenRead) {
  return el(
    'p',
    { class: 'empty' },
    board.fetchedAt === null
      ? board.fetching
        ? 'Asking Jira…'
        : 'Nothing read yet.'
      : // Deliberately says how many were looked at. An empty board and a
        // board that examined nothing look the same, and only one of them is
        // good news — the same trap the agenda and the PR board each guard.
        `${whenRead} ${board.checked} unfinished ${board.checked === 1 ? 'ticket' : 'tickets'} checked.`,
  );
}

/** The courts, what to do about each, and the rows parked out of them. */
function outOfSyncView(board, open, state, ui, handlers) {
  const parts = [];
  for (const court of TICKET_COURT_ORDER) {
    const rows = open.filter((row) => row.court === court);
    if (rows.length === 0) continue;
    // No dot on the heading, as on the pull request board. On the brief a section
    // dot is its source, but here the row dots mean the issue type, and an amber
    // one over a court heading reads as a claim that the court is Tasks.
    parts.push(section(TICKET_COURT_TITLE[court], rows, state, ui, handlers, null, renderTicketRow));
    parts.push(el('p', { class: 'court-hint' }, TICKET_COURT_HINT[court]));
  }

  if (open.length === 0 && !board.reason) parts.push(emptyTicketView(board, 'Nothing looks mislabelled.'));

  const parked = board.rows.filter((row) => row.status === 'snoozed');
  if (parked.length > 0) {
    parts.push(drawer('tickets:parked', `Parked (${parked.length})`, parked, state, ui, handlers, renderTicketRow));
  }
  return parts;
}

/**
 * The tickets in progress, grouped by the status each one is in.
 *
 * Grouped because the category holds more than one kind of thing — In Progress
 * and In Review, and a hold status if the user has one — and a heading per status
 * says which is which without reading every gutter. Matched case-insensitively,
 * since one real board spelled "In Progress" differently in two projects, and
 * titled by the first spelling seen. Alphabetical, so the groups don't trade
 * places as tickets move; within a group, Jira's own least-recently-touched order.
 */
function workingOnView(board, inProgress, state, ui, handlers) {
  if (inProgress.length === 0) return board.reason ? [] : [emptyTicketView(board, 'Nothing in progress.')];

  const groups = new Map();
  for (const row of inProgress) {
    const name = row.workflowStatus.trim() || '—';
    const group = groups.get(name.toLowerCase()) ?? { title: name, rows: [] };
    group.rows.push(row);
    groups.set(name.toLowerCase(), group);
  }
  return [...groups.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((group) => section(group.title, group.rows, state, ui, handlers, null, renderTicketRow));
}

/** "as of 10:42 · 19 of 86 unfinished tickets · reading as you@work every 15 min", on the refresh control. */
function ticketStatus(board, handlers, mode = 'sync') {
  const bits = [];
  // "refreshing…", as the pull request board says, so it cannot land beside the
  // "reading … every 15 min" clause below and say the same word twice.
  if (board.fetching) bits.push('refreshing…');
  else if (board.fetchedAt) bits.push(`as of ${formatTime(board.fetchedAt)}`);
  if (board.fetchedAt) {
    const unfinished = `${board.checked} unfinished ${board.checked === 1 ? 'ticket' : 'tickets'}`;
    bits.push(
      mode === 'working'
        ? `${(board.inProgress ?? []).length} of ${unfinished} in progress`
        : `${board.rows.filter((row) => row.status === 'open').length} of ${unfinished}`,
    );
  }
  if (board.projects.length > 0) bits.push(`in ${board.projects.join(', ')}`);
  // One clause, so "reading…" above doesn't land next to a second "reading".
  bits.push(`reading ${board.account ? `as ${board.account} ` : ''}every ${board.pollMinutes} min`);

  // No stale state: this status line has never carried an age to judge one by.
  return refreshControl({
    source: 'Jira',
    fetchedAt: board.fetchedAt,
    status: bits.join(' · '),
    fetching: board.fetching,
    stale: false,
    action: 'Ask Jira now (r)',
    onRefresh: () => handlers.refreshTickets(),
  });
}

/** Exported for `test/tickets-ui.test.ts`, which renders one row against a DOM stub. */
export function renderTicketRow(row, state, ui, handlers) {
  const now = new Date(state.now);
  const selected = ui.selectedId === row.id;

  // The key rather than the title, and a link only when there is a site to link
  // to: `url` is null when acli never named one, and `el()` drops a null href,
  // which would leave an anchor going nowhere. So the reference degrades to text.
  const reference = el('span', { class: 'item__ref' }, row.key);
  const title = row.url
    ? el('a', { href: row.url, target: '_blank', rel: 'noopener noreferrer' }, reference, ' ', row.summary)
    : el('span', {}, reference, ' ', row.summary);

  return el(
    'li',
    {
      class: 'item item--ticket',
      // Its own scheme, for `renderPullRow`'s reason: the same ticket can be a
      // brief row too, and two elements with one id is an ambiguous target.
      id: `ticket-${cssId(row.id)}`,
      dataset: {
        id: row.id,
        // Only a flagged row has either. One in Working on has no
        // complaint to be filed under and nothing to be parked from, and a
        // dataset handed `undefined` writes the word rather than leaving it out.
        ...(row.court ? { status: row.status, court: row.court } : {}),
        selected: String(selected),
        pending: String(ui.pending.has(row.id)),
        detail: String(ui.detailFor === row.id),
      },
      onclick: (event) => {
        if (event.target.closest('a, button, input, summary')) return;
        handlers.onSelect(row.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      // Not aria-hidden, unlike the source dots: this one is the only place the
      // issue type appears, so it has to be readable without seeing the colour.
      el('span', {
        class: 'item__dot',
        style: `background:${typeColor(row.issueType)}`,
        role: 'img',
        'aria-label': row.issueType || 'unknown type',
        title: row.issueType || 'unknown type',
      }),
    ),
    el(
      'div',
      { class: 'item__body' },
      renderTicketStatus(row, state, ui, handlers),
      el('p', { class: 'item__title' }, title),
      renderTicketMeta(row, state, handlers),
    ),
    renderTicketActions(row, state, ui, handlers),
    ui.menuFor === row.id ? renderSnoozeMenu(row, now, handlers, { indefinite: false, longRange: true }) : null,
  );
}

/**
 * The status the ticket is actually in — the other half of the sentence the court
 * heading starts, and the thing the user is about to go and change. Always shown,
 * even empty-handed, and alone in its own element because the stylesheet stands
 * it in a fixed gutter so every summary on the board starts at the same x.
 *
 * The issue type used to sit beside it and now rides on the dot: in a gutter that
 * narrow it wrapped underneath and cost a line on every card.
 */
/**
 * The status, and — where there is anything to move it to — the control that
 * changes it.
 *
 * Pressable only when the board has seen somewhere for this ticket to go. There
 * is deliberately no way to type a status name here: the offer is limited to
 * what has been observed, and a project whose workflow has never been seen
 * reaching an end simply cannot be finished from this tab. That is a known
 * limitation taken on purpose — a free-text field would invite naming statuses
 * that don't exist, and the answer to those is a refusal nobody needed to see.
 */
function renderTicketStatus(row, state, ui, handlers) {
  const offered = ticketStatusOptions(row, state);
  if (offered.length === 0) {
    return el('div', { class: 'item__meta item__meta--status' }, el('span', { class: 'pill pill--status' }, row.workflowStatus || '—'));
  }

  return el(
    'div',
    { class: 'item__meta item__meta--status' },
    el(
      'button',
      {
        type: 'button',
        class: 'pill pill--status pill--button',
        title: `Move ${row.key} to another status`,
        'aria-expanded': String(ui.statusFor === row.id),
        onclick: () => handlers.toggleStatus(row.id),
      },
      row.workflowStatus || '—',
    ),
    ui.statusFor === row.id ? renderStatusMenu(row, offered, ui, handlers) : null,
  );
}

/**
 * The statuses this row may be offered, which is *not* the same question as
 * which transitions Jira will allow.
 *
 * `acli` cannot answer the second — a work item's `transitions` come back null
 * and there is no command for them — so the offer is built from the statuses the
 * user's own tickets in that project are seen in, and Jira is left to be the
 * authority by refusing. Which means a refusal is an expected outcome here
 * rather than a bug, and has to read as Jira's answer rather than as an error.
 *
 * Scoped to the row's own project, because projects disagree: one real board was
 * running "In Progress" and "In progress" in two of them, and offering one
 * project's vocabulary on another's ticket is offering a refusal for certain.
 */
function ticketStatusOptions(row, state) {
  const project = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(row.key.trim())?.[1]?.toUpperCase();
  const all = (project && state.tickets?.statuses?.[project]) || [];
  const current = row.workflowStatus.trim().toLowerCase();
  return all.filter((status) => status.trim().toLowerCase() !== current);
}

function renderStatusMenu(row, offered, ui, handlers) {
  const busy = ui.pending.has(row.id);
  return el(
    'div',
    { class: 'menu menu--status', role: 'menu' },
    offered.map((status) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: busy,
          onclick: () => handlers.moveTicket(row.key, status, row.workflowStatus),
        },
        status,
      ),
    ),
  );
}

/**
 * The pills that are worth a second line because they are exceptions: a ticket
 * in Working on that is also out of sync, a pull request still open, or a row
 * someone parked. Null when there are none, which is the ordinary case and why
 * most cards are one line tall.
 */
function renderTicketMeta(row, state, handlers) {
  const pills = [];
  const flag = row.court ? null : outOfSyncFlag(row, state, handlers);
  if (flag) pills.push(flag);
  if (row.hasOpenPr) pills.push(el('span', { class: 'pill pill--tag' }, 'open PR'));
  if (row.status === 'snoozed' && row.snoozedUntil) {
    pills.push(el('span', { class: 'pill pill--tag' }, `parked until ${formatDay(row.snoozedUntil)}`));
  }
  pills.push(...rowPills(row, state));
  return pills.length > 0 ? el('div', { class: 'item__meta item__meta--extra' }, pills) : null;
}

/**
 * On a Working on row, whether the same ticket is out of sync — and a way to go
 * and see it there.
 *
 * This is how the more urgent of the two views reaches the other one. The row is
 * never shown twice on one screen, so without this an In Progress ticket whose
 * pull requests have all closed would read, in Working on, as work going fine.
 * The words carry it and the colour only agrees with them. A parked row gets no
 * flag: the park asked for exactly that complaint to stay quiet until its date.
 */
function outOfSyncFlag(row, state, handlers) {
  const flagged = state.tickets?.rows?.find((candidate) => candidate.id === row.id && candidate.status === 'open');
  if (!flagged) return null;
  return el(
    'button',
    {
      type: 'button',
      class: 'pill pill--button pill--flag',
      title: 'Show it under Out of sync',
      onclick: () => handlers.jumpToTicket(row.id),
    },
    `Out of sync: ${TICKET_COURT_TITLE[flagged.court]}`,
  );
}

/**
 * Park — and deliberately nothing else.
 *
 * No Done: the fix is a status change in Jira, and the next read drops the row on
 * its own. No Nudged either, which the pull request board offers: there is nobody
 * to nudge about your own ticket's status. Notes are written in the panel, which
 * a click on the card opens.
 *
 * And no Open, which the pull request board does have. The strip is absolutely
 * positioned over the card's top right, so on a 460px column every button in it
 * is width taken off the summary — and this one bought nothing, because the
 * summary beside it is already an anchor to the same browse URL, as is `o`. The
 * one that remains is the reason `.item__title` reserves the room it does.
 *
 * A row in Working on gets no strip at all. A park silences a complaint until a
 * date, and nothing on that row is complaining.
 */
function renderTicketActions(row, state, ui, handlers) {
  const buttons = [];

  if (row.court && row.status === 'open') {
    buttons.push(
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          title: 'Park this until a date',
          'aria-expanded': String(ui.menuFor === row.id),
          onclick: () => handlers.toggleMenu(row.id),
        },
        'Park',
      ),
    );
  } else if (row.court) {
    buttons.push(el('button', { type: 'button', class: 'button', onclick: () => handlers.unpark(row.id) }, 'Unpark'));
  }

  return buttons.length > 0 ? el('div', { class: 'item__actions' }, buttons) : null;
}
