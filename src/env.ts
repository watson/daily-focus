import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Where the optional `.env` lives: the repo root, never the working directory.
 *
 * A launchd job and a `node src/server.ts` run from somewhere else should read the
 * same file as `npm start` does, and the only path all three agree on is the one
 * relative to this source tree.
 */
export const DOTENV_PATH = resolve(import.meta.dirname, '..', '.env');

/** Where the store is when nothing says otherwise. */
export const DEFAULT_DATA_DIR = '~/.daily-focus';

/** The store's own settings, written by the dashboard's settings page. */
export const SETTINGS_FILE = 'settings.json';

/**
 * Settings that say where the store is and how the server listens. They are read
 * before the store's own settings can be, so they are never kept there: they come
 * from the environment or `.env`, and their defaults are right for almost everyone.
 */
export const LAUNCH_SETTINGS: readonly string[] = ['DAILY_FOCUS_DATA', 'DAILY_FOCUS_PORT', 'DAILY_FOCUS_HOST'];

/** `~` and `~/…` become the home directory; a bare command name (`gh`) is left for PATH. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (!p.includes('/')) return p;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * Read a `.env` file into a plain record. A missing file is the normal case and
 * reads as empty; anything else that goes wrong is worth hearing about, since a
 * config file that silently fails to load looks exactly like a wrong default.
 *
 * Synchronous on purpose: `loadConfig` is called at module top level by every
 * script, and a config that has to be awaited would ripple through all of them.
 */
export function readDotEnv(path: string = DOTENV_PATH): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
  // Some editors save a byte-order mark, which parseEnv would keep as part of the
  // first key — and a key that doesn't start with the prefix is silently dropped.
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(text.replace(/^﻿/, '')))) {
    if (value !== undefined) parsed[key] = value;
  }
  return parsed;
}

/**
 * Read the store's `settings.json`: one string per setting, spelled as the
 * variable it stands for, so it layers exactly as `.env` does.
 *
 * Unlike `.env`, a file that can't be read is reported rather than thrown. The
 * settings page is how this file gets fixed, and a dashboard that refused to
 * start over it would take the page down with it. Keys outside the project's
 * prefix, and the launch settings, are dropped: neither can mean anything here.
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
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && key.startsWith('DAILY_FOCUS_') && !LAUNCH_SETTINGS.includes(key)) {
      values[key] = value;
    }
  }
  return { values, error: null };
}

/** Only the keys with the project prefix, so a stray `PATH=` line can't rewire the process. */
function prefixed(record: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('DAILY_FOCUS_') && value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * Layer the file beneath the real environment.
 *
 * The environment wins on conflict, which is the convention every other tool
 * follows and the only one that lets a single `DAILY_FOCUS_DATA=... npm start`
 * override a file without editing it. Only keys with the project prefix are
 * taken from the file, so a stray `PATH=` line can't rewire the process.
 */
export function mergeEnv(
  fromFile: Readonly<Record<string, string>>,
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...prefixed(fromFile), ...processEnv };
}

/**
 * Everywhere a setting can come from, kept apart so the settings page can say
 * which one a value came from, and so a save can be checked before it lands.
 */
export interface EnvSources {
  /** The repo's `.env`, from before the store had settings of its own. */
  dotenv: Readonly<Record<string, string>>;
  /** The store's `settings.json`. */
  settings: Readonly<Record<string, string>>;
  /** The real environment, which wins over both files. */
  process: NodeJS.ProcessEnv;
  settingsPath: string;
  /** Why `settings.json` couldn't be used, when it couldn't. */
  settingsError: string | null;
}

/**
 * Gather every source. The store is found first, from the environment and
 * `.env` alone, since its own settings can't say where it is.
 */
export function envSources(processEnv: NodeJS.ProcessEnv = process.env, dotenv: Record<string, string> = readDotEnv()): EnvSources {
  const merged = mergeEnv(dotenv, processEnv);
  const dataDir = expandHome((merged.DAILY_FOCUS_DATA ?? '').trim() || DEFAULT_DATA_DIR);
  const settingsPath = resolve(dataDir, SETTINGS_FILE);
  const { values, error } = readSettingsFile(settingsPath);
  return { dotenv: prefixed(dotenv), settings: values, process: processEnv, settingsPath, settingsError: error };
}

/**
 * The environment the dashboard configures itself from: the real one over the
 * store's settings over `.env`. The settings page writes the middle layer, so a
 * value saved there beats the older file, and anything set in the environment for
 * one launch — a test, a second instance, the LaunchAgent — still beats both.
 */
export function layerEnv(sources: EnvSources, settings: Readonly<Record<string, string>> = sources.settings): NodeJS.ProcessEnv {
  return { ...sources.dotenv, ...settings, ...sources.process };
}

/** The environment as `loadConfig` reads it by default. */
export function loadEnv(): NodeJS.ProcessEnv {
  return layerEnv(envSources());
}
