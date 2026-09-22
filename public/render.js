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
  formatTime,
  formatWeekday,
  localDateKey,
  parseDate,
  relativeDay,
  relativeTime,
  renderMarkdown,
} from './format.js';

// `tasks` sits second on purpose: every other source is a queue somebody else fills,
// and their own list ranking below everyone else's noise is how it ends up ignored.
const SOURCE_ORDER = ['workday', 'tasks', 'email', 'github', 'slack', 'jira', 'atlassian', 'calendar', 'other'];

const SOURCE_LABEL = {
  workday: 'Workday',
  tasks: 'Tasks',
  email: 'Email',
  github: 'GitHub',
  slack: 'Slack',
  jira: 'Jira',
  atlassian: 'Atlassian',
  calendar: 'Calendar',
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

export function renderHeader(state) {
  const dateEl = document.getElementById('header-date');
  const now = new Date(state.now);
  dateEl.textContent = formatDay(state.brief.date ?? state.now) || formatDay(now.toISOString());

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

export function renderBanners(state, connectionError) {
  const container = document.getElementById('banners');
  const banners = [];

  if (state.problem) {
    banners.push(banner('critical', '!', state.problem));
  }
  if (state.brief.stale && !state.problem) {
    banners.push(
      banner(
        'warning',
        '!',
        `This brief is ${state.brief.ageHours} hours old — the morning agent may not have run.`,
      ),
    );
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
  if (connectionError) {
    banners.push(banner('warning', '!', `${connectionError.message}. Retrying…`));
  }
  for (const warning of state.warnings) {
    banners.push(banner('warning', '!', warning));
  }

  replace(container, banners);
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

function banner(tone, icon, text) {
  return el(
    'div',
    { class: `banner banner--${tone}`, role: 'status' },
    el('span', { class: 'banner__icon', 'aria-hidden': 'true' }, icon),
    el('span', {}, text),
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

  if (!focus || !focus.objective) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }

  node.hidden = false;
  node.replaceChildren(
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
    sections.push(drawer(`Snoozed (${snoozed.length})`, snoozed, state, ui, handlers));
  }

  const now = new Date(state.now);
  const cleared = actionable.filter(
    (item) =>
      (item.status === 'done' || item.status === 'dismissed') &&
      item.statusAt &&
      daysFromToday(item.statusAt, now) === 0,
  );
  if (cleared.length > 0) {
    sections.push(drawer(`Cleared today (${cleared.length})`, cleared, state, ui, handlers));
  }

  const note = captureNoteField(container);
  replace(container, sections);
  restoreNoteField(container, ui, note);
}

/**
 * Read the state of an open note field, on its way out.
 *
 * State arrives on a heartbeat, so a rebuild lands mid-sentence more often than
 * not, and it takes the field being typed into with it. The text survives in
 * `ui.noteDraft`, but the caret and the focus belong to the element that's about
 * to be discarded — the only place to get them is off it, just before it goes.
 */
function captureNoteField(container) {
  const input = container.querySelector('.note-form input');
  if (!input) return null;
  return {
    id: input.closest('.item')?.dataset.id ?? null,
    focused: document.activeElement === input,
    start: input.selectionStart,
    end: input.selectionEnd,
  };
}

/** Put focus and caret back on the field that replaced the one we measured. */
function restoreNoteField(container, ui, before) {
  const input = container.querySelector('.note-form input');
  if (!input) return;

  // A form that wasn't open on the same item a moment ago has just been opened,
  // and opening it is the request for the cursor.
  if (before?.id !== ui.noteFor) {
    input.focus();
    return;
  }

  // Otherwise leave focus wherever it was — a heartbeat shouldn't pull the cursor
  // out of the address bar and into a note.
  if (!before.focused) return;
  input.focus();
  input.setSelectionRange(before.start, before.end);
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

function drawer(title, items, state, ui, handlers, row = renderItem) {
  return el(
    'details',
    { class: 'drawer' },
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
      },
      onclick: (event) => {
        // Let links, buttons and inputs do their own thing.
        if (event.target.closest('a, button, input, summary')) return;
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
      renderNotes(item),
      ui.noteFor === item.id ? renderNoteForm(item, ui, handlers) : null,
    ),
    renderActions(item, ui, handlers),
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

function renderNotes(item) {
  if (item.notes.length === 0) return null;
  return el(
    'div',
    { class: 'item__notes' },
    item.notes.map((note) => el('p', { class: 'item__note' }, `“${note.text}”`)),
  );
}

function renderNoteForm(item, ui, handlers) {
  const input = el('input', {
    type: 'text',
    // The draft rather than an empty field: this input is thrown away and rebuilt
    // by every state push, and the text has to come back with it.
    value: ui.noteDraft,
    placeholder: 'Tell the agent what happened…',
    'aria-label': `Note for ${item.title}`,
    oninput: () => handlers.onNoteDraft(input.value),
  });

  return el(
    'form',
    {
      class: 'note-form',
      onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) handlers.onAction(item.id, 'note', { text });
        handlers.closeNote();
      },
    },
    input,
    el('button', { type: 'submit', class: 'button button--primary' }, 'Save'),
    el('button', { type: 'button', class: 'button', onclick: () => handlers.closeNote() }, 'Cancel'),
  );
}

function renderActions(item, ui, handlers) {
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

  buttons.push(
    el(
      'button',
      { type: 'button', class: 'button', title: 'Leave a note', onclick: () => handlers.toggleNote(item.id) },
      'Note',
    ),
  );

  return el('div', { class: 'item__actions' }, buttons);
}

/**
 * The snooze presets. `indefinite` offers "until the agent decides", which only
 * means something on the brief — the board has no agent deciding anything, so a
 * parked pull request always carries a date or is parked outright.
 */
function renderSnoozeMenu(item, now, handlers, { indefinite = true } = {}) {
  const presets = [
    ['Tomorrow', 1],
    ['In 3 days', 3],
    ['Next week', 7],
  ];

  const dateInput = el('input', { type: 'date', 'aria-label': 'Snooze until a specific date' });

  return el(
    'div',
    { class: 'menu', role: 'menu' },
    presets.map(([label, days]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onclick: () => handlers.onAction(item.id, 'snooze', { until: addDays(now, days) }),
        },
        label,
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
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
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
 * Two views, one page. The badge is the one number the board pushes into the
 * Today view: how many pull requests are waiting on you, right now.
 */
export function renderTabs(state, ui) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === ui.view));
  }
  const badge = document.getElementById('board-badge');
  const waiting = state.board?.enabled ? state.board.counts.you : 0;
  badge.hidden = waiting === 0;
  badge.textContent = String(waiting);
  badge.setAttribute('aria-label', `${waiting} waiting on you`);
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

  parts.push(boardStatus(board, now, handlers));

  if (board.reason) parts.push(banner('critical', '!', board.reason));
  for (const warning of board.warnings) parts.push(banner('warning', '!', warning));

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
    parts.push(drawer(`Parked (${parked.length})`, parked, state, ui, handlers, renderPullRow));
  }

  const note = captureNoteField(container);
  replace(container, parts);
  restoreNoteField(container, ui, note);
}

/** "as of 10:42 · polling alice, bob every 5 min", and the button that doesn't wait. */
function boardStatus(board, now, handlers) {
  const polled = board.accounts.filter((account) => account.ok).map((account) => account.login);
  const bits = [];
  if (board.fetching) bits.push('refreshing…');
  else if (board.fetchedAt) bits.push(`as of ${formatTime(board.fetchedAt)}`);
  if (polled.length > 0) {
    bits.push(`polling ${polled.join(', ')} every ${board.pollMinutes} min`);
  }
  if (board.fetchedAt && !board.fetching) {
    const ageMinutes = Math.round((now.getTime() - new Date(board.fetchedAt).getTime()) / 60_000);
    // Older than two polls means the poller has been failing or paused; say so
    // rather than let an "as of" from this morning pass for current.
    if (ageMinutes > board.pollMinutes * 2) bits.push(`${relativeTime(board.fetchedAt, now)}`);
  }

  return el(
    'div',
    { class: 'board__status' },
    el('span', { class: 'board__status-text' }, bits.join(' · ') || 'Not polled yet'),
    el(
      'button',
      {
        type: 'button',
        class: 'button',
        disabled: board.fetching,
        title: 'Ask GitHub now (r)',
        onclick: () => handlers.refreshBoard(),
      },
      board.fetching ? 'Refreshing…' : 'Refresh',
    ),
  );
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
      renderPullMeta(row, now),
      renderPullReasons(row, now),
      renderCancelledChecks(row),
      renderNotes(row),
      ui.noteFor === row.id ? renderNoteForm(row, ui, handlers) : null,
    ),
    renderPullActions(row, ui, handlers),
    ui.menuFor === row.id ? renderSnoozeMenu(row, now, handlers, { indefinite: false }) : null,
  );
  return node;
}

function renderPullMeta(row, now) {
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

function renderPullActions(row, ui, handlers) {
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

  buttons.push(
    el(
      'button',
      { type: 'button', class: 'button', title: 'Leave a note', onclick: () => handlers.toggleNote(row.id) },
      'Note',
    ),
  );

  return el('div', { class: 'item__actions' }, buttons);
}
