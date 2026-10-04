/**
 * `npm run service` — keep the dashboard running on macOS.
 *
 *   npm run service
 *   npm run service -- --remove
 *
 * `npm start` lasts as long as its terminal, and a dashboard that is down at 07:00
 * misses the morning's brief without anything on screen to say so. This installs a
 * LaunchAgent for the current user that starts the dashboard at login and again if
 * it crashes, then waits until it answers. Running it again rewrites the LaunchAgent
 * and restarts the dashboard, which is how a `git pull` or an edited `.env` takes
 * effect. `--remove` stops it and uninstalls it.
 *
 * The LaunchAgent is generated here rather than tracked, because everything in it
 * belongs to this machine: the checkout, the Node binary, and the PATH that finds
 * `gh`, `acli` and the agent's CLI. launchd hands a job almost no environment of its
 * own, so the PATH and any `DAILY_FOCUS_` variables are taken from the shell this
 * runs in. `.env` is not copied; the server reads it at every start.
 *
 * One service per store. The label is derived from the store's path, so a second
 * install against the same store replaces the first instead of starting a second
 * writer beside it, and a throwaway store can never displace the real service.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.ts';
import { command, IN_NPX_CACHE, PACKAGED, ranDirectly, ROOT } from '../src/install.ts';

const run = promisify(execFile);

/**
 * The launchd label for the dashboard on `dataDir`. The default store gets the
 * plain name; any other is named after its path, relative to home when it is
 * inside it, so the plist and the log say which store they belong to.
 */
export function serviceLabel(dataDir: string, home: string = homedir()): string {
  const fromHome = relative(home, dataDir);
  const where = fromHome !== '' && !fromHome.startsWith('..') && !isAbsolute(fromHome) ? fromHome : dataDir;
  const slug = where.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === 'daily-focus' ? 'local.daily-focus' : `local.daily-focus.${slug}`;
}

/** What launchd itself would give the job, kept so a sparse shell can't lose `ioreg` or `open`. */
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The service's PATH: this shell's, without what npm prepends for the script it
 * is running, with this Node first if the shell didn't have it. The CLIs npm
 * installs start with `#!/usr/bin/env node`, so they need Node on PATH to run.
 */
export function servicePath(path: string, nodeDir: string): string {
  const entries = path.split(':').filter((entry) => entry !== '' && !entry.split('/').includes('node_modules'));
  if (!entries.includes(nodeDir)) entries.unshift(nodeDir);
  return [...new Set([...entries, ...SYSTEM_PATH])].join(':');
}

/**
 * The environment the service keeps from this shell: PATH, and every
 * `DAILY_FOCUS_` variable, since a variable set in the environment beats `.env`
 * and is how a second instance on the same checkout is told apart.
 */
export function serviceEnvironment(env: NodeJS.ProcessEnv, nodeDir: string): Record<string, string> {
  const kept: Record<string, string> = { PATH: servicePath(env.PATH ?? '', nodeDir) };
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (key.startsWith('DAILY_FOCUS_') && value !== undefined) kept[key] = value;
  }
  return kept;
}

export interface ServiceSpec {
  label: string;
  /** The Node binary to run the server with. */
  node: string;
  /** The checkout, or the installed package, to run. */
  repo: string;
  /** Whether `repo` is the npm package, which runs its bundled CLI rather than building a checkout. */
  packaged: boolean;
  /** Where launchd writes the server's output. */
  log: string;
  env: Record<string, string>;
}

type PlistValue = string | boolean | readonly PlistValue[] | { readonly [key: string]: PlistValue };

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === 'boolean') return `${indent}<${value}/>`;
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.map((entry) => plistValue(entry, inner)), `${indent}</array>`].join('\n');
  }
  const lines = [`${indent}<dict>`];
  for (const [key, entry] of Object.entries(value)) {
    lines.push(`${inner}<key>${escapeXml(key)}</key>`, plistValue(entry, inner));
  }
  lines.push(`${indent}</dict>`);
  return lines.join('\n');
}

