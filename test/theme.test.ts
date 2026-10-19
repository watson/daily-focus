/**
 * Dark mode follows the OS until a mode is picked, and the menu can always hand
 * it back.
 *
 * The in-app override was removed once, and the bug that removed it is the thing
 * this file exists to keep out: the toggle stored light or dark, the page
 * re-stamped that choice before every paint, and a machine set to follow the clock
 * stayed pinned to whichever mode had been chosen once, months earlier. What makes
 * an override safe to offer again is that `system` is one of the choices rather
 * than the absence of one — it pins no scheme, stores nothing, and so cannot go
 * stale.
 *
 * The second reason it was removed was not a bug but a look: picking `system`
 * can change no colour at all, since it renders identically to whichever mode
 * the OS is already in, and a control that appears dead gets pressed again. The
 * menu answers that by checking the choice in force. The button shows the other
 * mode, the one the page is not in, worked out from the scheme the page renders
 * in rather than the choice, so under `system` it is the opposite of the OS.
 *
 * Both rules span three files and live in none of them, which is why they are
 * asserted here rather than left to a reviewer to notice. The stamp is read from
 * `index.html`, where it has to run before the bundle is fetched; the choices
 * and the glyphs from `client/theme.ts`, where the menu lives; which glyph the
 * button shows from the stylesheet.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { byClass, handlersWith, mount, mountOne, settle, uiWith } from './dom.ts';
import { BUTTON_GLYPHS, THEME_MENU, THEME_MODES, ThemeToggle } from '../client/theme.ts';
import type { ThemeMode } from '../client/types.ts';

const read = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
/** The menu lives in the client source now; the bundle it becomes is not tracked. */
const theme = () => readFile(new URL('../client/theme.ts', import.meta.url), 'utf8');

/** Run `index.html`'s pre-paint stamp against a given `localStorage`. */
function stamp(html: string, stored: string | null): string | undefined {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, 'the pre-paint stamp is gone, so dark-mode loads flash white');

  const body = script[1] ?? '';
  const documentElement = { dataset: {} as Record<string, string> };
  new Function('document', 'localStorage', body)(
    { documentElement },
    { getItem: () => stored },
  );
  return documentElement.dataset.theme;
}

