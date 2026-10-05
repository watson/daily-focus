import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { command, ranDirectly } from '../src/install.ts';

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, '../src/cli.ts');

test('the CLI says its version and how to use it', async () => {
  const { stdout: version } = await run(process.execPath, [cli, '--version']);
  assert.match(version.trim(), /^\d+\.\d+\.\d+/);
  const { stdout: help } = await run(process.execPath, [cli, '--help']);
  assert.match(help, /daily-focus --demo/);
  assert.match(help, /daily-focus service \[--remove\]/);
});

test('an unknown command or flag is refused, not ignored', async () => {
  for (const args of [['bogus'], ['--bogus'], ['init', 'extra']]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1, args.join(' '));
      assert.match(err.stderr ?? '', /^daily-focus: /);
      return true;
    });
  }
});

test('a checkout names its commands as npm scripts', () => {
  assert.equal(command('service', '--remove'), 'npm run service -- --remove');
  assert.equal(command('build-calendar'), 'npm run build:calendar');
});

test('only a source file counts as run directly, since every module of the package shares the CLI file', () => {
  const original = process.argv[1];
  try {
    process.argv[1] = '/pkg/dist/cli.js';
    assert.equal(ranDirectly(pathToFileURL('/pkg/dist/cli.js').href), false);
    process.argv[1] = '/repo/src/server.ts';
    assert.equal(ranDirectly(pathToFileURL('/repo/src/server.ts').href), true);
    assert.equal(ranDirectly(pathToFileURL('/repo/scripts/service.ts').href), false);
  } finally {
    process.argv.splice(1, 1, ...(original === undefined ? [] : [original]));
  }
});

test('a flag that belongs to another command is refused, not dropped', async () => {
  for (const args of [['seed', '--remove'], ['service', '--force'], ['init', '--no-open'], ['audit', '--demo']]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1, args.join(' '));
      assert.match(err.stderr ?? '', /doesn't apply to/);
      return true;
    });
  }
});
