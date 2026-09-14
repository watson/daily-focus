import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { computeAssetVersion } from '../src/assets.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-assets-'));
  dirs.push(dir);
  return dir;
}

test('the same tree yields the same version', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'app.js'), 'console.log(1)');
  assert.equal(await computeAssetVersion(dir), await computeAssetVersion(dir));
});

test('editing a file changes the version', async () => {
  const dir = await makeDir();
  const file = join(dir, 'style.css');
  await writeFile(file, 'body{}');
  const before = await computeAssetVersion(dir);

  await writeFile(file, 'body{color:red}');
  assert.notEqual(await computeAssetVersion(dir), before);
});

test('adding a file changes the version', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'a.js'), 'a');
  const before = await computeAssetVersion(dir);

  await writeFile(join(dir, 'b.js'), 'b');
  assert.notEqual(await computeAssetVersion(dir), before);
});

test('a missing directory yields a version rather than throwing', async () => {
  assert.equal(typeof (await computeAssetVersion('/nope/does/not/exist')), 'string');
});
