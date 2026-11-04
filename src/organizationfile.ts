/**
 * The organization setup the user adopted, as the store keeps it.
 *
 * `organization.json` records which setup is in use (the organization, the
 * commit it was read at, the settings it set and the files it pinned, each
 * with its SHA-256) and which setups the user said "Not now" to. The files
 * themselves are in `organization/`. The dashboard writes both, and only from
 * a click (`organization.ts`); this module only reads them, synchronously where
 * the settings are layered (`env.ts`) and just before a pinned file is run.
 *
 * Kept apart from `organization.ts`, which reads GitHub and checks a setup
 * against the settings page, so `env.ts` can read the record without importing
 * everything that page needs.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** The store file that records the setup in use and the ones put off. */
export const ORGANIZATION_FILE = 'organization.json';

/** The store folder the setup's files are kept in. */
export const ORGANIZATION_FOLDER = 'organization';

/**
 * The settings a setup may set to a file of its repository, under `files`:
 * each names a program the dashboard runs, so it is never set from `settings`,
 * where a setup could point it anywhere. The file is downloaded at the commit
 * the user approved and run only while it still has that commit's hash. Each
 * must be a program setting (`PROGRAM_SETTINGS` in `settings.ts`), which a test
 * checks; add one here only with the check before it runs.
 */
export const ORGANIZATION_FILE_SETTINGS: readonly string[] = ['DAILY_FOCUS_MERGE_HELPER'];

/** A file the setup pinned. */
export interface AdoptedFile {
  /** Where it is in the organization's repository. */
  source: string;
  /** Where it is kept, relative to the store: `organization/<name>`. */
  path: string;
  /** The hash the user approved, in hex. */
  sha256: string;
}

/** The setup in use. */
export interface AdoptedSetup {
  /** The organization's login, as GitHub spells it. */
  org: string;
  /** What the setup calls itself, for the page: "From Acme's setup". */
  name: string;
  /** `<org>/.daily-focus`. */
  repository: string;
  /** The GitHub account it was found as. */
  account: string;
  /** The commit everything here was read at. */
  commit: string;
  adoptedAt: string;
  /** The settings it sets, by name, as the review listed them. */
  settings: Record<string, string>;
  /** The files it pinned, by the setting each sets. */
  files: Record<string, AdoptedFile>;
  /** Where its suggested sources are in the repository, if it has any. Never written to `sources.md`. */
  sources: string | null;
}

/** A setup the user said "Not now" to, at one commit. A newer commit is offered again. */
export interface Dismissal {
  org: string;
  commit: string;
  at: string;
}

export interface OrganizationRecord {
  adopted: AdoptedSetup | null;
  dismissed: Dismissal[];
}

export const EMPTY_RECORD: OrganizationRecord = { adopted: null, dismissed: [] };

/** What the adopted setup adds to the settings: its name, and each value it sets, file settings as the stored file's full path. */
export interface OrganizationLayer {
  name: string;
  settings: Record<string, string>;
}

const SHA256 = /^[0-9a-f]{64}$/;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A path inside the store's organization folder, as the record keeps it, or null. */
function storedPath(value: unknown): string | null {
  const path = text(value);
  if (!path || isAbsolute(path) || path.includes('\\')) return null;
  const parts = path.split('/');
  if (parts.length !== 2 || parts[0] !== ORGANIZATION_FOLDER || ['', '.', '..'].includes(parts[1]!)) return null;
  return path;
}

/**
 * Read the record from what the file held. Forgiving, as the brief is: an
 * entry that doesn't read is dropped, and the rest stands. The dashboard is the
 * only writer, so anything odd here is a hand edit or a newer version.
 */
export function parseOrganizationRecord(raw: unknown): OrganizationRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_RECORD;
  const value = raw as Record<string, unknown>;
  const dismissed: Dismissal[] = [];
  if (Array.isArray(value.dismissed)) {
    for (const entry of value.dismissed as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { org, commit, at } = entry as Record<string, unknown>;
      const o = text(org);
      const c = text(commit);
      if (o && c) dismissed.push({ org: o, commit: c, at: text(at) ?? '' });
    }
  }
  return { adopted: parseAdopted(value.adopted), dismissed };
}

