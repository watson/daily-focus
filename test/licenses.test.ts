/**
 * The package's third-party licences: which npm packages a build read, found
 * from esbuild's own account of it, and what the file says of each.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { bundledPackageDirs, licensesText, packageCredit } from '../scripts/licenses.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('the packages a bundle read are found from its inputs, scoped and nested ones included', () => {
  const cwd = join(tmpdir(), 'checkout');
  // As esbuild writes them, with forward slashes on Windows too.
  const inputs = [
    'client/main.ts',
    'node_modules/preact/dist/preact.module.js',
    'node_modules/preact/hooks/dist/hooks.module.js',
    'node_modules/@preact/signals/dist/signals.module.js',
    'node_modules/@preact/signals/node_modules/left-pad/index.js',
  ];
  assert.deepEqual(bundledPackageDirs(inputs, cwd), [
    join(cwd, 'node_modules', '@preact', 'signals'),
    join(cwd, 'node_modules', '@preact', 'signals', 'node_modules', 'left-pad'),
    join(cwd, 'node_modules', 'preact'),
  ]);
});

test('each package is credited with its own licence file, and one without stops the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-licenses-'));
  dirs.push(dir);
  const credited = join(dir, 'tiny-lib');
  await mkdir(credited);
  await writeFile(join(credited, 'package.json'), JSON.stringify({ name: 'tiny-lib', version: '1.2.3', license: 'MIT', repository: { url: 'git+https://example.com/tiny-lib.git' } }));
  await writeFile(join(credited, 'LICENSE.md'), 'Copyright (c) Robin Lark\n');
  const credit = await packageCredit(credited);
  assert.deepEqual(credit, { name: 'tiny-lib', version: '1.2.3', url: 'https://example.com/tiny-lib', licence: 'MIT', text: 'Copyright (c) Robin Lark' });
  assert.equal(
    licensesText([credit]).split('\n').slice(3).join('\n'),
    '\n\ntiny-lib 1.2.3\n==============\nMIT · https://example.com/tiny-lib\n\nCopyright (c) Robin Lark\n',
  );

  const bare = join(dir, 'bare-lib');
  await mkdir(bare);
  await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'bare-lib', version: '0.1.0' }));
  await assert.rejects(packageCredit(bare), /bare-lib has no licence file/);
});
