/**
 * Dark mode belongs to the OS.
 *
 * There is no in-app toggle, and the reason is the bug that removed it: the
 * toggle wrote its choice to `localStorage`, the page re-stamped that choice
 * before every paint, and a machine set to follow the clock stayed pinned to
 * whichever mode had been chosen once, months earlier. A media query re-evaluates
 * itself when the system flips; a stored preference never does.
 *
 * So the rule is that the dark tokens are reachable *only* through
 * `prefers-color-scheme`. That spans three files and lives in none of them, which
 * is why it is asserted here rather than left to a reviewer to notice.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('the dark tokens sit behind prefers-color-scheme and nothing else', async () => {
  const css = await read('style.css');

  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /data-theme/, 'a theme override selector is back in the stylesheet');

  // The dark page colour must not be reachable outside the media block, or the
  // whole app would render dark for everyone.
  const outsideMedia = css.replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(outsideMedia, /--page:\s*#0d0d0d/);
});

test('nothing stamps or stores a theme', async () => {
  for (const name of ['index.html', 'app.js', 'render.js', 'format.js', 'api.js']) {
    const source = await read(name);
    assert.doesNotMatch(source, /dataset\.theme/, `${name} stamps a theme onto the document`);
    assert.doesNotMatch(source, /daily-focus:theme/, `${name} stores a theme preference`);
  }
});
