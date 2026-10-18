/**
 * Connecting GitHub and Jira from the page, against stand-ins for gh and acli
 * that say what the real ones say with no terminal, and wait for a file where
 * the real ones wait for the browser.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Connection, deviceCode } from '../src/connect.ts';
import type { FetchDeps } from '../src/tools.ts';
import type { Service } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fake {
  path: string;
  dir: string;
  /** Write it to have the browser part done. */
  entered: string;
  /** Write it to have the CLI signed in already. */
  signedIn: string;
  /** Every argument list it was run with, in order. */
  calls(): Promise<string[][]>;
}

/**
 * A gh or acli: its status says it is signed in once `signedIn` exists, in each
 * one's words; its login prints what the real one prints, waits for `entered`,
 * then ends as `then` says.
 */
async function fake(service: Service, then = 'process.exit(0);'): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-connect-'));
  dirs.push(dir);
  const entered = join(dir, 'entered');
  const signedIn = join(dir, 'signed-in');
  const log = join(dir, 'calls');
  const login =
    service === 'github'
      ? "process.stderr.write('! One-time code (AB12-CD34) copied to clipboard\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n');"
      : "process.stdout.write('⣽ Authenticating...');";
  const path = await fakeCli(
    join(dir, service === 'github' ? 'gh' : 'acli'),
    [
      `fs.appendFileSync(${quoted(log)}, JSON.stringify({ args, prompts: process.env.GH_PROMPT_DISABLED }) + '\\n');`,
      service === 'github'
        ? `if (args[0] === 'auth' && args[1] === 'status') { const hosts = fs.existsSync(${quoted(signedIn)}) ? { 'github.com': [{ login: 'alice', active: true, state: 'success' }] } : {}; say(JSON.stringify({ hosts })); process.exit(Object.keys(hosts).length ? 0 : 1); }`
        : `if (args[1] === 'auth' && args[2] === 'status') { if (fs.existsSync(${quoted(signedIn)})) { say('✓ Authenticated'); process.exit(0); } fail('✗ Error: not logged in'); }`,
      login,
      `while (!fs.existsSync(${quoted(entered)})) sleep(20);`,
      then,
    ].join('\n'),
  );
  return {
    path,
    dir,
    entered,
    signedIn,
    calls: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { args: string[] }).args),
  };
}

