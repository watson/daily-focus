import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Where the optional `.env` lives: the repo root, never the working directory.
 *
 * A launchd job and a `node src/server.ts` run from somewhere else should read the
 * same file as `npm start` does, and the only path all three agree on is the one
 * relative to this source tree.
 */
export const DOTENV_PATH = resolve(import.meta.dirname, '..', '.env');

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
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (value !== undefined) parsed[key] = value;
  }
  return parsed;
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
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(fromFile)) {
    if (key.startsWith('DAILY_FOCUS_')) merged[key] = value;
  }
  return { ...merged, ...processEnv };
}

/** The environment the dashboard configures itself from: `.env` under the real one. */
export function loadEnv(path: string = DOTENV_PATH): NodeJS.ProcessEnv {
  return mergeEnv(readDotEnv(path), process.env);
}
