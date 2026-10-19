/**
 * Connecting GitHub and Jira from the page, against stand-ins for gh and acli
 * that say what the real ones say with no terminal, and wait for a file where
 * the real ones wait for the browser.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Connection, deviceCode, sitePrompt } from '../src/connect.ts';
import type { FetchDeps } from '../src/tools.ts';
import type { Service } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];

const made: Connection[] = [];

after(async () => {
  // A test that failed may have left a CLI waiting on its input; it must not hold the run open.
  for (const c of made) c.stop();
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

/**
 * What acli does after the browser: draw its question of which site, as it draws
 * every prompt, then take keys from its input: Down moves, Enter chooses, and the
 * choice is saved to `chosen`. Asked to stop, it saves the highlighted one and
 * reports success, as the real one does.
 */
function siteQuestion(sites: string[], chosen: string): string {
  return [
    `const sites = ${JSON.stringify(sites)};`,
    `const save = (i) => fs.writeFileSync(${quoted(chosen)}, sites[i] ?? 'none');`,
    "const done = (i) => { save(i); process.stdout.write('\\r✓ Authentication successful\\n'); process.exit(0); };",
    "process.on('SIGTERM', () => done(0));",
    "process.stdout.write('\\x1b[?25l\\r┃ Select the site to login          \\r\\n');",
    "process.stdout.write(sites.map((site, i) => '┃ ' + (i === 0 ? '> ' : '  ') + site + '          \\r\\n').join(''));",
    "process.stdout.write('\\r\\n↑ up • ↓ down • / filter • enter submit\\x1b[D');",
    "let typed = '';",
    "process.stdin.on('data', (d) => { typed += d.toString(); if (typed.includes('\\r')) done(typed.split('\\x1b[B').length - 1); });",
  ].join('\n');
}

function connection(
  service: Service,
  cli: Fake | string,
  extra: { fetchDeps?: FetchDeps; toolsDir?: string; platform?: NodeJS.Platform; spawnFn?: typeof spawn } = {},
) {
  const events = { connected: 0 };
  const path = typeof cli === 'string' ? cli : cli.path;
  const c = new Connection(
    service,
    { toolsDir: extra.toolsDir ?? join(tmpdir(), 'no-tools-here'), github: { ghPath: path }, jira: { acliPath: path } },
    {
      onChange: () => {},
      onConnected: () => events.connected++,
      fetchDeps: extra.fetchDeps,
      spawnFn: extra.spawnFn,
      // The pipe, as on macOS and Linux, wherever the tests run; Windows' window has its own test.
      platform: extra.platform ?? 'darwin',
    },
  );
  made.push(c);
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
    { cli: undefined, status: 'done', choices: null, inWindow: false, code: null, url: null, login: 'alice', error: null, command: null },
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
  assert.deepEqual({ ...c.view(), cli: undefined }, { cli: undefined, status: 'idle', choices: null, inWindow: false, code: null, url: null, login: null, error: null, command: null });
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

test("Jira: acli's question of which site is asked on the page, and the answer typed for it", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-connect-'));
  dirs.push(dir);
  const chosen = join(dir, 'chosen');
  const acli = await fake('jira', siteQuestion(['acme.atlassian.net', 'acme-sandbox.atlassian.net', 'acme-old.atlassian.net'], chosen));
  const { c, events } = connection('jira', acli);
  c.start();
  await until(() => c.view().status === 'waiting', 'the browser');
  await writeFile(acli.entered, '');
  await until(() => c.view().status === 'choosing', 'the question');
  assert.deepEqual(c.view().choices, ['acme.atlassian.net', 'acme-sandbox.atlassian.net', 'acme-old.atlassian.net']);
  assert.match(c.choose('elsewhere.atlassian.net') ?? '', /isn't one of the sites/);

  assert.equal(c.choose('acme-old.atlassian.net'), null);
  await until(() => c.view().status === 'done', 'the end');
  assert.equal(await readFile(chosen, 'utf8'), 'acme-old.atlassian.net', 'two Downs, then Enter');
  assert.equal(events.connected, 1);
});

test('one site is the one chosen in the browser, so nothing is asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-connect-'));
  dirs.push(dir);
  const chosen = join(dir, 'chosen');
  const acli = await fake('jira', siteQuestion(['acme.atlassian.net'], chosen));
  const seen: string[] = [];
  const { c } = connection('jira', acli);
  c.start();
  await until(() => c.view().status === 'waiting', 'the browser');
  await writeFile(acli.entered, '');
  const poll = setInterval(() => seen.push(c.view().status), 5);
  await until(() => c.view().status === 'done', 'the end');
  clearInterval(poll);
  assert.ok(!seen.includes('choosing'));
  assert.equal(await readFile(chosen, 'utf8'), 'acme.atlassian.net');
});

