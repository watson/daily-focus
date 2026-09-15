import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Config } from './config.ts';
import { GhMissingError, fetchPulls, ghToken, listGhAccounts, type AccountFetch, type OrgVisibility } from './github.ts';
import { countBoard, resolveBoard } from './prs.ts';
import type { Action, BoardAccount, BoardState, PullRequest, PullsFile } from './types.ts';

/** Never poll more often than this, whatever the config says, once things start failing. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** Below this many GraphQL points left, wait for the window to reset rather than spend them. */
const RATE_LIMIT_FLOOR = 100;

/**
 * The calls the poller makes to the outside world, gathered so a test can supply
 * its own. The defaults are the real gh and GitHub.
 */
export interface BoardDeps {
  listAccounts(ghPath: string): Promise<{ login: string; active: boolean }[]>;
  token(ghPath: string, login: string | null): Promise<string>;
  fetch(token: string, scope: readonly string[], expectedLogin: string | null, signal?: AbortSignal): Promise<AccountFetch>;
}

const realDeps: BoardDeps = { listAccounts: listGhAccounts, token: ghToken, fetch: fetchPulls };

/**
 * The live pull request board.
 *
 * The one part of the dashboard that gathers anything itself. It borrows gh's
 * tokens, asks GitHub for the pull requests the user has open, and keeps the last
 * good answer in `prs.json` so a restart or a GitHub outage never blanks the page.
 * Judging whose court each PR is in happens in `prs.ts` at read time, since that
 * depends on the clock and the action log rather than on anything fetched.
 *
 * It polls only while somebody is looking — the SSE subscriber count is the
 * audience — plus once at startup so the tab has something on first paint.
 */
export class Board {
  readonly #config: Config;
  readonly #deps: BoardDeps;
  readonly #onChange: () => void;

  /** The last successful fetch, as on disk. */
  #file: PullsFile | null = null;
  /** What the last attempt found out, successful or not. */
  #accounts: BoardAccount[] = [];
  #attemptWarnings: string[] = [];
  /** Why nothing can be polled at all right now, when that's the case. */
  #reason: string | null = null;

  #fetching: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #audience = 0;
  #failures = 0;
  #stopped = false;
  /** When the rate limit says to leave GitHub alone until. */
  #holdUntil = 0;

  constructor(config: Config, onChange: () => void, deps: BoardDeps = realDeps) {
    this.#config = config;
    this.#deps = deps;
    this.#onChange = onChange;
  }

  get enabled(): boolean {
    return this.#config.github.enabled;
  }

