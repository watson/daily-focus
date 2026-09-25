import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { loadEnv } from './env.ts';
import { parseWeekdays, type Weekday } from './schedule.ts';

/**
 * Which half of a life an instance briefs. Each instance has its own store, server
 * and morning agent; the profile only picks their defaults, so any setting below
 * can still override it.
 *
 * `personal` switches off the Jira board, which would otherwise poll for tickets
 * nobody on this instance has, and away detection, since a personal instance
 * usually runs on a machine nobody sits at — its idle time says nothing about
 * whether the user is still in their session. The pull request board stays on:
 * side projects have pull requests too.
 */
export type Profile = 'work' | 'personal';

export const PROFILES: readonly Profile[] = ['work', 'personal'];

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
 * How the ticket board reaches Jira. See `jira.ts`, `tickets.ts` and
 * `ticketboard.ts`.
 *
 * The third thing the dashboard gathers itself, and for the pull request board's
 * reason: whether a ticket's status matches its pull requests is state rather
 * than judgement, and the point of a row is that the user goes and fixes it — so
 * it has to disappear when they do, which a morning brief written at dawn can
 * never do.
 */
export interface JiraConfig {
  /** `DAILY_FOCUS_JIRA=off` turns the board off entirely; nothing is read. */
  enabled: boolean;
  /**
   * Project keys to limit the search to. Empty means every project the account
   * can see, which is the zero-config case and usually right — the candidate set
   * is already narrowed to tickets assigned to the user.
   */
  projects: readonly string[];
  /**
   * Statuses in which standing still is deliberate rather than an oversight,
   * exactly as this Jira spells them: Blocked, On Hold, Waiting for customer.
   *
   * A ticket in one of these is already answering "why isn't this moving", so it
   * is not also asked. Which statuses those are is a property of the user's
   * workflow and never of this project, so nothing is recognised unless it is
   * configured here, and an empty list simply leaves every row in place.
   */
  holdStatuses: readonly string[];
  /**
   * The statuses the ticket board's Working on view shows, spelled as this Jira
   * spells them — the ones meaning the user is working on a ticket, as against
   * the ones where it waits on somebody else, like In Review.
   *
   * Jira files both kinds under one category, so only the names can tell them
   * apart, and which name means which is the user's workflow rather than this
   * project's. Empty shows everything Jira has in progress.
   */
  inProgressStatuses: readonly string[];
  /** Minutes between reads while a browser is watching. */
  pollMinutes: number;
  /**
   * The Atlassian site host browse links are built from, when `acli`'s own answer
   * isn't the one wanted. Null means use whichever site `acli` authenticated to.
   */
  site: string | null;
  /** The acli binary. Overridable for the reason `ghPath` is. */
  acliPath: string;
}

/** A coding-agent CLI the dashboard knows how to run headless. */
export type CliName = 'claude' | 'codex';

export const CLI_NAMES: readonly CliName[] = ['claude', 'codex'];

/** Which CLI answers when the user asks the assistant for help. */
export type AssistantAgent = CliName;

export const ASSISTANT_AGENTS: readonly AssistantAgent[] = CLI_NAMES;

/**
 * How the on-demand assistant runs. See `assistant.ts`.
 *
 * Not the morning agent. That one is scheduled, unattended and writes the brief;
 * this one is a CLI the dashboard runs headless when the user asks for help with
 * one item, in a chat they started. The two never share a setting, and the
 * vocabulary is kept apart on purpose: "agent" is the morning one, "assistant"
 * is this.
 */
export interface AssistantConfig {
  /** `DAILY_FOCUS_ASSISTANT=claude` or `codex`; null means off, which is the default. */
  agent: AssistantAgent | null;
  /** The CLI binary. Overridable for the reason `ghPath` is. */
  binPath: string;
  /**
   * Model and effort, passed through to the CLI untouched. Null means no flag,
   * which leaves the CLI on whatever the user configured in it: the zero-config
   * case, and usually the right one.
   */
  model: string | null;
  effort: string | null;
  /**
   * Tool permissions handed to Claude Code, in its own `--allowedTools` syntax.
   * The assistant runs with prompts disabled, so a tool not on this list is
   * denied outright. The default covers the two CLIs the boards already lean on,
   * fetching a page, and the claude.ai Gmail connector, which is how a draft
   * reaches the thread.
   * Codex has no equivalent; its sandbox, confined to the empty working
   * directory, is the whole policy.
   */
  tools: readonly string[];
}

/** A local time of day, as `DAILY_FOCUS_AGENT_AT` gives it. */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * How the dashboard runs the morning agent: on its own clock each scheduled
 * morning, and by hand when the user asks for a fresh brief. See `agent.ts`.
 *
 * The same agent either way, on the same wrapper prompt, in the store. Its
 * settings are its own rather than borrowed from the assistant's: the brief is
 * typically written by another CLI, another model and at another effort than a
 * quick answer about one row.
 */
