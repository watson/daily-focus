/**
 * Telling the dashboard someone is using it.
 *
 * The menu bar app can install updates on its own, and does so only once nobody
 * has used the dashboard for a while; see `macos/DailyFocus/Updates.swift`. The
 * Mac it runs on is often not the one the dashboard is read from, a laptop
 * reaching a Mac at home, so the Mac's own idle time says nothing about it. The
 * page says instead: a click, a key, a scroll or a touch in a tab you can see,
 * or the tab coming into view. A tab left open out of sight says nothing.
 */

/** The most often a page says so, which is as fine as the app needs. */
export const PRESENCE_EVERY_MS = 60_000;

export interface PresenceWatch {
  /** Something happened on the page that someone did. */
  noticed(): void;
}

export function watchPresence(deps: {
  visible: () => boolean;
  now: () => number;
  send: () => Promise<void>;
}): PresenceWatch {
  let last = -Infinity;
  return {
    noticed() {
      if (!deps.visible()) return;
      const now = deps.now();
      if (now - last < PRESENCE_EVERY_MS) return;
      last = now;
      // One that doesn't arrive only puts an update off.
      deps.send().catch((err: unknown) => console.warn('[daily-focus] could not tell the dashboard it is in use:', err));
    },
  };
}
