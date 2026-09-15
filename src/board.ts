import { readFile } from 'node:fs/promises';

import type { Config } from './config.ts';
import { writeJsonAtomic } from './fs.ts';
import {
  GhMissingError,
  fetchPulls,
  ghToken,
  listGhAccounts,
  toMergeState,
  type AccountFetch,
  type OrgVisibility,
} from './github.ts';
import { countBoard, resolveBoard } from './prs.ts';
import type {
  Action,
  BoardAccount,
  BoardState,
  CheckState,
  MergeableState,
  PendingCheck,
  PullActivity,
  PullRequest,
  PullsFile,
  ReviewDecision,
} from './types.ts';

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

/** An account the poller could get a token for. */
interface Identity {
  account: BoardAccount;
  token: string;
}

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
 *
 * Nothing here may throw past `refresh()` or `view()`: the scheduled poll runs
 * with nobody awaiting it, and the view is built inside every state the server
 * sends, so an error in either would take the brief down with the board.
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
  /** When the last poll finished, success or not. Zero until one has. */
  #lastPollAt = 0;
  /** When the rate limit says to leave GitHub alone until. */
  #holdUntil = 0;
  readonly #abort = new AbortController();

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

  /** Stop polling and cancel a fetch in flight, so nothing lands after close. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort.abort();
  }

  /**
   * How many browsers are watching. Polling pauses at zero, and a tab opening on
   * a board that is already older than one interval fetches straight away rather
   * than waiting one out.
   */
  setAudience(count: number): void {
    this.#audience = count;
    if (count === 0) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer || this.#fetching) return;
    if (this.#dueIn() === 0) void this.refresh();
    else this.#schedule();
  }

  /** Fetch now. Joins a fetch already in flight rather than starting a second. Never rejects. */
  async refresh(): Promise<void> {
    if (!this.enabled || this.#stopped) return;
    if (this.#fetching) return this.#fetching;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    this.#fetching = this.#poll()
      .catch((err: unknown) => {
        // Bookkeeping errors, not GitHub ones — those are handled inside. A poll
        // that throws must still leave a board behind and say what happened.
        this.#reason = `The board hit an unexpected error: ${(err as Error).message}`;
        this.#failures++;
        console.error(`[daily-focus] pull request poll failed: ${(err as Error).stack ?? String(err)}`);
      })
      .finally(() => {
        this.#fetching = null;
        this.#lastPollAt = Date.now();
        this.#schedule();
        this.#onChange();
      });
    this.#onChange();
    return this.#fetching;
  }

  /** The board joined with the action log, ready to render. Never throws. */
  view(actions: readonly Action[], now: Date): BoardState {
    const warnings = this.enabled ? [...this.#attemptWarnings] : [];
    let rows: BoardState['rows'] = [];
    if (this.enabled) {
      try {
        rows = resolveBoard(this.#file?.pulls ?? [], actions, now, this.#config.github.mergeGateChecks);
      } catch (err) {
        warnings.push(`Could not judge the pull requests on file: ${(err as Error).message}`);
      }
    }
    // The live accounts, unless there's a reason nothing was polled — then the
    // file's list would contradict the banner sitting next to it.
    const accounts = this.#reason ? [] : this.#accounts.length > 0 ? this.#accounts : (this.#file?.accounts ?? []);
    return {
      enabled: this.enabled,
      reason: this.enabled ? this.#reason : null,
      fetchedAt: this.#file?.fetchedAt ?? null,
      fetching: this.#fetching !== null,
      accounts: accounts.map((account) => ({ ...account })),
      scope: [...this.#config.github.scope],
      warnings,
      pollMinutes: this.#config.github.pollMinutes,
      rows,
      counts: countBoard(rows),
    };
  }

  /** Milliseconds until the next poll is due, from the last one, backoff and any hold. */
  #dueIn(): number {
    const base = this.#config.github.pollMinutes * 60_000;
    const backoff = Math.min(MAX_BACKOFF_MS, base * 2 ** this.#failures);
    const due = Math.max(this.#lastPollAt + backoff, this.#holdUntil);
    return Math.max(0, due - Date.now());
  }

  #schedule(): void {
    if (this.#stopped || this.#audience === 0 || this.#timer || this.#fetching) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh();
    }, this.#dueIn());
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
  async #identities(): Promise<Identity[]> {
    const { ghPath, accounts } = this.#config.github;

    if (accounts.length > 0) {
      const attempts = await Promise.allSettled(accounts.map((login) => this.#deps.token(ghPath, login)));
      const found: Identity[] = [];
      attempts.forEach((attempt, i) => {
        const login = accounts[i]!;
        if (attempt.status === 'fulfilled') {
          const account = { login, ok: true, error: null };
          this.#accounts.push(account);
          found.push({ account, token: attempt.value });
        } else if (attempt.reason instanceof GhMissingError) {
          throw attempt.reason;
        } else {
          this.#accounts.push({ login, ok: false, error: (attempt.reason as Error).message });
        }
      });
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
    const account = { login: active.login, ok: true, error: null };
    this.#accounts.push(account);
    return [{ account, token }];
  }

  async #poll(): Promise<void> {
    if (Date.now() < this.#holdUntil) {
      const until = new Date(this.#holdUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const notice = `Paused near GitHub's rate limit until ${until}.`;
      if (!this.#attemptWarnings.includes(notice)) this.#attemptWarnings.push(notice);
      return;
    }

    const previous = this.#file;
    this.#accounts = [];
    this.#attemptWarnings = [];
    this.#reason = null;

    let identities: Identity[];
    try {
      identities = await this.#identities();
    } catch (err) {
      this.#reason = (err as Error).message;
      this.#failures++;
      return;
    }

    const pulls: PullRequest[] = [];
    const warnings: string[] = [];
    const visibility = new Map<string, OrgVisibility[]>();
    let lowestRemaining: number | null = null;

    // The accounts are independent, so their round trips overlap.
    const results = await Promise.allSettled(
      identities.map((identity) =>
        this.#deps.fetch(identity.token, this.#config.github.scope, identity.account.login, this.#abort.signal),
      ),
    );
    results.forEach((result, i) => {
      const { account } = identities[i]!;
      if (result.status === 'rejected') {
        account.ok = false;
        account.error = (result.reason as Error).message;
        return;
      }
      account.login = result.value.login;
      pulls.push(...result.value.pulls);
      warnings.push(...result.value.warnings);
      for (const [org, seen] of Object.entries(result.value.orgs)) {
        visibility.set(org, [...(visibility.get(org) ?? []), seen]);
      }
      if (result.value.rateLimitRemaining !== null) {
        lowestRemaining = Math.min(lowestRemaining ?? Infinity, result.value.rateLimitRemaining);
      }
    });

    // An account that failed this round keeps what it had last time, so one
    // account's outage doesn't make the other's PRs vanish along with it.
    const failed = new Set(this.#accounts.filter((account) => !account.ok).map((account) => account.login.toLowerCase()));
    for (const pull of previous?.pulls ?? []) {
      if (failed.has(pull.account.toLowerCase())) pulls.push(pull);
    }

    // A private organisation is invisible to an account that isn't a member, and
    // with two accounts that is what one of them will always say. Only when every
    // account that answered can't find it is the name itself the problem.
    for (const [org, seen] of visibility) {
      if (seen.length > 0 && seen.every((state) => state === 'not-found')) {
        warnings.push(
          seen.length === 1
            ? `Can't find an organisation or user called ${org} — check DAILY_FOCUS_GITHUB_SCOPE.`
            : `None of the polled accounts can find an organisation or user called ${org} — check DAILY_FOCUS_GITHUB_SCOPE.`,
        );
      }
    }

    for (const account of this.#accounts) {
      if (!account.ok && account.error) this.#attemptWarnings.push(`${account.login}: ${account.error}`);
    }
    this.#attemptWarnings.push(...warnings);

    if (!this.#accounts.some((account) => account.ok)) {
      this.#failures++;
      return;
    }

    if (lowestRemaining !== null && lowestRemaining < RATE_LIMIT_FLOOR) {
      this.#holdUntil = Date.now() + MAX_BACKOFF_MS;
      this.#attemptWarnings.push("Close to GitHub's rate limit; pausing the board for half an hour.");
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
      await writeJsonAtomic(this.#config.pullsFile, this.#file);
    } catch (err) {
      // Losing the file costs a restart its first paint; it must not cost the board.
      console.warn(`[daily-focus] could not write prs.json: ${(err as Error).message}`);
    }
  }
}

/* ---------- prs.json ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T | null): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Stored pending checks, one bad entry at a time rather than all or nothing. */
function pendingChecks(value: unknown): PendingCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') return [];
    const check: PendingCheck = {
      name: entry.name,
      kind: entry.kind === 'status-context' ? 'status-context' : 'check-run',
      // Re-checked on the way in as well as on the way out: the file is ours, but
      // a link that reaches an anchor tag should never have been trusted twice.
      detailsUrl: typeof entry.detailsUrl === 'string' && /^https?:\/\//i.test(entry.detailsUrl) ? entry.detailsUrl : null,
    };
    if (typeof entry.checkRunId === 'number') check.checkRunId = entry.checkRunId;
    return [check];
  });
}

/**
 * One stored pull, made whole.
 *
 * The file is the server's own, but the same rule applies as to the agent's: one
 * odd entry must cost that entry, never the page. A pull without the handful of
 * facts nothing can stand in for is dropped; everything else gets the value a
 * fresh fetch would have given it.
 */
export function normalizeStoredPull(raw: unknown): PullRequest | null {
  if (!isRecord(raw)) return null;
  const { id, repo, number, title, url, createdAt } = raw;
  if (typeof id !== 'string' || typeof repo !== 'string' || typeof number !== 'number') return null;
  if (typeof title !== 'string' || typeof url !== 'string' || typeof createdAt !== 'string') return null;

  const reviews = Array.isArray(raw.reviews)
    ? raw.reviews.flatMap((review) =>
        isRecord(review) && typeof review.login === 'string' && typeof review.state === 'string' && typeof review.at === 'string'
          ? [{ login: review.login, state: review.state, at: review.at }]
          : [],
      )
    : [];

  let lastActivityByOthers: PullActivity | null = null;
  const others = raw.lastActivityByOthers;
  if (isRecord(others) && typeof others.at === 'string' && typeof others.login === 'string') {
    lastActivityByOthers = { at: others.at, login: others.login, kind: others.kind === 'review' ? 'review' : 'comment' };
  }

  return {
    id,
    account: str(raw.account, ''),
    repo,
    number,
    title,
    url,
    isDraft: raw.isDraft === true,
    createdAt,
    readyAt: str(raw.readyAt, createdAt),
    updatedAt: str(raw.updatedAt, createdAt),
    headRef: str(raw.headRef, ''),
    baseRef: str(raw.baseRef, ''),
    reviewDecision: oneOf<NonNullable<ReviewDecision>>(raw.reviewDecision, ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'], null),
    checks: oneOf<NonNullable<CheckState>>(raw.checks, ['success', 'failure', 'pending'], null),
    failingChecks: strings(raw.failingChecks),
    mergeable: oneOf<MergeableState>(raw.mergeable, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], 'UNKNOWN') ?? 'UNKNOWN',
    // Read through the same normaliser a fresh fetch uses, so the file and the API
    // can't come to different conclusions about what a merge state means: absent
    // is null and falls back to the older reading of ready, and a value the enum
    // doesn't have is `UNKNOWN` rather than anything resembling a clean merge.
    mergeStateStatus: toMergeState(raw.mergeStateStatus),
    pendingChecks: pendingChecks(raw.pendingChecks),
    autoMerge: raw.autoMerge === true,
    requestedReviewers: strings(raw.requestedReviewers),
    reviews,
    lastActivityByYou: typeof raw.lastActivityByYou === 'string' ? raw.lastActivityByYou : null,
    lastActivityByOthers,
  };
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
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.pulls)) return null;
    const accounts: BoardAccount[] = Array.isArray(raw.accounts)
      ? raw.accounts.flatMap((account) =>
          isRecord(account) && typeof account.login === 'string'
            ? [{ login: account.login, ok: account.ok === true, error: typeof account.error === 'string' ? account.error : null }]
            : [],
        )
      : [];
    return {
      version: 1,
      fetchedAt: raw.fetchedAt,
      accounts,
      scope: strings(raw.scope),
      warnings: strings(raw.warnings),
      pulls: raw.pulls.flatMap((pull) => normalizeStoredPull(pull) ?? []),
    };
  } catch {
    return null;
  }
}