  /** Load what the last run left on disk, then fetch once regardless of audience. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    this.#file = await readPullsFile(this.#config.pullsFile);
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
    if (!this.#timer && !this.#fetching) this.#schedule();
  }

  /** Fetch now. Joins a fetch already in flight rather than starting a second. */
  async refresh(): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    if (this.#fetching) return this.#fetching;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    this.#fetching = this.#poll().finally(() => {
      this.#fetching = null;
      this.#schedule();
      this.#onChange();
    });
    this.#onChange();
    return this.#fetching;
  }

  /** The board joined with the action log, ready to render. */
  view(actions: readonly Action[], now: Date): BoardState {
    const rows = this.enabled ? resolveBoard(this.#file?.pulls ?? [], actions, now) : [];
    return {
      enabled: this.enabled,
      reason: this.enabled ? this.#reason : null,
      fetchedAt: this.#file?.fetchedAt ?? null,
      fetching: this.#fetching !== null,
      accounts: this.#accounts.length > 0 ? this.#accounts : (this.#file?.accounts ?? []),
      scope: [...this.#config.github.scope],
      warnings: this.enabled ? [...this.#attemptWarnings] : [],
      pollMinutes: this.#config.github.pollMinutes,
      rows,
      counts: countBoard(rows),
    };
  }

  #schedule(): void {
    if (this.#stopped || this.#audience === 0 || this.#timer || this.#fetching) return;
    const base = this.#config.github.pollMinutes * 60_000;
    const backoff = Math.min(MAX_BACKOFF_MS, base * 2 ** this.#failures);
    const delay = Math.max(backoff, this.#holdUntil - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh();
    }, delay);
    this.#timer.unref();
  }

  /**
   * Which logins to poll as, and with what.
   *
   * Configured accounts are each named to gh explicitly; one that gh doesn't know
   * becomes a warning and the rest carry on. With nothing configured the active
   * account is used, and a second account being present is worth saying, since
   * "active" is whichever one was last switched to in a terminal.
   */
  async #identities(): Promise<{ login: string | null; token: string }[]> {
    const { ghPath, accounts } = this.#config.github;
    const found: { login: string | null; token: string }[] = [];

    if (accounts.length > 0) {
      for (const login of accounts) {
        try {
          found.push({ login, token: await this.#deps.token(ghPath, login) });
          this.#accounts.push({ login, ok: true, error: null });
        } catch (err) {
          if (err instanceof GhMissingError) throw err;
          this.#accounts.push({ login, ok: false, error: (err as Error).message });
        }
      }
      return found;
    }

    const known = await this.#deps.listAccounts(ghPath);
    const active = known.find((account) => account.active) ?? known[0] ?? null;
    if (!active) {
      throw new Error('gh is not logged in to github.com — run `gh auth login`, or set DAILY_FOCUS_GITHUB=off');
    }
    if (known.length > 1) {
      this.#attemptWarnings.push(
        `gh holds ${known.length} github.com accounts on this machine; polling only the active one, ${active.login}. ` +
          'Set DAILY_FOCUS_GITHUB_ACCOUNTS to poll more than one.',
      );
    }
    const token = await this.#deps.token(ghPath, null);
    this.#accounts.push({ login: active.login, ok: true, error: null });
    return [{ login: active.login, token }];
  }

  async #poll(): Promise<void> {
    if (Date.now() < this.#holdUntil) return;

    const previous = this.#file;
    this.#accounts = [];
    this.#attemptWarnings = [];
    this.#reason = null;

    let identities: { login: string | null; token: string }[];
    try {
      identities = await this.#identities();
    } catch (err) {
      this.#reason = (err as Error).message;
      this.#failures++;
      return;
    }

    const pulls: PullRequest[] = [];
    const warnings: string[] = [];
    const succeeded = new Set<string>();
    const visibility = new Map<string, OrgVisibility[]>();
    let lowestRemaining: number | null = null;

    for (const identity of identities) {
      const entry = this.#accounts.find((account) => account.login === identity.login) ?? null;
      try {
        const result = await this.#deps.fetch(identity.token, this.#config.github.scope, identity.login);
        pulls.push(...result.pulls);
        warnings.push(...result.warnings);
        succeeded.add(result.login.toLowerCase());
        for (const [org, seen] of Object.entries(result.orgs)) {
          visibility.set(org, [...(visibility.get(org) ?? []), seen]);
        }
        if (entry) entry.login = result.login;
        if (result.rateLimitRemaining !== null) {
          lowestRemaining = Math.min(lowestRemaining ?? Infinity, result.rateLimitRemaining);
        }
      } catch (err) {
        if (entry) {
          entry.ok = false;
          entry.error = (err as Error).message;
        }
      }
    }

    // An account that failed this round keeps what it had last time, so one
    // account's outage doesn't make the other's PRs vanish along with it.
    for (const pull of previous?.pulls ?? []) {
      const owner = this.#accounts.find((account) => account.login.toLowerCase() === pull.account.toLowerCase());
      if (owner && !owner.ok && !succeeded.has(pull.account.toLowerCase())) pulls.push(pull);
    }

    // A private organisation is invisible to an account that isn't a member, and
    // with two accounts that is what one of them will always say. Only when every
    // account that answered can't find it is the name itself the problem.
    for (const [org, seen] of visibility) {
      if (seen.length > 0 && seen.every((state) => state === 'not-found')) {
        warnings.push(
          seen.length === 1
            ? `Can't find an organisation called ${org} — check DAILY_FOCUS_GITHUB_SCOPE.`
            : `None of the polled accounts can find an organisation called ${org} — check DAILY_FOCUS_GITHUB_SCOPE.`,
        );
      }
    }

    for (const account of this.#accounts) {
      if (!account.ok && account.error) this.#attemptWarnings.push(`${account.login}: ${account.error}`);
    }
    this.#attemptWarnings.push(...warnings);

    if (succeeded.size === 0) {
      this.#failures++;
      return;
    }

    if (lowestRemaining !== null && lowestRemaining < RATE_LIMIT_FLOOR) {
      this.#holdUntil = Date.now() + MAX_BACKOFF_MS;
      this.#attemptWarnings.push('Close to GitHub\'s rate limit; pausing the board for half an hour.');
    }

    this.#failures = 0;
    this.#file = {
      version: 1,
      fetchedAt: new Date().toISOString(),
      accounts: this.#accounts.map((account) => ({ ...account })),
      scope: [...this.#config.github.scope],
      warnings,
      pulls,
    };
    try {
      await writePullsFile(this.#config.pullsFile, this.#file);
    } catch (err) {
      // Losing the file costs a restart its first paint; it must not cost the board.
      console.warn(`[daily-focus] could not write prs.json: ${(err as Error).message}`);
    }
  }
}

/** Read the last fetch back. Anything unreadable is treated as no file, never as an error. */
export async function readPullsFile(path: string): Promise<PullsFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Partial<PullsFile>;
    if (raw.version !== 1 || typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.pulls)) return null;
    return {
      version: 1,
      fetchedAt: raw.fetchedAt,
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      scope: Array.isArray(raw.scope) ? raw.scope : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      // A file from an earlier build may predate a field. Fill in what a fresh
      // fetch would have, so the first paint after an upgrade doesn't trip on it.
      pulls: raw.pulls
        .filter((pull): pull is PullRequest => typeof pull === 'object' && pull !== null && typeof pull.id === 'string')
        .map((pull) => ({
          ...pull,
          failingChecks: Array.isArray(pull.failingChecks) ? pull.failingChecks : [],
          reviews: Array.isArray(pull.reviews) ? pull.reviews : [],
          requestedReviewers: Array.isArray(pull.requestedReviewers) ? pull.requestedReviewers : [],
        })),
    };
  } catch {
    return null;
  }
}

/** Write via a sibling temp file and rename, so a reader never sees half a file. */
async function writePullsFile(path: string, file: PullsFile): Promise<void> {
  // A fixed name, so the store watcher can be told to ignore it; polls never overlap.
  const tmp = join(dirname(path), `${basename(path)}.tmp`);
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
