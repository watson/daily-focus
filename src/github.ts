import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CheckState, MergeableState, PullActivity, PullRequest, ReviewDecision } from './types.ts';

const run = promisify(execFile);

/** Long enough for a keychain prompt to be answered, short enough that a wedged gh can't stall a poll. */
const GH_TIMEOUT_MS = 15_000;
/** Networks fail slowly; this bounds one GraphQL round trip. */
const FETCH_TIMEOUT_MS = 30_000;

const GRAPHQL_URL = 'https://api.github.com/graphql';

/** Pages of search results to walk before giving up; fifty a page. */
const MAX_PAGES = 6;

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
    const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (failure.code === 'ENOENT') throw new GhMissingError(ghPath);
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === 'number' ? failure.code : 1,
    };
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
 * non-zero but still prints the structure, so the output is read either way.
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
    const { login, active, state } = entry as { login?: unknown; active?: unknown; state?: unknown };
    if (typeof login !== 'string' || login === '') continue;
    if (state !== undefined && state !== 'success') continue;
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

const SEARCH_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
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
        commits(last: 1) {
          nodes { commit { committedDate statusCheckRollup { state } } }
        }
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

/** Loosely typed: the shape of one `search.nodes` entry, as far as the board reads it. */
export interface RawPullRequest {
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
  autoMergeRequest?: { enabledAt?: string } | null;
  commits?: { nodes?: { commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null } }[] };
  readyEvents?: { nodes?: ({ createdAt?: string } | null)[] };
  reviewRequests?: { nodes?: { requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null }[] };
  reviews?: { nodes?: { author?: RawActor | null; state?: string; submittedAt?: string | null }[] };
  comments?: { nodes?: { author?: RawActor | null; createdAt?: string }[] };
}

export interface RawActor {
  __typename?: string;
  login?: string;
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

function toMergeable(state: string | null | undefined): MergeableState {
  return state === 'MERGEABLE' || state === 'CONFLICTING' ? state : 'UNKNOWN';
}

function toDecision(state: string | null | undefined): ReviewDecision {
  return state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'REVIEW_REQUIRED' ? state : null;
}

function latest(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return b > a ? b : a;
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
  const readyEvent = raw.readyEvents?.nodes?.find((node) => node?.createdAt)?.createdAt;
  const readyAt = raw.isDraft ? raw.createdAt : (readyEvent ?? raw.createdAt);

  let lastByYou: string | null = raw.createdAt;
  lastByYou = latest(lastByYou, readyAt);
  lastByYou = latest(lastByYou, head?.committedDate);

  let lastByOthers: PullActivity | null = null;
  const consider = (actor: RawActor | null | undefined, at: string | null | undefined, kind: PullActivity['kind']) => {
    if (!at || isBot(actor)) return;
    if (sameLogin(actor?.login, account)) {
      lastByYou = latest(lastByYou, at);
      return;
    }
    if (!lastByOthers || at > lastByOthers.at) lastByOthers = { at, login: actor?.login ?? 'someone', kind };
  };

  // Latest formal review per person, so a reviewer who approved after requesting
  // changes counts once, as approved.
  const latestReview = new Map<string, { login: string; state: string; at: string }>();
  for (const review of raw.reviews?.nodes ?? []) {
    const at = review.submittedAt ?? null;
    consider(review.author, at, 'review');
    if (!at || isBot(review.author) || sameLogin(review.author?.login, account)) continue;
    const login = review.author?.login;
    if (!login || typeof review.state !== 'string') continue;
    latestReview.set(login, { login, state: review.state, at });
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
    checks: toCheckState(head?.statusCheckRollup?.state),
    mergeable: toMergeable(raw.mergeable),
    autoMerge: Boolean(raw.autoMergeRequest?.enabledAt),
    requestedReviewers,
    reviews: [...latestReview.values()].filter((review) => review.state !== 'DISMISSED'),
    lastActivityByYou: lastByYou,
    lastActivityByOthers: lastByOthers,
  };
}

/* ---------- one account's worth ---------- */

export interface AccountFetch {
  /** The login the token actually belongs to, as GitHub reports it. */
  login: string;
  pulls: PullRequest[];
  warnings: string[];
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
  const fields = orgs.map((org, i) => `o${i}: organization(login: ${JSON.stringify(org)}) { login }`);
  return { query: `{ viewer { login } ${fields.join(' ')} }`, orgs };
}

export async function fetchPulls(
  token: string,
  scope: readonly string[],
  expectedLogin: string | null,
  signal?: AbortSignal,
): Promise<AccountFetch> {
  const warnings: string[] = [];

  const probe = buildProbeQuery(scope);
  const who = await graphql<{ viewer?: { login?: string } }>(token, probe.query, {}, signal);
  const login = who.data?.viewer?.login ?? expectedLogin ?? 'unknown';
  for (const error of who.errors) {
    const alias = error.path?.[0];
    const index = typeof alias === 'string' && /^o\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
    const org = probe.orgs[index];
    if (org && isSamlError(error)) {
      warnings.push(
        `${login} can't see ${org}: the token isn't authorised for that organisation's single sign-on. ` +
          `Run \`gh auth refresh\` as ${login}, or authorise the GitHub CLI app for ${org} under GitHub's SSO settings.`,
      );
    } else if (org && error.type === 'NOT_FOUND') {
      warnings.push(`${login} can't find an organisation called ${org} — check DAILY_FOCUS_GITHUB_SCOPE.`);
    }
  }

  const pulls: PullRequest[] = [];
  let after: string | null = null;
  let rateLimitRemaining = who.rateLimitRemaining;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: GraphQLResult<{
      search?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (RawPullRequest | null)[] };
    }> = await graphql(token, SEARCH_QUERY, { q: buildSearchQuery(scope), after }, signal);
    rateLimitRemaining = result.rateLimitRemaining ?? rateLimitRemaining;

    const fatal = result.errors.filter((error) => !isSamlError(error));
    if (result.data?.search === undefined && fatal.length > 0) {
      throw new GitHubRequestError(`GitHub search failed: ${fatal.map((error) => error.message).join('; ')}`);
    }
    for (const error of result.errors) {
      if (isSamlError(error) && !warnings.some((warning) => warning.includes('single sign-on'))) {
        warnings.push(`${login}: some results were withheld by an organisation's single sign-on policy.`);
      }
    }

    for (const node of result.data?.search?.nodes ?? []) {
      if (!node) continue;
      const pull = normalizePullRequest(node, login);
      if (pull) pulls.push(pull);
    }

    const pageInfo = result.data?.search?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
    if (page === MAX_PAGES - 1) {
      warnings.push(`${login} has more open pull requests than the board reads (${MAX_PAGES * 50}); narrow the scope.`);
    }
  }

  return { login, pulls, warnings, rateLimitRemaining };
}