/** The LaunchAgent's property list. */
export function servicePlist(spec: ServiceSpec): string {
  const job: Record<string, PlistValue> = {
    Label: spec.label,
    // What `npm start` runs, the client build included, without npm in between:
    // after `exec` the job's process is the server itself, so launchd's SIGTERM
    // reaches the handler that closes it cleanly. Node arrives as `$0` rather than
    // spliced into the command, so its path never needs quoting.
    //
    // The npm package has nothing to build: the page is shipped built, and the
    // CLI starts the same server.
    ProgramArguments: spec.packaged
      ? [spec.node, join(spec.repo, 'dist', 'cli.js'), '--no-open']
      : ['/bin/sh', '-c', '"$0" scripts/build.ts && exec "$0" src/server.ts', spec.node],
    WorkingDirectory: spec.repo,
    EnvironmentVariables: spec.env,
    RunAtLoad: true,
    // Restarted after a crash but not after a clean stop: the server exits 0 on
    // SIGTERM, so one stopped by hand stays stopped until the next login.
    KeepAlive: { SuccessfulExit: false },
    StandardOutPath: spec.log,
    StandardErrorPath: spec.log,
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(job, ''),
    '</plist>',
    '',
  ].join('\n');
}

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function kept(label: string, detail = ''): void {
  console.log(`  \x1b[2m·\x1b[0m \x1b[2m${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
}
function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function isLoaded(target: string): Promise<boolean> {
  return run('/bin/launchctl', ['print', target]).then(
    () => true,
    () => false,
  );
}

/** Stop and unload the job if it is loaded. Returns whether it was. */
async function bootOut(target: string): Promise<boolean> {
  if (!(await isLoaded(target))) return false;
  await run('/bin/launchctl', ['bootout', target]).catch(() => {});
  // bootout can return while the job is still being torn down, and bootstrapping
  // it again before then fails with nothing more useful than an I/O error.
  for (let i = 0; i < 80 && (await isLoaded(target)); i++) await sleep(250);
  if (await isLoaded(target)) throw new Error(`launchd is still holding ${target}; try again in a moment`);
  return true;
}

/** What answers on the dashboard's port: null for nothing, a store path for a dashboard. */
async function occupant(url: string): Promise<{ dataDir: string | null } | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = res.ok ? ((await res.json().catch(() => ({}))) as { dataDir?: unknown }) : {};
    return { dataDir: typeof body.dataDir === 'string' ? body.dataDir : null };
  } catch {
    return null;
  }
}

async function listeningPid(port: number): Promise<string> {
  return run('/usr/sbin/lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']).then(
    ({ stdout }) => stdout.trim().split('\n')[0] ?? '',
    () => '',
  );
}

/** A wildcard bind is reached on loopback; anything else where it listens. */
function reachable(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

export async function main(args: readonly string[]): Promise<number> {
  const remove = args.includes('--remove');
  const unknown = args.filter((arg) => arg !== '--remove');
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown[0]}. Usage: ${command('service', '[--remove]')}`);
    return 1;
  }
  if (platform() !== 'darwin') {
    console.error(
      `${command('service')} installs a macOS LaunchAgent. Elsewhere, run ${PACKAGED ? '`daily-focus --no-open`' : '`npm start`'} under your own service manager.`,
    );
    return 1;
  }
  // npx keeps its copy in npm's cache, which the next version replaces and npm may
  // clear: a LaunchAgent pointing into it would stop working with no warning.
  if (IN_NPX_CACHE && !remove) {
    console.error(
      'This copy of Daily Focus is in npx\'s cache, which npm replaces or clears, so a service\n' +
        'pointing at it would stop working. Install it first, then run the service from there:\n\n' +
        '    npm install -g daily-focus\n    daily-focus service\n',
    );
    return 1;
  }

  const config = loadConfig();
  const label = serviceLabel(config.dataDir);
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${label}`;
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const log = join(homedir(), 'Library', 'Logs', `${label}.log`);

  console.log(`\n\x1b[1mDaily Focus — background service\x1b[0m`);
  console.log(`\x1b[2m${label}, for ${tilde(config.dataDir)} (${config.profile} profile)\x1b[0m\n`);

  if (await bootOut(target)) ok('stopped the service');

  if (remove) {
    const existed = await stat(plistPath).then(
      () => true,
      () => false,
    );
    await rm(plistPath, { force: true });
    if (existed) ok('removed the LaunchAgent', tilde(plistPath));
    else kept('no LaunchAgent was installed for this store');
    kept('the log is left in place', tilde(log));
    console.log();
    return 0;
  }

  // Something else on the port would leave the service failing to listen every ten
  // seconds, and the first anyone heard of it would be a missing dashboard.
  const url = `http://${reachable(config.host)}:${config.port}`;
  const found = await occupant(url);
  if (found) {
    const pid = await listeningPid(config.port);
    const by = pid ? ` (process ${pid})` : '';
    if (found.dataDir === config.dataDir) {
      bad(`this dashboard is already running at ${url}${by}`, 'stop the one started by hand, then run this again');
    } else if (found.dataDir) {
      bad(`port ${config.port} is taken by the dashboard for ${tilde(found.dataDir)}${by}`, 'give one of them its own DAILY_FOCUS_PORT');
    } else {
      bad(`port ${config.port} is taken by something else${by}`, 'set DAILY_FOCUS_PORT to a free one');
    }
    console.log();
    return 1;
  }

  const env = serviceEnvironment(process.env, dirname(process.execPath));
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(log), { recursive: true });
  await writeFile(plistPath, servicePlist({ label, node: process.execPath, repo: ROOT, packaged: PACKAGED, log, env }), 'utf8');
  ok('wrote the LaunchAgent', tilde(plistPath));
  kept('runs', `${tilde(ROOT)} on Node ${process.version}`);
  kept('kept from this shell', Object.keys(env).join(', '));

  // Only what this start writes is worth showing if it fails.
  const logFrom = await stat(log).then(
    (s) => s.size,
    () => 0,
  );
  try {
    await run('/bin/launchctl', ['bootstrap', domain, plistPath]);
  } catch (error) {
    bad('launchd refused the LaunchAgent', ((error as { stderr?: string }).stderr ?? String(error)).trim());
    console.log();
    return 1;
  }

  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    if ((await occupant(url))?.dataDir === config.dataDir) {
      ok('running', url);
      console.log(`\n  It starts at login and again if it crashes. Logs: ${tilde(log)}`);
      console.log(
        `  Run \`${command('service')}\` again after ${PACKAGED ? 'updating' : 'pulling'}; \`${command('service', '--remove')}\` to stop it.\n`,
      );
      return 0;
    }
    await sleep(250);
  }

  bad(`installed, but nothing answered at ${url} within 30 seconds`);
  const output = (await readFile(log).catch(() => Buffer.alloc(0))).subarray(logFrom).toString('utf8').trim();
  if (output) console.log(`\n${output.split('\n').slice(-20).map((line) => `    ${line}`).join('\n')}`);
  console.log(`\n  launchd retries after a crash. Full log: ${tilde(log)}. To stop it: ${command('service', '--remove')}\n`);
  return 1;
}

// Only run when executed directly, so tests can import the plist builders.
if (ranDirectly(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
