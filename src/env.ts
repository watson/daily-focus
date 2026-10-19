import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

import { asProfile, findStore, PROFILES, type Profile, type StoreLocation } from './stores.ts';
import { fetchedBin } from './tools.ts';

/** Where the data folder is when nothing says otherwise: the stores are in it, a folder per profile. See `stores.ts`. */
export const DEFAULT_DATA_DIR = '~/.daily-focus';

/** The store's own settings, written by the dashboard's settings page and its setup screen. */
export const SETTINGS_FILE = 'settings.json';

/**
 * Settings that say where the data folder is and how the server listens. They
 * are read before the store's own settings can be, so they are never kept there:
 * they are taken from the environment, which is also how `cli.ts` passes on
 * `--data`, `--port` and `--host`, and how the menu bar app and a LaunchAgent
 * hand them over. Their defaults are right for almost everyone.
 */
export const LAUNCH_SETTINGS: readonly string[] = ['DAILY_FOCUS_DATA', 'DAILY_FOCUS_PORT', 'DAILY_FOCUS_HOST'];

/**
 * The profile, which is a little of both. Given at launch (`--profile`) it picks
 * the store in the data folder, and nothing saved can change it. Otherwise the
 * store's folder says it, and its settings keep the setup screen's answer, which
 * renames a new store's folder to match (see `stores.ts`). Either way the page
 * shows it and can't change it.
 */
export const PROFILE_SETTING = 'DAILY_FOCUS_PROFILE';

/** The profile given at launch, or null. One that is none of them is refused, before any store is touched. */
export function launchProfile(env: NodeJS.ProcessEnv = process.env): Profile | null {
  const raw = env[PROFILE_SETTING]?.trim();
  if (!raw) return null;
  const profile = asProfile(raw);
  if (!profile) throw new Error(`${PROFILE_SETTING} must be one of ${PROFILES.join(', ')}, got ${JSON.stringify(raw)}`);
  return profile;
}

/**
 * `--profile` from a script's own command line, put where the store is found
 * from: `npm run seed -- --profile personal` has no `daily-focus` in front to
 * pass it on.
 */
export function takeProfileFlag(argv: readonly string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({ args: [...argv], options: { profile: { type: 'string' } }, strict: false, allowPositionals: true });
  if (typeof values.profile === 'string') process.env[PROFILE_SETTING] = values.profile;
}

/**
 * The environment for a CLI the dashboard runs: the agent, the assistant, the
 * setup screen's sessions. The dashboard's own, except that `DAILY_FOCUS_DATA`
 * names the store itself, not the data folder the dashboard was given, so an
 * agent that honours it, as the morning prompts used to ask, works where it was
 * started.
 *
 * The gh and acli Daily Focus fetched, when it has, go on the end of PATH: the
 * prompts and `Bash(gh *)` name them by name alone, the folder holds nothing
 * else, and at the end a CLI of the user's own still comes first (`tools.ts`).
 */
export function cliEnvironment(
  config: { dataDir: string; toolsDir: string },
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, DAILY_FOCUS_DATA: config.dataDir };
  const fetched = fetchedBin(config.toolsDir);
  if (exists(fetched)) {
    const path = Object.keys(out).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    out[path] = [out[path], fetched].filter(Boolean).join(delimiter);
  }
  return out;
}

/** The data folder the environment names, with `~` expanded. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.DAILY_FOCUS_DATA?.trim() || DEFAULT_DATA_DIR);
}

/**
 * Settings by name, one string each, as `config.ts` builds the config from them.
 * The names are spelled like environment variables because they once were, and
 * `settings.json` still keeps them under those names.
 */
export type SettingValues = Readonly<Record<string, string | undefined>>;

/** A path in the home folder as `~/…`, for saying where something is. */
export function tilde(path: string, home: string = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

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
  /** The store, found in the data folder the launch settings name. */
  store: StoreLocation;
  /** The store's `settings.json`. */
  settings: Readonly<Record<string, string>>;
  settingsPath: string;
  /** Why `settings.json` couldn't be used, when it couldn't. */
  settingsError: string | null;
}

/**
 * Gather every source. The store is found first, from the environment alone,
 * since its own settings can't say where it is: the server passes the one it
 * settled on as it started (`stores.ts`), and anything else finds it where it
 * lies. Nothing else is taken from the environment: a variable left exported in
 * a shell can't change a setting the page says is saved.
 */
export function settingSources(
  env: NodeJS.ProcessEnv = process.env,
  store: StoreLocation = findStore(dataRoot(env), { asked: launchProfile(env) }),
): SettingSources {
  const launch: Record<string, string> = {};
  for (const key of LAUNCH_SETTINGS) {
    const value = env[key]?.trim();
    if (value) launch[key] = value;
  }
  const settingsPath = resolve(store.dir, SETTINGS_FILE);
  const { values, error } = readSettingsFile(settingsPath);
  return { launch, store, settings: values, settingsPath, settingsError: error };
}

/**
 * The values the dashboard configures itself from: the store, then the launch
 * settings, then the store's settings. A blank saved value is no value:
 * `config.ts` reads one as the default, and the settings page shows it so.
 *
 * `config.ts` reads `DAILY_FOCUS_DATA` as the store itself, so the data folder
 * the dashboard was given is replaced here by the store found in it, and the
 * profile by the one the store is for.
 */
export function layerSettings(sources: SettingSources, settings: Readonly<Record<string, string>> = sources.settings): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value.trim() !== '') kept[key] = value;
  }
  return {
    ...kept,
    ...sources.launch,
    DAILY_FOCUS_DATA: sources.store.dir,
    [PROFILE_SETTING]: sources.store.profile,
  };
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
