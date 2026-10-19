import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { appCalendarApp, appGh, command, defaultGh, MAC_APP_URL, offerMacApp, ranDirectly, startAdvice } from '../src/install.ts';

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, '../src/cli.ts');

/**
 * A data folder of the tests' own, which every run of the CLI is pointed at,
 * the ones expected to be refused included: a refusal that stops happening
 * would otherwise start a dashboard, or a script, on the default store.
 */
const sandbox = await mkdtemp(join(tmpdir(), 'daily-focus-cli-'));
after(() => rm(sandbox, { recursive: true, force: true }));
const run = (file: string, args: string[]) =>
  execute(file, args, { env: { ...process.env, DAILY_FOCUS_DATA: sandbox, DAILY_FOCUS_HOST: '127.0.0.1', DAILY_FOCUS_PORT: '0' } });

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

test('with --exit-with-stdin, the dashboard stops when whatever holds its input goes', async () => {
  const store = await mkdtemp(join(tmpdir(), 'daily-focus-lifeline-'));
  await mkdir(join(store, 'work'));
  // Nothing that reaches outside, saved in the store as the settings page would.
  await writeFile(join(store, 'work', 'settings.json'), JSON.stringify({ DAILY_FOCUS_GITHUB: 'off', DAILY_FOCUS_JIRA: 'off', DAILY_FOCUS_CALENDAR: 'off' }));
  const env = { ...process.env, DAILY_FOCUS_HOST: '127.0.0.1' };
  const child = spawn(process.execPath, [cli, '--data', store, '--no-open', '--exit-with-stdin', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((done, fail) => {
      let output = '';
      const timer = setTimeout(() => fail(new Error(`never listened:\n${output}`)), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (/dashboard {2}http:/.test(output)) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const exited = new Promise<number | null>((done) => child.once('exit', done));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((done) => setTimeout(() => done('still running'), 5_000))]);
    assert.equal(code, 0, 'stopped cleanly, as on SIGTERM');
  } finally {
    child.kill('SIGKILL');
    await rm(store, { recursive: true, force: true });
  }
});

test('the demo honours --profile, and fills its boards from sample data rather than gh and acli', async () => {
  const child = spawn(process.execPath, [cli, '--demo', '--no-open', '--port', '0', '--profile', 'personal'], {
    // Settings left exported in a shell, which nothing reads any more.
    env: { ...process.env, DAILY_FOCUS_HOST: '127.0.0.1', DAILY_FOCUS_JIRA: 'on', DAILY_FOCUS_AGENT: 'codex' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((done, fail) => {
      let output = '';
      const timer = setTimeout(() => fail(new Error(`never listened:\n${output}`)), 15_000);
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
    });
    type State = {
      setup: { profile: string };
      tickets: { enabled: boolean };
      board: { fetchedAt: string | null; rows: unknown[] };
      items: { source: string }[];
      agentRun: { enabled: boolean; runs: unknown[] };
    };
    let state = (await (await fetch(`${url}/api/state`)).json()) as State;
    for (let i = 0; i < 100 && state.board.fetchedAt === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = (await (await fetch(`${url}/api/state`)).json()) as State;
    }
    assert.equal(state.setup.profile, 'personal');
    assert.equal(state.tickets.enabled, false, 'the personal profile has no Jira, whatever the environment says');
    assert.equal(state.agentRun.enabled, false, 'nothing runs in the demo');
    assert.ok(state.agentRun.runs.length > 0, 'but the runs it would have made are there to read');
    assert.ok(state.board.rows.length > 0, 'the pull request board is filled from sample data');
    assert.ok(state.items.some((item) => item.source === 'eboks'), 'the personal brief');
  } finally {
    child.kill('SIGTERM');
    await new Promise((done) => child.once('exit', done));
  }
});

test('the demo refuses a profile it does not have, before making a store', async () => {
  await assert.rejects(run(process.execPath, [cli, '--demo', '--no-open', '--profile', 'home']), (err: { code?: number; stderr?: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr ?? '', /^daily-focus: --profile must be one of work, personal/);
    return true;
  });
});

test('a flag that belongs to another command is refused, not dropped', async () => {
  for (const args of [
    ['seed', '--remove'],
    ['service', '--force'],
    ['init', '--no-open'],
    ['audit', '--demo'],
    ['init', '--exit-with-stdin'],
    ['build-calendar', '--profile', 'personal'],
  ]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1, args.join(' '));
      assert.match(err.stderr ?? '', /doesn't apply to/);
      return true;
    });
  }
});

test('a profile that is neither is refused before anything starts', async () => {
  for (const args of [['--no-open', '--profile', 'home'], ['seed', '--profile', 'home'], ['init', '--profile', 'home']]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1, args.join(' '));
      assert.match(err.stderr ?? '', /^daily-focus: --profile must be one of work, personal, got "home"/);
      return true;
    });
  }
  assert.deepEqual(await readdir(sandbox), [], 'no store was made');
});

