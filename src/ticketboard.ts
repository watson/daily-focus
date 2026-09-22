/**
 * The poller behind the Jira ticket board. `board.ts` for tickets, and
 * deliberately the same shape: read what the last run left on disk, read once at
 * startup, then only while a browser is watching, and keep the last good answer
 * when a read fails.
 *
 * Simpler than the pull request board in two ways. There is one account rather
 * than several, because `acli` holds one Jira session; and there is no rate limit
 * to nurse, because three searches every quarter of an hour is not a load Jira
 * notices. Stricter in one: a ticket board is about status hygiene, which nothing
 * is ever waiting on, so it polls at a slower default than the PR board and the
 * tab's badge is a count rather than an alarm.
 */

import { readFile } from 'node:fs/promises';

import type { Config } from './config.ts';
import { writeJsonAtomic } from './fs.ts';
import {
  acliIdentity,
  fetchTickets,
  toTicket,
  transitionTicket,
  type JiraIdentity,
  type TicketFetch,
} from './jira.ts';
import { countTickets, resolveTickets } from './tickets.ts';
import type { Action, Ticket, TicketBoardState, TicketsFile } from './types.ts';

/** Never re-read more often than this once reads start failing. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** What the poller talks to, gathered so a test can supply its own. */
export interface TicketBoardDeps {
  identity(acliPath: string): Promise<JiraIdentity>;
  fetch(acliPath: string, opts: { projects: readonly string[]; site: string | null }): Promise<TicketFetch>;
  transition(acliPath: string, key: string, status: string): Promise<void>;
}

const realDeps: TicketBoardDeps = { identity: acliIdentity, fetch: fetchTickets, transition: transitionTicket };

export class TicketBoard {
  readonly #config: Config;
  readonly #deps: TicketBoardDeps;
  readonly #onChange: () => void;

  /** The last successful read, as on disk. */
  #file: TicketsFile | null = null;
  #warnings: string[] = [];
  /** Why nothing can be read at all right now, when that's the case. */
  #reason: string | null = null;

  #reading: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #audience = 0;
  #failures = 0;
  #stopped = false;
  #lastReadAt = 0;

  constructor(config: Config, onChange: () => void, deps: TicketBoardDeps = realDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#onChange = onChange;
  }

  get enabled(): boolean {
    return this.#config.jira.enabled;
  }