test('the dark palette has exactly one home', async () => {
  const css = await read('style.css');

  // Every dark step is the second half of its token's pair, so there is nothing
  // to keep in sync.
  assert.match(css, /--page:\s*light-dark\(#f2f1ec,\s*#0f1012\)/);

  // The second copy is what this guards. The palette used to be restated inside a
  // media query, and a scheme-specific selector anywhere is that copy starting
  // again — including for one lone property like the shadow.
  assert.doesNotMatch(
    css,
    /@media \(prefers-color-scheme/,
    'the dark palette has a second home again',
  );
  assert.doesNotMatch(
    css,
    /--page:\s*#0f1012/,
    'the dark page colour is reachable without `light-dark()`',
  );
});

test('only `color-scheme` selects a palette, and `system` selects nothing', async () => {
  const css = await read('style.css');

  // Both keywords, or `light-dark()` stops asking the OS and the third state
  // silently becomes light for everyone.
  assert.match(css, /:root \{[^}]*color-scheme: light dark;/);

  assert.match(css, /:root\[data-theme='light'\] \{\s*color-scheme: light;\s*\}/);
  assert.match(css, /:root\[data-theme='dark'\] \{\s*color-scheme: dark;\s*\}/);

  // A `system` rule pinning a scheme is the old bug wearing the new name: it
  // would freeze the page at whatever the OS said when the rule was written.
  assert.doesNotMatch(
    css,
    /:root\[data-theme='system'\][^{]*\{[^}]*color-scheme/,
    '`system` must not pin a colour scheme',
  );
});

test('the pre-paint stamp trusts only the two explicit modes', async () => {
  const html = await read('index.html');

  assert.equal(stamp(html, 'light'), 'light');
  assert.equal(stamp(html, 'dark'), 'dark');

  // Nothing stored, a value from an older build, a hand-edited one: all of them
  // have to leave the OS in charge rather than pin the page to what they found.
  assert.equal(stamp(html, null), 'system');
  assert.equal(stamp(html, 'system'), 'system');
  assert.equal(stamp(html, 'sepia'), 'system');
});

test('the button shows the mode the page is not in, even under the system', async () => {
  const css = await read('style.css');
  assert.deepEqual([...THEME_MODES], ['light', 'dark', 'system']);

  // The sun and the moon, never System's screen: the button shows a mode to go to.
  const icons = byClass(mountOne(h(ThemeToggle, { ui: uiWith(), handlers: handlersWith() })), 'theme-toggle__icon');
  assert.deepEqual(
    icons.map((icon) => icon.dataset.themeIcon),
    [...BUTTON_GLYPHS],
  );
  assert.deepEqual([...BUTTON_GLYPHS], ['light', 'dark']);

  // Picked by the scheme the page renders in, which under `system` is the OS's:
  // the moon on a light page, the sun on a dark one.
  assert.match(css, /\.theme-toggle__icon\[data-theme-icon='dark'\] \{\s*stroke: light-dark\(currentColor, transparent\);/);
  assert.match(css, /\.theme-toggle__icon\[data-theme-icon='light'\] \{\s*stroke: light-dark\(transparent, currentColor\);/);
  // Keyed to the choice instead, `system` would show one glyph whatever the OS says.
  assert.doesNotMatch(css, /data-theme='[a-z]+'\][^{]*\.theme-toggle__icon/, 'the icon is keyed to the choice, not the rendering');
});

/** The button and, when `open`, the menu, rendered for `mode`; and what the handlers were asked. */
function renderMenu(mode: ThemeMode, open: boolean) {
  const calls: string[] = [];
  const ui = uiWith({ theme: mode, menuFor: open ? THEME_MENU : null });
  const handlers = handlersWith({
    toggleMenu: (id) => calls.push(`toggleMenu ${id}`),
    setTheme: (picked) => calls.push(`setTheme ${picked}`),
  });
  const root = mount(h(ThemeToggle, { ui, handlers }));
  const button = root.querySelector<HTMLButtonElement>('#theme-toggle')!;
  const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  return { root, button, items, calls };
}

test('the button names the state and opens a menu rather than cycling', () => {
  const { button, items, calls } = renderMenu('system', false);
  assert.equal(button.getAttribute('aria-label'), 'Theme: following the system');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(items.length, 0, 'closed, there is no menu');

  button.click();
  assert.deepEqual(calls, [`toggleMenu ${THEME_MENU}`]);
});

test('the menu offers all three, checks the one in force, and picks by name', () => {
  const { root, button, items, calls } = renderMenu('dark', true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(root.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Theme');
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['Light', 'Dark', 'System'],
  );
  assert.deepEqual(
    items.map((item) => item.getAttribute('aria-checked')),
    ['false', 'true', 'false'],
  );
  // Each choice carries a glyph of its own beside the check every row has.
  for (const item of items) {
    assert.equal(byClass(item, 'menu__check').length, 1);
    assert.equal(byClass(item, 'menu__glyph').length, 1);
  }

  items[2]!.click();
  assert.deepEqual(calls, ['setTheme system']);
});

test('the menu starts on the choice in force and walks with the arrow keys', () => {
  const { items } = renderMenu('light', true);
  assert.equal(document.activeElement, items[0], 'focus starts on the checked choice');

  const press = (key: string) =>
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowDown');
  assert.equal(document.activeElement, items[1]);
  press('End');
  assert.equal(document.activeElement, items[2]);
  press('ArrowDown');
  assert.equal(document.activeElement, items[0], 'and wraps round');
  press('ArrowUp');
  assert.equal(document.activeElement, items[2]);
});

test('a click anywhere else closes the menu; a click in it or on its button does not', async () => {
  const { button, items, calls } = renderMenu('dark', true);
  const pointer = (target: Element) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

  pointer(items[0]!);
  pointer(button);
  assert.deepEqual(calls, []);

  pointer(document.body);
  await settle();
  assert.deepEqual(calls, [`toggleMenu ${THEME_MENU}`]);
});

test('choosing the system clears the override rather than recording one', async () => {
  const app = await theme();

  // Writing `system` to storage would render identically today and be a stale
  // pin the first time these state names change.
  assert.match(app, /localStorage\.removeItem\(THEME_KEY\)/);
});