test("the Mac app's calendar helper is found beside its Node, wherever the dashboard came from", { skip: process.platform === 'win32' && "the Mac app's paths" }, () => {
  const app = '/Applications/Daily Focus.app';
  const helper = `${app}/Contents/Helpers/Daily Focus Calendar.app`;
  const node = `${app}/Contents/Helpers/node`;
  const update = '/Users/x/Library/Application Support/Daily Focus/Dashboards/0.2.0/Daily Focus Dashboard.bundle/Contents/Resources/server';
  assert.equal(appCalendarApp(node, `${app}/Contents/Resources/server`), helper, 'the copy inside the app');
  assert.equal(appCalendarApp(node, update), helper, 'an update the app downloaded');
  assert.equal(appCalendarApp(node, '/Users/x/code/daily-focus'), helper, 'a checkout the app was pointed at');
  assert.equal(appCalendarApp('/opt/homebrew/bin/node', `${app}/Contents/Resources/server`), helper, "the app's copy on another Node");
  assert.equal(appCalendarApp('/opt/homebrew/bin/node', '/Users/x/code/daily-focus'), null, 'no app at all');
  assert.equal(appCalendarApp('/opt/homebrew/bin/node', update), null, 'an update run by hand, outside the app');
});

test('the npm package on a Mac points at the Mac app, and nothing else does', () => {
  assert.equal(offerMacApp('darwin', true, false), true, 'the package, run from a terminal or a service');
  assert.equal(offerMacApp('darwin', true, true), false, 'the package inside the app');
  assert.equal(offerMacApp('darwin', false, false), false, 'a checkout');
  assert.equal(offerMacApp('linux', true, false), false);
  assert.equal(offerMacApp('win32', true, false), false);
});

test('starting from a terminal, a Mac is pointed at the app, and npx elsewhere at an install of its own', () => {
  const mac = startAdvice(true, true);
  assert.ok(mac.includes(MAC_APP_URL), 'a link to the app');
  assert.ok(!mac.join(' ').includes('npm install'), 'and no other way, from npx or not');
  assert.deepEqual(startAdvice(true, false), mac);
  const npx = startAdvice(false, true).join(' ');
  assert.match(npx, /npm install -g daily-focus/);
  assert.doesNotMatch(npx, /daily-focus service/, 'the service is a LaunchAgent, for a Mac');
  assert.deepEqual(startAdvice(false, false), [], 'an install of its own, or a checkout');
});

test("the Mac app's gh is used only when there is none on PATH", { skip: process.platform === 'win32' && "the Mac app's paths" }, () => {
  const app = '/Applications/Daily Focus.app';
  const gh = `${app}/Contents/Helpers/GitHub CLI/gh`;
  assert.equal(appGh(`${app}/Contents/Helpers/node`, `${app}/Contents/Resources/server`), gh, 'in a folder of its own, beside the Node');
  assert.equal(appGh('/opt/homebrew/bin/node', '/Users/x/code/daily-focus'), null, 'no app at all');
  const has = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(defaultGh(true, has(gh), gh), 'gh', "the user's own wins");
  assert.equal(defaultGh(false, has(gh), gh), gh, "none on PATH: the app's");
  assert.equal(defaultGh(false, has(), gh), 'gh', 'an app from before it carried one');
  assert.equal(defaultGh(false, has(), null), 'gh', 'the npm package, which never does');
});
