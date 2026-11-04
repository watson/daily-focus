/**
 * An organization's Daily Focus setup: found through the user's GitHub
 * sign-in, offered, and applied only when the user says so.
 *
 * An organization publishes its setup in a private repository of its own named
 * `.daily-focus`, as GitHub's own `.github` repository works, holding
 * `daily-focus.json`:
 *
 *   { "version": 1,
 *     "name": "Acme",
 *     "settings": { "DAILY_FOCUS_GITHUB_SCOPE": "org:acme" },
 *     "files": { "DAILY_FOCUS_MERGE_HELPER": "bin/merge-helper" },
 *     "sources": "sources.md" }
 *
 * `settings` are values for settings on the settings page, each checked as the
 * page would check it. `files` pins a setting that names a program to a file of
 * the repository: it is downloaded at the commit the user approved, kept in the
 * store, and run only while it still has that commit's hash. `sources` is a
 * snippet the user may copy into their own source list; nothing writes it to
 * `sources.md`, which only the user saves.
 *
 * Three rules hold throughout:
 *
 * - Discovery and updates only read GitHub, as the accounts the board reads as,
 *   at start and about once a day, and only while GitHub is on. A read that
 *   fails is a warning, never "no setup", and what was found before stands.
 * - Nothing applies without a click: "Use it" writes `organization.json` and
 *   the files and restarts, a newer commit changes nothing until the user
 *   applies it, and "Stop using" takes it all away. Nothing is written to GitHub.
 * - A pinned file runs only at the approved hash (`approvedFileProblem`).
 *
 * The public code names no organization: everything particular to one is in
 * its own repository.
 */

import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

import { loadConfig, type Config, type Profile } from './config.ts';
import { LAUNCH_SETTINGS, PROFILE_SETTING } from './env.ts';
import { writeJsonAtomic } from './fs.ts';
import {
  GhAuthError,
  RepositoryFileProblem,
  fetchOrganizations,
  fetchRepositoryFile,
  fetchSetupRepository,
  ghToken,
  listGhAccounts,
} from './github.ts';
import {
  EMPTY_RECORD,
  ORGANIZATION_FILE_SETTINGS,
  ORGANIZATION_FOLDER,
  organizationLayer,
  readOrganizationRecordAsync,
  sha256,
  type AdoptedFile,
  type AdoptedSetup,
  type OrganizationLayer,
  type OrganizationRecord,
} from './organizationfile.ts';
import { PERMISSION_SETTINGS, PROGRAM_SETTINGS, settingDef } from './settings.ts';
import { resolveTool } from './tools.ts';

/** The repository an organization keeps its setup in. */
export const SETUP_REPOSITORY = '.daily-focus';
/** The file in it that describes the setup. */
export const SETUP_FILE = 'daily-focus.json';
/** The version of the format this Daily Focus reads. */
export const SETUP_VERSION = 1;
/** How often a dashboard left running looks again. */
export const CHECK_EVERY_MS = 24 * 3_600_000;

/** The longest name a setup goes by on the page. */
const MAX_NAME = 60;
/** The most of a sources snippet kept: a list of sources, not a document. */
const MAX_SOURCES_CHARS = 64 * 1024;

/* ---------- the format ---------- */

/** A setting the setup names that it may not set, and why. */
export interface SkippedSetting {
  key: string;
  value: string;
  why: string;
}

/** A setting the setup pins to a file of its repository. */
export interface SetupFile {
  setting: string;
  path: string;
}

export interface SkippedFile {
  setting: string;
  path: string;
  why: string;
}

/** What `daily-focus.json` says, checked: what it may set, and what it may not with why. */
export interface ParsedSetup {
  name: string;
  /** The settings it may set, by name, in the order it gave them. */
  settings: Record<string, string>;
  skipped: SkippedSetting[];
  files: SetupFile[];
  skippedFiles: SkippedFile[];
  /** Where its suggested sources are in the repository. */
  sources: string | null;
  sourcesProblem: string | null;
}

/**
 * A path inside the repository, in the form GitHub takes it, or null for one
 * that isn't: empty, absolute, with a backslash, or with a `.` or `..` part
 * that could reach outside it.
 */
