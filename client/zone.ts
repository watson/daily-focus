/**
 * Telling the dashboard where you are.
 *
 * The dashboard keeps one time zone, for its morning clock and every date and
 * time on the page, and it is the zone of the browser it was last looked at
 * from; see `src/zone.ts`. This is the browser's half.
 *
 * A browser says where it is when you look at it: the page loads, its
 * connection to the dashboard comes back, the tab comes into view or the window
 * takes focus. It also says so when its own zone changes while it is open. Only
 * then, and only if the dashboard is somewhere else. A tab that asserted its
 * zone on a timer would take it back from the laptop you are reading, if it
 * were left open on a Mac at home.
 */

/** How often an open tab looks at its own zone. Nothing is sent unless it has changed. */
export const ZONE_CHECK_MS = 60_000;

export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Whether two names are one zone to this browser. The server's Intl may spell a
 * zone the old way, "Asia/Calcutta" for "Asia/Kolkata", and that difference
 * must not read as being somewhere else.
 */
export function sameZone(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const canonical = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

export interface ZoneWatch {
  /** You are looking at the page: tell the dashboard if it is in another zone. */
  look(): void;
  /** The timer's check: tell it only if this browser's own zone has changed since. */
  check(): void;
}

export function watchZone(deps: {
  browserZone: () => string;
  /** Undefined until the first state has arrived. */
  dashboardZone: () => string | undefined;
  /** Hidden tabs report only their own zone changing, never on being loaded or reconnected. */
  visible: () => boolean;
  send: (zone: string) => Promise<void>;
}): ZoneWatch {
  let seen = deps.browserZone();
  /** The zone being sent now, so a reconnect and a focus at once send it once. */
  let sending: string | null = null;

  function tellIfElsewhere(): void {
    const here = deps.browserZone();
    const there = deps.dashboardZone();
    if (there === undefined || sameZone(here, there) || sending === here) return;
    sending = here;
    deps
      .send(here)
      .catch((err: unknown) => console.warn(`[daily-focus] could not tell the dashboard this browser is in ${here}:`, err))
      .finally(() => {
        sending = null;
      });
  }

  return {
    look() {
      seen = deps.browserZone();
      if (deps.visible()) tellIfElsewhere();
    },
    check() {
      const here = deps.browserZone();
      if (here === seen) return;
      seen = here;
      tellIfElsewhere();
    },
  };
}
