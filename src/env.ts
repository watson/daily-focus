import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Where the store is when nothing says otherwise. */
export const DEFAULT_DATA_DIR = '~/.daily-focus';

/** The store's own settings, written by the dashboard's settings page and its setup screen. */
export const SETTINGS_FILE = 'settings.json';

/**
 * Settings that say where the store is and how the server listens. They are read
 * before the store's own settings can be, so they are never kept there: they are
 * the one thing taken from the environment, which is also how `cli.ts` passes
 * on `--data`, `--port` and `--host`, and how the menu bar app and a LaunchAgent
 * hand them over. Their defaults are right for almost everyone.
 */
export const LAUNCH_SETTINGS: readonly string[] = ['DAILY_FOCUS_DATA', 'DAILY_FOCUS_PORT', 'DAILY_FOCUS_HOST'];

/**
 * Settings by name, one string each, as `config.ts` builds the config from them.
 * The names are spelled like environment variables because they once were, and
 * `settings.json` still keeps them under those names.
 */
export type SettingValues = Readonly<Record<string, string | undefined>>;

/** `~` and `~/…` become the home directory; a bare command name (`gh`) is left for PATH. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (!p.includes('/')) return p;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * Read the store's `settings.json`: one string per setting, spelled as
 * `config.ts` reads it.
 *
 * A file that can't be read is reported rather than thrown. The settings page is
 * how this file gets fixed, and a dashboard that refused to start over it would
 * take the page down with it. Keys outside the project's prefix, and the launch
 * settings, are dropped: neither can mean anything here.
 */
export function readSettingsFile(path: string): { values: Record<string, string>; error: string | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, error: null };
    return { values: {}, error: `could not read ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { values: {}, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, error: `${path} should hold an object of settings` };
  }
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('DAILY_FOCUS_') || LAUNCH_SETTINGS.includes(key)) continue;
    // The page writes text, but a hand edit may well write 50 or true, which mean
    // what "50" and "true" do; read them so, rather than dropping them unsaid.
    if (typeof value === 'string') values[key] = value;
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') values[key] = String(value);
    else unreadable.push(key);
  }
  const error = unreadable.length > 0 ? `${path} has values that aren't text, a number or true/false: ${unreadable.join(', ')}` : null;
  return { values, error };
}

/**
 * Everywhere a setting can come from, kept apart so the settings page can say
 * which one a value came from, and so a save can be checked before it lands.
 */
export interface SettingSources {
  /** The launch settings, from the environment the dashboard was started with. */
  launch: Readonly<Record<string, string>>;
  /** The store's `settings.json`. */
  settings: Readonly<Record<string, string>>;
  /**
   * Settings the code that started the dashboard holds over the store's, which the
   * settings page shows and can't change. Only the demo has any, and tests: the
   * ones that would run a CLI or reach outside, so nothing switches them on.
   */
  fixed: Readonly<Record<string, string>>;
  settingsPath: string;
  /** Why `settings.json` couldn't be used, when it couldn't. */
  settingsError: string | null;
}

/**
 * Gather every source. The store is found first, from the environment alone,
 * since its own settings can't say where it is. Nothing else is taken from the
 * environment: a variable left exported in a shell can't change a setting the
 * page says is saved.
 */
export function settingSources(env: NodeJS.ProcessEnv = process.env, fixed: Readonly<Record<string, string>> = {}): SettingSources {
  const launch: Record<string, string> = {};
  for (const key of LAUNCH_SETTINGS) {
    const value = env[key]?.trim();
    if (value) launch[key] = value;
  }
  const dataDir = expandHome(launch.DAILY_FOCUS_DATA ?? DEFAULT_DATA_DIR);
  const settingsPath = resolve(dataDir, SETTINGS_FILE);
  const { values, error } = readSettingsFile(settingsPath);
  return { launch, settings: values, fixed, settingsPath, settingsError: error };
}

/**
 * The values the dashboard configures itself from: the launch settings, then
 * what is fixed, then the store's settings. A blank saved value is no value:
 * `config.ts` reads one as the default, and the settings page shows it so.
 */
export function layerSettings(sources: SettingSources, settings: Readonly<Record<string, string>> = sources.settings): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value.trim() !== '') kept[key] = value;
  }
  return { ...kept, ...sources.fixed, ...sources.launch };
}

/** The values as `loadConfig` reads them by default. */
export function loadSettings(): Record<string, string> {
  return layerSettings(settingSources());
}

/**
 * Where a checkout kept settings before the store had its own: the repo root.
 * Nothing reads it now. It is only looked for, so a dashboard started from a
 * checkout that still has one can say what it is ignoring.
 */
export const OLD_DOTENV_PATH = resolve(import.meta.dirname, '..', '.env');

/** What to say about a `.env` left at `path`, or null when there is none or it sets nothing. */
export function oldDotenvWarning(path: string = OLD_DOTENV_PATH): string | null {
  if (!existsSync(path)) return null;
  let keys: string[];
  try {
    const parsed = parseEnv(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    keys = Object.keys(parsed).filter((key) => key.startsWith('DAILY_FOCUS_') && (parsed[key] ?? '').trim() !== '');
  } catch {
    keys = [];
  }
  if (keys.length === 0) return null;
  const launch = keys.filter((key) => LAUNCH_SETTINGS.includes(key));
  const rest = keys.filter((key) => !LAUNCH_SETTINGS.includes(key));
  const parts = [`${path} is no longer read.`];
  if (rest.length > 0) parts.push(`Set ${rest.join(', ')} on the settings page instead.`);
  if (launch.length > 0) {
    const flags = launch.map((key) => `--${key.slice('DAILY_FOCUS_'.length).toLowerCase()}`);
    parts.push(`Give ${flags.join(', ')} when starting it, or set ${launch.join(', ')} in the environment.`);
  }
  parts.push('Then delete the file.');
  return parts.join(' ');
}
