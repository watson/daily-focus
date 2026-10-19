/**
 * How this copy of Daily Focus was installed, for the commands it tells you to run.
 *
 * A checkout runs the TypeScript in `src/` directly and its commands are npm
 * scripts: `npm run service`. The npm package is the same code bundled into
 * `dist/` as JavaScript, and its commands are the CLI's: `daily-focus service`.
 * Which one this is shows in the extension of the running file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True in the npm package, false in a checkout. */
export const PACKAGED = import.meta.url.endsWith('.js');

/** The checkout, or the installed package: where `prompts/`, `schema/` and `public/` are. */
export const ROOT = resolve(import.meta.dirname, '..');

/**
 * Whether this copy is in npm's npx cache. npm replaces it when a newer version
 * is run and may clear it at any time, so nothing long-lived should point into it.
 */
export const IN_NPX_CACHE = ROOT.split(sep).includes('_npx');

export type Command = 'init' | 'service' | 'audit' | 'seed' | 'build-calendar';

/** The command to type for `name`, as this copy was installed: `npm run service -- --remove` or `daily-focus service --remove`. */
export function command(name: Command, args = ''): string {
  if (PACKAGED) return `daily-focus ${name}${args ? ` ${args}` : ''}`;
  return `npm run ${name === 'build-calendar' ? 'build:calendar' : name}${args ? ` -- ${args}` : ''}`;
}

/**
 * Whether the module at `url` is the file Node was asked to run.
 *
 * Only ever true for a source file. In the package every module is bundled into
 * the CLI's files, so a module comparing its own URL with the script Node ran
 * would find a match and start itself inside an unrelated command.
 */
export function ranDirectly(url: string): boolean {
  const file = fileURLToPath(url);
  return file.endsWith('.ts') && process.argv[1] !== undefined && resolve(process.argv[1]) === file;
}

/** This copy's version, from its `package.json`: a placeholder in a checkout. */
export function packageVersion(root: string = ROOT): string {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The calendar helper the Mac app carries, when the app runs this dashboard. Found
 * here by the dashboard itself rather than handed over by the app, so that a helper
 * set in Settings still wins, and the setting stays one the page can change.
 *
 * The app's own Node sits beside the helper in `Daily Focus.app/Contents/Helpers`,
 * wherever the dashboard it runs came from: the copy inside the app, or an update
 * the app downloaded to Application Support. Failing that, a copy inside the app
 * finds it from its own place, `Contents/Resources/server`.
 */
export function appCalendarApp(execPath: string, root: string): string | null {
  return appHelper(execPath, root, 'Daily Focus Calendar.app');
}

/** Where `name` would be in the Mac app's `Contents/Helpers`, found as `appCalendarApp` says; null outside the app. */
function appHelper(execPath: string, root: string, name: string): string | null {
  const contents = `.app${sep}Contents${sep}`;
  if (dirname(execPath).endsWith(`${contents}Helpers`)) return resolve(dirname(execPath), name);
  if (root.includes(`${contents}Resources${sep}`)) return resolve(root, '..', '..', 'Helpers', name);
  return null;
}

export const APP_CALENDAR_APP = appCalendarApp(process.execPath, ROOT);

/**
 * Where `daily-focus build-calendar` puts the calendar helper: outside the
 * package, which an update replaces, and in one place for every copy, since
 * macOS keeps the calendar permission with the helper that asked for it.
 */
export const USER_CALENDAR_APP = resolve(homedir(), 'Library', 'Application Support', 'Daily Focus', 'Daily Focus Calendar.app');

/**
 * Where to get the Mac app, which runs the dashboard from the menu bar, carries
 * the calendar helper and updates itself. On a Mac, that is the way to run Daily
 * Focus; the npm package is for Linux and Windows, and for anyone who would rather
 * run it themselves.
 */
export const MAC_APP_URL = 'https://dailyfocus.dev/setup/#install';

/**
 * Whether to point at the Mac app: true for the npm package on a Mac, run by
 * anything but the app. Never for a checkout, which is someone working on Daily
 * Focus itself.
 */
export function offerMacApp(platform: string = process.platform, packaged: boolean = PACKAGED, inApp: boolean = APP_CALENDAR_APP !== null): boolean {
  return platform === 'darwin' && packaged && !inApp;
}

/**
 * What the dashboard says as it starts from a terminal, about a better way to
 * run it: on a Mac, the app. Elsewhere, from npx, an install of its own under
 * the system's service manager, since npm replaces or clears npx's copy.
 */
export function startAdvice(macApp: boolean = offerMacApp(), inNpx: boolean = IN_NPX_CACHE): string[] {
  if (macApp) {
    return [
      'On a Mac, the Daily Focus app runs this for you from the menu bar. It starts',
      'at login, brings your calendar into the agenda, and updates itself:',
      MAC_APP_URL,
    ];
  }
  if (inNpx) {
    return [
      'Running from npx. To keep it running in the background, install it with',
      'npm install -g daily-focus and start it from your service manager:',
      'https://dailyfocus.dev/setup/#running',
    ];
  }
  return [];
}
