import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { laterISO } from './time.ts';
import type {
  CheckState,
  MergeStateStatus,
  MergeableState,
  PendingCheck,
  PullActivity,
  PullRequest,
  ReviewDecision,
} from './types.ts';

const run = promisify(execFile);

/** Long enough for a keychain prompt to be answered, short enough that a wedged gh can't stall a poll. */
const GH_TIMEOUT_MS = 15_000;
/** Networks fail slowly; this bounds one GraphQL round trip. */
const FETCH_TIMEOUT_MS = 30_000;

const GRAPHQL_URL = 'https://api.github.com/graphql';

/**
 * How many pull requests to ask for at a time, and how many pages to walk.
 *
 * Deliberately well under GraphQL's hundred-node maximum. The per-pull payload
 * here is large — fifty reviews and fifty comments each — and a page of fifty has
 * been measured taking eleven seconds against an account with forty open pull
 * requests, which is past the gateway's patience: it answers 502, or 200 with a
 * truncated body. The product is the ceiling on pulls read.
 *
 * The checks used to ride along in this request and no longer do, which is what
 * bought the headroom back: carrying a hundred contexts per pull made the page
 * 380 KB and took eight to ten seconds, one bad afternoon away from the timeout
 * it was already trimmed once to avoid. Without them the same page is 28 KB and
 * answers in under four. See `CHECKS_QUERY`.
 */
const PAGE_SIZE = 25;
const MAX_PAGES = 12;

/*
 * Every gh invocation runs with prompts and update nags disabled. Without this
 * an unauthenticated gh can sit waiting for a keypress that never comes, and a
 * "new version available" line lands in stdout where a token was expected.
 */
const GH_ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };

/** gh itself couldn't be run: not installed, or not where we were told. */
export class GhMissingError extends Error {
  constructor(ghPath: string) {
    super(`could not run \`${ghPath}\` — install the GitHub CLI or set DAILY_FOCUS_GH to its path`);
    this.name = 'GhMissingError';
  }
}

/** gh ran, but had no token to give. */
export class GhAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhAuthError';
  }
}

async function gh(ghPath: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(ghPath, args, { env: GH_ENV, timeout: GH_TIMEOUT_MS, maxBuffer: 1 << 20 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (failure.code === 'ENOENT' || failure.code === 'EACCES') throw new GhMissingError(ghPath);
    // A timed-out gh is not a logged-out gh. execFile hands back an empty stderr
    // on a kill, so say what actually happened rather than letting the caller
    // read the silence as "no token".
    const stderr = failure.killed || failure.signal
      ? `gh did not answer within ${GH_TIMEOUT_MS / 1000}s — a keychain prompt or a slow network?`
      : failure.stderr || failure.message;
    return { stdout: failure.stdout ?? '', stderr, code: typeof failure.code === 'number' ? failure.code : 1 };
  }
}

export interface GhAccount {
  login: string;
  active: boolean;
}

/**
 * Which github.com accounts gh knows about on this machine.
 *
 * `gh auth status --json` reports every host; only github.com matters here since
 * the board doesn't do Enterprise Server. A gh that isn't logged in anywhere exits
 * non-zero but still prints the structure, so the output is read either way. Each
 * entry's `state` is gh's own liveness check against the API, which fails offline
 * too, so it is deliberately not consulted: a token that exists is listed, and if
 * it's bad the fetch says so with the real error.
 */
export async function listGhAccounts(ghPath: string): Promise<GhAccount[]> {
  const { stdout } = await gh(ghPath, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const hosts = (parsed as { hosts?: Record<string, unknown> })?.hosts;
  const entries = hosts?.['github.com'];
  if (!Array.isArray(entries)) return [];
  const accounts: GhAccount[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { login, active } = entry as { login?: unknown; active?: unknown };
    if (typeof login !== 'string' || login === '') continue;
    accounts.push({ login, active: active === true });
  }
  return accounts;
}

/**
 * Borrow a token from gh rather than keeping one of our own.
 *
 * With a login, the account is named explicitly and `gh auth switch` in a
 * terminal can't change what the board polls. Without one, whatever gh has active
 * on github.com is used — the zero-config case.
 */
export async function ghToken(ghPath: string, login: string | null): Promise<string> {
  const args = ['auth', 'token', '--hostname', 'github.com'];
  if (login) args.push('--user', login);
  const { stdout, stderr, code } = await gh(ghPath, args);
  const token = stdout.trim();
  if (code !== 0 || token === '') {
    const detail = stderr.trim().split('\n')[0] ?? '';
    throw new GhAuthError(
      login
        ? `gh has no login for ${login} on this machine (${detail || 'no token'}) — run \`gh auth login\` as that account`
        : `gh is not logged in to github.com (${detail || 'no token'}) — run \`gh auth login\``,
    );
  }
  return token;
}

/* ---------- GraphQL ---------- */

export interface GraphQLError {
  message: string;
  type?: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResult<T> {
  data: T | null;
  errors: GraphQLError[];
  /** From the response headers, so a poller can back off before it's cut off. */
  rateLimitRemaining: number | null;
}

/** The request itself failed: network, auth, or a non-JSON reply. */
export class GitHubRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

/**
 * True for GitHub's "authorise this token for single sign-on" refusal.
 *
 * Worth recognising specifically because a SAML-protected org otherwise looks
 * exactly like an org with nothing in it: search results are filtered rather than
 * refused. The org probe in `fetchPulls` exists to turn the silence into this.
 */
export function isSamlError(error: GraphQLError): boolean {
  if (error.extensions?.saml_failure === true) return true;
  return /SAML enforcement/i.test(error.message);
}

export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GraphQLResult<T>> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'daily-focus',
      },
      body: JSON.stringify({ query, variables }),
      signal: combined,
    });
  } catch (err) {
    throw new GitHubRequestError(`GitHub request failed: ${(err as Error).message}`);
  }

  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const rateLimitRemaining = Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining') ? remaining : null;

  if (res.status === 401) throw new GitHubRequestError('GitHub rejected the token (401) — run `gh auth login` again', 401);
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new GitHubRequestError(`GitHub answered ${res.status}${text ? `: ${text}` : ''}`, res.status);
  }

  let body: { data?: T; errors?: GraphQLError[] };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new GitHubRequestError(`GitHub returned unreadable JSON: ${(err as Error).message}`, res.status);
  }
  return { data: body.data ?? null, errors: body.errors ?? [], rateLimitRemaining };
}

