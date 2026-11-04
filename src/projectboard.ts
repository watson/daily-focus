/**
 * The poller behind projects: the epics to offer, and the projects someone has
 * opened. `ticketboard.ts` in shape — read once at startup, then only while a
 * browser is watching, keep the last good answer when a read fails — with two
 * differences.
 *
 * A project is read when someone opens it, not before: each read is a search
 * per epic and a `view` per unfinished ticket, which is fine for the one being
 * looked at and wasteful for every epic on the list.
 *
 * And nothing is written to disk. A project's read is a few seconds of `acli`,
 * a restart reads it again, and a file would be a cache of other people's
 * tickets in the store for no gain.
 */

import type { Config } from './config.ts';
import { errorDetail, extend, toReadFailure, unexpectedDetail, type Failure, type Streak } from './failure.ts';
import { AcliAuthError, AcliMissingError, acliIdentity, fetchAssignedEpics, fetchProject, type JiraIdentity } from './jira.ts';
import { canonicalId } from './ids.ts';
import { planProject } from './projects.ts';
import type { FoldedActions } from './store.ts';
import { resolveTool } from './tools.ts';
import type { LinkedPull, ProjectRead, ProjectState, ProjectSummary, ProjectTicket, ProjectsState } from './types.ts';

/** Never re-read more often than this once reads start failing. */
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * The projects' tickets with what the dashboard knows of them besides Jira: what
 * the user has noted on each, from the folded action log, so the panel shows the
 * notes the ticket board would; and the user's pull requests GitHub links to
 * each, by key, from the ticket board's read of every unfinished ticket of
 * theirs, which its two lists show only some of.
 */
export function withProjectFacts(
  view: ProjectsState,
  folded: ReadonlyMap<string, FoldedActions>,
  pulls: ReadonlyMap<string, readonly LinkedPull[]> = new Map(),
): ProjectsState {
  const noted = (ticket: ProjectTicket): ProjectTicket => ({
    ...ticket,
    notes: folded.get(canonicalId(`jira:${ticket.key}`))?.notes ?? [],
    ...(ticket.mine && pulls.has(ticket.key.toUpperCase()) ? { github: [...pulls.get(ticket.key.toUpperCase())!] } : {}),
  });
  const open: ProjectsState['open'] = {};
  for (const [key, entry] of Object.entries(view.open)) {
    open[key] = entry.read ? { ...entry, read: { ...entry.read, tickets: entry.read.tickets.map(noted) } } : entry;
  }
  return { ...view, open };
}

/** A ticket in a project kept open, by the `jira:<KEY>` id the panel and the action log use. */
export function findProjectTicket(view: ProjectsState | undefined, id: string): ProjectTicket | undefined {
  const wanted = canonicalId(id);
  for (const entry of Object.values(view?.open ?? {})) {
    const ticket = entry.read?.tickets.find((each) => canonicalId(`jira:${each.key}`) === wanted);
    if (ticket) return ticket;
  }
  return undefined;
}

/** How many projects are kept. The one opened least recently goes first. */
export const KEPT_PROJECTS = 5;

/** A project opened again within this of its last read is not read again for it. */
export const FRESH_FOR_MS = 60_000;

/** What the poller talks to, gathered so a test can supply its own. */
export interface ProjectBoardDeps {
  identity(acliPath: string): Promise<JiraIdentity>;
  epics(acliPath: string, site: string | null): Promise<ProjectSummary[]>;
  project(acliPath: string, key: string, site: string | null): Promise<ProjectRead>;
}

const realDeps: ProjectBoardDeps = { identity: acliIdentity, epics: fetchAssignedEpics, project: fetchProject };

interface Entry {
  read: ProjectRead | null;
  reading: Promise<void> | null;
  reason: Failure | null;
  streak: Streak | null;
  /** When it was last opened, which decides what is dropped. */
  openedAt: number;
}

export class ProjectBoard {
  readonly #config: Config;
  readonly #deps: ProjectBoardDeps;
  readonly #onChange: () => void;

  #epics: ProjectSummary[] = [];
  #fetchedAt: string | null = null;
  #reason: Failure | null = null;
  #streak: Streak | null = null;
  /** The site browse links are built for: the configured one, or the one `acli` names. */
  #site: string | null = null;
  readonly #open = new Map<string, Entry>();

  #reading: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #audience = 0;
  #stopped = false;
  #lastReadAt = 0;

  constructor(config: Config, onChange: () => void, deps: ProjectBoardDeps = realDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#onChange = onChange;
    this.#site = config.jira.site;
  }

  /** Off with the Jira board, which reads through the same `acli`. */
  get enabled(): boolean {
    return this.#config.jira.enabled;
  }

  /** Read the epics once, regardless of audience. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await this.refresh();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** How many browsers are watching. Polling pauses at zero. */
  setAudience(count: number): void {
    this.#audience = count;
    if (count === 0) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer || this.#reading) return;
    if (this.#dueIn() === 0) void this.refresh();
    else this.#schedule();
  }

  /** Read the epics, and every project kept, now. Joins a read already in flight. Never rejects. */
  async refresh(): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    if (this.#reading) return this.#reading;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    this.#reading = this.#readAll()
      .catch((err: unknown) => {
        this.#reason = { message: `Projects hit an unexpected error: ${(err as Error).message}`, detail: unexpectedDetail(err) };
        this.#streak = extend(this.#streak);
        console.error(`[daily-focus] project poll failed: ${(err as Error).stack ?? String(err)}`);
      })
      .finally(() => {
        this.#reading = null;
        this.#lastReadAt = Date.now();
        this.#schedule();
        this.#onChange();
      });
    this.#onChange();
    return this.#reading;
  }

  /**
   * Open a project: read it, unless it was read within `FRESH_FOR_MS`, and keep
   * it. Resolves once it has been read. Never rejects: a failed read is in its
   * state, under the last good one.
   */
  async open(key: string): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    let entry = this.#open.get(key);
    if (!entry) {
      entry = { read: null, reading: null, reason: null, streak: null, openedAt: 0 };
      this.#open.set(key, entry);
    }
    entry.openedAt = Date.now();
    this.#forgetOldest();
    const fresh = entry.read !== null && Date.now() - Date.parse(entry.read.fetchedAt) < FRESH_FOR_MS && entry.reason === null;
    if (fresh) return;
    await this.#readProject(key, entry);
  }

