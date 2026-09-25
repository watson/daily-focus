import type { Config, TimeOfDay } from './config.ts';
import { isSameLocalDay, localDateKey, parseISO, startOfLocalDay } from './time.ts';

/**
 * Which weekdays the morning brief is expected on.
 *
 * The dashboard has to know this to say anything honest about an old brief: a file
 * from Friday read on Sunday is only "stale" if a run was ever due in between. The
 * obvious answer — Mon–Fri — is a guess about the reader's calendar, and it is wrong
 * for anyone on a Sun–Thu week, which is most of Israel and much of the Gulf.
 *
 * So it is `DAILY_FOCUS_AGENT_DAYS` when set, and Mon–Fri otherwise. Those are the
 * days the dashboard's own clock starts the agent on, and nothing else starts it,
 * so there is nothing to infer from the archive: the days briefs have landed on are
 * this dashboard's own runs, and reading a schedule off them would let a few hand
 * runs on a Saturday talk it into scheduling Saturdays.
 *
 * Deliberately *not* used: `Intl.Locale.getWeekInfo()`, which does know that `he-IL`
 * has a Fri–Sat weekend. It answers a different question — what the region's weekend
 * is, not what this machine's crontab does — and it needs a locale we can't source
 * reliably: on the author's Mac, Node resolves `en-US` while the OS region is set
 * to a different country entirely. A guess dressed as knowledge is worse here.
 */

/** 0 = Sunday … 6 = Saturday, matching `Date.getDay()` and cron's day-of-week. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Allow time for source gathering and publication after a refresh is expected.
export const BRIEF_REFRESH_GRACE_HOURS = 45 / 60;

export const MONDAY_TO_FRIDAY: readonly Weekday[] = [1, 2, 3, 4, 5];

export interface Schedule {
  /** The weekdays a run is due on, ascending. */
  days: readonly Weekday[];
  /** Where that came from, so `npm run audit` can show its working. */
  source: 'config' | 'default';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** True when a run was due on `date`. */
export function runsOn(schedule: Schedule, date: Date): boolean {
  return schedule.days.includes(date.getDay() as Weekday);
}

/** The next local date, after `from`, that a run is due on. Null if nothing ever is. */
export function nextRunDate(schedule: Schedule, from: Date): string | null {
  const cursor = startOfLocalDay(from);
  for (let i = 0; i < 7; i++) {
    cursor.setDate(cursor.getDate() + 1);
    if (runsOn(schedule, cursor)) return localDateKey(cursor);
  }
  return null;
}

/** "Mon–Fri" / "Sun, Tue, Thu" — for the audit output, not the browser. */
export function describeSchedule(schedule: Schedule): string {
  const days = schedule.days;
  if (days.length === 0) return 'never';
  const contiguous = days.every((day, i) => i === 0 || day === days[i - 1]! + 1);
  return contiguous && days.length > 2
    ? `${DAY_NAMES[days[0]!]}–${DAY_NAMES[days[days.length - 1]!]}`
    : days.map((day) => DAY_NAMES[day]).join(', ');
}

/**
 * Parse a cron-style day-of-week spec: `1-5`, `0-4`, `1,3,5`, `0,6`.
 *
 * Numbered like cron and like `Date.getDay()` — 0 is Sunday — so anyone who has
 * written a crontab already knows the numbering. Descending ranges are
 * rejected rather than wrapped, because `6-0` is as likely to be a typo as a
 * weekend, and `6,0` says it without ambiguity.
 */
export function parseWeekdays(spec: string): Weekday[] {
  const days = new Set<Weekday>();

  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;

    const range = /^([0-6])\s*-\s*([0-6])$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        throw new Error(`day range "${piece}" runs backwards; write it as a list, e.g. "6,0"`);
      }
      for (let day = from; day <= to; day++) days.add(day as Weekday);
      continue;
    }

    if (!/^[0-6]$/.test(piece)) {
      throw new Error(`"${piece}" is not a weekday; use 0–6 where 0 is Sunday, e.g. "1-5"`);
    }
    days.add(Number(piece) as Weekday);
  }

  if (days.size === 0) throw new Error('no weekdays given');
  return [...days].sort((a, b) => a - b);
}

/** The schedule: `DAILY_FOCUS_AGENT_DAYS` if set, else Mon–Fri. */
export function resolveSchedule(config: Config): Schedule {
  if (config.agentDays) return { days: config.agentDays, source: 'config' };
  return { days: MONDAY_TO_FRIDAY, source: 'default' };
}

/* ---------- the dashboard's own clock ---------- */

/** `at` on the same local day as `date`. */
export function atTimeOn(date: Date, at: TimeOfDay): Date {
  const when = startOfLocalDay(date);
  when.setHours(at.hour, at.minute, 0, 0);
  return when;
}

/** "06:30", for the client. */
export function describeTime(at: TimeOfDay): string {
  return `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
}

export interface RunDueInput {
  at: TimeOfDay;
  schedule: Schedule;
  /** When the newest run started, by clock or by hand, whatever became of it. */
  lastRunStartedAt: string | null;
  now: Date;
}

/**
 * Whether the dashboard should start the agent now.
 *
 * Once a day, at `at` or as soon after it as the dashboard is running — the
 * machine was asleep, the tab was closed, the laptop was opened at nine — on a
 * scheduled day. A run started today, by clock or by hand, is today's run
 * whatever became of it: one that failed counts too, so a CLI that is broken
 * today is tried once, and reported once, rather than every half minute until
 * it is fixed.
 */
export function scheduledRunDue({ at, schedule, lastRunStartedAt, now }: RunDueInput): boolean {
  if (!runsOn(schedule, now)) return false;
  if (now.getTime() < atTimeOn(now, at).getTime()) return false;
  return !ranToday(lastRunStartedAt, now);
}

/** The next moment the dashboard will start the agent, for saying so. Null if never. */
export function nextScheduledRun({ at, schedule, lastRunStartedAt, now }: RunDueInput): Date | null {
  const today = atTimeOn(now, at);
  if (runsOn(schedule, now) && now.getTime() < today.getTime() && !ranToday(lastRunStartedAt, now)) {
    return today;
  }
  const next = nextRunDate(schedule, now);
  if (!next) return null;
  const date = parseISO(next);
  return date ? atTimeOn(date, at) : null;
}

function ranToday(lastRunStartedAt: string | null, now: Date): boolean {
  const when = parseISO(lastRunStartedAt);
  return when !== null && isSameLocalDay(when, now);
}