/* ---------- the search ---------- */

/** The search GitHub runs, with the configured scope appended as-is. */
export function buildSearchQuery(scope: readonly string[]): string {
  return ['is:pr', 'is:open', 'archived:false', 'author:@me', ...scope].join(' ');
}

/** One page of a commit's checks. GraphQL's connection maximum, and what a page costs. */
const CONTEXT_PAGE_SIZE = 100;

/**
 * How far the walk past the first page of checks will go: pages for one commit,
 * and pages for one account's whole poll.
 *
 * Both are sized from measurement rather than taste. A large matrix repository
 * puts 700–1300 checks on a commit, so sixteen pages is roughly double the worst
 * seen; and an account with thirty-two open pull requests, half of them in such a
 * repository, spent 27 rounds reading the rest. The whole poll measured 37
 * requests and 47 of the five thousand points an hour GraphQL allows, against 5
 * requests and 7 points before the checks moved out of the search — so polling
 * every five minutes spends roughly a ninth of the budget, and only while
 * somebody has the board open, since that is the only time `board.ts` polls.
 *
 * Both are spent rather than enforced: a pull request the budget didn't reach
 * keeps the summary reading it already had, which is the pessimistic direction,
 * and says so once in a warning.
 */
const MAX_CONTEXT_PAGES = 16;
const MAX_CONTEXT_REQUESTS = 200;

/** How many pulls' checks to ask for in one request. See `CHECKS_QUERY`. */
const CHECKS_BATCH_SIZE = 6;

/**
 * One commit's checks, asked for identically wherever they are read, because the
 * two readings have to agree: the search's first page and the walk that completes
 * it are spliced together and summarized as one set.
 *
 * `checkSuite` is here for supersession rather than for display. A re-run leaves
 * the run it replaced on the commit, and the workflow it belongs to plus its run
 * and attempt numbers are the only things that say which of two runs of a name is
 * the live one. See `latestChecks`.
 */
const CHECK_CONTEXTS = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun {
      databaseId name status conclusion detailsUrl startedAt completedAt
      checkSuite { app { id } workflowRun { databaseId runNumber runAttempt workflow { id } } }
    }
    ... on StatusContext { context state targetUrl createdAt }
  }`;

const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        number
        title
        url
        isDraft
        createdAt
        updatedAt
        headRefName
        baseRefName
        repository { nameWithOwner }
        reviewDecision
        mergeable
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { oid committedDate } } }
        readyEvents: timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) {
          nodes { ... on ReadyForReviewEvent { createdAt } }
        }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        reviews(last: 50) {
          nodes { author { __typename login } state submittedAt }
        }
        comments(last: 50) {
          nodes { author { __typename login } createdAt }
        }
      }
    }
  }
}`;

/**
 * Merge states, asked for on their own.
 *
 * `mergeStateStatus` is not a stored field GitHub reads back: it computes a trial
 * merge to answer, and doing that for a page of pull requests whose check rollups
 * are also being fetched reliably times the gateway out — a 502, and a board that
 * silently keeps yesterday's rows. Asked for by node id and nothing else, fifty at
 * a time come back in about seven seconds. Two modest requests beat one that
 * doesn't answer.
 */
const MERGE_STATE_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id mergeStateStatus }
  }
}`;

/**
 * The checks on several pulls' head commits, keyed by node id.
 *
 * Batched rather than asked per pull request, and six is measured rather than
 * picked: six first pages come back in two to three seconds for 189 KB and cost a
 * single point of the rate limit, where the same six asked one at a time cost six
 * points and six seconds. Twelve still answers, at 341 KB and four and a half
 * seconds — near enough the payload that made the search itself unreliable to be
 * worth staying below.
 */
const CHECKS_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: ${CONTEXT_PAGE_SIZE}) { ${CHECK_CONTEXTS} }
            }
          }
        }
      }
    }
  }
}`;

/** One pull request's head commit, as the checks request describes it. */
interface RawHead {
  oid: string | null;
  rollup: RawRollup | null;
}

