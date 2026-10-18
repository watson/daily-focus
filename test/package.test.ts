/**
 * The npm package, built and run the way npm installs it: JavaScript under a
 * `node_modules` path, where Node refuses TypeScript, and every module bundled
 * into the CLI's files. Slow by this suite's standards, since it builds, but
 * nothing else catches a module that starts itself inside the bundle or a path
 * that only resolves in a checkout.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { OWN_CALENDAR_APP } from '../src/install.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
let home: string;
let pkg: string;

before(async () => {
  await run(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root });
  await run(process.execPath, [join(root, 'scripts/package.ts')], { cwd: root });
  home = await mkdtemp(join(tmpdir(), 'daily-focus-package-'));
  pkg = join(home, 'node_modules', 'daily-focus');
  await mkdir(pkg, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[] };
  for (const entry of ['package.json', ...manifest.files]) {
    // The calendar helper is there only once built: a release adds the one it signed.
    if (resolve(root, entry) === OWN_CALENDAR_APP && !existsSync(OWN_CALENDAR_APP)) continue;
    await cp(join(root, entry), join(pkg, entry), { recursive: true });
  }
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('the package ships what it runs and nothing it does not', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
    files: string[];
    private?: boolean;
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.private, undefined, 'a private package cannot be published');
  assert.equal(manifest.bin['daily-focus'], 'dist/cli.js');
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'the server needs nothing at runtime');
  for (const needed of ['dist/', 'public/app.js', 'prompts/', 'schema/']) assert.ok(manifest.files.includes(needed), needed);
  assert.ok(!manifest.files.some((entry) => entry.startsWith('src') || entry.startsWith('test')));
});

test('the package carries the calendar helper where the dashboard looks for its own', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[] };
  const own = relative(root, OWN_CALENDAR_APP).split(sep).join('/');
  assert.ok(manifest.files.includes(`${own}/`), `package.json ships ${own}`);
  const release = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(release.includes(`"$package/${own}"`), 'and the release puts the copy it signed there');
});

test('installed under node_modules, the demo starts and serves the sample brief', async () => {
  const child = spawn(process.execPath, [join(pkg, 'dist/cli.js'), '--demo', '--no-open', '--port', '0'], {
    cwd: home,
    env: { ...process.env, PATH: process.env.PATH, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((done, fail) => {
      let output = '';
      const timer = setTimeout(() => fail(new Error(`no dashboard line within 15s:\n${output}`)), 15_000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /dashboard {2}(http:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          done(match[1]!);
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('exit', (code) => fail(new Error(`exited ${code}:\n${output}`)));
    });
    type State = {
      items: unknown[];
      setup: { needed: boolean };
      board: { fetchedAt: string | null; rows: unknown[] };
      tickets: { fetchedAt: string | null; rows: unknown[] };
    };
    let state = (await (await fetch(`${url}/api/state`)).json()) as State;
    assert.ok(state.items.length > 5);
    assert.equal(state.setup.needed, false);
    // The boards fill in the background, from the bundled sample worlds.
    for (let i = 0; i < 100 && (state.board.fetchedAt === null || state.tickets.fetchedAt === null); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = (await (await fetch(`${url}/api/state`)).json()) as State;
    }
    assert.ok(state.board.rows.length > 0, 'the pull request board is filled');
    assert.ok(state.tickets.rows.length > 0, 'and so is the ticket board');
    assert.equal((await fetch(`${url}/app.js`)).status, 200, 'the page is shipped built');
    const health = (await (await fetch(`${url}/api/health`)).json()) as { dataDir: string };
    const prompt = await readFile(join(health.dataDir, 'prompt.md'), 'utf8');
    assert.match(prompt, /morning brief/i, "the store links to the package's own prompt");
  } finally {
    child.kill('SIGTERM');
    await new Promise((done) => child.once('exit', done));
  }
});

test('installed under node_modules, the commands name themselves as the CLI', async () => {
  const store = join(home, 'store');
  const { stdout } = await run(process.execPath, [join(pkg, 'dist/cli.js'), 'init', '--data', store], { cwd: home });
  assert.match(stdout, /daily-focus (service|--demo)/);
  assert.doesNotMatch(stdout, /npm run/);
});