  /** Everything the page shows, planned. Never throws. */
  view(): ProjectsState {
    if (!this.enabled) {
      return { enabled: false, epics: [], fetchedAt: null, fetching: false, reason: null, open: {} };
    }
    const reading = this.#reading !== null;
    const retryAt = this.#stopped ? null : Date.now() + this.#dueIn();
    const open: Record<string, ProjectState> = {};
    for (const [key, entry] of this.#open) {
      let read: ProjectState['read'] = null;
      let reason = entry.reason;
      if (entry.read) {
        try {
          read = { ...entry.read, plan: planProject(entry.read.tickets, entry.read.outside) };
        } catch (err) {
          reason ??= { message: `Could not work out the order of ${key}: ${(err as Error).message}`, detail: unexpectedDetail(err) };
        }
      }
      const fetching = entry.reading !== null;
      open[key] = { key, read, fetching, reason: reason ? toReadFailure(reason, entry.streak, retryAt, fetching) : null };
    }
    return {
      enabled: true,
      epics: [...this.#epics],
      fetchedAt: this.#fetchedAt,
      fetching: reading,
      reason: this.#reason ? toReadFailure(this.#reason, this.#streak, retryAt, reading) : null,
      open,
    };
  }

  /**
   * Drop the projects opened least recently, beyond `KEPT_PROJECTS`. One still
   * being read goes too: its read lands in an entry nobody keeps.
   */
  #forgetOldest(): void {
    while (this.#open.size > KEPT_PROJECTS) {
      let oldest: string | null = null;
      for (const [key, entry] of this.#open) {
        if (oldest === null || entry.openedAt < this.#open.get(oldest)!.openedAt) oldest = key;
      }
      this.#open.delete(oldest!);
    }
  }

  #intervalMs(): number {
    const base = this.#config.jira.pollMinutes * 60_000;
    const failures = this.#streak?.attempts ?? 0;
    if (failures === 0) return base;
    return Math.min(base * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS);
  }

  #dueIn(): number {
    if (this.#lastReadAt === 0) return 0;
    return Math.max(0, this.#lastReadAt + this.#intervalMs() - Date.now());
  }

  #schedule(): void {
    if (this.#stopped || this.#audience === 0 || this.#timer || this.#reading) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh();
    }, this.#dueIn());
    this.#timer.unref?.();
  }

  /** The acli to run, looked at each time: one fetched since the last read is used at once. */
  #acliPath(): string {
    return resolveTool('acli', this.#config.jira.acliPath, this.#config.toolsDir).path;
  }

  async #readAll(): Promise<void> {
    const acliPath = this.#acliPath();
    try {
      const identity = await this.#deps.identity(acliPath);
      // The configured site wins, as on the ticket board.
      this.#site = this.#config.jira.site ?? identity.site;
      this.#epics = await this.#deps.epics(acliPath, this.#site);
      this.#fetchedAt = new Date().toISOString();
      this.#reason = null;
      this.#streak = null;
    } catch (err) {
      this.#streak = extend(this.#streak);
      const fix = err instanceof AcliMissingError || err instanceof AcliAuthError ? `${(err as Error).message}, or set DAILY_FOCUS_JIRA=off` : null;
      const message = fix ?? `could not read your epics from Jira: ${(err as Error).message}`;
      this.#reason = { message: this.#fetchedAt ? `${message}. Showing the last good read.` : message, detail: errorDetail(err) };
    }

    await Promise.all([...this.#open].map(([key, entry]) => this.#readProject(key, entry)));
  }

  /**
   * The site to build browse links for. Asked of `acli` when a project is opened
   * before the epics were first read, which is the read that usually learns it.
   */
  async #siteFor(acliPath: string): Promise<string | null> {
    if (this.#site !== null) return this.#site;
    try {
      this.#site = (await this.#deps.identity(acliPath)).site;
    } catch {
      // The project's own read will fail the same way, and say so.
    }
    return this.#site;
  }

  /** Read one project into its entry. Joins a read of it already in flight. Never rejects. */
  #readProject(key: string, entry: Entry): Promise<void> {
    if (entry.reading) return entry.reading;
    const acliPath = this.#acliPath();
    entry.reading = this.#siteFor(acliPath)
      .then((site) => this.#deps.project(acliPath, key, site))
      .then(
        (read) => {
          entry.read = read;
          entry.reason = null;
          entry.streak = null;
        },
        (err: unknown) => {
          entry.streak = extend(entry.streak);
          const message = `could not read ${key} from Jira: ${(err as Error).message}`;
          entry.reason = { message: entry.read ? `${message}. Showing the last good read.` : message, detail: errorDetail(err) };
        },
      )
      .finally(() => {
        entry.reading = null;
        this.#onChange();
      });
    this.#onChange();
    return entry.reading;
  }
}