export function repositoryPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (path === '' || path.length > 512 || /[\\\0]/.test(path) || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How a value the setup gave reads in the review. */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

/** Why the settings page would refuse these values, or null. */
function refusal(values: Record<string, string>): string | null {
  try {
    loadConfig(values);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Check `daily-focus.json` as `org` published it. A whole setup is refused
 * only when it can't be read at all: not an object, or a version this
 * Daily Focus doesn't read. Anything else it names that it may not set is
 * skipped, with why, for the review to show.
 *
 * Each setting is checked as the settings page checks a save, by building the
 * config from it, on a store of this profile with nothing else set. A setting
 * that needs another (the morning agent's time needs its CLI) is checked with
 * the ones already accepted, so the order they are given in doesn't matter.
 */
export function parseSetup(raw: unknown, org: string, context: { profile: Profile; dataDir: string }): ParsedSetup | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `${SETUP_FILE} should hold an object` };
  const value = raw as Record<string, unknown>;
  if (value.version !== SETUP_VERSION) {
    if (value.version === undefined) {
      return { error: `${SETUP_FILE} doesn't say which version of the format it is in; this Daily Focus reads version ${SETUP_VERSION}` };
    }
    const newer = typeof value.version === 'number' && value.version > SETUP_VERSION;
    return {
      error:
        `${SETUP_FILE} is in version ${JSON.stringify(value.version)} of the format, and this Daily Focus reads version ${SETUP_VERSION}` +
        (newer ? '. Update Daily Focus to use it' : ''),
    };
  }
  for (const field of ['settings', 'files'] as const) {
    const given = value[field];
    if (given !== undefined && (typeof given !== 'object' || given === null || Array.isArray(given))) {
      return { error: `"${field}" in ${SETUP_FILE} should be an object, by setting name` };
    }
  }

  const name = typeof value.name === 'string' && value.name.trim() !== '' ? cut(value.name.replace(/\s+/g, ' ').trim(), MAX_NAME) : org;
  const skipped: SkippedSetting[] = [];
  const candidates: [string, string][] = [];
  for (const [key, given] of Object.entries((value.settings ?? {}) as Record<string, unknown>)) {
    const text = typeof given === 'string' ? given.trim() : (typeof given === 'number' && Number.isFinite(given)) || typeof given === 'boolean' ? String(given) : null;
    const why =
      LAUNCH_SETTINGS.includes(key) || key === PROFILE_SETTING
        ? 'says where the store is, which profile it is or how the dashboard listens, so only its start can set it'
        : !settingDef(key)
          ? 'is not a setting on the settings page'
          : PROGRAM_SETTINGS.includes(key)
            ? ORGANIZATION_FILE_SETTINGS.includes(key)
              ? 'names a program to run, so an organization sets it only under "files", to a file in its repository'
              : 'names a program to run, which an organization never sets'
            : PERMISSION_SETTINGS.includes(key)
              ? 'grants the coding CLIs tool permissions, which only you set'
              : text === null
              ? 'must be text'
              : text === ''
                ? 'is empty'
                : null;
    if (why) skipped.push({ key, value: shown(given), why });
    else candidates.push([key, text!]);
  }

  const base: Record<string, string> = { [PROFILE_SETTING]: context.profile, DAILY_FOCUS_DATA: context.dataDir };
  const accepted: Record<string, string> = {};
  let pending = candidates;
  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    const left: [string, string][] = [];
    for (const [key, text] of pending) {
      if (refusal({ ...base, ...accepted, [key]: text }) === null) {
        accepted[key] = text;
        progress = true;
      } else {
        left.push([key, text]);
      }
    }
    pending = left;
  }
  for (const [key, text] of pending) skipped.push({ key, value: text, why: refusal({ ...base, ...accepted, [key]: text })! });
  // In the order the setup gave them, whatever order they were accepted in.
  const settings: Record<string, string> = {};
  for (const [key] of candidates) if (key in accepted) settings[key] = accepted[key]!;

  const files: SetupFile[] = [];
  const skippedFiles: SkippedFile[] = [];
  for (const [setting, given] of Object.entries((value.files ?? {}) as Record<string, unknown>)) {
    const path = repositoryPath(given);
    if (!ORGANIZATION_FILE_SETTINGS.includes(setting)) {
      skippedFiles.push({
        setting,
        path: shown(given),
        why: `can't be set to a file; an organization pins files only for ${ORGANIZATION_FILE_SETTINGS.join(', ')}`,
      });
    } else if (!path) {
      skippedFiles.push({ setting, path: shown(given), why: 'is not a path inside the repository' });
    } else {
      files.push({ setting, path });
    }
  }

  let sources: string | null = null;
  let sourcesProblem: string | null = null;
  if (value.sources !== undefined && value.sources !== null) {
    sources = repositoryPath(value.sources);
    if (!sources) sourcesProblem = `"sources" is ${shown(value.sources)}, which is not a path inside the repository`;
  }

  return { name, settings, skipped, files, skippedFiles, sources, sourcesProblem };
}

/* ---------- reading GitHub ---------- */

/** An account the board reads as, with its token, or why there is none. */
export interface AccountToken {
  login: string;
  token: string | null;
  error: string | null;
}

/** Discovery's reads, gathered so a test can supply its own. Every one only reads. */
export interface OrganizationReads {
  /** A token for each account the board reads as: the configured ones, or gh's active one. */
  accounts(): Promise<AccountToken[]>;
  /** The organizations an account is in, by login. */
  organizations(token: string): Promise<string[]>;
  /** `<org>/.daily-focus`'s default branch and the commit it is at, or null when there is none (GitHub's 404). */
  repository(token: string, org: string): Promise<{ branch: string; commit: string } | null>;
  /** A file of `repo` at `commit`, or null when it isn't there. Throws `RepositoryFileProblem` for one that can't be used. */
  file(token: string, repo: string, path: string, commit: string): Promise<Uint8Array | null>;
}

/** The real reads: gh's tokens, as the board borrows them, and GitHub's REST API. */
export function githubReads(config: Config): OrganizationReads {
  return {
    async accounts() {
      const gh = resolveTool('gh', config.github.ghPath, config.toolsDir);
      if (config.github.accounts.length > 0) {
        return Promise.all(
          config.github.accounts.map(async (login): Promise<AccountToken> => {
            try {
              return { login, token: await ghToken(gh.path, login), error: null };
            } catch (err) {
              return { login, token: null, error: (err as Error).message };
            }
          }),
        );
      }
      const known = await listGhAccounts(gh.path);
      const active = known.find((account) => account.active) ?? known[0];
      if (!active) throw new GhAuthError('gh is not signed in to GitHub');
      return [{ login: active.login, token: await ghToken(gh.path, null), error: null }];
    },
    organizations: fetchOrganizations,
    repository: (token, org) => fetchSetupRepository(token, org, SETUP_REPOSITORY),
    file: fetchRepositoryFile,
  };
}

/** A setup found, with everything the review shows and "Use it" writes, read at one commit. */
interface Found {
  org: string;
  account: string;
  repository: string;
  branch: string;
  commit: string;
  setup: ParsedSetup;
  /** Each pinned file's bytes and hash, by setting: what "Use it" writes, exactly as the review showed it. */
  files: Map<string, { source: string; bytes: Uint8Array; sha256: string }>;
  sourcesText: string | null;
}

/** What reading one organization came to. A read that failed throws instead. */
type Reading = { kind: 'none' } | { kind: 'found'; found: Found } | { kind: 'unusable'; warning: string };

/* ---------- what the page is told ---------- */

/** A setup the page offers: one found while none is in use, or a newer commit of the one that is. */
export interface OrganizationOffer {
  org: string;
  name: string;
  commit: string;
  kind: 'new' | 'update';
  /** The user said "Not now" to this commit: the banner leaves it out, the settings page still lists it. */
  dismissed: boolean;
}

/** Organization setups, for every tab. Nothing a setup suggests as sources: that is asked for with its review. */
export interface OrganizationState {
  /** Whether it looks at all, which it does only while GitHub is on. */
  enabled: boolean;
  checking: boolean;
  checkedAt: string | null;
  adopted: { org: string; name: string; repository: string; commit: string; adoptedAt: string } | null;
  offers: OrganizationOffer[];
  warnings: string[];
}

export type Change = 'added' | 'changed' | 'same';

export interface ReviewSetting {
  key: string;
  label: string;
  value: string;
  change: Change;
  /** What the setup in use sets it to, for an update that changes it. */
  was: string | null;
}

export interface ReviewFile {
  setting: string;
  label: string;
  path: string;
  /** The file on GitHub at the commit. */
  url: string;
  sha256: string;
  /** Its size in bytes; null for the setup in use when it hasn't been read again. */
  size: number | null;
  change: Change;
  /** The hash the user approved before, for an update that changes it. */
  was: string | null;
}

/** Everything a setup would do, for the user to say yes or no to. Asked for on its own: it carries the sources snippet. */
export interface OrganizationReview {
  org: string;
  name: string;
  kind: 'new' | 'update';
  repository: string;
  account: string;
  branch: string;
  commit: string;
  /** The repository on GitHub at the commit. */
  url: string;
  /** For an update, what changed on GitHub between the commit in use and this one. */
  compareUrl: string | null;
  adoptedCommit: string | null;
  dismissed: boolean;
  settings: ReviewSetting[];
  /** Settings the setup in use sets that this commit no longer does. */
  removed: { key: string; label: string; was: string }[];
  skipped: (SkippedSetting & { label: string | null })[];
  files: ReviewFile[];
  removedFiles: { setting: string; label: string; path: string }[];
  skippedFiles: SkippedFile[];
  sources: { path: string; url: string; text: string } | null;
  sourcesProblem: string | null;
}

/* ---------- the setups ---------- */

export interface OrganizationDeps {
  /** Every change worth showing. */
  onChange(): void;
  /**
   * Why a setup's values can't be used with the store's own settings, or null:
   * the config built from both, as the next start will build it.
   */
  check(layer: OrganizationLayer): string | null;
  reads?: OrganizationReads;
  now?: () => Date;
}

const key = (org: string): string => org.toLowerCase();
const short = (commit: string): string => commit.slice(0, 7);

function fileUrl(repository: string, commit: string, path: string): string {
  return `https://github.com/${repository}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** A file name for the store, from its name in the repository: plain characters only. */
function storedName(source: string, setting: string, taken: ReadonlySet<string>): string {
  const plain = posix.basename(source).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || 'file';
  const name = taken.has(plain.toLowerCase()) ? `${setting.toLowerCase().replace(/_/g, '-')}-${plain}` : plain;
  return name.endsWith('.tmp') ? `${name}-file` : name;
}

/**
 * The organization setups found and the one in use.
 *
 * What was found is kept in memory, read again at start and once a day, and
 * only what the user adopts is written, to `organization.json` and its folder.
 * Nothing here throws past `check()` or `view()`, which run with nobody
 * awaiting them or inside every state the server sends.
 */
export class Organizations {
  readonly #config: Config;
  readonly #deps: OrganizationDeps;
  readonly #reads: OrganizationReads;
  readonly #now: () => Date;

  #record: OrganizationRecord = EMPTY_RECORD;
  /** The setups found, by lowercased organization. */
  #found = new Map<string, Found>();
  #warnings: string[] = [];
  #checking: Promise<void> | null = null;
  #checkedAt: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** The write in progress, which the next waits for. */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(config: Config, deps: OrganizationDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#reads = deps.reads ?? githubReads(config);
    this.#now = deps.now ?? (() => new Date());
  }

  /** Discovery runs only while GitHub is on: with it off, nothing here reads anything. */
  get enabled(): boolean {
    return this.#config.github.enabled;
  }

  /** Read what the store holds, then look once in the background, and once a day after. */
  async start(): Promise<void> {
    await this.load();
    if (!this.enabled || this.#stopped) return;
    this.#timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.#timer.unref();
    void this.check();
  }

  async load(): Promise<void> {
    this.#record = await readOrganizationRecordAsync(this.#config.organizationFile);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Look now. Joins a look already going. Never rejects. */
  check(): Promise<void> {
    if (!this.enabled || this.#stopped) return Promise.resolve();
    if (this.#checking) return this.#checking;
    this.#checking = this.#look()
      .catch((err: unknown) => {
        // A failed read is not "none": what was found before stands.
        this.#warnings = [`Couldn't look for your organizations' Daily Focus settings: ${(err as Error).message}`];
      })
      .finally(() => {
        this.#checking = null;
        this.#checkedAt = this.#now().toISOString();
        for (const warning of this.#warnings) console.warn(`[daily-focus] ${warning}`);
        if (!this.#stopped) this.#deps.onChange();
      });
    this.#deps.onChange();
    return this.#checking;
  }

  async #look(): Promise<void> {
    const accounts = await this.#reads.accounts();
    const warnings: string[] = [];
    const found = new Map<string, Found>();
    /** Organizations read, whatever came of it. */
    const seen = new Set<string>();
    /** Organizations whose read failed, whose last find stands. */
    const failed = new Set<string>();
    let incomplete = false;

    // Each organization, with every account that is in it: a private setup
    // repository looks missing to an account that can't see it, so one
    // account's "none" is not the organization's.
    const byOrg = new Map<string, { org: string; tries: { login: string; token: string }[] }>();
    /** Accounts whose organizations were listed: only they can say a setup is gone. */
    const listed = new Set<string>();
    for (const account of accounts) {
      if (!account.token) {
        warnings.push(`Couldn't look for your organizations' Daily Focus settings as ${account.login}: ${account.error ?? 'no token'}`);
        incomplete = true;
        continue;
      }
      let orgs: string[];
      try {
        orgs = await this.#reads.organizations(account.token);
      } catch (err) {
        warnings.push(`Couldn't list the organizations ${account.login} is in, to look for their Daily Focus settings: ${(err as Error).message}`);
        incomplete = true;
        continue;
      }
      listed.add(account.login);
      for (const org of orgs) {
        const entry = byOrg.get(key(org)) ?? { org, tries: [] };
        entry.tries.push({ login: account.login, token: account.token });
        byOrg.set(key(org), entry);
      }
    }

    // Through each account in turn until one finds it, or reads a setup it
    // can't use; a failed read counts only when no account found it.
    const outcomes = await Promise.all(
      [...byOrg.values()].map(async ({ org, tries }) => {
        const errors: string[] = [];
        for (const { login, token } of tries) {
          try {
            const reading = await this.#read(login, token, org);
            if (reading.kind !== 'none') return { org, reading, errors: [] };
          } catch (err) {
            errors.push(`as ${login}: ${(err as Error).message}`);
          }
        }
        return { org, reading: null, errors };
      }),
    );
    for (const { org, reading, errors } of outcomes) {
      seen.add(key(org));
      if (reading?.kind === 'found') found.set(key(org), reading.found);
      else if (reading?.kind === 'unusable') warnings.push(reading.warning);
      else if (errors.length > 0) {
        warnings.push(`Couldn't look for ${org}'s Daily Focus settings ${errors.join('; ')}`);
        failed.add(key(org));
      }
    }

    // What couldn't be read this time stands as it was last read: an account
    // that couldn't list its organizations may be the one that found it.
    // So does one whose finder couldn't be asked this time: another account
    // that can't see a private repository finds nothing, which proves nothing.
    for (const [org, previous] of this.#found) {
      const unasked = incomplete && (!seen.has(org) || !listed.has(previous.account));
      if (!found.has(org) && (failed.has(org) || unasked)) found.set(org, previous);
    }
    this.#found = found;
    this.#warnings = warnings;
  }

  /** Read one organization's setup. Throws when GitHub couldn't be read, which is not the same as no setup. */
  async #read(account: string, token: string, org: string): Promise<Reading> {
    const repo = await this.#reads.repository(token, org);
    if (!repo) return { kind: 'none' };
    const repository = `${org}/${SETUP_REPOSITORY}`;
    // The same commit as last time is the same setup: nothing to read again.
    const previous = this.#found.get(key(org));
    if (previous && previous.commit === repo.commit) return { kind: 'found', found: previous };

    const where = `${repository} at ${short(repo.commit)}`;
    let bytes: Uint8Array | null;
    try {
      bytes = await this.#reads.file(token, repository, SETUP_FILE, repo.commit);
    } catch (err) {
      if (err instanceof RepositoryFileProblem) return { kind: 'unusable', warning: `${org}'s Daily Focus settings can't be used: ${err.message} in ${where}` };
      throw err;
    }
    if (!bytes) return { kind: 'unusable', warning: `${repository} has no ${SETUP_FILE} on its default branch, ${repo.branch}` };
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      // Not the parser's own words: they quote the file, and its values may be private.
      return { kind: 'unusable', warning: `${org}'s Daily Focus setup can't be used: ${SETUP_FILE} in ${where} is not valid JSON` };
    }
    const parsed = parseSetup(raw, org, { profile: this.#config.profile, dataDir: this.#config.dataDir });
    if ('error' in parsed) return { kind: 'unusable', warning: `${org}'s Daily Focus settings can't be used: ${parsed.error}` };

    const setup: ParsedSetup = { ...parsed, files: [], skippedFiles: [...parsed.skippedFiles] };
    const files = new Map<string, { source: string; bytes: Uint8Array; sha256: string }>();
    for (const file of parsed.files) {
      try {
        const content = await this.#reads.file(token, repository, file.path, repo.commit);
        if (!content) {
          setup.skippedFiles.push({ ...file, why: `isn't in the repository at ${short(repo.commit)}` });
          continue;
        }
        files.set(file.setting, { source: file.path, bytes: content, sha256: sha256(content) });
        setup.files.push(file);
      } catch (err) {
        if (!(err instanceof RepositoryFileProblem)) throw err;
        setup.skippedFiles.push({ ...file, why: err.message });
      }
    }

    let sourcesText: string | null = null;
    if (parsed.sources) {
      try {
        const content = await this.#reads.file(token, repository, parsed.sources, repo.commit);
        if (content) sourcesText = cut(new TextDecoder().decode(content), MAX_SOURCES_CHARS);
        else setup.sourcesProblem = `${parsed.sources} isn't in the repository at ${short(repo.commit)}`;
      } catch (err) {
        if (!(err instanceof RepositoryFileProblem)) throw err;
        setup.sourcesProblem = err.message;
      }
    }

    return { kind: 'found', found: { org, account, repository, branch: repo.branch, commit: repo.commit, setup, files, sourcesText } };
  }

  #dismissed(org: string, commit: string): boolean {
    return this.#record.dismissed.some((entry) => key(entry.org) === key(org) && entry.commit === commit);
  }

  /** What the page needs to offer a setup, never what it suggests as sources. */
  view(): OrganizationState {
    const adopted = this.#record.adopted;
    const offers: OrganizationOffer[] = [];
    for (const found of this.#found.values()) {
      // One setup at a time: while one is in use, only its own newer commits are offered.
      if (adopted && (key(found.org) !== key(adopted.org) || found.commit === adopted.commit)) continue;
      offers.push({
        org: found.org,
        name: found.setup.name,
        commit: found.commit,
        kind: adopted ? 'update' : 'new',
        dismissed: this.#dismissed(found.org, found.commit),
      });
    }
    return {
      enabled: this.enabled,
      checking: this.#checking !== null,
      checkedAt: this.#checkedAt,
      adopted: adopted
        ? { org: adopted.org, name: adopted.name, repository: adopted.repository, commit: adopted.commit, adoptedAt: adopted.adoptedAt }
        : null,
      offers,
      warnings: [...this.#warnings],
    };
  }

  /** Everything `org`'s setup would do, against the one in use for an update; null when none from it is offered. */
  review(org: string): OrganizationReview | null {
    const found = this.#found.get(key(org));
    const adopted = this.#record.adopted;
    if (!found) return adopted && key(adopted.org) === key(org) ? this.#inUse(adopted) : null;
    if (adopted && key(adopted.org) !== key(found.org)) return null;
    const label = (setting: string): string => settingDef(setting)?.label ?? setting;
    const before = adopted ?? null;
    const changeOf = (now: string, was: string | undefined): Change => (before === null || was === undefined ? 'added' : now === was ? 'same' : 'changed');

    const settings = Object.entries(found.setup.settings).map(([setting, value]): ReviewSetting => {
      const was = before?.settings[setting];
      const change = before ? changeOf(value, was) : 'added';
      return { key: setting, label: label(setting), value, change, was: change === 'changed' ? was! : null };
    });
    const removed = before
      ? Object.entries(before.settings)
          .filter(([setting]) => !(setting in found.setup.settings))
          .map(([setting, was]) => ({ key: setting, label: label(setting), was }))
      : [];
    const files = [...found.files].map(([setting, file]): ReviewFile => {
      const was = before?.files[setting]?.sha256;
      const change = before ? changeOf(file.sha256, was) : 'added';
      return {
        setting,
        label: label(setting),
        path: file.source,
        url: fileUrl(found.repository, found.commit, file.source),
        sha256: file.sha256,
        size: file.bytes.byteLength,
        change,
        was: change === 'changed' ? was! : null,
      };
    });
    const removedFiles = before
      ? Object.entries(before.files)
          .filter(([setting]) => !found.files.has(setting))
          .map(([setting, file]) => ({ setting, label: label(setting), path: file.source }))
      : [];

    return {
      org: found.org,
      name: found.setup.name,
      kind: before ? 'update' : 'new',
      repository: found.repository,
      account: found.account,
      branch: found.branch,
      commit: found.commit,
      url: `https://github.com/${found.repository}/tree/${found.commit}`,
      compareUrl: before && before.commit !== found.commit ? `https://github.com/${found.repository}/compare/${before.commit}...${found.commit}` : null,
      adoptedCommit: before?.commit ?? null,
      dismissed: this.#dismissed(found.org, found.commit),
      settings,
      removed,
      skipped: found.setup.skipped.map((entry) => ({ ...entry, label: settingDef(entry.key)?.label ?? null })),
      files,
      removedFiles,
      skippedFiles: found.setup.skippedFiles,
      sources:
        found.setup.sources && found.sourcesText !== null
          ? { path: found.setup.sources, url: fileUrl(found.repository, found.commit, found.setup.sources), text: found.sourcesText }
          : null,
      sourcesProblem: found.setup.sourcesProblem,
    };
  }

  /**
   * The setup in use, as the store records it, for when nothing newer has been
   * read: before the first look, or with GitHub off or unreadable. Without the
   * sources it suggests, which only a read of the repository has.
   */
  #inUse(adopted: AdoptedSetup): OrganizationReview {
    const label = (setting: string): string => settingDef(setting)?.label ?? setting;
    return {
      org: adopted.org,
      name: adopted.name,
      kind: 'update',
      repository: adopted.repository,
      account: adopted.account,
      branch: '',
      commit: adopted.commit,
      url: `https://github.com/${adopted.repository}/tree/${adopted.commit}`,
      compareUrl: null,
      adoptedCommit: adopted.commit,
      dismissed: false,
      settings: Object.entries(adopted.settings).map(([setting, value]) => ({ key: setting, label: label(setting), value, change: 'same', was: null })),
      removed: [],
      skipped: [],
      files: Object.entries(adopted.files).map(([setting, file]) => ({
        setting,
        label: label(setting),
        path: file.source,
        url: fileUrl(adopted.repository, adopted.commit, file.source),
        sha256: file.sha256,
        size: null,
        change: 'same',
        was: null,
      })),
      removedFiles: [],
      skippedFiles: [],
      sources: null,
      sourcesProblem: null,
    };
  }

  /** One write at a time, each from the record as the last left it. */
  #serial<T>(write: () => Promise<T>): Promise<T> {
    const next = this.#writes.then(write);
    this.#writes = next.catch(() => {});
    return next;
  }

  /**
   * Use `org`'s setup at `commit`, the one the review showed, or apply its
   * newer commit over the one in use. Writes the files exactly as the review
   * hashed them, then the record, which is what makes the settings apply at
   * the restart the caller asks for. Resolves with why not, or null.
   */
  adopt(org: string, commit: string): Promise<string | null> {
    return this.#serial(async () => {
      const found = this.#found.get(key(org));
      if (!found) return `No Daily Focus settings from ${org} have been found`;
      if (found.commit !== commit) return `${found.setup.name}'s Daily Focus settings have changed since you opened them. Review them again`;
      const current = this.#record.adopted;
      if (current && key(current.org) !== key(found.org)) return `You're using ${current.name}'s Daily Focus settings. Stop using them first`;

      const files: Record<string, AdoptedFile> = {};
      const taken = new Set<string>();
      for (const [setting, file] of found.files) {
        const name = storedName(file.source, setting, taken);
        taken.add(name.toLowerCase());
        files[setting] = { source: file.source, path: `${ORGANIZATION_FOLDER}/${name}`, sha256: file.sha256 };
      }
      const adopted: AdoptedSetup = {
        org: found.org,
        name: found.setup.name,
        repository: found.repository,
        account: found.account,
        commit: found.commit,
        adoptedAt: this.#now().toISOString(),
        settings: { ...found.setup.settings },
        files,
        sources: found.setup.sources,
      };
      const refused = this.#deps.check(organizationLayer({ adopted, dismissed: [] }, this.#config.dataDir)!);
      if (refused) return `${found.setup.name}'s Daily Focus settings can't be used with your own: ${refused}`;

      // The files first and the record last: until the record names a file's
      // new hash, a run of it is refused rather than run unapproved.
      const folder = this.#config.organizationDir;
      await mkdir(folder, { recursive: true });
      for (const [setting, file] of found.files) {
        const target = resolve(this.#config.dataDir, files[setting]!.path);
        const temp = `${target}.tmp`;
        await writeFile(temp, file.bytes, { mode: 0o755 });
        await chmod(temp, 0o755);
        await rename(temp, target);
      }
      const kept = new Set(Object.values(files).map((file) => posix.basename(file.path)));
      for (const entry of await readdir(folder)) {
        if (!kept.has(entry)) await rm(join(folder, entry), { recursive: true, force: true });
      }
      this.#record = { adopted, dismissed: this.#record.dismissed.filter((entry) => key(entry.org) !== key(found.org)) };
      await writeJsonAtomic(this.#config.organizationFile, this.#record);
      this.#deps.onChange();
      return null;
    });
  }

  /** "Not now" for `org`'s setup at `commit`: no banner for it until a newer commit. Resolves with why not, or null. */
  dismiss(org: string, commit: string): Promise<string | null> {
    return this.#serial(async () => {
      const found = this.#found.get(key(org));
      if (!found || found.commit !== commit) return `No Daily Focus settings from ${org} at ${short(commit)} have been found`;
      this.#record = {
        adopted: this.#record.adopted,
        dismissed: [
          ...this.#record.dismissed.filter((entry) => key(entry.org) !== key(found.org)),
          { org: found.org, commit, at: this.#now().toISOString() },
        ],
      };
      await writeJsonAtomic(this.#config.organizationFile, this.#record);
      this.#deps.onChange();
      return null;
    });
  }

  /**
   * Stop using the setup in use: its files and its settings go, at the restart
   * the caller asks for. What is left of the record is a "Not now" for the
   * commit found, so the banner doesn't offer straight back what was just put
   * away; the settings page still lists it. Resolves with why not, or null.
   */
  leave(): Promise<string | null> {
    return this.#serial(async () => {
      const adopted = this.#record.adopted;
      if (!adopted) return "No organization's Daily Focus settings are in use";
      await rm(this.#config.organizationDir, { recursive: true, force: true });
      const commit = this.#found.get(key(adopted.org))?.commit ?? adopted.commit;
      this.#record = {
        adopted: null,
        dismissed: [
          ...this.#record.dismissed.filter((entry) => key(entry.org) !== key(adopted.org)),
          { org: adopted.org, commit, at: this.#now().toISOString() },
        ],
      };
      await writeJsonAtomic(this.#config.organizationFile, this.#record);
      this.#deps.onChange();
      return null;
    });
  }
}
