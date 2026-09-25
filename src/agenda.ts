import type { Agenda, FreeWindow, ResolvedItem } from './types.ts';
import { isDateOnly, isSameLocalDay, parseISO } from './time.ts';

/** Assumed length of an event the agent gave a start but no end. */
const DEFAULT_EVENT_MINUTES = 30;
const MS_PER_MINUTE = 60_000;

interface Interval {
  start: number;
  end: number;
}

/**
 * An event's occupied span, or null when it belongs on the agenda without eating
 * the day's free windows.
 *
 * Two cases return null. All-day events (a bare YYYY-MM-DD start), or a public
 * holiday would blank out every focus block. And events explicitly marked
 * `blocking: false` — a delivery window is a thing to know about, not a thing
 * that stops you working.
 */
function busySpan(item: ResolvedItem): Interval | null {
  if (isDateOnly(item.start)) return null;
  if (item.blocking === false) return null;

  const start = parseISO(item.start);
  if (!start) return null;

  const parsedEnd = parseISO(item.end);
  const end =
    parsedEnd && parsedEnd.getTime() > start.getTime()
      ? parsedEnd
      : new Date(start.getTime() + DEFAULT_EVENT_MINUTES * MS_PER_MINUTE);

  return { start: start.getTime(), end: end.getTime() };
}

/** Merge overlapping/touching intervals into a minimal set, ascending. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const next of sorted) {
    const last = merged[merged.length - 1];
    if (last && next.start <= last.end) {
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

export interface AgendaOptions {
  /** Off means events only: no free windows, no focus time, no day bounds in play. */
  freeWindows: boolean;
  workStartHour: number;
  workEndHour: number;
  minFreeWindowMinutes: number;
  /** Local "HH:MM" from the brief, overriding the configured defaults for today. */
  dayStart?: string | undefined;
  dayEnd?: string | undefined;
}

/** Resolve an "HH:MM" override against a fallback hour, on the day of `now`. */
function dayBoundary(now: Date, clock: string | undefined, fallbackHour: number): Date {
  const parsed = clock ? /^(\d{1,2}):(\d{2})$/.exec(clock) : null;
  const hour = parsed ? Number(parsed[1]) : fallbackHour;
  const minute = parsed ? Number(parsed[2]) : 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

function clockString(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Build today's schedule from the brief's events: what's on, what collides, and
 * which gaps are long enough to defend as focus time.
 */
export function buildAgenda(items: ResolvedItem[], now: Date, opts: AgendaOptions): Agenda {
  const events = items
    .filter((item) => item.kind === 'event' && item.status !== 'dismissed')
    .filter((item) => {
      const start = parseISO(item.start);
      return start !== null && isSameLocalDay(start, now);
    })
    .sort((a, b) => {
      // All-day events float to the top; timed events run in clock order.
      const aAllDay = isDateOnly(a.start);
      const bAllDay = isDateOnly(b.start);
      if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;
      const at = parseISO(a.start)?.getTime() ?? 0;
      const bt = parseISO(b.start)?.getTime() ?? 0;
      return at - bt;
    });

  const spans = new Map<string, Interval>();
  for (const event of events) {
    const span = busySpan(event);
    if (span) spans.set(event.id, span);
  }

  // Pairwise overlap. The agenda is a single day, so n is small enough that the
  // quadratic scan is cheaper than the bookkeeping to avoid it.
  const conflictIds = new Set<string>();
  const entries = [...spans.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i]!;
      const [idB, b] = entries[j]!;
      if (a.start < b.end && b.start < a.end) {
        conflictIds.add(idA);
        conflictIds.add(idB);
      }
    }
  }

  const dayStart = dayBoundary(now, opts.dayStart, opts.workStartHour);
  const dayEnd = dayBoundary(now, opts.dayEnd, opts.workEndHour);

  const busy = mergeIntervals(
    [...spans.values()]
      .map((span) => ({
        start: Math.max(span.start, dayStart.getTime()),
        end: Math.min(span.end, dayEnd.getTime()),
      }))
      .filter((span) => span.end > span.start),
  );

  // With free windows off the bounds are still reported, so the header can say what
  // it would have used, but nothing is measured against them.
  const freeWindows: FreeWindow[] = [];
  let cursor = dayStart.getTime();
  const stops = opts.freeWindows ? [...busy, { start: dayEnd.getTime(), end: dayEnd.getTime() }] : [];
  for (const span of stops) {
    const minutes = Math.round((span.start - cursor) / MS_PER_MINUTE);
    if (minutes >= opts.minFreeWindowMinutes) {
      freeWindows.push({
        start: new Date(cursor).toISOString(),
        end: new Date(span.start).toISOString(),
        minutes,
      });
    }
    cursor = Math.max(cursor, span.end);
  }

  // What's genuinely left, counted from now rather than from the start of the day —
  // a window you're already halfway through only offers the half that remains.
  let remainingFocusMinutes = 0;
  for (const window of freeWindows) {
    const start = Math.max(new Date(window.start).getTime(), now.getTime());
    const end = new Date(window.end).getTime();
    if (end > start) remainingFocusMinutes += Math.round((end - start) / MS_PER_MINUTE);
  }

  return {
    events,
    conflictIds: [...conflictIds],
    tracksFreeTime: opts.freeWindows,
    freeWindows,
    remainingFocusMinutes,
    dayStart: clockString(dayStart),
    dayEnd: clockString(dayEnd),
  };
}