/** The first page of checks for a batch of pulls already found, by node id. */
async function fetchChecks(
  token: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<{ heads: Map<string, RawHead>; rateLimitRemaining: number | null }> {
  const heads = new Map<string, RawHead>();
  if (ids.length === 0) return { heads, rateLimitRemaining: null };
  const result = await graphql<{ nodes?: (RawPullRequest | null)[] }>(token, CHECKS_QUERY, { ids }, signal);
  const fatal = result.errors.filter((error) => !isSamlError(error));
  if (result.data?.nodes === undefined && fatal.length > 0) {
    throw new GitHubRequestError(`GitHub wouldn't list the checks: ${fatal.map((error) => error.message).join('; ')}`);
  }
  for (const node of result.data?.nodes ?? []) {
    if (!node || typeof node.id !== 'string' || node.id === '') continue;
    const head = node.commits?.nodes?.[0]?.commit;
    heads.set(node.id, { oid: head?.oid ?? null, rollup: head?.statusCheckRollup ?? null });
  }
  return { heads, rateLimitRemaining: result.rateLimitRemaining };
}

/** Read one commit's checks onto the pull request, replacing whatever was there. */
function applyChecks(pull: PullRequest, rollup: RawRollup | null | undefined): void {
  const ci = summarizeChecks(rollup);
  pull.checks = ci.checks;
  pull.failingChecks = ci.failing;
  pull.pendingChecks = ci.pending;
  pull.cancelledChecks = ci.cancelled;
}

export interface RawMergeState {
  id?: string;
  mergeStateStatus?: string | null;
}

/** Read the merge-state reply into a map keyed by node id. One odd node costs itself. */
export function mergeStatesFromNodes(nodes: readonly (RawMergeState | null | undefined)[]): Map<string, MergeStateStatus | null> {
  const states = new Map<string, MergeStateStatus | null>();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || node.id === '') continue;
    states.set(node.id, toMergeState(node.mergeStateStatus));
  }
  return states;
}

/** Loosely typed: the shape of one `search.nodes` entry, as far as the board reads it. */
export interface RawPullRequest {
  /** The GraphQL node id, used only to join the merge-state request. Never stored. */
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  headRefName?: string;
  baseRefName?: string;
  repository?: { nameWithOwner?: string };
  reviewDecision?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  autoMergeRequest?: { enabledAt?: string } | null;
  commits?: { nodes?: { commit?: { oid?: string; committedDate?: string; statusCheckRollup?: RawRollup | null } }[] };
  readyEvents?: { nodes?: ({ createdAt?: string } | null)[] };
  reviewRequests?: { nodes?: { requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null }[] };
  reviews?: { nodes?: { author?: RawActor | null; state?: string; submittedAt?: string | null }[] };
  comments?: { nodes?: { author?: RawActor | null; createdAt?: string }[] };
}

export interface RawActor {
  __typename?: string;
  login?: string;
}

export interface RawRollup {
  state?: string;
  contexts?: {
    totalCount?: number;
    /** Absent from an older cache, and authoritative when present. See `rollupTruncated`. */
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: (RawCheck | null)[];
  };
}

/** Where a check run came from, which is what says whether a re-run replaced it. */
export interface RawCheckSuite {
  app?: { id?: string } | null;
  workflowRun?: {
    databaseId?: number | null;
    runNumber?: number | null;
    runAttempt?: number | null;
    workflow?: { id?: string } | null;
  } | null;
}

/** One entry in the rollup: a check run from an app, or a commit status. */
export interface RawCheck {
  __typename?: string;
  /** CheckRun */
  databaseId?: number | null;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  checkSuite?: RawCheckSuite | null;
  /** StatusContext */
  context?: string;
  state?: string;
  targetUrl?: string | null;
  createdAt?: string | null;
}

/**
 * Bots don't count as people waiting on you.
 *
 * GitHub Apps carry the `Bot` type and a `[bot]` suffix; both are checked because
 * REST-era fixtures and some proxies only give one of the two.
 */
export function isBot(actor: RawActor | null | undefined): boolean {
  if (!actor) return true;
  if (actor.__typename === 'Bot') return true;
  return typeof actor.login === 'string' && actor.login.endsWith('[bot]');
}

