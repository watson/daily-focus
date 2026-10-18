/**
 * Which store a dashboard opens, and moving a store from before the profile
 * folders into its folder.
 *
 * The data folder, `~/.daily-focus` unless `--data` names another, holds one
 * store per profile: `work/` and `personal/`. Each still has its own dashboard,
 * as a store always has; the folder only keeps them together, so a computer
 * that briefs both has one place for Daily Focus rather than two.
 *
 * A dashboard told its profile at launch (`--profile`) opens that profile's
 * store. One that wasn't opens what is there: the profile it ran before a
 * restart, then a store from before the folders, then the one folder there is,
 * then `work/`. So `daily-focus` with no flags keeps opening the store it
 * always did.
 *
 * Before the folders, the data folder was the store. The first dashboard of
 * that store's profile to start moves it into its folder (`settleStore`), so a
 * personal dashboard never moves a work store, and two dashboards starting at
 * once never both move one. Everything in the data folder goes, the agent's
 * own leftovers included, by rename: nothing is copied, it takes no time, and
 * a folder that is a symlink or a mount point moves the same. It all gathers in
 * a staging folder that is renamed into place last, so a move cut short carries
 * on at the next start. A move that can't be done safely isn't attempted:
 * not out of the home folder or the top of a disk, which `--data ~` would
 * otherwise empty into `~/work`, and never over a profile folder that already
 * exists. Nothing is merged.
 *
 * A store's settings may name the other profile: the setup screen's finish
 * saves the answer to "What should your brief cover?" there, in a store that
 * began as `work/`. A dashboard not told its profile renames the folder to
 * match at its next start, when that name is free.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, parse } from 'node:path';

/**
 * Which half of a life an instance briefs. Each instance has its own store, server
 * and morning agent; the profile names the store's folder and picks their
 * defaults, so any setting can still override those.
 *
 * `personal` switches off the Jira board, which would otherwise poll for tickets
 * nobody on this instance has. The pull request board stays on: side projects
 * have pull requests too.
 */
export type Profile = 'work' | 'personal';

export const PROFILES: readonly Profile[] = ['work', 'personal'];

/**
 * Every name a store keeps at its top level. One of them in the data folder
 * itself is a store from before the folders, waiting to be moved into one.
 * `test/stores.test.ts` checks this against the paths in `Config`.
 */
export const STORE_ENTRIES: readonly string[] = [
  'actions.jsonl',
  'agent-settings.json',
  'agent.jsonl',
  'archive',
  'assistant',
  'assistant.jsonl',
  'assistant.md',
  'calendar.json',
  'copies.json',
  'focus.md',
  'items.json',
  'items.schema.json',
  'onboarding',
  'onboarding.json',
  'prompt.md',
  'prs.json',
  'settings.json',
  'sources.md',
  'tickets.json',
  'timezone.json',
];

/**
 * What says a folder holds a store: any of its files. Not its folders, whose
 * names (`archive`, `assistant`) are common enough to be anyone's.
 */
const STORE_FILES: readonly string[] = STORE_ENTRIES.filter((name) => !['archive', 'assistant', 'onboarding'].includes(name));

const STAGING_PREFIX = '.moving-';

export interface StoreLocation {
  /** The data folder, which holds a folder per profile. */
  root: string;
  profile: Profile;
  /** The store: the profile's folder, or the data folder itself while a store there waits to be moved. */
  dir: string;
  /** Whether the profile was given at launch, which nothing saved can change. */
  given: boolean;
  /**
   * What `settleStore` does before the store is read: move a store from before
   * the folders into the profile's folder, or rename the folder to the profile
   * its settings name.
   */
  move: null | { kind: 'into-folder' } | { kind: 'rename'; to: Profile };
  /** A move that looked due but can't be done safely, said on the page and in the log. */
  problem: string | null;
}

export interface StoreChoice {
  /** The profile given at launch, from `--profile` or `DAILY_FOCUS_PROFILE`. */
  asked?: Profile | null;
  /** The profile this process ran before a restart, which a restart keeps. */
  last?: Profile | null;
  home?: string;
}

/** `name` as a profile, null when it is none. */
export function asProfile(name: unknown): Profile | null {
  const value = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return (PROFILES as readonly string[]).includes(value) ? (value as Profile) : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stagingFor(root: string, profile: Profile): string {
  return join(root, `${STAGING_PREFIX}${profile}`);
}

/** The profile a store's settings name, if they name one. A file that doesn't read names none. */
export function savedProfile(dir: string): Profile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? asProfile((parsed as Record<string, unknown>).DAILY_FOCUS_PROFILE) : null;
  } catch {
    return null;
  }
}

