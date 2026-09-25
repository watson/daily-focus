/**
 * Dark mode follows the OS until the toggle is pressed, and the toggle can always
 * hand it back.
 *
 * The in-app override was removed once, and the bug that removed it is the thing
 * this file exists to keep out: the toggle stored light or dark, the page
 * re-stamped that choice before every paint, and a machine set to follow the clock
 * stayed pinned to whichever mode had been chosen once, months earlier. What makes
 * an override safe to offer again is that `system` is a state in the cycle rather
 * than the absence of one — it pins no scheme, stores nothing, and so cannot go
 * stale.
 *
 * The second reason it was removed was not a bug but a look: one press in three
 * changes no colour at all, since `system` renders identically to whichever mode
 * the OS is already in, and a control that appears dead gets pressed again. The
 * compensation is that the button reports the state, so a press is always visible
 * even when the page is not — which makes "every state has its own glyph" a rule
 * and not a decoration.
 *
 * Both rules span three files and live in none of them, which is why they are
 * asserted here rather than left to a reviewer to notice. The stamp is read from
 * `index.html`, where it has to run before the bundle is fetched; the cycle and
 * the glyphs from `client/theme.ts`, where the toggle lives.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
/** The toggle lives in the client source now; the bundle it becomes is not tracked. */
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
  assert.match(css, /--page:\s*light-dark\(#f9f9f7,\s*#0d0d0d\)/);

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
    /--page:\s*#0d0d0d/,
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

test('every state in the cycle has its own glyph, so no press is invisible', async () => {
  const [css, app] = await Promise.all([read('style.css'), theme()]);

  const cycle = /const THEME_CYCLE = \[([^\]]+)\]/.exec(app);
  assert.ok(cycle, 'the cycle is no longer where this test can read it');
  const states = [...(cycle[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(states, ['system', 'light', 'dark']);

  for (const state of states) {
    assert.match(app, new RegExp(`'data-theme-icon': '${state}'`), `no ${state} glyph`);
    assert.match(
      css,
      new RegExp(`:root\\[data-theme='${state}'\\] [^,{]*\\[data-theme-icon='${state}'\\]`),
      `the ${state} glyph is never shown`,
    );
    assert.match(app, new RegExp(`${state}:`), `the ${state} state goes unlabelled`);
  }
});

test('choosing the system clears the override rather than recording one', async () => {
  const app = await theme();

  // Writing `system` to storage would render identically today and be a stale
  // pin the first time these state names change.
  assert.match(app, /localStorage\.removeItem\(THEME_KEY\)/);
});