function sameLogin(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function toCheckState(state: string | undefined): CheckState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

const CHECK_RANK: Record<NonNullable<CheckState>, number> = { success: 1, pending: 2, failure: 3 };

function worse(a: CheckState, b: CheckState): CheckState {
  if (a === null) return b;
  if (b === null) return a;
  return CHECK_RANK[b] > CHECK_RANK[a] ? b : a;
}

/**
 * Check run conclusions that mean red: the check reached a verdict about the code
 * and the verdict was no.
 *
 * `CANCELLED` is deliberately not one of them, and this is the second place this
 * file departs from `gh pr checks` on purpose. A cancelled run reached no verdict
 * at all, and nothing in the API says who stopped it or why: a merge queue
 * dropping an entry whose gate never cleared, a concurrency group superseding the
 * run, somebody hitting the button. Reading that as "your move" invents the one
 * fact nobody told us, so a cancellation is collected on its own and left out of
 * the verdict in both directions.
 */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED_CONCLUSIONS: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Only http(s) links are kept, so a `javascript:` details URL can never reach the DOM. */
function safeUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Whether GitHub had more checks on this commit than it handed back.
 *
 * `pageInfo` is the direct answer and wins whenever it was asked for, including
 * when it says the walk reached the end: a `totalCount` that moved while the pages
 * were being read is a count taken at a different moment, not evidence that
 * something went unread. `totalCount` is the fallback for a caller — or a cached
 * file — from before the cursor was fetched.
 */
export function rollupTruncated(rollup: RawRollup): boolean {
  const more = rollup.contexts?.pageInfo?.hasNextPage;
  if (typeof more === 'boolean') return more;
  const total = rollup.contexts?.totalCount;
  return typeof total === 'number' && total > (rollup.contexts?.nodes?.length ?? 0);
}

/** A check's place in its slot's history: run then attempt, or failing those, its clock. */
type Generation = readonly [number, number];

/**
 * What a re-run replaces: a check name within one workflow.
 *
 * Narrower than the name alone, and deliberately so — a matrix that gives two
 * jobs of the same workflow run the same display name puts two live check runs of
 * that name on the commit, and they have to survive as two. Checks from something
 * other than Actions have no run to key on and fall back to their app. A check
 * that says nothing about where it came from gets a slot of its own name and is
 * separated from its namesakes only by the clock.
 *
 * REST's `?filter=latest` is not a substitute for any of this, however much it
 * sounds like one: asked for a name with a superseded run, it was measured
 * returning both the dead run and its replacement, because "latest" there is per
 * check suite and a re-run makes a new suite.
 */
function checkSlot(node: RawCheck): string {
  if (node.__typename === 'StatusContext') return `status\u0000${node.context ?? ''}`;
  const workflow = node.checkSuite?.workflowRun?.workflow?.id;
  if (typeof workflow === 'string' && workflow !== '') return `workflow\u0000${workflow}\u0000${node.name ?? ''}`;
  const app = node.checkSuite?.app?.id;
  if (typeof app === 'string' && app !== '') return `app\u0000${app}\u0000${node.name ?? ''}`;
  return `check\u0000${node.name ?? ''}`;
}

/**
 * Which generation of its slot a check belongs to.
 *
 * Run and attempt numbers where GitHub gives them, because they are the only
 * monotonic thing here: check run timestamps have been seen completing a run
 * before it started, so ordering re-runs by the clock would be ordering them by
 * noise. Everything else falls back to that clock, and anything with no clock
 * either ties — which keeps it, since a tie is not evidence of supersession.
 */
function checkGeneration(node: RawCheck): Generation {
  const run = node.checkSuite?.workflowRun;
  const sequence = run?.runNumber ?? run?.databaseId;
  if (typeof sequence === 'number') return [sequence, run?.runAttempt ?? 0];
  const at = node.completedAt ?? node.startedAt ?? node.createdAt ?? null;
  const time = at ? Date.parse(at) : Number.NaN;
  return [Number.isFinite(time) ? time : 0, 0];
}

/**
 * The live check runs, with the ones a re-run superseded dropped.
 *
 * GitHub does not replace a check run when it is run again: both stay on the
 * commit, in separate check suites, and `statusCheckRollup` hands back every one
 * of them. So a check that failed and was then fixed *without a push* — a
 * workflow re-run, or an edit to the pull request that re-triggers one, which is
 * how a title or commit-message check gets fixed — goes on reading red for as
 * long as the head commit stands, because the dead run is still there to be read.
 * GitHub's own pull request page collapses each check to its latest run, and this
 * is that, done before any verdict is folded rather than after: a superseded
 * failure that reached `worse` would already have outvoted its own fix.
 *
 * Only a later generation of the same slot drops anything. Within one run and
 * attempt every check of a name is kept, which is what keeps a genuinely failing
 * matrix job from being hidden behind a namesake that passed.
 */
export function latestChecks(nodes: readonly (RawCheck | null)[]): RawCheck[] {
  const slots = new Map<string, { generation: Generation; nodes: RawCheck[] }>();
  const order: string[] = [];
  for (const node of nodes) {
    if (!node) continue;
    const slot = checkSlot(node);
    const generation = checkGeneration(node);
    const held = slots.get(slot);
    if (!held) {
      slots.set(slot, { generation, nodes: [node] });
      order.push(slot);
      continue;
    }
    if (generation[0] === held.generation[0] && generation[1] === held.generation[1]) {
      held.nodes.push(node);
    } else if (generation[0] > held.generation[0] || (generation[0] === held.generation[0] && generation[1] > held.generation[1])) {
      // The slot keeps its place in the reading order; only its contents change.
      slots.set(slot, { generation, nodes: [node] });
    }
  }
  return order.flatMap((slot) => slots.get(slot)?.nodes ?? []);
}

/**
 * What CI says, read from the individual checks rather than the rollup's summary.
 *
 * The summary `state` has been seen reporting SUCCESS on a commit whose required
 * check was FAILURE, which put a red PR in the ready-to-merge bucket. Walking the
 * contexts the way `gh pr checks` does gives the answer that page gives, and the
 * names of what failed.
 *
 * The summary is consulted only where the contexts cannot answer: none came back,
 * or `totalCount` says there are more than the hundred asked for. It is the weaker
 * reading in both directions — optimistic in the case above, pessimistic about a
 * run that was merely cancelled — so wherever the checks themselves are all in
 * hand, they have the last word.
 *
 * The unfinished ones are collected by name too, because "blocked on something
 * still running" and "blocked on the repository's merge policy" read identically
 * from the merge state alone, and the difference is the whole point of the gate
 * bucket. Cancellations are collected the same way and for the same reason: to be
 * sayable without being a verdict. Which name means which is not decided here:
 * these are facts, and the match against configuration happens in `prs.ts`.
 */
export function summarizeChecks(
  rollup: RawRollup | null | undefined,
): { checks: CheckState; failing: string[]; pending: PendingCheck[]; cancelled: PendingCheck[] } {
  if (!rollup) return { checks: null, failing: [], pending: [], cancelled: [] };

  const failing: string[] = [];
  const pending: PendingCheck[] = [];
  const cancelled: PendingCheck[] = [];
  const read = rollup.contexts?.nodes ?? [];
  const nodes = latestChecks(read);
  let derived: CheckState = null;
  for (const node of nodes) {
    if (node.__typename === 'CheckRun') {
      const name = node.name ?? 'unnamed check';
      const waiting: PendingCheck = { name, kind: 'check-run', detailsUrl: safeUrl(node.detailsUrl) };
      if (typeof node.databaseId === 'number') waiting.checkRunId = node.databaseId;
      if (node.status !== 'COMPLETED' || !node.conclusion) {
        pending.push(waiting);
        derived = worse(derived, 'pending');
      } else if (node.conclusion === 'CANCELLED') {
        // Named so the row can say so, and deliberately left out of `derived`: a
        // cancellation is neither a failure nor something still running.
        cancelled.push(waiting);
      } else if (FAILED_CONCLUSIONS.has(node.conclusion)) {
        failing.push(name);
        derived = worse(derived, 'failure');
      } else if (PASSED_CONCLUSIONS.has(node.conclusion)) {
        derived = worse(derived, 'success');
      } else {
        // STALE and anything GitHub adds later: not a pass, not a fail.
        pending.push(waiting);
        derived = worse(derived, 'pending');
      }
    } else if (node.__typename === 'StatusContext') {
      const name = node.context ?? 'unnamed status';
      if (node.state === 'FAILURE' || node.state === 'ERROR') {
        failing.push(name);
        derived = worse(derived, 'failure');
      } else if (node.state === 'SUCCESS') {
        derived = worse(derived, 'success');
      } else {
        // PENDING and EXPECTED, plus anything unrecognised: not finished.
        pending.push({ name, kind: 'status-context', detailsUrl: safeUrl(node.targetUrl) });
        derived = worse(derived, 'pending');
      }
    }
  }

  // Truncation is measured against what GitHub handed back, not against what
  // survived `latestChecks`: dropping a superseded run is this function reading
  // the page, not GitHub withholding it. Zero contexts read is the other way
  // round — there, the summary is all there is.
  const unread = read.length === 0 || rollupTruncated(rollup);
  return { checks: unread ? worse(derived, toCheckState(rollup.state)) : derived, failing, pending, cancelled };
}

function toMergeable(state: string | null | undefined): MergeableState {
  return state === 'MERGEABLE' || state === 'CONFLICTING' ? state : 'UNKNOWN';
}

const MERGE_STATES: readonly MergeStateStatus[] = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
];

