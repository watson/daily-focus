import type { Config } from './config.ts';
import { listArchivedDates } from './archive.ts';
import { calendarDaysBetween, localDateKey, parseISO, startOfLocalDay } from './time.ts';

/**
 * Which weekdays the morning brief is expected on.
 *
 * The dashboard has to know this to say anything honest about an old brief: a file
 * from Friday read on Sunday is only "stale" if a run was ever due in between. The
 * obvious answer — Mon–Fri — is a guess about the reader's calendar, and it is wrong
 * for anyone on a Sun–Thu week, which is most of Israel and much of the Gulf.
 *
 * So the question is answered in this order, most trustworthy first:
 *
 *  1. `DAILY_FOCUS_AGENT_DAYS`, which mirrors the scheduled task's own day spec.
 *     Nothing else can be more accurate, because that *is* the schedule.
 *  2. The archive. Every brief is snapshotted under its date, so the days a brief
 *     has actually landed on are on disk — the same reasoning the action log gets:
 *     the record of what happened beats an inference about what should.
 *  3. Mon–Fri, as the default that has to exist for the first three weeks.
 *
 * Deliberately *not* used: `Intl.Locale.getWeekInfo()`, which does know that `he-IL`
 * has a Fri–Sat weekend. It answers a different question — what the region's weekend
 * is, not what this machine's crontab does — and it needs a locale we can't source
 * reliably: on the author's Mac, Node resolves `en-US` while the OS region is set
 * to a different country entirely. A guess dressed as knowledge is worse here.
 */

/** 0 = Sunday … 6 = Saturday, matching `Date.getDay()` and cron's day-of-week. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const MONDAY_TO_FRIDAY: readonly Weekday[] = [1, 2, 3, 4, 5];

export interface Schedule {
  /** The weekdays a run is due on, ascending. */
  days: readonly Weekday[];
  /** Where that came from, so `npm run audit` can show its working. */
  source: 'config' | 'observed' | 'default';
}

/** How far back to look for evidence of the schedule. */
const WINDOW_DAYS = 28;

/**
 * Days of history needed before absence means anything.
 *
 * Three weeks, so every weekday has had three chances to appear and a single
 * hand-run brief on a Saturday can't outvote the two Saturdays either side of it.
 */
const MIN_HISTORY_DAYS = 21;

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
 * Numbered like cron and like `Date.getDay()` — 0 is Sunday — so the value can be
 * copied straight out of the crontab line that runs the agent. Descending ranges are
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

/**
 * Work out the schedule for `now`: config if set, else what the archive shows, else
 * Mon–Fri.
 */
export async function resolveSchedule(config: Config, now: Date = new Date()): Promise<Schedule> {
  if (config.agentDays) return { days: config.agentDays, source: 'config' };

  const observed = await observeSchedule(config, now);
  return observed ? { days: observed, source: 'observed' } : { days: MONDAY_TO_FRIDAY, source: 'default' };
}

/**
 * Infer the schedule from the days briefs have actually landed on.
 *
 * A weekday is counted in when a brief arrived on *most* of its occurrences in the
 * window. Both halves of that matter:
 *
 *   - a majority, not any sighting, so one brief generated by hand on a Sunday
 *     doesn't make Sundays look scheduled — and the evidence expires as the window
 *     moves on;
 *   - a majority, not all, so a week off doesn't make Monday look unscheduled.
 *
 * Today is excluded from both counts: this morning's run may still be pending, and a
 * day that hasn't finished is not evidence of anything.
 *
 * Returns null until there's enough history to be worth trusting, and if the answer
 * comes out empty — a store that's barely been used — which is the caller's cue to
 * fall back rather than believe a schedule of no days at all.
 */
async function observeSchedule(config: Config, now: Date): Promise<Weekday[] | null> {
  const dates = await listArchivedDates(config);
  if (dates.length === 0) return null;

  const seen = new Array(7).fill(0) as number[];
  const chances = new Array(7).fill(0) as number[];

  // Yesterday back to the window's edge, or to the oldest snapshot we hold.
  const oldest = parseISO(dates[0]!);
  if (!oldest) return null;
  const span = Math.min(WINDOW_DAYS, calendarDaysBetween(oldest, now));
  if (span < MIN_HISTORY_DAYS) return null;

  const archived = new Set(dates);
  const cursor = startOfLocalDay(now);
  for (let i = 0; i < span; i++) {
    cursor.setDate(cursor.getDate() - 1);
    const day = cursor.getDay();
    chances[day]!++;
    if (archived.has(localDateKey(cursor))) seen[day]!++;
  }

  const days: Weekday[] = [];
  for (let day = 0; day < 7; day++) {
    if (chances[day]! > 0 && seen[day]! * 2 >= chances[day]!) days.push(day as Weekday);
  }
  return days.length > 0 ? days : null;
}
