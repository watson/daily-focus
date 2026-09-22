import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { loadEnv } from './env.ts';
import { parseWeekdays, type Weekday } from './schedule.ts';

/**
 * How the pull request board reaches GitHub. See `board.ts` and `github.ts`.
 *
 * The board is the one part of the dashboard that gathers anything itself, so its
 * settings are grouped rather than spread through the rest of the config.
 */
export interface GitHubConfig {
  /** `DAILY_FOCUS_GITHUB=off` turns the board off entirely; nothing is polled. */
  enabled: boolean;
  /**
   * Logins to poll as, each resolved to a token through `gh auth token --user`.
   * Empty means "whatever account gh has active", which is the zero-config case.
   */
  accounts: readonly string[];
  /**
   * Search qualifiers restricting which PRs count, already in GitHub's syntax:
   * `org:acme` or `repo:acme/webapp`. Empty means every PR the account authored.
   */
  scope: readonly string[];
  /**
   * Check names that stand for the whole merge policy of their repository, exactly
   * as GitHub spells them.
   *
   * Some repositories put review policy, ownership and security behind one status
   * check and let that check speak for all of it. Such a check pending means the
   * merge is refused, but says nothing about whose action is missing — reviewers',
   * the author's, or an automated system's — so the board gives it a bucket of its
   * own rather than guessing. Which names those are is a property of the user's
   * repositories, never of this project: nothing is recognised unless it is
   * configured here, and an empty list simply means no row gets that treatment.
   */
  mergeGateChecks: readonly string[];
  /** Minutes between polls while a browser is watching. */
  pollMinutes: number;
  /** The gh binary. Overridable because a launchd job's PATH rarely has Homebrew on it. */
  ghPath: string;
}

/**
 * How the agenda reaches Calendar.app. See `calendar.ts` and `calendarboard.ts`.
 *
 * The brief is written once at dawn, so a meeting declined at eleven leaves a gap
 * the dashboard cannot see. This is the live read that closes it; when it is off,
 * or has never succeeded, the agenda falls back to the events in the brief.
 */
export interface CalendarConfig {
  /** `DAILY_FOCUS_CALENDAR=off` turns the live read off; the brief's events are used. */
  enabled: boolean;
  /**
   * Calendar names exactly as **Calendar.app** spells them, which is not always how
   * the briefing agent's source list spells them — the two reach the same calendars
   * through different accounts. Deliberately not read from `sources.md`: that file
   * is the agent's, the server has never opened it, and the two lists answer
   * different questions now that neither depends on the other.
   *
   * A name matching several calendars keeps all of them, since a calendar shared
   * from a second account appears once per account. Empty means nothing is read.
   */
  names: readonly string[];
  /**
   * The user's own addresses, used to find their own reply among an event's
   * attendees. Needed because `isCurrentUser` is false for every attendee of every
   * event on a Google account synced through Calendar.app, so an address is the
   * only reliable way to tell a meeting you declined from one you're going to.
   */
  addresses: readonly string[];
  /** Minutes between reads while a browser is watching. */
  pollMinutes: number;
  /** The helper bundle built by `npm run build:calendar`. */
  appPath: string;
}

/**
 * All configuration is environment-driven so the agent and the dashboard can be
 * pointed at the same store without either one hardcoding a path. The environment
 * itself is the real one layered over the repo-root `.env`, see `env.ts`.
 */
export interface Config {
  /** Directory holding items.json and actions.jsonl. */
  dataDir: string;
  itemsFile: string;
  actionsFile: string;
  /** The standing objective, hand-written by the user. */
  focusFile: string;
  /**
   * The source list the briefing agent reads: which calendars, which account, which
   * recurring documents. Hand-written, and the server never opens it — the path
   * lives here only so `npm run init` and the docs can't disagree about where it is.
   */
  sourcesFile: string;
  /**
   * The morning prompt, and the payload schema it validates against. Both are
   * authored in this repo and installed into the store as symlinks by `npm run
   * init`, so the briefing agent needs nothing outside its own directory — see
   * `prompts/README.md`. The server never opens either; the paths live here for the
   * same reason `sourcesFile` does.
   */
  promptFile: string;
  schemaFile: string;
  /** Dated snapshots of past briefs, written by the server. */
  archiveDir: string;
  /** The one running focus session, if any. */
  sessionFile: string;
  /** Append-only focus session history, read by the agent. */
  sessionsLogFile: string;
  /** Default length of a focus session, in minutes. */
  sessionMinutes: number;
  /**
   * Minutes of an untouched machine after which a running session is treated as
   * abandoned. 0 disables it, leaving only the two-hour backstop.
   */
  awayAfterMinutes: number;
  port: number;
  host: string;
  /** Local hour the working day starts, for free-window detection. */
  workStartHour: number;
  workEndHour: number;
  /** A gap this long or longer counts as a focus window. */
  minFreeWindowMinutes: number;
  /** Scheduled hours before a refresh is expected, followed by a 45-minute grace period. */
  staleAfterHours: number;
  /**
   * Weekdays the briefing agent is scheduled on, 0 = Sunday. Null when it hasn't
   * been said, which leaves `schedule.ts` to work it out from the archive.
   */
  agentDays: readonly Weekday[] | null;
  /** The live pull request board. */
  github: GitHubConfig;
  /** Where prs.json lives: the board's last good fetch, written by the server. */
  pullsFile: string;
  /** The live agenda. */
  calendar: CalendarConfig;
  /** Where calendar.json lives: the last good calendar read, written by the server. */
  calendarFile: string;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * A comma-separated list, trimmed, empties and duplicates dropped.
 *
 * Commas only, unlike `envList`: GitHub check names contain spaces often enough
 * that splitting on whitespace would turn one name into three that match nothing.
 */
function envNameList(name: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (raw === undefined) return [];
  const names: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed !== '' && !names.includes(trimmed)) names.push(trimmed);
  }
  return names;
}

