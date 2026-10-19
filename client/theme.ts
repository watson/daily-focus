/**
 * Dark mode: light, dark, or whatever the system says, picked from a menu on one
 * button in the header.
 *
 * There was a toggle here once, and it was removed for two reasons that both had
 * to be answered before it could come back.
 *
 * The first was a bug. It stored light or dark and offered no way back, and the
 * page re-stamped that choice before every paint — so a machine set to follow the
 * clock stayed pinned to whichever mode had been chosen once, months earlier. The
 * answer is that "system" is one of the choices and the default, so handing the
 * decision back to the OS is one click rather than a storage edit. It clears the
 * stored value instead of recording itself, which is also what a browser that has
 * never been told does, and the stylesheet reaches it through
 * `color-scheme: light dark`, which re-evaluates itself when the OS flips.
 *
 * The second was that a choice can change nothing on screen, because "system"
 * renders identically to whichever mode the OS is already in — and a control that
 * appears dead gets pressed again. The button used to cycle through the three, so
 * one press in three was that dead press. A menu names all three and checks the
 * one in force, so a choice that changes no colour still moves the check. Each
 * choice there has a glyph of its own: the sun, the moon, and for System a
 * screen, the sign most apps use for "whatever this device says".
 *
 * The button shows the mode the page is not in: the moon on a light page and
 * the sun on a dark one, whichever choice put it there. Under System that is the
 * opposite of whatever the OS says right now, so the stylesheet picks the glyph
 * with `light-dark()`, as it picks the palette, and it turns over the moment the
 * OS flips.
 *
 * Nothing here listens to `prefers-color-scheme`. The old version had to, to keep
 * a label reading "switch to dark" honest while the OS flipped underneath it; a
 * label naming the choice rather than the rendering has nothing to keep up with,
 * and the one thing that does follow the rendering is the stylesheet's.
 *
 * The stamp that runs before first paint lives in `index.html`, since it has to
 * run before this bundle is even fetched; it and `applyTheme` write the same
 * attribute and read the same key.
 */

