/**
 * The poller behind the live agenda. `board.ts` for calendars, and deliberately
 * the same shape: read once at startup, then only while a browser is watching,
 * keeping the last good answer when a read fails.
 *
 * Simpler than the board in one way — the calendar is local, so there is no rate
 * limit to respect and no network to back off from — and stricter in another. An
 * empty answer has two meanings here. A day with no meetings is empty, and so is
 * a misconfigured calendar name, a revoked permission, and a helper that was
 * never built. Only the first is allowed to reach the screen as an empty agenda;
 * the rest have to fall back to the brief and say why, because the failure this
 * guards against is the one `github.ts` already documents: nothing is exactly
 * what a quiet day looks like.
 */

import type { Config } from './config.ts';
import { CalendarHelperError, parseCalendarFacts, runHelper, selectEvents, type CalendarFacts } from './calendar.ts';
import { writeJsonAtomic } from './fs.ts';
import type { CalendarState } from './types.ts';

import { readFile } from 'node:fs/promises';

/** Never re-read more often than this once reads start failing. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** What the poller talks to, gathered so a test can supply its own. */
export interface CalendarDeps {
  run(appPath: string, addresses: readonly string[]): Promise<CalendarFacts>;
}

const realDeps: CalendarDeps = { run: runHelper };

export class CalendarBoard {
  readonly #config: Config;
  readonly #deps: CalendarDeps;
  readonly #onChange: () => void;

  #facts: CalendarFacts | null = null;
  #problem: string | null = null;
  #warnings: string[] = [];

  #reading: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #audience = 0;
  #failures = 0;
  #stopped = false;
  #lastReadAt = 0;

  constructor(config: Config, onChange: () => void, deps: CalendarDeps = realDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#onChange = onChange;
  }

  /**
   * Off when switched off, and off when no calendar has been named — an unnamed
   * calendar list isn't a broken setup, it's a feature nobody turned on, and it
   * must not produce a banner every morning.
   */
  get enabled(): boolean {
    return this.#config.calendar.enabled && this.#config.calendar.names.length > 0;
  }

  /** Load the last good read off disk, then read once regardless of audience. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    this.#facts = await readCalendarFile(this.#config.calendarFile);
    await this.refresh();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  setAudience(count: number): void {
    this.#audience = count;
    if (count === 0) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer || this.#reading) return;
    if (this.#dueIn() === 0) void this.refresh();
    else this.#schedule();
  }

  /** Read now. Joins a read already running rather than starting a second. Never rejects. */
  async refresh(): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    if (this.#reading) return this.#reading;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    this.#reading = this.#read()
      .catch((err: unknown) => {
        this.#problem = `The calendar read hit an unexpected error: ${(err as Error).message}`;
        this.#failures++;
        console.error(`[daily-focus] calendar read failed: ${(err as Error).stack ?? String(err)}`);
      })
      .finally(() => {
        this.#reading = null;
        this.#lastReadAt = Date.now();
        if (this.#audience > 0 && !this.#stopped) this.#schedule();
        this.#onChange();
      });

    return this.#reading;
  }

  async #read(): Promise<void> {
    const { appPath, addresses } = this.#config.calendar;
    try {
      const facts = await this.#deps.run(appPath, addresses);
      this.#facts = facts;
      this.#problem = null;
      this.#failures = 0;
      await writeJsonAtomic(this.#config.calendarFile, facts);
    } catch (err) {
      this.#failures++;
      const message =
        err instanceof CalendarHelperError
          ? err.message
          : `could not read the calendar: ${(err as Error).message}`;
      // A failed read keeps the previous answer, exactly as a failed account keeps
      // its rows on the board. Say so either way — a stale agenda that looks fresh
      // is the thing worth avoiding.
      this.#problem = this.#facts
        ? `${message}. Showing the last good read.`
        : `${message}. Showing the events from this morning's brief instead.`;
    }
  }

  /** The agenda as it stands, derived on every read rather than stored. */
  state(): CalendarState {
    if (!this.enabled) {
      return { events: [], live: false, fetchedAt: null, problem: null, warnings: [] };
    }
    if (!this.#facts) {
      return {
        events: [],
        live: false,
        fetchedAt: null,
        problem: this.#problem ?? 'The calendar has not been read yet.',
        warnings: this.#warnings,
      };
    }

    const { events, unmatched, matched } = selectEvents(this.#facts, this.#config.calendar.names);
    const warnings = [...this.#warnings];
    if (unmatched.length > 0) {
      warnings.push(
        `No calendar named ${unmatched.map((n) => `"${n}"`).join(', ')}. ` +
          `Check DAILY_FOCUS_CALENDARS against the names in Calendar.app.`,
      );
    }
    if (this.#config.calendar.addresses.length === 0) {
      warnings.push(
        'DAILY_FOCUS_CALENDAR_ADDRESSES is unset, so meetings you declined still show and still block time.',
      );
    }

    // Every configured name missed. That is a broken setup rather than a free day,
    // and showing an empty agenda would hide it — so fall back and complain.
    if (matched === 0) {
      return {
        events: [],
        live: false,
        fetchedAt: this.#facts.generatedAt,
        problem:
          'None of the configured calendars exist in Calendar.app, so the brief’s events are being shown instead.',
        warnings,
      };
    }

    return { events, live: true, fetchedAt: this.#facts.generatedAt, problem: this.#problem, warnings };
  }

  #intervalMs(): number {
    const base = this.#config.calendar.pollMinutes * 60_000;
    if (this.#failures === 0) return base;
    return Math.min(base * 2 ** Math.min(this.#failures, 6), MAX_BACKOFF_MS);
  }

  #dueIn(): number {
    if (this.#lastReadAt === 0) return 0;
    return Math.max(0, this.#lastReadAt + this.#intervalMs() - Date.now());
  }

  #schedule(): void {
    if (this.#timer || this.#stopped || this.#audience === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh();
    }, this.#dueIn() || this.#intervalMs());
    this.#timer.unref?.();
  }
}

/** Read the cache back defensively; it is a cache, so losing it costs one read. */
export async function readCalendarFile(path: string): Promise<CalendarFacts | null> {
  try {
    return parseCalendarFacts(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}
