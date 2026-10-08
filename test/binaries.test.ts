/**
 * The loader a Linux or Windows executable runs first (`binaries/main.ts`), short
 * of being one: where it unpacks, and that it unpacks whole, once, and nowhere
 * it shouldn't. The executables themselves are built and run by CI, which has
 * the platforms; see `binaries/build.ts`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { dashboardsDir, unpack, unpackedDir, type Manifest } from '../binaries/main.ts';

let dashboards: string;

before(async () => {
  dashboards = join(await mkdtemp(join(tmpdir(), 'daily-focus-loader-')), 'dashboards');
});

after(async () => {
  await rm(join(dashboards, '..'), { recursive: true, force: true });
});

const contents: Record<string, string> = {
  'package.json': '{ "name": "daily-focus", "version": "1.2.3" }\n',
  'dist/cli.js': 'console.log("hi")\n',
  'prompts/morning-brief-work.md': '# Morning brief\n',
};
const manifest: Manifest = { version: '1.2.3', hash: 'abcdef012345', files: Object.keys(contents) };

/** The assets as the loader reads them, counting the reads. */
function assets(): { read: (key: string) => Uint8Array; reads: () => number } {
  let count = 0;
  return {
    read: (key) => {
      count++;
      const text = contents[key];
      assert.ok(text !== undefined, `no asset ${key}`);
      return new TextEncoder().encode(text);
    },
    reads: () => count,
  };
}

test("a build unpacks in the user's data directory, as each platform has it", () => {
  assert.equal(dashboardsDir('linux', {}, '/home/me'), '/home/me/.local/share/daily-focus/dashboards');
  assert.equal(dashboardsDir('linux', { XDG_DATA_HOME: '/data' }, '/home/me'), '/data/daily-focus/dashboards');
  assert.equal(dashboardsDir('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/daily-focus/dashboards');
  const local = join('C:', 'Users', 'me', 'AppData', 'Local');
  assert.equal(dashboardsDir('win32', { LOCALAPPDATA: local }, join('C:', 'Users', 'me')), join(local, 'daily-focus', 'dashboards'));
  assert.equal(dashboardsDir('win32', {}, join('C:', 'Users', 'me')), join(local, 'daily-focus', 'dashboards'));
});

test('the first run unpacks the package whole, under its version and hash, and later runs find it', async () => {
  const first = assets();
  const dir = unpack(dashboards, manifest, first.read);
  assert.equal(dir, unpackedDir(dashboards, manifest));
  assert.equal(dir, join(dashboards, '1.2.3-abcdef012345'));
  assert.equal(first.reads(), 3);
  for (const [file, text] of Object.entries(contents)) {
    assert.equal(await readFile(join(dir, 'package', ...file.split('/')), 'utf8'), text);
  }
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), manifest);
  assert.deepEqual(await readdir(dashboards), ['1.2.3-abcdef012345'], 'nothing staged is left beside it');

  const again = assets();
  assert.equal(unpack(dashboards, manifest, again.read), dir);
  assert.equal(again.reads(), 0, 'a build already there is not read again');
});

test('a rebuild of the same version with other contents unpacks beside the first', async () => {
  const rebuilt = { ...manifest, hash: '0123456789ab' };
  const dir = unpack(dashboards, rebuilt, assets().read);
  assert.equal(dir, join(dashboards, '1.2.3-0123456789ab'));
  assert.deepEqual((await readdir(dashboards)).sort(), ['1.2.3-0123456789ab', '1.2.3-abcdef012345']);
});

test('a file that would land outside the package stops the unpacking, and leaves nothing behind', async () => {
  const bad: Manifest = { version: '9.9.9', hash: 'bad000000000', files: ['package.json', '../escape.txt'] };
  assert.throws(() => unpack(dashboards, bad, () => new Uint8Array()), /refusing to unpack \.\.\/escape\.txt/);
  assert.ok(!(await readdir(dashboards)).some((name) => name.startsWith('9.9.9')), 'neither the build nor its staging directory remains');
});