/**
 * GitHub's merge state, or null when it didn't say.
 *
 * Null and `UNKNOWN` are different answers and are kept apart on purpose. `UNKNOWN`
 * is GitHub telling us it hasn't worked the merge out yet, which is not ready —
 * it computes the answer lazily, so the first request for a pull request it hasn't
 * looked at recently reports `UNKNOWN` and the next one reports the real state.
 * That resolves itself within a poll, which is why it costs a row a turn in
 * `checks` rather than anything worse. Null is nobody having told us at all — an
 * older cache — and falls back to the pre-merge-state reading in `prs.ts`. Anything
 * GitHub adds to the enum later reads as `UNKNOWN`, since a value we can't reason
 * about must not be read as a clean merge.
 */
export function toMergeState(state: unknown): MergeStateStatus | null {
  if (typeof state !== 'string' || state === '') return null;
  return (MERGE_STATES as readonly string[]).includes(state) ? (state as MergeStateStatus) : 'UNKNOWN';
}

function toDecision(state: string | null | undefined): ReviewDecision {
  return state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'REVIEW_REQUIRED' ? state : null;
}

/**
 * Reduce one search node to the facts the board keeps. Returns null for anything
 * that isn't recognisably a pull request, so one odd node can't sink a page.
 */
export function normalizePullRequest(raw: RawPullRequest, account: string): PullRequest | null {
  const repo = raw.repository?.nameWithOwner;
  if (typeof raw.number !== 'number' || typeof repo !== 'string' || typeof raw.title !== 'string') return null;
  if (typeof raw.url !== 'string' || typeof raw.createdAt !== 'string') return null;

  const head = raw.commits?.nodes?.[0]?.commit;
  const ci = summarizeChecks(head?.statusCheckRollup);
  const readyEvent = raw.readyEvents?.nodes?.find((node) => node?.createdAt)?.createdAt;
  const readyAt = raw.isDraft ? raw.createdAt : (readyEvent ?? raw.createdAt);

  let lastByYou: string | null = raw.createdAt;
  lastByYou = laterISO(lastByYou, readyAt);
  lastByYou = laterISO(lastByYou, head?.committedDate);

  let lastByOthers: PullActivity | null = null;
  const consider = (actor: RawActor | null | undefined, at: string | null | undefined, kind: PullActivity['kind']) => {
    if (!at || isBot(actor)) return;
    if (sameLogin(actor?.login, account)) {
      lastByYou = laterISO(lastByYou, at);
      return;
    }
    if (!lastByOthers || at > lastByOthers.at) lastByOthers = { at, login: actor?.login ?? 'someone', kind };
  };

  // One standing review per person: a reviewer who approved after requesting
  // changes counts once, as approved. Only a verdict replaces a verdict — GitHub
  // files every inline reply as a COMMENTED review, and "thanks" an hour after an
  // approval does not withdraw it. A dismissal does.
  const latestReview = new Map<string, { login: string; state: string; at: string }>();
  for (const review of raw.reviews?.nodes ?? []) {
    const at = review.submittedAt ?? null;
    consider(review.author, at, 'review');
    if (!at || isBot(review.author) || sameLogin(review.author?.login, account)) continue;
    const login = review.author?.login;
    if (!login || typeof review.state !== 'string') continue;
    const verdict = review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED';
    if (verdict || !latestReview.has(login)) latestReview.set(login, { login, state: review.state, at });
  }
  for (const comment of raw.comments?.nodes ?? []) {
    consider(comment.author, comment.createdAt ?? null, 'comment');
  }

  const requestedReviewers: string[] = [];
  for (const request of raw.reviewRequests?.nodes ?? []) {
    const who = request.requestedReviewer;
    const name = who?.login ?? who?.slug;
    if (typeof name === 'string' && name !== '') requestedReviewers.push(name);
  }

  return {
    id: `github:pr:${repo}#${raw.number}`,
    account,
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    isDraft: raw.isDraft === true,
    createdAt: raw.createdAt,
    readyAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.createdAt,
    headRef: typeof raw.headRefName === 'string' ? raw.headRefName : '',
    baseRef: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
    reviewDecision: toDecision(raw.reviewDecision),
    checks: ci.checks,
    failingChecks: ci.failing,
    mergeable: toMergeable(raw.mergeable),
    mergeStateStatus: toMergeState(raw.mergeStateStatus),
    pendingChecks: ci.pending,
    cancelledChecks: ci.cancelled,
    autoMerge: Boolean(raw.autoMergeRequest?.enabledAt),
    requestedReviewers,
    reviews: [...latestReview.values()].filter((review) => review.state !== 'DISMISSED'),
    lastActivityByYou: lastByYou,
    lastActivityByOthers: lastByOthers,
  };
}

