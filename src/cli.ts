#!/usr/bin/env node
/**
 * `daily-focus`, the command the npm package installs.
 *
 *   npx daily-focus                  start the dashboard and open it
 *   npx daily-focus --demo           look around with sample data, in a throwaway store
 *   daily-focus service [--remove]   keep it running in the background on macOS
 *   daily-focus init | audit | seed | build-calendar
 *
 * Everything else happens in the dashboard: the setup steps on a new store, and
 * the settings page after. A checkout has the same commands as npm scripts.
 *
 * The subcommands are loaded only when asked for, after the flags have been
 * turned into the environment they read: each of them builds its config the
 * moment it loads.
 */

import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { IN_NPX_CACHE, ROOT, USER_CALENDAR_APP } from './install.ts';

const run = promisify(execFile);

const HELP = `Daily Focus: a dashboard for deciding what to work on today.

Usage
  daily-focus [options]            start the dashboard and open it in your browser
  daily-focus --demo               look around with sample data, in a throwaway store
  daily-focus service [--remove]   keep it running in the background (macOS)
  daily-focus init                 create the store with templates to edit by hand
  daily-focus audit [--against <items.json>]
                                   check the current brief against the contract
  daily-focus seed [--force]       write a sample brief to the store
  daily-focus build-calendar       build the macOS calendar helper for the live agenda

Options
  --data <dir>      the store (default ~/.daily-focus)
  --port <port>     the port to listen on (default 4321)
  --host <host>     the address to listen on (default 127.0.0.1)
  --profile <name>  work or personal, for a new store
  --no-open         don't open the browser
  -v, --version     print the version
  -h, --help        print this

Everything else is set up in the dashboard itself.`;

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Open `url` in the default browser, quietly: failing to is never worth stopping for. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

/** The browser opens for someone at a terminal, and never for launchd, an app, or CI. */
function shouldOpen(flag: boolean): boolean {
  return flag && process.stdout.isTTY === true && !process.env.CI;
}

/**
 * The demo: the dashboard on a throwaway store holding the sample brief, with
 * nothing connected and nothing that runs an agent, so it can be looked at
 * before anything is set up. The store is deleted on the way out.
 */
async function demo(open: boolean): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'daily-focus-demo-'));
  process.on('exit', () => rmSync(store, { recursive: true, force: true }));
  Object.assign(process.env, {
    DAILY_FOCUS_DATA: store,
    // Any free port unless one was asked for, so the demo never collides with
    // a dashboard already running on 4321.
    DAILY_FOCUS_PORT: process.env.DAILY_FOCUS_PORT ?? '0',
    DAILY_FOCUS_PROFILE: 'work',
    DAILY_FOCUS_AGENT: 'off',
    DAILY_FOCUS_ASSISTANT: 'off',
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_CALENDAR: 'off',
  });
  const { sampleBrief } = await import('./sample.ts');
  await writeFile(join(store, 'items.json'), `${JSON.stringify(sampleBrief(), null, 2)}\n`);
  await start(open, (url) => {
    console.log(`\n  The demo is at ${url}, with sample data in a throwaway store.`);
    console.log('  Nothing is connected and nothing runs. Stop it with Ctrl+C; the store goes with it.\n');
  });
}

async function start(open: boolean, onStarted?: (url: string) => void): Promise<void> {
  const { runServer } = await import('./server.ts');
  await runServer({
    onStarted: (url) => {
      onStarted?.(url);
      if (shouldOpen(open)) openInBrowser(url);
    },
  });
}

/**
 * Build the calendar helper and put it where every copy looks for it, outside
 * the package, which an update replaces. The script needs the Xcode command line
 * tools, so it is run here rather than shipped built.
 */
async function buildCalendar(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('The calendar helper reads Calendar.app, so it is macOS-only. Nothing to build.');
    return;
  }
  const script = join(ROOT, 'tools', 'dfcal', 'build.sh');
  const built = join(ROOT, 'tools', 'dfcal', 'build', 'Daily Focus Calendar.app');
  try {
    const { stdout } = await run('/bin/sh', [script]);
    process.stdout.write(stdout);
  } catch (err) {
    console.error((err as { stderr?: string }).stderr?.trim() || (err as Error).message);
    process.exitCode = 1;
    return;
  }
  await mkdir(join(USER_CALENDAR_APP, '..'), { recursive: true });
  rmSync(USER_CALENDAR_APP, { recursive: true, force: true });
  // `ditto` keeps the bundle's signature intact, which a plain copy may not.
  await run('/usr/bin/ditto', [built, USER_CALENDAR_APP]);
  console.log(`installed ${USER_CALENDAR_APP}`);
  console.log('Restart the dashboard, choose calendars in its settings, and allow access when macOS asks.');
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      data: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      profile: { type: 'string' },
      open: { type: 'boolean', default: true },
      demo: { type: 'boolean' },
      remove: { type: 'boolean' },
      force: { type: 'boolean' },
      against: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }

  // The flags are only another way to set the environment, which is how
  // everything below is configured.
  if (values.data !== undefined) process.env.DAILY_FOCUS_DATA = values.data;
  if (values.port !== undefined) process.env.DAILY_FOCUS_PORT = values.port;
  if (values.host !== undefined) process.env.DAILY_FOCUS_HOST = values.host;
  if (values.profile !== undefined) process.env.DAILY_FOCUS_PROFILE = values.profile;
  const open = values.open !== false;

  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`unexpected ${rest[0]}; see daily-focus --help`);

  switch (command) {
    case undefined:
    case 'start':
      if (values.demo) return demo(open);
      if (IN_NPX_CACHE) {
        console.log('  Running from npx. To keep it running in the background, install it:');
        console.log('  npm install -g daily-focus, then daily-focus service.\n');
      }
      return start(open);
    case 'service': {
      const { main: service } = await import('../scripts/service.ts');
      process.exitCode = await service(values.remove ? ['--remove'] : []);
      return;
    }
    // These three are scripts that do their work as they load, and read their
    // own flags from the command line.
    case 'init':
      await import('../scripts/init.ts');
      return;
    case 'audit':
      await import('../scripts/audit.ts');
      return;
    case 'seed':
      await import('../scripts/seed.ts');
      return;
    case 'build-calendar':
      return buildCalendar();
    default:
      throw new Error(`unknown command ${command}; see daily-focus --help`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`daily-focus: ${(err as Error).message}`);
  process.exitCode = 1;
}