/** A comma- or whitespace-separated list, trimmed, empties dropped. */
function envList(name: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (raw === undefined) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Turn the scope list into search qualifiers.
 *
 * An entry with a slash is a repository, anything else an organisation (or a
 * user, which GitHub's `org:` qualifier also accepts). Entries already written as
 * qualifiers pass through, so `org:acme` and `acme` mean the same thing.
 */
export function parseScope(entries: readonly string[]): string[] {
  const qualifiers: string[] = [];
  for (const entry of entries) {
    const bare = entry.replace(/^(org|repo|user):/i, '');
    if (bare === '') continue;
    const qualifier = bare.includes('/') ? `repo:${bare}` : `org:${bare}`;
    if (!qualifiers.includes(qualifier)) qualifiers.push(qualifier);
  }
  return qualifiers;
}

function envGitHub(env: NodeJS.ProcessEnv): GitHubConfig {
  const flag = (env.DAILY_FOCUS_GITHUB ?? '').trim().toLowerCase();
  const pollMinutes = envInt('DAILY_FOCUS_GITHUB_POLL_MINUTES', 5, env);
  if (pollMinutes < 1) {
    throw new Error(`DAILY_FOCUS_GITHUB_POLL_MINUTES must be at least 1, got ${pollMinutes}`);
  }
  return {
    enabled: !['off', 'false', '0', 'no'].includes(flag),
    accounts: envList('DAILY_FOCUS_GITHUB_ACCOUNTS', env),
    scope: parseScope(envList('DAILY_FOCUS_GITHUB_SCOPE', env)),
    mergeGateChecks: envNameList('DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS', env),
    pollMinutes,
    ghPath: expandHome((env.DAILY_FOCUS_GH ?? '').trim() || 'gh'),
  };
}

function envCalendar(env: NodeJS.ProcessEnv): CalendarConfig {
  const flag = (env.DAILY_FOCUS_CALENDAR ?? '').trim().toLowerCase();
  const pollMinutes = envInt('DAILY_FOCUS_CALENDAR_POLL_MINUTES', 5, env);
  if (pollMinutes < 1) {
    throw new Error(`DAILY_FOCUS_CALENDAR_POLL_MINUTES must be at least 1, got ${pollMinutes}`);
  }
  return {
    enabled: !['off', 'false', '0', 'no'].includes(flag),
    // Commas only, as for merge gate checks: calendar names contain spaces.
    names: envNameList('DAILY_FOCUS_CALENDARS', env),
    addresses: envNameList('DAILY_FOCUS_CALENDAR_ADDRESSES', env),
    pollMinutes,
    appPath: expandHome(
      (env.DAILY_FOCUS_CALENDAR_APP ?? '').trim() ||
        resolve(import.meta.dirname, '..', 'tools/dfcal/build/Daily Focus Calendar.app'),
    ),
  };
}

/**
 * Copy the day-of-week field out of whatever runs the agent: `1-5`, `0-4`, `0,6`.
 *
 * Unset is not the same as "every day" — it means we haven't been told, and the
 * schedule gets inferred instead. A bad spec throws at startup rather than being
 * silently read as Mon–Fri, since a wrong schedule makes the staleness banner lie.
 */
function envWeekdays(name: string, env: NodeJS.ProcessEnv): readonly Weekday[] | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  try {
    return parseWeekdays(raw);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `~` and `~/…` become the home directory; a bare command name (`gh`) is left for PATH. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (!p.includes('/')) return p;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** A string knob; an empty value in `.env` means the default, as it does for numbers. */
function envString(name: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/**
 * Build the config. With no argument it reads the real environment layered over
 * the repo's `.env`; tests pass an explicit object and never touch the file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = loadEnv()): Config {
  const dataDir = expandHome(envString('DAILY_FOCUS_DATA', '~/.daily-focus', env));
  return {
    dataDir,
    itemsFile: resolve(dataDir, 'items.json'),
    actionsFile: resolve(dataDir, 'actions.jsonl'),
    focusFile: resolve(dataDir, 'focus.md'),
    sourcesFile: resolve(dataDir, 'sources.md'),
    promptFile: resolve(dataDir, 'prompt.md'),
    schemaFile: resolve(dataDir, 'items.schema.json'),
    archiveDir: resolve(dataDir, 'archive'),
    sessionFile: resolve(dataDir, 'session.json'),
    sessionsLogFile: resolve(dataDir, 'sessions.jsonl'),
    pullsFile: resolve(dataDir, 'prs.json'),
    calendarFile: resolve(dataDir, 'calendar.json'),
    sessionMinutes: envInt('DAILY_FOCUS_SESSION_MINUTES', 25, env),
    awayAfterMinutes: envInt('DAILY_FOCUS_AWAY_AFTER', 10, env),
    port: envInt('DAILY_FOCUS_PORT', 4321, env),
    host: envString('DAILY_FOCUS_HOST', '127.0.0.1', env),
    workStartHour: envInt('DAILY_FOCUS_WORK_START', 9, env),
    workEndHour: envInt('DAILY_FOCUS_WORK_END', 17, env),
    minFreeWindowMinutes: envInt('DAILY_FOCUS_MIN_FREE_WINDOW', 45, env),
    staleAfterHours: envInt('DAILY_FOCUS_STALE_AFTER_HOURS', 24, env),
    agentDays: envWeekdays('DAILY_FOCUS_AGENT_DAYS', env),
    github: envGitHub(env),
    calendar: envCalendar(env),
  };
}