/* ---------- one account's worth ---------- */

/**
 * What one account could see of each organisation in scope.
 *
 * `not-found` is what GitHub says about a private organisation to an account that
 * isn't a member, which with two accounts is the normal case for one of them. So
 * it is reported rather than warned about here; `board.ts` warns only when no
 * account at all can find it, which is when it's a typo.
 */
export type OrgVisibility = 'ok' | 'saml' | 'not-found';

export interface AccountFetch {
  /** The login the token actually belongs to, as GitHub reports it. */
  login: string;
  pulls: PullRequest[];
  warnings: string[];
  orgs: Record<string, OrgVisibility>;
  rateLimitRemaining: number | null;
}

/**
 * Ask which orgs in scope this token can actually see, before searching them.
 *
 * A search scoped to a SAML-protected org the token isn't authorised for returns
 * nothing, and nothing is what a quiet board looks like. Asking for each org by
 * name gets a refusal instead of an absence, which can be shown and fixed. An org
 * this account simply isn't a member of is not a warning — with two accounts,
 * each seeing its own orgs is the normal case.
 */
function buildProbeQuery(scope: readonly string[]): { query: string; orgs: string[] } {
  const orgs = scope
    .filter((qualifier) => qualifier.startsWith('org:'))
    .map((qualifier) => qualifier.slice('org:'.length));
  // `repositoryOwner` resolves a user as well as an organisation, since the scope
  // accepts both. Asking for one repository is what makes single sign-on speak up:
  // the owner itself is public and answers cleanly however the token is authorised.
  const fields = orgs.map(
    (org, i) => `o${i}: repositoryOwner(login: ${JSON.stringify(org)}) { login repositories(first: 1) { totalCount } }`,
  );
  return { query: `{ viewer { login } ${fields.join(' ')} }`, orgs };
}

/** One commit's checks being read past the first page, and where the reading got to. */
interface Walk {
  id: string;
  pull: PullRequest;
  /** The head commit the first page described. */
  oid: string | null;
  /** That first page, which the walk resumes from and is spliced onto. */
  rollup: RawRollup;
  /** Contexts read beyond the first page. */
  nodes: RawCheck[];
  cursor: string | null;
  totalCount: number | undefined;
  /** The walk reached the end of this commit's contexts. */
  complete: boolean;
  /** The head commit moved mid-walk, so what was read belongs to no one commit. */
  stale: boolean;
  done: boolean;
}

/**
 * One round of several commits' remaining checks, each resumed from its own cursor.
 *
 * Aliased fields rather than `nodes(ids: [...])`, because every pull request is at
 * a different point in its own connection and `nodes` takes one argument list for
 * all of them. Same idiom as the org probe above, and the same reason: the
 * alternative is a request per pull request, and a large repository needs a dozen
 * of those for one commit.
 */
export function buildRemainingChecksQuery(batch: readonly { id: string; cursor: string | null }[]): string {
  const fields = batch.map((walk, i) => {
    const after = walk.cursor === null ? 'null' : JSON.stringify(walk.cursor);
    return `w${i}: node(id: ${JSON.stringify(walk.id)}) {
    ... on PullRequest {
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup { contexts(first: ${CONTEXT_PAGE_SIZE}, after: ${after}) { ${CHECK_CONTEXTS} } }
          }
        }
      }
    }
  }`;
  });
  return `{\n  ${fields.join('\n  ')}\n}`;
}

/**
 * Read the checks the first page didn't fit, for every pull request that has some.
 *
 * A hundred contexts is generous for most repositories and nothing like enough for
 * a large test matrix: 700 to 1300 on one commit, where the first page can be all
 * green while the failure — or the merge gate still running — sits on the third.
 * An account with thirty-two such pull requests takes about 105 pages to read
 * out, which is two minutes and 105 requests asked one pull request at a time.
 * Batched six to a request it is 27 requests and 45 seconds — and since a request
 * costs one point whether it carries one pull request or six, measured both ways,
 * the batching buys the points back as well as the time.
 *
 * Every walk advances one page per round, so the rounds are bounded by the longest
 * commit rather than by how many there are. A round that fails costs the pulls in
 * it their completion and nothing more: they keep the first page's reading, in
 * which `summarizeChecks` has already folded GitHub's summary as a floor.
 */
