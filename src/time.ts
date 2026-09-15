/**
 * Date helpers. Everything user-facing is in the server's local timezone, which is
 * the same machine the user reads the dashboard on.
 */

const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD in local time. Not toISOString(), which would shift across midnight in UTC-negative zones. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a bare "YYYY-MM-DD", which the agent uses for all-day events and due dates. */
export function isDateOnly(value: unknown): boolean {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

/**
 * Parse an ISO 8601 string, returning null rather than an Invalid Date.
 *
 * A bare "YYYY-MM-DD" is parsed as *local* midnight. `new Date("2026-09-10")` would
 * give UTC midnight, which lands on the previous day for anyone west of Greenwich —
 * so a due date would silently show as overdue.
 */
export function parseISO(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Local midnight at the start of the day containing `d`. */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Whole days from `from` to `to`, counted in local calendar days so that
 * 23:00 yesterday to 01:00 today is 1 day, not 0.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = startOfLocalDay(from).getTime();
  const b = startOfLocalDay(to).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

/** True when `d` falls on the same local calendar day as `reference`. */
export function isSameLocalDay(d: Date, reference: Date): boolean {
  return localDateKey(d) === localDateKey(reference);
}

/**
 * Which days count as working days.
 *
 * Mon–Fri is only the fallback, not a fact: a Sun–Thu working week is normal in
 * Israel and much of the Gulf, so both functions below take the test as an argument
 * and `schedule.ts` supplies the real answer. Everything that hardcoded a weekend
 * goes through here.
 */
export type DayTest = (d: Date) => boolean;

/** True Mon–Fri in local time. The default, for when nothing better is known. */
export function isWorkingDay(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/**
 * Working days elapsed since `from`.
 *
 * The day of `from` itself doesn't count, so finishing something today reads as 0.
 * Non-working days are excluded deliberately: this number exists to show neglect,
 * and a counter that ticks over a weekend would be measuring the calendar, not the
 * work.
 */
export function workingDaysSince(from: Date, to: Date, counts: DayTest = isWorkingDay): number {
  const cursor = startOfLocalDay(from);
  const end = startOfLocalDay(to);
  let count = 0;

  while (cursor.getTime() < end.getTime()) {
    cursor.setDate(cursor.getDate() + 1);
    if (counts(cursor)) count++;
  }
  return count;
}

/**
 * Elapsed milliseconds from `from` to `to`, counting only the hours that fall on a
 * counted day. The weekend — whichever days that is — contributes nothing.
 *
 * This is the clock to measure a weekday schedule against: it keeps "a day has
 * passed without a run" meaning a day the run was actually due.
 *
 * It walks local calendar days rather than dividing the span, so a DST change
 * inside it can't shift a day boundary by an hour.
 */
export function workingMsBetween(from: Date, to: Date, counts: DayTest = isWorkingDay): number {
  if (to.getTime() <= from.getTime()) return 0;

  let cursor = from;
  let total = 0;

  while (cursor.getTime() < to.getTime()) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const sliceEnd = Math.min(nextMidnight.getTime(), to.getTime());
    if (counts(cursor)) total += sliceEnd - cursor.getTime();
    cursor = new Date(sliceEnd);
  }
  return total;
}

/**
 * The later of two ISO 8601 timestamps, tolerating either being absent.
 *
 * Plain string comparison is exact for timestamps in the same zone and format,
 * which is what GitHub returns; the fallbacks are what make it usable on fields
 * that may not be there at all.
 */
export function laterISO(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!b) return a ?? null;
  if (!a) return b;
  return b > a ? b : a;
}