export interface AgentRunConfig {
  /** `DAILY_FOCUS_AGENT=codex` or `claude`; null means off, which is the default. */
  cli: CliName | null;
  /**
   * The local time the dashboard starts the agent on each scheduled day: 07:00
   * unless `DAILY_FOCUS_AGENT_AT` says otherwise. Null when that is `off`, which
   * leaves the schedule to whatever else runs the agent, or when the agent is.
   */
  at: TimeOfDay | null;
  /** The CLI binary. Overridable for the reason `ghPath` is. */
  binPath: string;
  /** Passed through untouched, as the assistant's are. Null means no flag. */
  model: string | null;
  effort: string | null;
  /**
   * Tool permissions handed to Claude Code for reaching its sources, as for the
   * assistant. Writing the brief is not on this list: `briefWritingTools` is
   * added by the runner for a run and withheld for a follow-up question, so a
   * chat about a finished brief cannot rewrite it. Codex ignores this; its
   * sandbox, confined to the store, is the policy.
   */
  tools: readonly string[];
}

/**
 * All configuration is environment-driven so the agent and the dashboard can be
 * pointed at the same store without either one hardcoding a path. The environment
 * itself is the real one layered over the repo-root `.env`, see `env.ts`.
 */
export interface Config {
  profile: Profile;
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
  /** The prompt in this repo that `promptFile` links to, chosen by the profile. */
  promptSource: string;
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
  /**
   * Whether the agenda looks for free windows and counts focus time left. That
   * needs a start and end to the day, which an evening at home does not have, so
   * the personal profile defaults to off: events only, no "Free · 5 h" rows.
   */
  freeWindows: boolean;
  /** Local hour the working day starts, for free-window detection. */
  workStartHour: number;
  workEndHour: number;
  /** A gap this long or longer counts as a focus window. */
  minFreeWindowMinutes: number;
  /** Scheduled hours before a refresh is expected, followed by a 45-minute grace period. */
  staleAfterHours: number;
  /**
   * Weekdays the briefing agent runs on, 0 = Sunday. With `agent.at` set these
   * are the days the dashboard starts it, Mon–Fri when unset. Otherwise they
   * describe whatever else runs it, and null leaves `schedule.ts` to work that
   * out from the archive.
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
  /** The Jira ticket board. */
  jira: JiraConfig;
  /** Where tickets.json lives: the board's last good read, written by the server. */
  ticketsFile: string;
  /** The on-demand assistant. */
  assistant: AssistantConfig;
  /** Append-only record of every assistant turn, written by the server. */
  assistantLogFile: string;
  /**
   * The assistant's working directory: an empty directory inside the store. It
   * gets no checkout on purpose. Anything that needs one is a job for a real
   * coding session, and running here with nothing to edit is what makes the
   * boundary a property of the process rather than a line in a prompt.
   */
  assistantDir: string;
  /**
   * The assistant's instructions, linked into the store by `npm run init` as the
   * morning prompt is. Unlike that one, the server does open this: it is the
   * server that starts the assistant, so it is the server that hands over the
   * text. `assistantPromptSource` is the copy in this repo it falls back to before
   * init has run.
   */
  assistantPromptFile: string;
  assistantPromptSource: string;
  /** The morning agent, when the dashboard starts it by hand. */
  agent: AgentRunConfig;
  /** Append-only record of every run the dashboard started, written by the server. */
  agentLogFile: string;
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

/** An on/off switch; unset or empty means `fallback`. */
function envFlag(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const flag = (env[name] ?? '').trim().toLowerCase();
  if (flag === '') return fallback;
  return !['off', 'false', '0', 'no'].includes(flag);
}

function envGitHub(env: NodeJS.ProcessEnv): GitHubConfig {
  const pollMinutes = envInt('DAILY_FOCUS_GITHUB_POLL_MINUTES', 5, env);
  if (pollMinutes < 1) {
    throw new Error(`DAILY_FOCUS_GITHUB_POLL_MINUTES must be at least 1, got ${pollMinutes}`);
  }
  return {
    enabled: envFlag('DAILY_FOCUS_GITHUB', true, env),
    accounts: envList('DAILY_FOCUS_GITHUB_ACCOUNTS', env),
    scope: parseScope(envList('DAILY_FOCUS_GITHUB_SCOPE', env)),
    mergeGateChecks: envNameList('DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS', env),
    pollMinutes,
    ghPath: expandHome((env.DAILY_FOCUS_GH ?? '').trim() || 'gh'),
  };
}

function envCalendar(env: NodeJS.ProcessEnv): CalendarConfig {
  const pollMinutes = envInt('DAILY_FOCUS_CALENDAR_POLL_MINUTES', 5, env);
  if (pollMinutes < 1) {
    throw new Error(`DAILY_FOCUS_CALENDAR_POLL_MINUTES must be at least 1, got ${pollMinutes}`);
  }
  return {
    enabled: envFlag('DAILY_FOCUS_CALENDAR', true, env),
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

function envJira(env: NodeJS.ProcessEnv, profile: Profile): JiraConfig {
  // Fifteen rather than the boards' five: status hygiene is never urgent, and
  // three searches a poll is a cost worth paying three times less often.
  const pollMinutes = envInt('DAILY_FOCUS_JIRA_POLL_MINUTES', 15, env);
  if (pollMinutes < 1) {
    throw new Error(`DAILY_FOCUS_JIRA_POLL_MINUTES must be at least 1, got ${pollMinutes}`);
  }
  return {
    enabled: envFlag('DAILY_FOCUS_JIRA', profile === 'work', env),
    projects: envList('DAILY_FOCUS_JIRA_PROJECTS', env),
    // Commas only, as for merge gate checks and calendars: status names contain
    // spaces almost by default — "In Review", "Waiting for customer".
    holdStatuses: envNameList('DAILY_FOCUS_JIRA_HOLD_STATUSES', env),
    inProgressStatuses: envNameList('DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES', env),
    pollMinutes,
    // Tolerates a pasted URL, since that is what is on screen when someone goes
    // looking for their site's name.
    site: envString('DAILY_FOCUS_JIRA_SITE', '', env).replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null,
    acliPath: expandHome((env.DAILY_FOCUS_ACLI ?? '').trim() || 'acli'),
  };
}

/**
 * `off`, or one of the CLIs. Anything else throws: read as off, a typo would
 * quietly remove the assistant and nothing would say why.
 */
function envCli(name: string, env: NodeJS.ProcessEnv): CliName | null {
  const raw = envString(name, 'off', env).toLowerCase();
  if (['off', 'false', '0', 'no', 'none'].includes(raw)) return null;
  if (!(CLI_NAMES as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be off or one of ${CLI_NAMES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return raw as CliName;
}

function envAssistant(env: NodeJS.ProcessEnv): AssistantConfig {
  const agent = envCli('DAILY_FOCUS_ASSISTANT', env);
  // Commas only: a Claude Code permission rule has a space in it, `Bash(gh *)`.
  const tools = envNameList('DAILY_FOCUS_ASSISTANT_TOOLS', env);
  return {
    agent,
    binPath: expandHome((env.DAILY_FOCUS_ASSISTANT_BIN ?? '').trim() || (agent ?? 'claude')),
    model: envString('DAILY_FOCUS_ASSISTANT_MODEL', '', env) || null,
    effort: envString('DAILY_FOCUS_ASSISTANT_EFFORT', '', env) || null,
    tools: tools.length > 0 ? tools : DEFAULT_ASSISTANT_TOOLS,
  };
}

/**
 * What the assistant may reach for when nobody is there to answer a prompt: the
 * GitHub and Atlassian CLIs, read and write alike since a comment is something
 * the user asked for in so many words, and the Gmail connector for drafts.
 */
export const DEFAULT_ASSISTANT_TOOLS: readonly string[] = ['Bash(gh *)', 'Bash(acli *)', 'WebFetch', 'mcp__claude_ai_Gmail'];

/**
 * What the morning agent may reach its sources with under Claude Code, unless
 * `DAILY_FOCUS_AGENT_TOOLS` says otherwise: the two CLIs, fetching a page, and
 * Gmail. Its other sources — calendar, chat, documents — are whichever
 * connectors the user has, under names only they know, so they are added by
 * setting the list.
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ['Bash(gh *)', 'Bash(acli *)', 'WebFetch', 'mcp__claude_ai_Gmail'];

/**
 * What the morning agent may always do, whatever the list says, since a brief
 * can't be written without it: write `items.json` by way of a temporary sibling
 * and a rename, and nothing else in the store. The prompt and schema are
 * symlinks out of the store into this repo, so reading them is allowed where
 * they actually live as well.
 */
export function briefWritingTools(): string[] {
  const repo = resolve(import.meta.dirname, '..');
  return [
    // `//` anchors a rule at the filesystem root; the path supplies one slash.
    `Read(/${repo}/prompts/**)`,
    `Read(/${repo}/schema/**)`,
    'Write(./items.json)',
    'Write(./items.json.*)',
    'Edit(./items.json.*)',
    'Bash(mv items.json.* items.json)',
  ];
}

/** When the dashboard starts the agent unless told otherwise. */
export const DEFAULT_AGENT_AT: TimeOfDay = { hour: 7, minute: 0 };

function envAgent(env: NodeJS.ProcessEnv): AgentRunConfig {
  const cli = envCli('DAILY_FOCUS_AGENT', env);
  const at = envTimeOfDay('DAILY_FOCUS_AGENT_AT', env);
  // A time set by hand with no CLI would be a schedule that never fires, and
  // nothing on screen would say so. Refuse it at startup instead.
  if (at && !cli && envString('DAILY_FOCUS_AGENT_AT', '', env) !== '') {
    throw new Error('DAILY_FOCUS_AGENT_AT needs DAILY_FOCUS_AGENT set to codex or claude');
  }
  // Commas only, for the reason the assistant's list gives.
  const tools = envNameList('DAILY_FOCUS_AGENT_TOOLS', env);
  return {
    cli,
    at: cli ? at : null,
    binPath: expandHome((env.DAILY_FOCUS_AGENT_BIN ?? '').trim() || (cli ?? 'codex')),
    model: envString('DAILY_FOCUS_AGENT_MODEL', '', env) || null,
    effort: envString('DAILY_FOCUS_AGENT_EFFORT', '', env) || null,
    tools: tools.length > 0 ? tools : DEFAULT_AGENT_TOOLS,
  };
}

/** `06:30`, `6:30` or `18:00`, local time. Unset is 07:00; `off` means no clock of the dashboard's own. */
function envTimeOfDay(name: string, env: NodeJS.ProcessEnv): TimeOfDay | null {
  const raw = envString(name, '', env).toLowerCase();
  if (raw === '') return DEFAULT_AGENT_AT;
  if (['off', 'false', '0', 'no', 'none', 'never'].includes(raw)) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) throw new Error(`${name} must be a 24-hour time such as 06:30, or off, got ${JSON.stringify(raw)}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
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

/** An unknown profile throws: read as `work`, it would quietly poll work accounts. */
function envProfile(env: NodeJS.ProcessEnv): Profile {
  const raw = envString('DAILY_FOCUS_PROFILE', 'work', env).toLowerCase();
  if (!(PROFILES as readonly string[]).includes(raw)) {
    throw new Error(`DAILY_FOCUS_PROFILE must be one of ${PROFILES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return raw as Profile;
}

/**
 * Build the config. With no argument it reads the real environment layered over
 * the repo's `.env`; tests pass an explicit object and never touch the file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = loadEnv()): Config {
  const dataDir = expandHome(envString('DAILY_FOCUS_DATA', '~/.daily-focus', env));
  const profile = envProfile(env);
  return {
    profile,
    dataDir,
    itemsFile: resolve(dataDir, 'items.json'),
    actionsFile: resolve(dataDir, 'actions.jsonl'),
    focusFile: resolve(dataDir, 'focus.md'),
    sourcesFile: resolve(dataDir, 'sources.md'),
    promptFile: resolve(dataDir, 'prompt.md'),
    promptSource: resolve(import.meta.dirname, '..', 'prompts', `morning-brief-${profile}.md`),
    schemaFile: resolve(dataDir, 'items.schema.json'),
    archiveDir: resolve(dataDir, 'archive'),
    sessionFile: resolve(dataDir, 'session.json'),
    sessionsLogFile: resolve(dataDir, 'sessions.jsonl'),
    pullsFile: resolve(dataDir, 'prs.json'),
    calendarFile: resolve(dataDir, 'calendar.json'),
    ticketsFile: resolve(dataDir, 'tickets.json'),
    sessionMinutes: envInt('DAILY_FOCUS_SESSION_MINUTES', 25, env),
    awayAfterMinutes: envInt('DAILY_FOCUS_AWAY_AFTER', profile === 'personal' ? 0 : 10, env),
    port: envInt('DAILY_FOCUS_PORT', 4321, env),
    host: envString('DAILY_FOCUS_HOST', '127.0.0.1', env),
    freeWindows: envFlag('DAILY_FOCUS_FREE_WINDOWS', profile !== 'personal', env),
    workStartHour: envInt('DAILY_FOCUS_WORK_START', 9, env),
    workEndHour: envInt('DAILY_FOCUS_WORK_END', 17, env),
    minFreeWindowMinutes: envInt('DAILY_FOCUS_MIN_FREE_WINDOW', 45, env),
    staleAfterHours: envInt('DAILY_FOCUS_STALE_AFTER_HOURS', 24, env),
    agentDays: envWeekdays('DAILY_FOCUS_AGENT_DAYS', env),
    github: envGitHub(env),
    calendar: envCalendar(env),
    jira: envJira(env, profile),
    assistant: envAssistant(env),
    assistantLogFile: resolve(dataDir, 'assistant.jsonl'),
    assistantDir: resolve(dataDir, 'assistant'),
    assistantPromptFile: resolve(dataDir, 'assistant.md'),
    assistantPromptSource: resolve(import.meta.dirname, '..', 'prompts', 'assistant.md'),
    agent: envAgent(env),
    agentLogFile: resolve(dataDir, 'agent.jsonl'),
  };
}