async function walkRemainingChecks(
  token: string,
  walks: readonly Walk[],
  budget: number,
  signal?: AbortSignal,
): Promise<{ requests: number; rateLimitRemaining: number | null; failure: string | null; exhausted: boolean }> {
  let requests = 0;
  let rateLimitRemaining: number | null = null;
  let failure: string | null = null;
  let exhausted = false;

  for (let round = 0; round < MAX_CONTEXT_PAGES && !exhausted; round++) {
    const active = walks.filter((walk) => !walk.done);
    if (active.length === 0) break;
    for (let from = 0; from < active.length; from += CHECKS_BATCH_SIZE) {
      if (requests >= budget) {
        exhausted = true;
        break;
      }
      const batch = active.slice(from, from + CHECKS_BATCH_SIZE);
      requests++;
      let result: GraphQLResult<Record<string, RawPullRequest | null>>;
      try {
        result = await graphql(token, buildRemainingChecksQuery(batch), {}, signal);
      } catch (err) {
        failure ??= (err as Error).message;
        for (const walk of batch) walk.done = true;
        continue;
      }
      rateLimitRemaining = result.rateLimitRemaining ?? rateLimitRemaining;
      const fatal = result.errors.filter((error) => !isSamlError(error));
      if (result.data === null && fatal.length > 0) {
        failure ??= fatal.map((error) => error.message).join('; ');
        for (const walk of batch) walk.done = true;
        continue;
      }
      batch.forEach((walk, i) => {
        const head = result.data?.[`w${i}`]?.commits?.nodes?.[0]?.commit;
        // A push landing mid-walk gives `commits(last: 1)` a different commit,
        // whose connection this cursor doesn't index at all. What was read is
        // thrown away rather than spliced onto the wrong commit; the next poll
        // reads the new head from its first page.
        if (walk.oid && head?.oid && head.oid !== walk.oid) {
          walk.stale = true;
          walk.done = true;
          return;
        }
        const contexts = head?.statusCheckRollup?.contexts;
        // Nothing to read and no error: leave it unfinished, which keeps the
        // summary in charge rather than claiming the checks in hand are all of them.
        if (!contexts) {
          walk.done = true;
          return;
        }
        if (typeof contexts.totalCount === 'number') walk.totalCount = contexts.totalCount;
        for (const node of contexts.nodes ?? []) if (node) walk.nodes.push(node);
        if (contexts.pageInfo?.hasNextPage === true && contexts.pageInfo.endCursor) {
          walk.cursor = contexts.pageInfo.endCursor;
        } else {
          walk.complete = true;
          walk.done = true;
        }
      });
    }
  }
  return { requests, rateLimitRemaining, failure, exhausted };
}

