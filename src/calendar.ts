/**
 * `calendar.json` — today's events as Calendar.app has them.
 *
 * The second thing in this repo that gathers rather than reads (see `github.ts`),
 * and for the same reason: an agenda is state, not judgement. The brief is written
 * once at dawn, so a meeting declined at eleven leaves a gap the dashboard cannot
 * see, and the focus time it offers is time you do not have.
 *
 * Everything here is pure except `runHelper`. The helper is a `.app` bundle
 * launched with `open`, which is not a style choice — see `tools/dfcal/build.sh`
 * for why a plain binary is refused. `open` returns as soon as the app is launched
 * and gives us no exit code and no stdout, so the contract is a file: the helper
 * always writes one, including on refusal, and a missing file means it died.
 */

import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Item } from './types.ts';

const run = promisify(execFile);

/** How long to wait for the helper's output file before calling it dead. */
const HELPER_TIMEOUT_MS = 20_000;
const POLL_MS = 150;

/** EKParticipantStatus.declined. The only response we act on. */
const DECLINED = 3;
/** EKEventAvailability.free — the only value that frees the slot. See `blocking`. */
const AVAILABILITY_FREE = 1;

/** One event as the helper reports it. Everything is optional; it is parsed, not trusted. */
export interface RawCalendarEvent {
  externalId?: unknown;
  calendarId?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  allDay?: unknown;
  availability?: unknown;
  selfStatus?: unknown;
  url?: unknown;
}

export interface RawCalendar {
  id?: unknown;
  title?: unknown;
  source?: unknown;
}

/** The helper's whole payload, or the refusal it writes instead. */
export interface CalendarFacts {
  generatedAt: string;
  calendars: { id: string; title: string; source: string }[];
  events: RawCalendarEvent[];
}

export interface CalendarSelection {
  events: Item[];
  /** Configured names that matched no calendar at all. */
  unmatched: string[];
  /** How many calendars the configured names resolved to, duplicates included. */
  matched: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Local `YYYY-MM-DD`, which is how `agenda.ts` recognises an all-day event. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A stable id for one occurrence.
 *
 * `calendarItemExternalIdentifier` is shared by every occurrence of a recurring
 * event — Apple's documentation says so outright and says to disambiguate by start
 * — so the id has to carry the start as well or a weekly standup would be one item
 * for all time. The stamp is local and offset-free so the same occurrence spells
 * the same way whatever the formatter does.
 */
function eventId(externalId: string, start: Date, allDay: boolean): string {
  if (allDay) return `calendar:event:${externalId}:${localDate(start)}`;
  const stamp =
    `${localDate(start).replace(/-/g, '')}T` +
    `${String(start.getHours()).padStart(2, '0')}${String(start.getMinutes()).padStart(2, '0')}`;
  return `calendar:event:${externalId}:${stamp}`;
}

/** Parse whatever is on disk into facts, salvaging rather than rejecting. */
export function parseCalendarFacts(raw: unknown): CalendarFacts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  // A refusal is a well-formed payload with an error in it, not facts.
  if (str(obj.error)) return null;

  const calendars: CalendarFacts['calendars'] = [];
  if (Array.isArray(obj.calendars)) {
    for (const entry of obj.calendars as RawCalendar[]) {
      const id = str(entry?.id);
      const title = str(entry?.title);
      if (id && title) calendars.push({ id, title, source: str(entry?.source) ?? '' });
    }
  }

  return {
    generatedAt: str(obj.generatedAt) ?? new Date(0).toISOString(),
    calendars,
    events: Array.isArray(obj.events) ? (obj.events as RawCalendarEvent[]) : [],
  };
}

/**
 * Turn the facts into agenda events, keeping only the configured calendars.
 *
 * Names are matched case-insensitively against the calendar title, and a name
 * matching several calendars keeps **all** of them. That is not sloppiness: a
 * calendar shared from a second account appears once per account, and the copies
 * are not identical — one is a strict superset of the other, because events Google
 * creates on your behalf from email don't travel through sharing. Taking the union
 * and folding duplicates by id gets the fuller view without having to know which
 * copy is authoritative.
 */