function connection(service: Service, cli: Fake | string, extra: { fetchDeps?: FetchDeps; toolsDir?: string } = {}) {
  const events = { connected: 0 };
  const path = typeof cli === 'string' ? cli : cli.path;
  const c = new Connection(
    service,
    { toolsDir: extra.toolsDir ?? join(tmpdir(), 'no-tools-here'), github: { ghPath: path }, jira: { acliPath: path } },
    { onChange: () => {}, onConnected: () => events.connected++, fetchDeps: extra.fetchDeps },
  );
  return { c, events };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("GitHub: gh's code and link are shown, and a finished sign-in says who", async () => {
  const gh = await fake('github', "process.stderr.write('✓ Authentication complete.\\n✓ Logged in as alice\\n'); process.exit(0);");
  const { c, events } = connection('github', gh);
  assert.deepEqual(c.view().cli, { found: true, fetched: false });

  c.start();
  await until(() => c.view().status === 'waiting', 'the code');
  assert.equal(c.view().code, 'AB12-CD34');
  assert.equal(c.view().url, 'https://github.com/login/device');
  assert.equal(c.busy, true);

  c.start();
  await writeFile(gh.entered, '');
  await until(() => c.view().status === 'done', 'the end');
  assert.deepEqual(
    { ...c.view(), cli: undefined },
    { cli: undefined, status: 'done', code: null, url: null, login: 'alice', error: null, command: null },
  );
  assert.equal(events.connected, 1, 'one sign-in, though Connect was pressed twice');
  assert.deepEqual(await gh.calls(), [
    ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'],
    ['auth', 'login', '--web', '--hostname', 'github.com'],
  ]);
});

test('a CLI signed in already is left as it is, unless asked to sign in again', async () => {
  const gh = await fake('github');
  await writeFile(gh.signedIn, '');
  const { c, events } = connection('github', gh);
  c.start();
  await until(() => c.view().status === 'done', 'the end');
  assert.equal(events.connected, 1);
  assert.deepEqual(await gh.calls(), [['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']], 'no sign-in');

  c.start(true);
  await until(() => c.view().status === 'waiting', 'the code');
  await c.cancel();
  assert.deepEqual((await gh.calls()).at(-1), ['auth', 'login', '--web', '--hostname', 'github.com'], 'again: a fresh sign-in');
});

test('Jira: acli waits on the browser, with no code to show, and connects when it comes back', async () => {
  const acli = await fake('jira');
  const { c, events } = connection('jira', acli);
  c.start();
  await until(() => c.view().status === 'waiting', 'the browser');
  assert.equal(c.view().code, null);
  await writeFile(acli.entered, '');
  await until(() => c.view().status === 'done', 'the end');
  assert.equal(events.connected, 1);
  assert.deepEqual(await acli.calls(), [
    ['jira', 'auth', 'status'],
    ['jira', 'auth', 'login', '--web'],
  ]);
});

test('a sign-in that fails says why, and how to finish in a terminal', async () => {
  const acli = await fake('jira', "fail('✗ Error: you must select a site in the terminal');");
  const { c, events } = connection('jira', acli);
  c.start();
  await until(() => c.view().status === 'waiting', 'the browser');
  await writeFile(acli.entered, '');
  await until(() => c.view().status === 'failed', 'the failure');
  assert.equal(c.view().error, 'you must select a site in the terminal');
  assert.match(c.view().command ?? '', /acli.* jira auth login --web$/);
  assert.equal(events.connected, 0);
});

test('cancelling stops the CLI and goes back to the button', async () => {
  const gh = await fake('github');
  const { c, events } = connection('github', gh);
  c.start();
  await until(() => c.view().status === 'waiting', 'the code');
  await c.cancel();
  assert.equal(c.busy, false, 'stopped by the time it resolves');
  assert.deepEqual({ ...c.view(), cli: undefined }, { cli: undefined, status: 'idle', code: null, url: null, login: null, error: null, command: null });
  assert.equal(events.connected, 0);
});

test('a CLI that isn\'t there is fetched first, and a fetch that fails says why', async () => {
  const toolsDir = await mkdtemp(join(tmpdir(), 'daily-focus-connect-tools-'));
  dirs.push(toolsDir);
  const seen: string[] = [];
  const fetchDeps: FetchDeps = {
    fetch: (async () => {
      seen.push('fetch');
      throw new Error('getaddrinfo ENOTFOUND acli.atlassian.com');
    }) as unknown as typeof fetch,
    run: async () => '',
    platform: process.platform,
    arch: 'arm64',
  };
  // `acli` by name, where there is none: neither on this PATH nor fetched.
  const path = process.env.PATH;
  process.env.PATH = toolsDir;
  try {
    const { c } = connection('jira', 'acli', { fetchDeps, toolsDir });
    assert.deepEqual(c.view().cli, { found: false, fetched: false });
    c.start();
    await until(() => c.view().status === 'failed', 'the failure');
    assert.deepEqual(seen, ['fetch']);
    assert.match(c.view().error ?? '', /couldn't reach acli\.atlassian\.com/);
  } finally {
    process.env.PATH = path;
  }
});

test("the code is read from either of gh's ways of saying it", () => {
  assert.equal(deviceCode('\n! First copy your one-time code: AB12-CD34\nOpen this URL…'), 'AB12-CD34', 'up to 2.98');
  assert.equal(deviceCode('! One-time code (AB12-CD34) copied to clipboard\nOpen this URL…'), 'AB12-CD34', 'by 2.102');
  assert.equal(deviceCode('Open this URL to continue in your web browser: https://github.com/login/device'), null, 'not yet');
});
