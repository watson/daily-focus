import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { parseWeekdays, type Weekday } from './schedule.ts';

/**
 * All configuration is environment-driven so the agent and the dashboard can be
 * pointed at the same store without either one hardcoding a path.
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
  /** Working hours after which the brief is flagged as stale in the UI. */
  staleAfterHours: number;
  /**
   * Weekdays the briefing agent is scheduled on, 0 = Sunday. Null when it hasn't
   * been said, which leaves `schedule.ts` to work it out from the archive.
   */
  agentDays: readonly Weekday[] | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
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

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = expandHome(env.DAILY_FOCUS_DATA ?? '~/.daily-focus');
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
    sessionMinutes: envInt('DAILY_FOCUS_SESSION_MINUTES', 25),
    awayAfterMinutes: envInt('DAILY_FOCUS_AWAY_AFTER', 10),
    port: envInt('DAILY_FOCUS_PORT', 4321),
    host: env.DAILY_FOCUS_HOST ?? '127.0.0.1',
    workStartHour: envInt('DAILY_FOCUS_WORK_START', 9),
    workEndHour: envInt('DAILY_FOCUS_WORK_END', 17),
    minFreeWindowMinutes: envInt('DAILY_FOCUS_MIN_FREE_WINDOW', 45),
    staleAfterHours: envInt('DAILY_FOCUS_STALE_AFTER_HOURS', 24),
    agentDays: envWeekdays('DAILY_FOCUS_AGENT_DAYS', env),
  };
}