test('cancelling while it asks which site leaves acli no chance to choose one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-connect-'));
  dirs.push(dir);
  const chosen = join(dir, 'chosen');
  const acli = await fake('jira', siteQuestion(['acme.atlassian.net', 'acme-sandbox.atlassian.net'], chosen));
  const { c, events } = connection('jira', acli);
  c.start();
  await until(() => c.view().status === 'waiting', 'the browser');
  await writeFile(acli.entered, '');
  await until(() => c.view().status === 'choosing', 'the question');
  await c.cancel();
  assert.equal(c.view().status, 'idle');
  assert.equal(events.connected, 0, 'cancelled is never connected');
  assert.equal(existsSync(chosen), false, 'stopped outright, not asked to, which acli takes as choosing the highlighted site');
});

test("acli's site question is read once it is all drawn", () => {
  const drawn =
    '\u001b[?25l\r┃ Select the site to login                \r\n┃ > acme.atlassian.net          \r\n┃   acme-sandbox.atlassian.net   \r\n\r\n↑ up • ↓ down • / filter • enter submit\u001b[D';
  assert.deepEqual(sitePrompt(`⣽ Authenticating...${drawn}`)?.sites, ['acme.atlassian.net', 'acme-sandbox.atlassian.net']);
  assert.equal(sitePrompt(drawn.slice(0, drawn.indexOf('\r\n\r\n'))), null, 'not before the keys line under it');
  assert.equal(sitePrompt('┃ Select authentication method\r\n┃ > API Token\r\n┃   Web\r\n\r\nenter submit'), null, 'not another question');
});

test("on Windows acli signs in in a window of its own, and its status says how that went", async () => {
  const acli = await fake('jira');
  const started: { file: string; args: string[] }[] = [];
  const windows: EventEmitter[] = [];
  // PowerShell, as far as the test needs it: what it was asked to start, and a window that closes on cue.
  const spawnFn = ((file: string, args: string[]) => {
    started.push({ file, args });
    const window = Object.assign(new EventEmitter(), { pid: 4242, kill: () => window.emit('close', null) });
    windows.push(window);
    return window;
  }) as unknown as typeof spawn;

  const { c, events } = connection('jira', acli, { platform: 'win32', spawnFn });
  c.start();
  await until(() => c.view().status === 'waiting', 'the window');
  assert.equal(c.view().inWindow, true);
  assert.equal(started[0]!.file, 'powershell.exe');
  const script = Buffer.from(started[0]!.args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /^\$p = Start-Process -FilePath '.+acli.*' -ArgumentList 'jira','auth','login','--web' -Wait -PassThru; exit \$p\.ExitCode$/);

  // Closed before signing in: said so, with the command for a terminal.
  windows[0]!.emit('close', 1);
  await until(() => c.view().status === 'failed', 'the failure');
  assert.equal(c.view().error, 'the window closed before acli had signed in');
  assert.match(c.view().command ?? '', /jira auth login --web$/);

  // Closed after signing in: connected, by acli's own status.
  c.start();
  await until(() => c.view().status === 'waiting', 'the window again');
  await writeFile(acli.signedIn, '');
  windows[1]!.emit('close', 0);
  await until(() => c.view().status === 'done', 'the end');
  assert.equal(events.connected, 1);

  // Cancelled: the window goes, and nothing is connected.
  await rm(acli.signedIn);
  c.start(true);
  await until(() => c.view().status === 'waiting', 'the window once more');
  await c.cancel();
  assert.equal(c.view().status, 'idle');
  assert.equal(events.connected, 1);
});