/** The store entries lying in the data folder itself. */
function looseEntries(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => STORE_ENTRIES.includes(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A store from before the folders, in the data folder itself: its profile, and
 * what of it is there. A staging folder is one whose move was cut short.
 */
function olderStore(root: string): { profile: Profile; entries: string[] } | null {
  const entries = looseEntries(root);
  for (const profile of PROFILES) {
    const staging = stagingFor(root, profile);
    if (isDirectory(staging)) return { profile, entries: [...entries, basename(staging)] };
  }
  if (!entries.some((name) => STORE_FILES.includes(name))) return null;
  return { profile: savedProfile(root) ?? 'work', entries };
}

/** The home folder or the top of a disk, which no store is moved out of. */
function isUnmovable(root: string, home: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const resolved = real(root);
  return resolved === real(home) || resolved === parse(resolved).root;
}

function listed(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => `\`${name}\``);
  return names.length > 3 ? `${shown.join(', ')} and ${names.length - 3} more` : shown.join(', ');
}

/** Where the store is for `choice`, from what is in `root`, and what has to happen before it is read. Reads, never writes. */
export function findStore(root: string, choice: StoreChoice = {}): StoreLocation {
  const asked = choice.asked ?? null;
  const home = choice.home ?? homedir();
  const given = asked !== null;
  const wanted = asked ?? choice.last ?? null;
  const older = olderStore(root);
  if (older && (wanted === null || wanted === older.profile)) {
    const profile = older.profile;
    const folder = join(root, profile);
    const at = { root, profile, given };
    if (isUnmovable(root, home)) {
      return {
        ...at,
        dir: folder,
        move: null,
        problem:
          `\`${root}\` holds a store's files (${listed(older.entries)}), but it is your home folder or the top of a disk, ` +
          `so the dashboard won't move them into \`${folder}\`. It opens that folder instead.`,
      };
    }
    if (isDirectory(folder)) {
      return {
        ...at,
        dir: folder,
        move: null,
        problem:
          `\`${root}\` holds a store's files (${listed(older.entries)}) beside the \`${profile}\` folder. ` +
          `The dashboard uses \`${folder}\` and has left them where they are; an older version of Daily Focus may have written them.`,
      };
    }
    return { ...at, dir: root, move: { kind: 'into-folder' }, problem: null };
  }

  const found = PROFILES.filter((profile) => isDirectory(join(root, profile)));
  const profile = wanted ?? (found.length === 1 ? found[0]! : 'work');
  const dir = join(root, profile);
  const at = { root, profile, dir, given };
  const saved = given ? null : savedProfile(dir);
  if (saved && saved !== profile) {
    if (!isDirectory(join(root, saved))) return { ...at, move: { kind: 'rename', to: saved }, problem: null };
    return {
      ...at,
      move: null,
      problem: `\`${dir}\` is saved as a ${saved} store, but \`${join(root, saved)}\` already exists, so it stays ${profile}.`,
    };
  }
  return { ...at, move: null, problem: null };
}

/** Where the store will be, and for which profile, once `settleStore` has done what `location` says. */
export function settled(location: StoreLocation): { dir: string; profile: Profile } {
  const { move } = location;
  if (move?.kind === 'rename') return { dir: join(location.root, move.to), profile: move.to };
  if (move?.kind === 'into-folder') return { dir: join(location.root, location.profile), profile: location.profile };
  return { dir: location.dir, profile: location.profile };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put the store where `findStore` says it belongs, before anything reads it,
 * and say what moved. Only the server does this, as it starts: the scripts read
 * a store wherever it is.
 *
 * A move that fails part way throws, so no dashboard starts on half a store;
 * the next start carries on from the staging folder.
 */
export async function settleStore(location: StoreLocation, home: string = homedir()): Promise<{ location: StoreLocation; moved: string | null }> {
  const { root, profile, move } = location;
  if (move === null) return { location, moved: null };
  if (move.kind === 'rename') {
    const to = join(root, move.to);
    if (await exists(to)) throw new Error(`could not rename ${location.dir} to ${to}: it already exists`);
    await rename(location.dir, to);
    return {
      location: { ...findStore(root, { asked: move.to, home }), given: false },
      moved: `renamed ${location.dir} to ${to}, the ${move.to} store its settings name`,
    };
  }
  const folder = join(root, profile);
  const staging = stagingFor(root, profile);
  if (await exists(folder)) throw new Error(`could not move the store in ${root} into ${folder}: it already exists`);
  await mkdir(staging, { recursive: true });
  for (const name of await readdir(root)) {
    if ((PROFILES as readonly string[]).includes(name) || name.startsWith(STAGING_PREFIX)) continue;
    // A rename replaces a file it lands on, so a name both here and moved means
    // two copies of something, and which is current isn't this code's to guess.
    if (await exists(join(staging, name))) {
      throw new Error(`could not move ${join(root, name)} into ${folder}: ${join(staging, name)} is already there`);
    }
    await rename(join(root, name), join(staging, name));
  }
  await rename(staging, folder);
  return {
    location: { ...findStore(root, { asked: profile, home }), given: location.given },
    moved: `moved the ${profile} store in ${root} into ${folder}`,
  };
}
