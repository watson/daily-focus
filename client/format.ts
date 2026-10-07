/** Formatting helpers shared by the renderers. No DOM, no fetching. */

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const shortDayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const shortDayYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

export type DateLike = string | null | undefined;

export function parseDate(value: DateLike): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  // A bare date is local midnight, matching the server's parsing.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new Date(+dateOnly[1]!, +dateOnly[2]! - 1, +dateOnly[3]!);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTime(value: DateLike): string {
  const d = parseDate(value);
  return d ? timeFmt.format(d) : '';
}

export function formatDay(value: DateLike): string {
  const d = parseDate(value);
  return d ? dayFmt.format(d) : '';
}

export function formatShortDay(value: DateLike): string {
  const d = parseDate(value);
  return d ? shortDayFmt.format(d) : '';
}

/** "Friday". */
export function formatWeekday(value: DateLike): string {
  const d = parseDate(value);
  return d ? weekdayFmt.format(d) : '';
}

/**
 * The calendar days are counted on: the server's.
 *
 * The server decides when a snooze has arrived, what is overdue and which day the
 * brief is for, all by its own zone, and the browser can be in another one,
 * reaching the dashboard from abroad. A snooze worked out on the browser's
 * calendar and judged on the server's comes straight back: "Tomorrow" in New York
 * after six in the evening is already today in Copenhagen. So `dayKey` and the
 * bare dates `daysFromToday` compares count in this zone. Times of day stay in the
 * browser's, where the reader is. Unset, as in a test that doesn't care, it is
 * the browser's own.
 */
let dayKeyFmt: Intl.DateTimeFormat | null = null;
let calendarZone: string | undefined;

/** Count days in `timeZone` from now on: the zone the server sends in its state. */
export function setCalendarZone(timeZone: string | undefined): void {
  if (timeZone === calendarZone) return;
  calendarZone = timeZone;
  try {
    dayKeyFmt = timeZone
      ? new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      : null;
  } catch {
    // A zone this browser doesn't know: its own calendar is the nearest guess.
    dayKeyFmt = null;
  }
}

/** The day `d` falls on, on the server's calendar, as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  if (dayKeyFmt) {
    const parts = dayKeyFmt.formatToParts(d);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Day arithmetic on YYYY-MM-DD keys, done in UTC, which has no daylight saving
 * to step around. The keys name days on the server's calendar; UTC only counts.
 */
function splitKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y!, m! - 1, d!];
}

function keyAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `days` after the one `key` names. */
export function addDays(key: string, days: number): string {
  const [y, m, d] = splitKey(key);
  return keyAt(Date.UTC(y, m, d + days));
}

/**
 * The same day some months ahead, clamped to the end of a short month.
 *
 * The clamp is the whole reason this isn't a one-liner: `Date.UTC(y, m + 1, 31)`
 * for the 31st of January is the 3rd of March, because the day overflows February
 * and rolls on. A park set from the last day of a long month would quietly land
 * days into the month after the one it named.
 */
export function addMonths(key: string, months: number): string {
  const [y, m, d] = splitKey(key);
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return keyAt(Date.UTC(y, m + months, Math.min(d, lastDay)));
}

/**
 * Whole calendar days from today to `value`. Negative means the past.
 *
 * A bare date (a due date, a snooze) names a day on the server's calendar, the
 * one it is judged on, so it is counted from the server's today. A timestamp is
 * shown with its time of day in the browser's zone, and its day is counted there
 * too: a run at 01:00 where you are happened "today at 01:00", whatever the date
 * is at home.
 */
export function daysFromToday(value: DateLike, now = new Date()): number | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = splitKey(value);
    const [ty, tm, td] = splitKey(dayKey(now));
    return Math.round((Date.UTC(y, m, d) - Date.UTC(ty, tm, td)) / 86_400_000);
  }
  const target = parseDate(value);
  if (!target) return null;
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** "Today" / "Tomorrow" / "3 days ago" / a short date. */
export function relativeDay(value: DateLike, now = new Date()): string {
  const diff = daysFromToday(value, now);
  if (diff === null) return '';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff <= 7) return `in ${diff} days`;
  if (diff < -1 && diff >= -7) return `${Math.abs(diff)} days ago`;
  return formatShortDay(value);
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/**
 * "just now" / "12 min ago" / "5 h ago" / "3 days ago" / a short date.
 *
 * Hour granularity under two days, because on the pull request board the
 * difference between a review that landed an hour ago and one from this morning
 * is the difference between "they're on it" and "ask".
 */
export function relativeTime(value: DateLike, now = new Date()): string {
  const d = parseDate(value);
  if (!d) return '';
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} days ago`;
  // Past a month the date itself reads better than "247 days ago", and once it's
  // in another year the year has to be on it: "Jan 14" is ambiguous on a PR that
  // has been open since the one before last.
  return d.getFullYear() === now.getFullYear() ? formatShortDay(value) : shortDayYearFmt.format(d);
}

/** The first non-empty line, without the Markdown that would read as noise in one. */
export function firstLine(text: unknown): string {
  const line = String(text).split('\n').find((l) => l.trim() !== '') ?? '';
  return line.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim();
}