import { h, type JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { el, type Props } from './el.ts';
import { Menu } from './items.ts';
import type { Handlers, ThemeMode, UiState } from './types.ts';

export const THEME_KEY = 'daily-focus:theme';
/** In the menu's order: the two modes, then handing the choice back. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
/** The button's: only ever the mode the page is not in, so never System's screen. */
export const BUTTON_GLYPHS = ['light', 'dark'] as const;

/**
 * The menu is open under this key in `menuFor`, the record the row menus keep,
 * so opening one closes the other, Escape closes whichever is open, and the
 * stylesheet's one menu anchor stays unambiguous.
 */
export const THEME_MENU = 'header:theme';

/** Each choice as the menu names it, and the state as the button's label says it. */
const THEME_NAME: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};
const THEME_NOW: Record<ThemeMode, string> = {
  light: 'light',
  dark: 'dark',
  system: 'following the system',
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** What the pre-paint stamp decided, which is the state the page loaded in. */
export function stampedTheme(): ThemeMode {
  const stamped = document.documentElement.dataset.theme;
  return isThemeMode(stamped) ? stamped : 'system';
}

export function themeLabel(mode: ThemeMode): string {
  return `Theme: ${THEME_NOW[mode]}`;
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
 * The button, and the menu while it is open. The button draws the sun and the
 * moon, and the stylesheet paints the one for the mode the page is not in, so
 * the icon is right in the same paint as the colours.
 */
export function ThemeToggle({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element[] {
  const mode = ui.theme.value;
  const open = ui.menuFor.value === THEME_MENU;
  const label = themeLabel(mode);
  const button = el(
    'button',
    {
      type: 'button',
      class: 'icon-button theme-toggle',
      id: 'theme-toggle',
      'aria-label': label,
      title: label,
      'aria-haspopup': 'menu',
      'aria-expanded': String(open),
      onClick: () => handlers.toggleMenu(THEME_MENU),
    },
    BUTTON_GLYPHS.map((each) => GLYPHS[each]({ key: each, class: 'theme-toggle__icon', 'data-theme-icon': each })),
  );
  return open ? [button, h(ThemeMenu, { mode, ui, handlers })] : [button];
}

/**
 * The three choices, each with a check if it is the one in force, its glyph,
 * and its name.
 *
 * Unlike the row menus, this one also closes on a click or focus anywhere else,
 * since a menu in the header has no card to click to put it away. It closes by
 * writing the same `menuFor` the button and Escape do, so light dismiss is not a
 * second record of whether it is open. Focus starts on the choice in force, as
 * a radio group's does, and goes back to the button when the menu closes with
 * focus still in it.
 */
function ThemeMenu({ mode, ui, handlers }: { mode: ThemeMode; ui: UiState; handlers: Handlers }): JSX.Element {
  const checked = useRef<HTMLButtonElement>(null);
  // Layout, not plain: `Menu` has shown the popover by now, since a child's
  // layout effects run first, and focus lands in the same frame the menu does.
  useLayoutEffect(() => {
    const menu = checked.current?.parentElement;
    checked.current?.focus();
    const outside = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('.menu--theme, #theme-toggle')) return;
      if (ui.menuFor.value === THEME_MENU) handlers.toggleMenu(THEME_MENU);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      if (menu?.contains(document.activeElement)) document.getElementById('theme-toggle')?.focus();
    };
  }, []);

  return h(
    Menu,
    { class: 'menu menu--theme', label: 'Theme' },
    THEME_MODES.map((each) =>
      el(
        'button',
        {
          key: each,
          type: 'button',
          role: 'menuitemradio',
          ref: each === mode ? checked : undefined,
          'aria-checked': String(each === mode),
          onClick: () => handlers.setTheme(each),
          onKeyDown: walkMenu,
        },
        check(),
        GLYPHS[each]({ class: 'menu__glyph' }),
        THEME_NAME[each],
      ),
    ),
  );
}

/** Up and down the choices, wrapping round, and Home and End to either end. */
function walkMenu(event: KeyboardEvent): void {
  const current = event.currentTarget as HTMLElement;
  const items = [...(current.parentElement?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  const at = items.indexOf(current);
  const to: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
  const next = to[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[(next + items.length) % items.length]?.focus();
}

const STROKED = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.7',
  'stroke-linecap': 'round',
  'aria-hidden': 'true',
};

/** On every choice and visible on the one in force, so the glyphs after it line up. */
function check(): JSX.Element {
  return el(
    'svg',
    { ...STROKED, class: 'menu__check', 'stroke-width': '2', 'stroke-linejoin': 'round' },
    el('path', { d: 'M5 12.5 9.5 17 19 7' }),
  );
}

/**
 * One glyph per choice, all drawn in the same stroke so they read as a set with
 * the header's icons. The menu shows all three; the button only the sun and the
 * moon. System is a screen on its stand: the device, whose own setting it follows.
 */
const GLYPHS: Record<ThemeMode, (props: Props) => JSX.Element> = {
  light: (props) =>
    el(
      'svg',
      { ...STROKED, ...props },
      el('circle', { cx: '12', cy: '12', r: '4.1' }),
      el('path', {
        d: 'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.35 5.35l1.5 1.5M17.15 17.15l1.5 1.5M18.65 5.35l-1.5 1.5M6.85 17.15l-1.5 1.5',
      }),
    ),
  dark: (props) => el('svg', { ...STROKED, ...props }, el('path', { d: 'M20.6 14.1A8.6 8.6 0 1 1 9.9 3.4 6.8 6.8 0 0 0 20.6 14.1z' })),
  system: (props) =>
    el(
      'svg',
      { ...STROKED, 'stroke-linejoin': 'round', ...props },
      el('rect', { x: '3', y: '4', width: '18', height: '12.5', rx: '2' }),
      el('path', { d: 'M12 16.5v3.6M8.4 20.1h7.2' }),
    ),
};