export function selectEvents(facts: CalendarFacts, calendarNames: readonly string[]): CalendarSelection {
  const wanted = calendarNames.map((n) => n.trim().toLowerCase()).filter((n) => n !== '');

  const idsByName = new Map<string, string[]>();
  for (const name of wanted) {
    idsByName.set(
      name,
      facts.calendars.filter((c) => c.title.trim().toLowerCase() === name).map((c) => c.id),
    );
  }
  const unmatched = [...idsByName.entries()].filter(([, ids]) => ids.length === 0).map(([name]) => name);
  const keep = new Set([...idsByName.values()].flat());

  const byId = new Map<string, Item>();
  for (const raw of facts.events) {
    const calendarId = str(raw.calendarId);
    if (!calendarId || !keep.has(calendarId)) continue;

    // The log outranks the calendar everywhere else in this repo, but a declined
    // invitation is the one place upstream state *is* the answer: you said no, so
    // it is not your meeting and it must not eat your day.
    if (num(raw.selfStatus) === DECLINED) continue;

    const externalId = str(raw.externalId);
    const startText = str(raw.start);
    if (!externalId || !startText) continue;
    const start = new Date(startText);
    if (Number.isNaN(start.getTime())) continue;

    const allDay = raw.allDay === true;
    const id = eventId(externalId, start, allDay);
    // Same event reached through two accounts. First one wins; they agree on
    // everything that matters, and the id is what proves they are one thing.
    if (byId.has(id)) continue;

    const item: Item = {
      id,
      source: 'calendar',
      kind: 'event',
      title: str(raw.title) ?? '(untitled)',
      start: allDay ? localDate(start) : start.toISOString(),
    };

    const endText = str(raw.end);
    if (endText && !allDay) {
      const end = new Date(endText);
      if (!Number.isNaN(end.getTime())) item.end = end.toISOString();
    }

    // Only "free" frees the slot. `notSupported` is left blocking on purpose: it
    // means the calendar can't answer, and reserving time you didn't need is the
    // cheaper mistake than promising a focus block that isn't there.
    if (num(raw.availability) === AVAILABILITY_FREE) item.blocking = false;

    const url = str(raw.url);
    if (url && /^https?:\/\//i.test(url)) item.url = url;

    byId.set(id, item);
  }

  return { events: [...byId.values()], unmatched, matched: keep.size };
}

/**
 * The helper refused, never answered, or could not be launched. Its message goes
 * on screen as-is, so it says what to do rather than what macOS said.
 */
export class CalendarHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarHelperError';
  }
}

/**
 * Launch the helper and read what it wrote.
 *
 * `open -n` forces a fresh instance: without it, a still-running copy is merely
 * reactivated and the new arguments are dropped, so a wedged run would silently
 * serve the previous one's output forever.
 */
export async function runHelper(appPath: string, selfAddresses: readonly string[]): Promise<CalendarFacts> {
  // The bundle is a build output, so a fresh checkout or worktree doesn't have one.
  // Asked to launch it anyway, `open` fails with its whole command line — temp path
  // and calendar addresses included — and a raw NSError dump, none of which says
  // what to do.
  try {
    await stat(appPath);
  } catch {
    throw new CalendarHelperError(
      `the calendar helper isn't built at ${appPath} — run npm run build:calendar, ` +
        'or point DAILY_FOCUS_CALENDAR_APP at an existing build',
    );
  }

  const out = join(tmpdir(), `daily-focus-calendar-${process.pid}-${Date.now()}.json`);
  try {
    try {
      await run('/usr/bin/open', ['-n', '-a', appPath, '--args', out, selfAddresses.join(',')], {
        timeout: HELPER_TIMEOUT_MS,
      });
    } catch (err) {
      // The detail is for whoever is debugging, not for the agenda.
      console.warn(`[daily-focus] could not launch the calendar helper: ${(err as Error).message}`);
      throw new CalendarHelperError(`macOS couldn't launch the calendar helper at ${appPath}; the server log has the detail`);
    }

    const deadline = Date.now() + HELPER_TIMEOUT_MS;
    for (;;) {
      let text: string | null = null;
      try {
        text = await readFile(out, 'utf8');
      } catch {
        text = null;
      }
      if (text !== null && text.trim() !== '') {
        const raw: unknown = JSON.parse(text);
        const facts = parseCalendarFacts(raw);
        if (facts) return facts;
        const detail = (raw as { detail?: unknown; error?: unknown } | null) ?? {};
        throw new CalendarHelperError(str(detail.detail) ?? str(detail.error) ?? 'the calendar helper refused');
      }
      if (Date.now() > deadline) {
        throw new CalendarHelperError(
          `the calendar helper wrote nothing within ${HELPER_TIMEOUT_MS / 1000}s — is ${appPath} built?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await rm(out, { force: true });
  }
}