/** The merge states for pulls already found, by node id. */
async function fetchMergeStates(
  token: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<{ states: Map<string, MergeStateStatus | null>; rateLimitRemaining: number | null }> {
  if (ids.length === 0) return { states: new Map(), rateLimitRemaining: null };
  const result = await graphql<{ nodes?: (RawMergeState | null)[] }>(token, MERGE_STATE_QUERY, { ids }, signal);
  const fatal = result.errors.filter((error) => !isSamlError(error));
  if (result.data?.nodes === undefined && fatal.length > 0) {
    throw new GitHubRequestError(fatal.map((error) => error.message).join('; '));
  }
  return { states: mergeStatesFromNodes(result.data?.nodes ?? []), rateLimitRemaining: result.rateLimitRemaining };
}

export async function fetchPulls(
  token: string,
  scope: readonly string[],
  expectedLogin: string | null,
  signal?: AbortSignal,
): Promise<AccountFetch> {
  const warnings: string[] = [];

  const probe = buildProbeQuery(scope);
  const who = await graphql<{ viewer?: { login?: string } } & Record<string, unknown>>(token, probe.query, {}, signal);
  const login = who.data?.viewer?.login ?? expectedLogin ?? 'unknown';
  const orgs: Record<string, OrgVisibility> = {};
  let samlWarned = false;
  probe.orgs.forEach((org, i) => {
    const error = who.errors.find((candidate) => candidate.path?.[0] === `o${i}`);
    if (error && isSamlError(error)) {
      orgs[org] = 'saml';
      samlWarned = true;
      warnings.push(
        `${login} can't see ${org}: the token isn't authorised for that organisation's single sign-on. ` +
          `Run \`gh auth refresh\` as ${login}, or authorise the GitHub CLI app for ${org} under GitHub's SSO settings.`,
      );
    } else if (!error && who.data?.[`o${i}`] === null) {
      // No such owner answers as null without an error.
      orgs[org] = 'not-found';
    } else {
      orgs[org] = 'ok';
    }
  });

  const pulls: PullRequest[] = [];
  let after: string | null = null;
  let rateLimitRemaining = who.rateLimitRemaining;
  let mergeStateWarned = false;
  let contextsWarned = false;
  let contextBudgetWarned = false;
  let contextRequests = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: GraphQLResult<{
      search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (RawPullRequest | null)[] };
    }> = await graphql(token, SEARCH_QUERY, { q: buildSearchQuery(scope), first: PAGE_SIZE, after }, signal);
    rateLimitRemaining = result.rateLimitRemaining ?? rateLimitRemaining;

    const fatal = result.errors.filter((error) => !isSamlError(error));
    if (result.data?.search === undefined && fatal.length > 0) {
      throw new GitHubRequestError(`GitHub search failed: ${fatal.map((error) => error.message).join('; ')}`);
    }
    if (!samlWarned && result.errors.some(isSamlError)) {
      samlWarned = true;
      warnings.push(`${login}: some results were withheld by an organisation's single sign-on policy.`);
    }

    // Keyed by node id only for as long as it takes to ask for the merge states;
    // the id is GitHub's handle for the pull request, not a fact about it, and it
    // is deliberately not among the facts that reach `prs.json`.
    const found = new Map<string, PullRequest>();
    for (const node of result.data?.search?.nodes ?? []) {
      if (!node) continue;
      const pull = normalizePullRequest(node, login);
      if (!pull) continue;
      // The node id is now the join key for the checks as well as the merge state,
      // and a pull request whose checks were never read looks quiet rather than
      // unknown. So one without an id is dropped, the same way `normalizePullRequest`
      // drops a node it can't make sense of, rather than shown with a reading
      // nothing supplied.
      if (typeof node.id !== 'string' || node.id === '') continue;
      pulls.push(pull);
      found.set(node.id, pull);
    }

    // The board is the search; the merge state is an improvement on it. So a
    // second request that fails leaves the pulls alone and says so once, rather
    // than costing the account its rows — `prs.ts` falls back to judging ready
    // from the review and the checks when nothing says otherwise.
    try {
      const states = await fetchMergeStates(token, [...found.keys()], signal);
      rateLimitRemaining = states.rateLimitRemaining ?? rateLimitRemaining;
      for (const [nodeId, pull] of found) {
        if (states.states.has(nodeId)) pull.mergeStateStatus = states.states.get(nodeId) ?? null;
      }
    } catch (err) {
      if (!mergeStateWarned) {
        mergeStateWarned = true;
        warnings.push(
          `${login}: GitHub wouldn't say whether these pull requests can be merged (${(err as Error).message}). ` +
            'Ready to merge falls back to the reviews and checks until the next poll.',
        );
      }
    }

    // The checks, which the search no longer carries. Unlike the merge state this
    // is not an improvement on the search but half of what a court is judged from,
    // and a pull request with no reading at all would look quiet rather than
    // unknown — an empty `pendingChecks` beside a null `checks` is exactly what
    // `prs.ts` reads as nothing outstanding. So a batch that fails takes the
    // account's whole round with it: the board keeps the rows it had and says why,
    // rather than showing a red pull request as ready to merge.
    const partial: { id: string; pull: PullRequest; oid: string | null; rollup: RawRollup }[] = [];
    const ids = [...found.keys()];
    for (let from = 0; from < ids.length; from += CHECKS_BATCH_SIZE) {
      const batch = ids.slice(from, from + CHECKS_BATCH_SIZE);
      const checks = await fetchChecks(token, batch, signal);
      rateLimitRemaining = checks.rateLimitRemaining ?? rateLimitRemaining;
      for (const [nodeId, head] of checks.heads) {
        const pull = found.get(nodeId);
        if (!pull) continue;
        applyChecks(pull, head.rollup);
        if (head.rollup && rollupTruncated(head.rollup)) {
          partial.push({ id: nodeId, pull, oid: head.oid, rollup: head.rollup });
        }
      }
    }

    // Read the rest of the checks for the pulls that had more than a page of them.
    // Unlike the first page this is an improvement on a reading that already
    // exists rather than the only one there is, so what it costs when it fails is
    // the completion: `summarizeChecks` falls back to GitHub's summary, which is
    // the pessimistic direction and self-corrects on the next poll.
    if (partial.length > 0) {
      const walks: Walk[] = partial.map((entry) => ({
        ...entry,
        nodes: [],
        cursor: entry.rollup.contexts?.pageInfo?.endCursor ?? null,
        totalCount: entry.rollup.contexts?.totalCount,
        complete: false,
        stale: false,
        done: false,
      }));
      const walked = await walkRemainingChecks(token, walks, MAX_CONTEXT_REQUESTS - contextRequests, signal);
      contextRequests += walked.requests;
      rateLimitRemaining = walked.rateLimitRemaining ?? rateLimitRemaining;

      for (const walk of walks) {
        if (walk.stale || walk.nodes.length === 0) continue;
        applyChecks(walk.pull, {
          state: walk.rollup.state,
          contexts: {
            totalCount: walk.totalCount,
            // What the walk found out, said in the one field that outranks the
            // count: complete means the checks themselves have the last word.
            pageInfo: { hasNextPage: !walk.complete },
            nodes: [...(walk.rollup.contexts?.nodes ?? []), ...walk.nodes],
          },
        });
      }

      if (walked.failure && !contextsWarned) {
        contextsWarned = true;
        warnings.push(
          `${login}: GitHub wouldn't list all the checks on some pull requests (${walked.failure}). ` +
            "Their CI state comes from GitHub's own summary until the next poll.",
        );
      }
      if (walked.exhausted && !contextBudgetWarned) {
        contextBudgetWarned = true;
        warnings.push(
          `${login}: some pull requests have more checks than the board reads in one poll, so their CI state ` +
            "comes from GitHub's own summary rather than the checks themselves.",
        );
      }
    }

    const pageInfo = result.data?.search?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
    if (page === MAX_PAGES - 1) {
      warnings.push(`${login} has more open pull requests than the board reads (${MAX_PAGES * PAGE_SIZE}); narrow the scope.`);
    }
  }

  return { login, pulls, warnings, orgs, rateLimitRemaining };
}
