/**
 * Dark mode: system → light → dark, on one button in the header.
 *
 * There was a toggle here once, and it was removed for two reasons that both had
 * to be answered before it could come back.
 *
 * The first was a bug. It stored light or dark and offered no way back, and the
 * page re-stamped that choice before every paint — so a machine set to follow the
 * clock stayed pinned to whichever mode had been chosen once, months earlier. The
 * answer is that "system" is a state in the cycle and the default, so handing the
 * decision back to the OS is one press rather than a storage edit. It clears the
 * stored value instead of recording itself, which is also what a browser that has
 * never been told does, and the stylesheet reaches it through
 * `color-scheme: light dark`, which re-evaluates itself when the OS flips.
 *
 * The second was that a three-state cycle has a press that changes nothing on
 * screen, because "system" renders identically to whichever mode the OS is
 * already in — and a button that appears dead gets pressed again. So the button
 * reports the state as well as changing it: one glyph per state, and a label
 * naming both where you are and where the next press goes. That makes it the
 * icon's job to be legible in all three, which is why `system` is the sliced
 * sun-and-moon rather than a third shade of the same shape.
 *
 * Nothing here listens to `prefers-color-scheme`. The old version had to, to keep
 * a label reading "switch to dark" honest while the OS flipped underneath it; a
 * label naming the state rather than the rendering has nothing to keep up with.
 *
 * The stamp that runs before first paint lives in `index.html`, since it has to
 * run before this bundle is even fetched; it and `applyTheme` write the same
 * attribute and read the same key.
 */

import type { JSX } from 'preact';

import { el } from './el.ts';
import type { Handlers, ThemeMode, UiState } from './types.ts';

export const THEME_KEY = 'daily-focus:theme';
export const THEME_CYCLE = ['system', 'light', 'dark'] as const;

/** The action the next press performs, and the state you are in now. */
const THEME_NEXT: Record<ThemeMode, string> = {
  system: 'Follow the system theme',
  light: 'Switch to light mode',
  dark: 'Switch to dark mode',
};
const THEME_NOW: Record<ThemeMode, string> = {
  system: 'now following the system',
  light: 'now light',
  dark: 'now dark',
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_CYCLE as readonly string[]).includes(value);
}

/** What the pre-paint stamp decided, which is the state the page loaded in. */
export function stampedTheme(): ThemeMode {
  const stamped = document.documentElement.dataset.theme;
  return isThemeMode(stamped) ? stamped : 'system';
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length] ?? 'system';
}

export function themeLabel(mode: ThemeMode): string {
  return `${THEME_NEXT[nextTheme(mode)]} (${THEME_NOW[mode]})`;
}

/** Stamp the document and remember the choice, or forget it: see the header comment. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  // Storing `system` would render the same, but leaving nothing behind is what
  // makes it the same state a browser that has never been told is already in.
  if (mode === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
}

/**
 * The button, and its three glyphs. One glyph per state, and only the stamped
 * one shows; the stylesheet picks it by `data-theme-icon`.
 *
 * System is both icons at once, cut on the diagonal: the sun on a light half,
 * the moon on a dark one. Its light and dark are written out as hex rather than
 * taken from the palette, which is the one place in the stylesheet's reach that
 * a colour is hardcoded. It has to be: the glyph depicts light and dark instead
 * of being drawn in them, so a half painted in `--page` would follow the scheme
 * and show a dark "light side" on a dark page — the exact opposite of what it
 * claims. Nothing load-bearing rides on the hues; they are greys, and the label
 * says in words which state the button is in.
 */
export function ThemeToggle({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element {
  const label = themeLabel(ui.theme.value);
  return el(
    'button',
    {
      type: 'button',
      class: 'icon-button theme-toggle',
      id: 'theme-toggle',
      'aria-label': label,
      title: label,
      onClick: () => handlers.toggleTheme(),
    },
    el(
      'svg',
      { class: 'theme-toggle__icon', 'data-theme-icon': 'system', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
      // The badge is a whole light disc with the dark half laid over it, not two
      // halves meeting: abutting fills leave the page colour showing through the
      // diagonal as a hairline once the browser antialiases both edges of it. The
      // dark grey is lifted off `--page`'s #0d0d0d so the dark half is still a
      // shape on a dark page.
      el('circle', { cx: '12', cy: '12', r: '10', fill: '#f9f9f7' }),
      el('path', { d: 'M4.93 19.07A10 10 0 0 0 19.07 4.93Z', fill: '#17171a' }),
      // Sun on the light half, moon on the dark one, each sized to sit clear of
      // the cut — which is what saves a clip path, and what a change to either
      // radius would spend.
      el('circle', { cx: '7.8', cy: '7.8', r: '2.1', fill: '#17171a' }),
      el('path', {
        d: 'M10.99 8.65 12.24 8.99M8.65 10.99 8.99 12.24M5.47 10.13 4.55 11.05M4.61 6.95 3.36 6.61M6.95 4.61 6.61 3.36M10.13 5.47 11.05 4.55',
        stroke: '#17171a',
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
      }),
      el('path', {
        'fill-rule': 'evenodd',
        fill: '#f9f9f7',
        d: 'M11.2 15.7a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M9.95 13.95a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
      }),
      // The rim is the only part that follows the page, so the badge still reads
      // as one of the header's icons.
      el('circle', { cx: '12', cy: '12', r: '10', stroke: 'currentColor', 'stroke-width': '1.3' }),
    ),
    el(
      'svg',
      {
        class: 'theme-toggle__icon',
        'data-theme-icon': 'light',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.7',
        'stroke-linecap': 'round',
        'aria-hidden': 'true',
      },
      el('circle', { cx: '12', cy: '12', r: '4.1' }),
      el('path', {
        d: 'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.35 5.35l1.5 1.5M17.15 17.15l1.5 1.5M18.65 5.35l-1.5 1.5M6.85 17.15l-1.5 1.5',
      }),
    ),
    el(
      'svg',
      {
        class: 'theme-toggle__icon',
        'data-theme-icon': 'dark',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.7',
        'stroke-linecap': 'round',
        'aria-hidden': 'true',
      },
      el('path', { d: 'M20.6 14.1A8.6 8.6 0 1 1 9.9 3.4 6.8 6.8 0 0 0 20.6 14.1z' }),
    ),
  );
}