  /** Load what the last run left on disk, then read once regardless of audience. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    this.#file = await readTicketsFile(this.#config.ticketsFile);
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

  /** Read now. Joins a read already in flight rather than starting a second. Never rejects. */
  async refresh(): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    if (this.#reading) return this.#reading;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    this.#reading = this.#read()
      .catch((err: unknown) => {
        // Bookkeeping errors, not Jira ones — those are handled inside. A read
        // that throws must still leave a board behind and say what happened.
        this.#reason = `The ticket board hit an unexpected error: ${(err as Error).message}`;
        this.#failures++;
        console.error(`[daily-focus] jira poll failed: ${(err as Error).stack ?? String(err)}`);
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

  /** The board joined with the action log, ready to render. Never throws. */
  view(actions: readonly Action[], now: Date): TicketBoardState {
    const warnings = this.enabled ? [...this.#warnings] : [];
    let rows: TicketBoardState['rows'] = [];
    if (this.enabled) {
      try {
        rows = resolveTickets(this.#file?.tickets ?? [], actions, now, this.#config.jira.holdStatuses);
      } catch (err) {
        warnings.push(`Could not judge the tickets on file: ${(err as Error).message}`);
      }
    }
    return {
      enabled: this.enabled,
      reason: this.enabled ? this.#reason : null,
      fetchedAt: this.#file?.fetchedAt ?? null,
      fetching: this.#reading !== null,
      // Suppressed alongside a reason, as the board's account list is: an
      // account line beside "acli is not logged in" contradicts the banner.
      account: this.#reason ? null : (this.#file?.account ?? null),
      projects: [...this.#config.jira.projects],
      warnings,
      pollMinutes: this.#config.jira.pollMinutes,
      rows,
      counts: countTickets(rows),
      checked: this.#file?.tickets.length ?? 0,
      statuses: this.#file?.statuses ?? {},
    };
  }

  /**
   * Move one ticket to a status, then read the board back.
   *
   * The only thing in this process that changes anything outside it, and it runs
   * only from a click. It deliberately does *not* touch `#file` itself: the row
   * on screen has to come from Jira having actually accepted the move, so the
   * refresh is the confirmation. A refresh already in flight is joined rather
   * than doubled, which is why this awaits `refresh` rather than `#read`.
   *
   * Unlike everything else on this class, it rejects — the caller is a request
   * handler with somebody waiting on the answer, and a transition that silently
   * did nothing is the one failure this must never present as success.
   */
  async transition(key: string, status: string): Promise<void> {
    if (!this.enabled) throw new Error('the Jira ticket board is switched off (DAILY_FOCUS_JIRA=off)');
    if (this.#stopped) throw new Error('the server is shutting down');
    await this.#deps.transition(this.#config.jira.acliPath, key, status);
    await this.refresh();
  }

  #intervalMs(): number {
    const base = this.#config.jira.pollMinutes * 60_000;
    if (this.#failures === 0) return base;
    return Math.min(base * 2 ** Math.min(this.#failures, 6), MAX_BACKOFF_MS);
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

  async #read(): Promise<void> {
    const { acliPath, projects, site: configuredSite } = this.#config.jira;

    let identity: JiraIdentity;
    try {
      identity = await this.#deps.identity(acliPath);
    } catch (err) {
      // No session and no acli are both "nothing can be read", and both already
      // say what to do about it; the off switch is worth adding because neither
      // is worth fixing if the user never wanted this board. Either way the
      // previous rows stay on screen under the banner, since a status that was
      // wrong an hour ago is still wrong.
      this.#reason = `${(err as Error).message}, or set DAILY_FOCUS_JIRA=off`;
      this.#failures++;
      return;
    }

    // The configured site wins: `acli` names the site it authenticated against,
    // which is the right default, but a user whose browse host differs from it
    // needs a way to say so that a successful auth probe can't overrule.
    const site = configuredSite ?? identity.site;

    try {
      const { tickets, statuses, warnings } = await this.#deps.fetch(acliPath, { projects, site });
      this.#reason = null;
      this.#warnings = warnings;
      this.#failures = 0;
      this.#file = {
        version: 1,
        fetchedAt: new Date().toISOString(),
        account: identity.account,
        projects: [...projects],
        warnings,
        tickets,
        statuses,
      };
      try {
        await writeJsonAtomic(this.#config.ticketsFile, this.#file);
      } catch (err) {
        // Losing the file costs a restart its first paint; it must not cost the board.
        console.warn(`[daily-focus] could not write tickets.json: ${(err as Error).message}`);
      }
    } catch (err) {
      this.#failures++;
      const message = `could not read Jira: ${(err as Error).message}`;
      // Say so either way. A stale board that looks current is the thing worth
      // avoiding, and this one's whole job is telling the user something is out
      // of date — it does not get to be out of date silently.
      this.#reason = this.#file ? `${message}. Showing the last good read.` : message;
    }
  }
}

/* ---------- tickets.json ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * One stored ticket, made whole.
 *
 * Read back through the same reducer a fresh read uses, so the file and `acli`
 * can't come to different conclusions about what a status category means or which
 * hierarchy levels belong on the board. The stored shape is already flat, so it
 * is handed over as both the issue and its fields — `toTicket` looks in both
 * places for a key, and finds everything else where this writer left it.
 */
export function normalizeStoredTicket(raw: unknown): Ticket | null {
  if (!isRecord(raw)) return null;
  const { key, url, workflowStatus, statusCategory, issueType, summary } = raw;
  if (typeof key !== 'string' || key === '') return null;
  // Rebuilt into the API's nesting rather than trusted field by field, so there
  // is exactly one place that decides what an unknown category or a missing
  // status name becomes.
  const site = typeof url === 'string' ? /^https:\/\/([^/]+)\/browse\//.exec(url)?.[1] ?? null : null;
  return toTicket(
    {
      key,
      fields: {
        summary,
        status: { name: workflowStatus, statusCategory: { key: statusCategory } },
        issuetype: { name: issueType, hierarchyLevel: 0 },
      },
    },
    site,
    raw.hasAnyPr === true,
    raw.hasOpenPr === true,
    // Absent in a file written before the development panel was read — which
    // must come back as "not confirmed" rather than as confirmed, since those
    // files are exactly the ones whose settled court counted drafts as merges.
    raw.allPrsClosed === true,
  );
}

/** Read the last read back. Anything unreadable is treated as no file, never as an error. */
export async function readTicketsFile(path: string): Promise<TicketsFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.tickets)) {
      return null;
    }
    const statuses: Record<string, string[]> = {};
    if (isRecord(raw.statuses)) {
      for (const [project, names] of Object.entries(raw.statuses)) {
        const list = strings(names);
        if (list.length > 0) statuses[project] = list;
      }
    }

    return {
      version: 1,
      fetchedAt: raw.fetchedAt,
      account: typeof raw.account === 'string' ? raw.account : null,
      projects: strings(raw.projects),
      warnings: strings(raw.warnings),
      tickets: raw.tickets.flatMap((ticket) => normalizeStoredTicket(ticket) ?? []),
      statuses,
    };
  } catch {
    return null;
  }
}
