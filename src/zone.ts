/**
 * The dashboard's time zone: the one its morning clock runs on and every date
 * and time on the page is shown in.
 *
 * It is where the user is, and the browser knows that better than the server:
 * a Mac mini at home has no idea you have flown to New York, but the laptop you
 * open the dashboard on does. So the zone is whatever a browser last said it
 * was in (`report`), which the page does when you look at it; see
 * `client/zone.ts`.
 *
 * The other thing that moves it is the zone of the Mac the dashboard runs on
 * changing (`checkSystem`). Node reads the zone once, at startup, so without
 * this a dashboard left running through a flight kept the old zone for days and
 * ran the morning agent at 13:00. It is also what covers the morning after a
 * flight, before any tab has been opened. A Mac mini at home never changes zone,
 * so it never takes the zone back from a browser abroad: whichever moved last
 * wins.
 *
 * The zone and the Mac's zone at the time are kept in `timezone.json`, so a
 * restart keeps the browser's word and still notices a Mac that moved while the
 * dashboard was off. Applying a zone sets `process.env.TZ`, which makes Node
 * read it again for every Date and Intl call, and which every child process
 * inherits: the morning agent, the assistant and the calendar helper count the
 * same days as the dashboard.
 */

import { readFile, readlink } from 'node:fs/promises';

import { writeJsonAtomic } from './fs.ts';
import { localTimeZone } from './time.ts';

interface ZoneFile {
  timeZone: string;
  /** The Mac's zone when `timeZone` was decided, or null if it couldn't be read. */
  systemTimeZone: string | null;
}

/**
 * `raw` if it is a zone this process can count days in, otherwise null. Named
 * zones only: an offset such as "+02:00" would pass Intl, but it means nothing
 * as `TZ` and doesn't follow daylight saving.
 */
export function validZone(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

/**
 * The zone macOS is set to now, read fresh rather than from Node, which only
 * looked at startup. `/etc/localtime` is a link into the zone database that
 * macOS moves when the zone changes; most Linux systems keep it the same way.
 * Null where it isn't a link, and the Mac's zone is then simply not followed.
 */
export async function readSystemZone(path = '/etc/localtime'): Promise<string | null> {
  try {
    const target = await readlink(path);
    const name = /zoneinfo\/(?:posix\/|right\/)?(.+)$/.exec(target)?.[1];
    return validZone(name);
  } catch {
    return null;
  }
}

/**
 * The zone a dashboard starting now would use, decided without writing anything.
 * A store that has never been told one keeps the zone Node started in. One that
 * has keeps it, unless the Mac has moved since (`moved`).
 */
export async function startingZone(file: string, system: string | null): Promise<{ timeZone: string; moved: boolean }> {
  const saved = await loadZoneFile(file);
  if (!saved) return { timeZone: localTimeZone(), moved: false };
  if (system && saved.systemTimeZone && system !== saved.systemTimeZone) return { timeZone: system, moved: true };
  return { timeZone: saved.timeZone, moved: false };
}

async function loadZoneFile(file: string): Promise<ZoneFile | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const timeZone = validZone(record.timeZone);
  if (!timeZone) return null;
  return { timeZone, systemTimeZone: validZone(record.systemTimeZone) };
}

export class TimeZoneKeeper {
  readonly #file: string;
  readonly #readSystem: () => Promise<string | null>;
  #current = localTimeZone();
  /** The Mac's zone as last read, so `checkSystem` acts on a change rather than a difference. */
  #system: string | null = null;

  constructor(file: string, readSystem: () => Promise<string | null> = readSystemZone) {
    this.#file = file;
    this.#readSystem = readSystem;
  }

  get current(): string {
    return this.#current;
  }

  /** Decide the zone at startup; see `startingZone`. */
  async start(): Promise<void> {
    this.#system = await this.#readSystem();
    const { timeZone, moved } = await startingZone(this.#file, this.#system);
    if (moved) await this.#adopt(timeZone);
    else this.#apply(timeZone);
  }

  /** A browser says it is in `zone`. True if that changed the dashboard's. */
  async report(zone: string): Promise<boolean> {
    if (zone === this.#current) return false;
    await this.#adopt(zone);
    return true;
  }

  /** Follow the Mac if its zone has changed since last read. True if that changed the dashboard's. */
  async checkSystem(): Promise<boolean> {
    const system = await this.#readSystem();
    if (!system || system === this.#system) return false;
    this.#system = system;
    if (system === this.#current) {
      await this.#save();
      return false;
    }
    await this.#adopt(system);
    return true;
  }

  async #adopt(zone: string): Promise<void> {
    this.#apply(zone);
    await this.#save();
  }

  #apply(zone: string): void {
    this.#current = zone;
    process.env.TZ = zone;
  }

  async #save(): Promise<void> {
    const file: ZoneFile = { timeZone: this.#current, systemTimeZone: this.#system };
    try {
      await writeJsonAtomic(this.#file, file);
    } catch (err) {
      // The zone still applies; only a restart would forget it.
      console.warn(`[daily-focus] could not save the time zone: ${(err as Error).message}`);
    }
  }
}
