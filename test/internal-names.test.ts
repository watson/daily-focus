/**
 * Daily Focus is public and names no company: what is particular to one, its
 * tools, hosts, organization and bots, lives in that company's own setup
 * (`src/organization.ts`), never here. This scans every tracked text file for
 * names known to be some company's internal ones, and fails on any.
 *
 * To catch another, add it to `INTERNAL_NAMES`. A name that matches inside a
 * longer word by accident can be given as a whole word. Only this file, which
 * lists them, is left out of the scan; never add another exception: a match is
 * something to take out of the repository, or, if it is a false alarm, a
 * reason to say the name more precisely here.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const SELF = 'test/internal-names.test.ts';

/** Each name, matched ignoring case: anywhere in a line, or as a whole word only. */
const INTERNAL_NAMES: readonly { name: string; whole?: boolean }[] = [
  { name: 'devflow' },
  { name: 'dogbrew' },
  { name: 'ddoghq' },
  { name: 'ddbuild.io' },
  { name: 'datadoghq.atlassian' },
  { name: 'dd-mergequeue' },
  { name: 'ddr', whole: true },
];

function pattern({ name, whole }: { name: string; whole?: boolean }): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped, 'i');
}

/** What the walk skips when git can't list the files. */
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'data']);

/** The tracked files, or without git, everything but dependencies, builds and the bundle. */
function repositoryFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
      }
    };
    walk(root);
    return files.filter((file) => !file.startsWith('public/app.js'));
  }
}

/** Text, as far as a quick look can tell: no NUL in its first few kilobytes. */
function readText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

test('no tracked file names a company’s internal tools, hosts or bots', () => {
  const patterns = INTERNAL_NAMES.map((entry) => ({ entry, regex: pattern(entry) }));
  const found: string[] = [];
  const files = repositoryFiles();
  assert.ok(files.length > 50, `expected to scan the repository, found ${files.length} files`);
  for (const file of files) {
    if (file === SELF) continue;
    const text = readText(join(root, file));
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      for (const { entry, regex } of patterns) {
        if (regex.test(line)) found.push(`${file}:${i + 1} names "${entry.name}"`);
      }
    });
  }
  assert.deepEqual(found, [], `internal names in the repository:\n${found.join('\n')}`);
});

test('the internal-name patterns match what they should, and only that', () => {
  const ddr = pattern({ name: 'ddr', whole: true });
  assert.ok(ddr.test('run DDR first'));
  assert.ok(ddr.test('`ddr` is'));
  assert.ok(!ddr.test('address'), 'a whole word, not part of one');
  assert.ok(!ddr.test('ddr_x'));
  assert.ok(pattern({ name: 'ddbuild.io' }).test('https://x.DDBUILD.IO/y'));
  assert.ok(!pattern({ name: 'ddbuild.io' }).test('ddbuildxio'), 'a dot is a dot');
});