function parseAdopted(raw: unknown): AdoptedSetup | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const org = text(value.org);
  const commit = text(value.commit);
  if (!org || !commit) return null;
  const settings: Record<string, string> = {};
  if (typeof value.settings === 'object' && value.settings !== null && !Array.isArray(value.settings)) {
    for (const [key, setting] of Object.entries(value.settings)) {
      if (key.startsWith('DAILY_FOCUS_') && typeof setting === 'string' && setting.trim() !== '') settings[key] = setting;
    }
  }
  const files: Record<string, AdoptedFile> = {};
  if (typeof value.files === 'object' && value.files !== null && !Array.isArray(value.files)) {
    for (const [key, file] of Object.entries(value.files)) {
      if (!ORGANIZATION_FILE_SETTINGS.includes(key) || typeof file !== 'object' || file === null) continue;
      const entry = file as Record<string, unknown>;
      const path = storedPath(entry.path);
      const sha256 = text(entry.sha256)?.toLowerCase() ?? null;
      const source = text(entry.source);
      if (path && source && sha256 && SHA256.test(sha256)) files[key] = { source, path, sha256 };
    }
  }
  return {
    org,
    name: text(value.name) ?? org,
    repository: text(value.repository) ?? `${org}/.daily-focus`,
    account: text(value.account) ?? '',
    commit,
    adoptedAt: text(value.adoptedAt) ?? '',
    settings,
    files,
    sources: text(value.sources),
  };
}

/** Read `organization.json`. Missing is none; one that can't be read is none too, said why. */
export function readOrganizationRecord(path: string): { record: OrganizationRecord; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { record: EMPTY_RECORD, error: null };
    return { record: EMPTY_RECORD, error: `could not read ${path}: ${(err as Error).message}` };
  }
  try {
    return { record: parseOrganizationRecord(JSON.parse(raw)), error: null };
  } catch (err) {
    return { record: EMPTY_RECORD, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
}

/** The same, without holding up the event loop: for the check before a pinned file runs. */
export async function readOrganizationRecordAsync(path: string): Promise<OrganizationRecord> {
  try {
    return parseOrganizationRecord(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return EMPTY_RECORD;
  }
}

/** What the adopted setup sets, with each pinned file as its full path in `storeDir`; null when none is in use. */
export function organizationLayer(record: OrganizationRecord, storeDir: string): OrganizationLayer | null {
  const adopted = record.adopted;
  if (!adopted) return null;
  const settings: Record<string, string> = { ...adopted.settings };
  for (const [key, file] of Object.entries(adopted.files)) settings[key] = resolve(storeDir, file.path);
  return { name: adopted.name, settings };
}

/**
 * Whether `path` is in the store's organization folder, which every file a
 * setup pins is (`storedPath`): anything elsewhere is the user's own, and needs
 * no look at the record at all.
 */
export function inOrganizationFolder(storeDir: string, path: string): boolean {
  return resolve(path).startsWith(`${resolve(storeDir, ORGANIZATION_FOLDER)}${sep}`);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Whether the program at `path` may run, as far as an organization setup has
 * a say: null when it may, otherwise why not, to follow "it" in a sentence.
 *
 * A program the setup pinned runs only while it still has the hash the user
 * approved, read afresh each time, so a file changed since, by anyone, is never
 * run. Anything else in the setup's folder is refused too: nothing approved it.
 * A program elsewhere is the user's own, and this has nothing to say about it.
 */
export async function approvedFileProblem(storeDir: string, path: string): Promise<string | null> {
  if (!inOrganizationFolder(storeDir, path)) return null;
  const full = resolve(path);
  const record = await readOrganizationRecordAsync(resolve(storeDir, ORGANIZATION_FILE));
  const adopted = record.adopted;
  const pinned = adopted ? Object.values(adopted.files).find((file) => resolve(storeDir, file.path) === full) : undefined;
  if (!pinned) return `wasn't run: ${path} came with an organization's Daily Focus settings, but none in use approved it`;
  let bytes: Uint8Array;
  try {
    bytes = await readFile(full);
  } catch (err) {
    return `wasn't run: ${path} could not be read to check it is the file you approved (${(err as Error).message})`;
  }
  if (sha256(bytes) !== pinned.sha256) {
    return `wasn't run: ${path} has changed since you approved it with ${adopted!.name}'s Daily Focus settings, so its SHA-256 no longer matches`;
  }
  return null;
}
