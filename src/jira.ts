/**
 * How the ticket board reaches Jira: the Atlassian CLI, borrowed the way
 * `github.ts` borrows gh.
 *
 * `acli` keeps its own OAuth session, so there is no token here to store, expire
 * or leak — the same bargain the pull request board struck, and the reason this
 * board could be built at all.
 *
 * **One function here writes to Jira**, and exactly one: `transitionTicket`. It
 * moves a work item to a named status and does nothing else — no field edits, no
 * comments, no deletes — and it only ever runs from a click the user made on a
 * row. Everything else is a search or a status read. That boundary is the whole
 * safety argument for pointing this at a shared Jira, so a second writing
 * function needs to be a deliberate decision rather than a convenience.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Ticket, TicketStatusCategory } from './types.ts';

const run = promisify(execFile);

/**
 * Long enough for `acli` to refresh an OAuth token it decided was stale, short
 * enough that a wedged one can't hold a poll open forever. A warm search of a
 * hundred tickets measures around three seconds.
 */
const ACLI_TIMEOUT_MS = 45_000;

/**
 * Tickets per page. `--paginate` then walks to the end, so unlike `github.ts`
 * there is no page ceiling here — deliberately, because the candidate set is
 * bounded by one person's own unfinished work rather than by an organisation's
 * activity. A heavy backlog measured 105.
 */
const PAGE_LIMIT = 200;

/*
 * NO_COLOR because the output is parsed: `acli` prints a ✓ or ✗ line and would
 * wrap it in escape codes on a terminal, and the JSON is read off the same stream.
 */
const ACLI_ENV = { ...process.env, NO_COLOR: '1' };

/** `acli` itself couldn't be run: not installed, or not where we were told. */
export class AcliMissingError extends Error {
  constructor(acliPath: string) {
    super(
      `could not run \`${acliPath}\` — install the Atlassian CLI or set DAILY_FOCUS_ACLI to its path`,
    );
    this.name = 'AcliMissingError';
  }
}

/** `acli` ran, but has no usable Jira session. */
export class AcliAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcliAuthError';
  }
}

/** A search ran and failed — bad JQL, a permission, or Jira being Jira. */
export class JiraSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraSearchError';
  }
}

/**
 * A transition was refused. Carries Jira's own words, because this is the one
 * place the dashboard cannot know the answer in advance: `acli` exposes no way
 * to ask which transitions a work item allows, so the offer is made from the
 * statuses the user's own tickets are seen in and Jira is left to be the
 * authority on whether the move is legal.
 */
export class JiraTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraTransitionError';
  }
}

async function acli(acliPath: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(acliPath, args, {
      env: ACLI_ENV,
      timeout: ACLI_TIMEOUT_MS,
      // A hundred tickets of raw Jira issue JSON measured 135 KB; this is room
      // for a board several times that before the buffer becomes the limit.
      maxBuffer: 8 << 20,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (failure.code === 'ENOENT' || failure.code === 'EACCES') throw new AcliMissingError(acliPath);
    // A killed acli is not an unauthenticated one. execFile leaves stderr empty
    // on a timeout, and an empty stderr would otherwise be read as "it said
    // nothing", which is indistinguishable from a clean refusal.
    const stderr = failure.killed || failure.signal
      ? `acli did not answer within ${ACLI_TIMEOUT_MS / 1000}s — a slow network, or an OAuth refresh waiting on something?`
      : failure.stderr || failure.message;
    return { stdout: failure.stdout ?? '', stderr, code: typeof failure.code === 'number' ? failure.code : 1 };
  }
}

/** The first line of a complaint, with acli's ✗ marker trimmed off. */
function firstLine(stderr: string): string {
  return (
    stderr
      .split('\n')
      .map((line) => line.replace(/^\s*[✗✓]\s*/u, '').replace(/^Error:\s*/i, '').trim())
      .find((line) => line !== '') ?? ''
  );
}

/* ---------- who acli is ---------- */

export interface JiraIdentity {
  /**
   * The Atlassian site host, used to build browse links. Null when `acli` said
   * it was authenticated but didn't name a site, in which case rows render
   * without links rather than with guessed ones.
   */
  site: string | null;
  /** The account, for the status line. Null when `acli` didn't say. */
  account: string | null;
}

/**
 * Who `acli` is logged in as, and to which site.
 *
 * This doubles as the auth probe, for the reason `github.ts` probes each org: an
 * unauthenticated CLI and a quiet board look identical, and a board that looks
 * merely empty is the failure worth spending a round trip to avoid. Only a
 * non-zero exit is fatal — an authenticated `acli` that words its output
 * differently costs the browse links and a warning, not the board.
 *
 * The site is not derived from the `self` URLs in the search results. Those name
 * the internal host Jira Cloud is served from rather than the tenant, so a link
 * built from one would be well-formed and wrong.
 */
export async function acliIdentity(acliPath: string): Promise<JiraIdentity> {
  const { stdout, stderr, code } = await acli(acliPath, ['jira', 'auth', 'status']);
  if (code !== 0) {
    const detail = firstLine(stderr) || firstLine(stdout) || 'no Jira session';
    throw new AcliAuthError(`acli has no Jira session (${detail}) — run \`acli jira auth login\``);
  }
  const site = /^\s*Site:\s*(\S+)\s*$/mu.exec(stdout)?.[1] ?? null;
  const account = /^\s*Email:\s*(\S+)\s*$/mu.exec(stdout)?.[1] ?? null;
  return { site: site ?? null, account };
}

/* ---------- JQL ---------- */

/**
 * The two development-panel predicates the whole board rests on.
 *
 * Jira exposes exactly these two counts to JQL — `.all` and `.open`, and nothing
 * else. Its parser says so itself when asked for a third: *for
 * "development[pullrequests]" use "development[pullrequests].all" or
 * "development[pullrequests].open"*. So `.merged`, `.declined` and `.draft` are
 * all parse errors, "closed" here means merged or abandoned, and the board is
 * careful never to claim which.
 *
 * **`.open` does not count a draft**, which is the trap this board fell into.
 * GitHub's Jira integration reports `DRAFT` as a state *beside* `OPEN` rather
 * than a kind of it, and sets `open: false` on the rollup — so a ticket whose
 * every pull request is a draft matches `.all > 0` and not `.open > 0`, which is
 * indistinguishable through JQL alone from a ticket whose every pull request has
 * merged. `fetchTickets` repairs the count from the development panel itself;
 * see `readDevPullRequests`.
 */
export const ANY_PR = 'development[pullrequests].all > 0';
export const OPEN_PR = 'development[pullrequests].open > 0';

/** A JQL string literal. Project keys are tame, but nothing here builds on that. */
function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One search, built from the candidate clause and an optional extra predicate.
 *
 * The candidate set is "unfinished, and mine to move" — assigned to the user, or
 * raised by them and still unassigned, which is the same pair the morning prompt
 * uses. `statusCategory` rather than a list of status names, so no site's column
 * names are baked in here.
 *
 * `ORDER BY updated ASC` is how a row's age reaches the screen at all. None of
 * the timestamp fields are available through `acli`'s search whitelist — only
 * `key`, `status`, `issuetype`, `summary`, `assignee` and `priority` — but
 * ordering on one is allowed, so the board inherits "least recently touched
 * first" as a ranking and claims no dates it can't show.
 */
export function buildJql(projects: readonly string[], predicate: string | null): string {
  const clauses = [
    'statusCategory != Done',
    '(assignee = currentUser() OR (reporter = currentUser() AND assignee IS EMPTY))',
  ];
  if (projects.length > 0) clauses.push(`project IN (${projects.map(quoteJql).join(', ')})`);
  if (predicate) clauses.push(predicate);
  return `${clauses.join(' AND ')} ORDER BY updated ASC`;
}

/**
 * The fields worth asking for, of the handful `acli` permits — the whitelist is
 * `key`, `status`, `issuetype`, `summary`, `assignee` and `priority`, and no
 * timestamp is on it.
 *
 * Used for all three searches, including the two that only need keys, because
 * **`--fields key` on its own returns an array of nulls**: the right number of
 * entries, every one of them empty, and a zero exit code. Asking for a real field
 * alongside it is what makes the keys appear. That is a trap worth spending a few
 * kilobytes to stay out of, since the two membership searches coming back empty is
 * indistinguishable from a user with no pull requests.
 */
const FIELDS = 'key,status,issuetype,summary';

async function search(
  acliPath: string,
  jql: string,
  { limit = PAGE_LIMIT, paginate = true }: { limit?: number; paginate?: boolean } = {},
): Promise<unknown[]> {
  const args = [
    'jira', 'workitem', 'search',
    '--jql', jql,
    '--fields', FIELDS,
    '--limit', String(limit),
    '--json',
  ];
  if (paginate) args.push('--paginate');
  const { stdout, stderr, code } = await acli(acliPath, args);
  if (code !== 0) {
    throw new JiraSearchError(firstLine(stderr) || firstLine(stdout) || 'the Jira search failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // A zero exit with unreadable output is not an empty result, and must not be
    // allowed to read as one: an empty answer is what this board's every failure
    // mode looks like from the outside.
    throw new JiraSearchError(`could not read acli's answer as JSON (${stdout.trim().slice(0, 120) || 'empty'})`);
  }
  if (!Array.isArray(parsed)) throw new JiraSearchError("acli's answer was not a list of work items");
  return parsed;
}

/* ---------- reading one issue ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CATEGORIES: readonly TicketStatusCategory[] = ['new', 'indeterminate', 'done', 'undefined'];

function toCategory(value: unknown): TicketStatusCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
    ? (value as TicketStatusCategory)
    : 'undefined';
}

/** The issue key, which Jira puts at the top level rather than among the fields. */
function issueKey(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.key === 'string' && raw.key !== '') return raw.key;
  const fields = isRecord(raw.fields) ? raw.fields : null;
  return typeof fields?.key === 'string' && fields.key !== '' ? fields.key : null;
}

/**
 * The browse link for a work item, or null when `acli` never said which site it
 * is logged in to. Shared with the warnings, which name keys and are the one
 * place in this board a row is talked about without being rendered as one.
 */
function browseUrl(site: string | null, key: string): string | null {
  return site ? `https://${site}/browse/${encodeURIComponent(key)}` : null;
}

/**
 * One issue, reduced to facts. Null for anything unreadable, one issue at a time
 * rather than all or nothing — the same rule `validate.ts` applies to the brief.
 *
 * Tickets above the base hierarchy level are dropped here: an epic with merged
 * children is a project in progress rather than an oversight, and telling someone
 * to close the epic tracking their current objective is worse than saying nothing.
 * The level is read off the issue type rather than matched against a list of type
 * names, so a site's own extra tier above Epic — an Initiative, a Theme — is
 * excluded without being named.
 */
export function toTicket(
  raw: unknown,
  site: string | null,
  hasAnyPr: boolean,
  hasOpenPr: boolean,
  allPrsClosed = false,
): Ticket | null {
  const key = issueKey(raw);
  if (key === null || !isRecord(raw)) return null;
  const fields = isRecord(raw.fields) ? raw.fields : {};

  const issuetype = isRecord(fields.issuetype) ? fields.issuetype : {};
  const level = typeof issuetype.hierarchyLevel === 'number' ? issuetype.hierarchyLevel : 0;
  if (level > 0) return null;

  const status = isRecord(fields.status) ? fields.status : {};
  const category = isRecord(status.statusCategory) ? status.statusCategory : {};

  return {
    id: `jira:${key}`,
    key,
    summary: typeof fields.summary === 'string' ? fields.summary : key,
    workflowStatus: typeof status.name === 'string' ? status.name : '',
    statusCategory: toCategory(category.key),
    issueType: typeof issuetype.name === 'string' ? issuetype.name : '',
    url: browseUrl(site, key),
    // An open pull request is a pull request, whatever the other count said.
    hasAnyPr: hasAnyPr || hasOpenPr,
    hasOpenPr,
    // Never inferred from the two above, which is the whole point of the field:
    // they cannot tell "all closed" from "could not find out".
    allPrsClosed: allPrsClosed && !hasOpenPr,
  };
}

/* ---------- the development panel ---------- */

/**
 * Jira's own id for the development panel field. The same on every Cloud site,
 * and the only route to what JQL will not select.
 *
 * `acli jira workitem search` refuses it — *field 'customfield_10000' is not
 * allowed* — which is presumably why the board went so long reading drafts as
 * merges. `acli jira workitem view` has no such whitelist and returns it.
 */
export const DEV_FIELD = 'customfield_10000';

/** What the development panel rolls a ticket's pull requests up to. */
export interface DevPullRequests {
  /** How many pull requests Jira has linked to the ticket. */
  count: number;
  /** The state it rolls them up to: `OPEN`, `DRAFT`, `MERGED` or `DECLINED`. */
  state: string;
  /** How many of `count` are in that state. Below it, the rest are unnamed. */
  stateCount: number;
}

/**
 * Pull request states that mean the code side of a ticket is over.
 *
 * `DRAFT` and `OPEN` are the other two, and both mean work is still in flight.
 * `DRAFT`'s absence from this list is the entire fix: it used to be absent from
 * the *question* instead, which read it as closed by default.
 */
const CLOSED_PR_STATES: readonly string[] = ['MERGED', 'DECLINED'];

/**
 * How many panels to read at once. One measured 1.2 seconds, and only the
 * settled candidates are asked about — nineteen on the heaviest real board seen,
 * usually a handful. Five keeps the repair inside a few seconds without opening
 * a process per ticket.
 */
const DEV_CONCURRENCY = 5;

/**
 * The JSON object starting at `from`, found by matching braces.
 *
 * The panel arrives as Java's rendering of a map rather than as JSON —
 * `{pullrequest={…}, build={…}, json={…}}` — and only its `json=` member is
 * readable. Slicing to the last `}` would take the outer map's brace with it, so
 * the extent is matched; braces inside strings are skipped, since a branch or
 * repository name carrying one would otherwise end the object early.
 */
function jsonObjectAt(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * The pull request rollup out of one development panel field, or null when the
 * panel did not answer.
 *
 * Null is not "no pull requests" — it is "we did not find out", and the caller
 * keeps those apart. A ticket matching `.all > 0` whose panel carries no
 * `pullrequest` summary at all is a real case rather than a hypothetical: one was
 * measured carrying six repositories and twenty-two builds and no pull requests,
 * disagreeing with the JQL that selected it.
 *
 * **`isStale` is deliberately not consulted.** Every panel read through this
 * route reports it true, including ones whose contents were checked by hand and
 * found correct, so gating on it would empty the settled court entirely rather
 * than guard anything. `errors` is consulted, because a panel that failed to
 * reach a provider may be missing a pull request — the one way this read can be
 * wrong in the unsafe direction.
 */
export function readDevPullRequests(field: unknown): DevPullRequests | null {
  if (typeof field !== 'string') return null;
  const marker = field.indexOf('json=');
  if (marker === -1) return null;
  const opens = field.indexOf('{', marker);
  if (opens === -1) return null;
  const body = jsonObjectAt(field, opens);
  if (body === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const cached = isRecord(parsed) && isRecord(parsed.cachedValue) ? parsed.cachedValue : null;
  if (!cached) return null;
  if (Array.isArray(cached.errors) && cached.errors.length > 0) return null;

  const summary = isRecord(cached.summary) ? cached.summary : null;
  const pullrequest = summary && isRecord(summary.pullrequest) ? summary.pullrequest : null;
  const overall = pullrequest && isRecord(pullrequest.overall) ? pullrequest.overall : null;
  if (!overall) return null;

  const { count, stateCount, state } = overall;
  if (typeof count !== 'number' || typeof stateCount !== 'number' || typeof state !== 'string') return null;
  return { count, state, stateCount };
}

/**
 * Whether the panel **positively said** every linked pull request is closed.
 *
 * Everything unknown answers false, which is the polarity `readTransitionReport`
 * argues for and for the same reason: on a board whose whole job is catching
 * statuses that say untrue things, a false "finished" is a lie the user has no
 * way to catch, while a false "don't know" costs one row that the next read
 * restores.
 */
export function allPullRequestsClosed(dev: DevPullRequests | null): boolean {
  if (dev === null || dev.count < 1) return false;
  // The rollup names one state and how many sit in it. Fewer than the total
  // means the rest are in states it did not name, and any of them could be a
  // draft, so the only honest answer is that we do not know.
  if (dev.stateCount !== dev.count) return false;
  return CLOSED_PR_STATES.includes(dev.state.toUpperCase());
}

/**
 * Read one ticket's development panel.
 *
 * Throws when `acli` could not be asked, returns null when it answered without
 * naming any pull requests. Both end in the same place — the ticket is not
 * confirmed settled — but only the first is a fault worth a different warning.
 */
export async function fetchDevPullRequests(acliPath: string, key: string): Promise<DevPullRequests | null> {
  const { stdout, stderr, code } = await acli(acliPath, [
    'jira', 'workitem', 'view', key,
    '--fields', DEV_FIELD,
    '--json',
  ]);
  if (code !== 0) {
    throw new JiraSearchError(
      firstLine(stderr) || firstLine(stdout) || `could not read the development panel for ${key}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new JiraSearchError(`could not read acli's development panel answer for ${key} as JSON`);
  }
  const fields = isRecord(parsed) && isRecord(parsed.fields) ? parsed.fields : null;
  if (!fields) throw new JiraSearchError(`acli's answer for ${key} carried no fields`);
  return readDevPullRequests(fields[DEV_FIELD]);
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ---------- the fetch ---------- */

export interface TicketFetch {
  tickets: Ticket[];
  /**
   * Statuses the user's own tickets are seen in, keyed by project — the offer the
   * status menu is built from. A fact about their Jira rather than a workflow:
   * nothing here claims these are all the statuses, or that any given move
   * between them is legal. See `transitionTicket`.
   */
  statuses: Record<string, string[]>;
  warnings: string[];
}

/**
 * Every unfinished ticket that is the user's to move, each carrying whether Jira
 * has a pull request for it and whether one is still open.
 *
 * **Three searches, not one, and the split is forced.** The development-panel
 * counts can be filtered on but not selected: no `--fields` value returns them,
 * and Jira exposes no other route to them that `acli` can reach. So membership of
 * a predicate is the only way to learn it, and the two extra searches ask for the
 * cheapest field there is and are read as sets of keys.
 *
 * **Any of the three failing takes the whole round with it.** Losing the base
 * search is obvious, but losing either set is worse than it looks: a ticket
 * missing from both reads as *no code was ever linked to this*, which is a
 * perfectly plausible ticket rather than an error. One failed request would
 * quietly empty the settled court and flood the idle one, so the round fails and
 * the poller keeps the rows it had. The same reasoning `github.ts` applies to its
 * checks request, for the same reason: nothing is what a quiet board looks like.
 *
 * **Then one development panel read per settled candidate**, because the third
 * search answers a subtly different question from the one the settled court
 * needs: `.open` excludes drafts. That repair is per-ticket and allowed to fail
 * per-ticket, which is the opposite rule from the three above and safe for the
 * opposite reason — a panel that cannot be read withholds a verdict instead of
 * inventing one.
 */
export async function fetchTickets(
  acliPath: string,
  opts: { projects: readonly string[]; site: string | null },
): Promise<TicketFetch> {
  const [base, anyPr, openPr] = await Promise.all([
    search(acliPath, buildJql(opts.projects, null)),
    search(acliPath, buildJql(opts.projects, ANY_PR)),
    search(acliPath, buildJql(opts.projects, OPEN_PR)),
  ]);

  /**
   * The keys a membership search matched.
   *
   * Entries it couldn't read a key from are an error rather than a smaller set,
   * and this is the one place in this file that refuses to salvage. Everywhere
   * else a skipped entry costs that entry; here it would silently move a ticket
   * from "its pull requests are all closed" to "it never had one", which is a
   * plausible-looking answer nobody would go looking for. `--fields key` alone
   * used to produce exactly that.
   */
  const keys = (issues: readonly unknown[], what: string): Set<string> => {
    const set = new Set<string>();
    for (const issue of issues) {
      const key = issueKey(issue);
      if (key !== null) set.add(key);
    }
    if (issues.length > 0 && set.size === 0) {
      throw new JiraSearchError(`the ${what} search returned ${issues.length} work items and no readable keys`);
    }
    return set;
  };
  const withAny = keys(anyPr, 'linked pull request');
  const withOpen = keys(openPr, 'open pull request');

  const warnings: string[] = [];
  const tickets: Ticket[] = [];
  let unreadable = 0;
  for (const raw of base) {
    const key = issueKey(raw);
    const ticket = toTicket(raw, opts.site, key !== null && withAny.has(key), key !== null && withOpen.has(key));
    if (ticket) tickets.push(ticket);
    else if (key === null) unreadable++;
  }
  if (unreadable > 0) {
    warnings.push(`Skipped ${unreadable} work ${unreadable === 1 ? 'item' : 'items'} Jira described in a way this board could not read.`);
  }

  // **Repair the open count from the development panel**, because JQL's `.open`
  // does not count a draft — see the note above `ANY_PR`. Only the settled
  // candidates are worth asking about: every other ticket either already has an
  // open pull request or has none at all, and neither reading can change.
  //
  // Unlike the three searches above, one of these failing costs one row rather
  // than the round, and the difference is that the fallback here is honest. A
  // failed search would silently move tickets between courts; a failed panel
  // read only withholds the settled verdict, which drops the row rather than
  // making a claim about it.
  const candidates = tickets.filter((ticket) => ticket.hasAnyPr && !ticket.hasOpenPr);
  const panels = await mapLimit(candidates, DEV_CONCURRENCY, (ticket) =>
    fetchDevPullRequests(acliPath, ticket.key).then(
      (dev) => ({ asked: true, dev }),
      () => ({ asked: false, dev: null }),
    ),
  );
  // Two ways to learn nothing, kept apart because they say different things to
  // whoever reads the banner: this machine could not get an answer, or it got one
  // that contradicts the search. Neither is claimed to be permanent — one real
  // ticket read as unaccounted for with six repositories, 22 builds and no pull
  // request summary at all, and answered with a plain `OPEN` rollup hours later.
  const unanswered: string[] = [];
  const unaccounted: string[] = [];
  candidates.forEach((ticket, i) => {
    const { asked, dev } = panels[i]!;
    if (allPullRequestsClosed(dev)) {
      ticket.allPrsClosed = true;
    } else if (!asked) {
      // Nothing was learned, so nothing is claimed. The ticket keeps Jira's own
      // counts and simply fails the settled court's positive test.
      unanswered.push(ticket.key);
    } else if (dev === null) {
      // `acli` answered and the panel offered no pull request rollup, though the
      // JQL index counted one. Held out for the same reason and reported
      // differently, because the user can see both halves of the disagreement and
      // "could not read the panel" is not what happened.
      unaccounted.push(ticket.key);
    } else {
      // The panel named a state that is not closed — a draft, or an open pull
      // request `.open` somehow disagreed about. Either way work is in flight,
      // which is what `hasOpenPr` is supposed to mean.
      ticket.hasOpenPr = true;
    }
  });
  // Keys the user can actually open. A warning is the one place this board talks
  // about a ticket without rendering a row for it, so the link has to come from
  // here — and it is the held-out rows in particular that someone will want to
  // go and look at, since the board is declining to say anything about them.
  const listed = (keys: readonly string[]): string =>
    keys
      .map((key) => {
        const url = browseUrl(opts.site, key);
        return url === null ? key : `[${key}](${url})`;
      })
      .join(', ');
  const heldOut = (keys: readonly string[]): string =>
    `${keys.length === 1 ? 'it is' : 'they are'} held out of "no open pull requests left" rather than guessed at`;
  if (unanswered.length > 0) {
    warnings.push(
      `Could not read Jira's development panel for ${listed(unanswered)}, so ${heldOut(unanswered)}. The next read may well manage it.`,
    );
  }
  if (unaccounted.length > 0) {
    warnings.push(
      `Jira's search says ${listed(unaccounted)} ${unaccounted.length === 1 ? 'has' : 'have'} pull requests, but its own development panel names none, so ${heldOut(unaccounted)}. Jira is disagreeing with itself; the row comes back when one of its caches catches up.`,
    );
  }
  if (!opts.site) {
    warnings.push(
      'acli did not say which Atlassian site it is logged in to, so these rows have no links. Set DAILY_FOCUS_JIRA_SITE to your site host.',
    );
  }

  // The vocabulary read follows the base one because it is scoped to the projects
  // the base one found, and it is the only read here allowed to fail on its own:
  // without it the status menu offers fewer ways out of the workflow, which is a
  // smaller menu rather than a wrong board. The three above are load-bearing, for
  // the reason at the top of this function.
  const projects = [...new Set(tickets.map((ticket) => projectOf(ticket.key)).filter((p): p is string => p !== null))];
  const finished = await Promise.all(projects.map((project) => fetchDoneStatuses(acliPath, project).catch(() => null)));
  const unread = projects.filter((_, i) => finished[i] === null);
  if (unread.length > 0) {
    warnings.push(
      `Could not read how work gets finished in ${unread.join(', ')}, so the status menu there may be missing a way out of the workflow.`,
    );
  }

  return {
    tickets,
    statuses: statusesByProject(base, ...finished.map((batch) => batch ?? [])),
    warnings,
  };
}

/* ---------- the status vocabulary ---------- */

/**
 * What finished tickets in one project are sitting in, so the board can offer a
 * way *out* of the workflow rather than only moves within it.
 *
 * The candidate search excludes that whole category by construction, so this is
 * the only place a completion status can come from — and it is the move most often
 * wanted from a row saying "no open pull requests left".
 *
 * **Deliberately not restricted to the user's own tickets.** It was, and that
 * left a project where they had never finished anything with no way to finish
 * anything: measured on a real board, one project's eight tickets were all still
 * open, so its done status had never once been observed. Anyone's finished ticket
 * answers the question equally well, and only the status *name* is kept — see
 * `statusesByProject`, which reads nothing else off these issues.
 *
 * One request per project rather than one `project IN (...)` for all of them,
 * because the newest fifty in a busy project would crowd out a quiet one entirely
 * — which is exactly the project that needs asking about.
 *
 * Bounded and newest first: this is a vocabulary, not a history, and the statuses
 * in recent use are the ones the workflow still has.
 */
export async function fetchDoneStatuses(acliPath: string, project: string): Promise<unknown[]> {
  const jql = `statusCategory = Done AND project = ${quoteJql(project)} ORDER BY updated DESC`;
  return search(acliPath, jql, { limit: 25, paginate: false });
}

/**
 * The project key a Jira key belongs to.
 *
 * This is the one place anything here reads structure out of an identifier, and
 * it is a different identifier from the one `AGENTS.md` says to treat as opaque:
 * that rule is about the dashboard's own `jira:<KEY>` ids, whose recipe an agent
 * re-derives from a prompt every morning. A work item key's `<PROJECT>-<number>`
 * shape is Jira's own and Jira enforces it. Anything that doesn't match yields
 * null and simply gets the whole vocabulary offered to it.
 */
export function projectOf(key: string): string | null {
  return /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(key.trim())?.[1]?.toUpperCase() ?? null;
}

/**
 * Statuses grouped by project, from whatever issues were read.
 *
 * Grouped because one site's projects disagree: measured on one real board,
 * two projects were running "In Progress" and "In progress", and a third called
 * its finished state "Done (ZD Automation)". Offering one project's vocabulary on
 * another's ticket would be offering a refusal.
 */
export function statusesByProject(...batches: readonly unknown[][]): Record<string, string[]> {
  const byProject: Record<string, string[]> = {};
  for (const batch of batches) {
    for (const raw of batch) {
      const key = issueKey(raw);
      if (key === null) continue;
      const project = projectOf(key);
      if (project === null) continue;
      const fields = isRecord(raw) && isRecord(raw.fields) ? raw.fields : {};
      const status = isRecord(fields.status) && typeof fields.status.name === 'string' ? fields.status.name : '';
      if (status === '') continue;
      const seen = (byProject[project] ??= []);
      if (!seen.includes(status)) seen.push(status);
    }
  }
  for (const statuses of Object.values(byProject)) statuses.sort((a, b) => a.localeCompare(b));
  return byProject;
}

/* ---------- the one write ---------- */

/**
 * Move one work item to a named status.
 *
 * `--yes` because the confirmation this stands in for already happened: the user
 * picked the status off the row. `--key` takes one key and only one, since a
 * click is about one ticket and `acli` would just as happily take a JQL query —
 * a bulk transition is not a thing this dashboard should be able to express.
 *
 * The arguments go through `execFile` as a list, never a shell string, so a
 * status name carrying a quote or a semicolon is a status name and not a command.
 * That matters more than it looks: the status arrives from an HTTP request body.
 */
export async function transitionTicket(acliPath: string, key: string, status: string): Promise<void> {
  const { stdout, stderr, code } = await acli(acliPath, [
    'jira', 'workitem', 'transition',
    '--key', key,
    '--status', status,
    '--yes',
    '--json',
  ]);

  if (code !== 0) {
    throw new JiraTransitionError(firstLine(stderr) || firstLine(stdout) || `Jira would not move ${key} to ${status}`);
  }

  // **A zero exit says nothing about whether the move happened.** Measured: a
  // status the workflow does not allow exits 0 with an empty stderr and reports
  // the refusal only in the payload —
  //
  //   {"results":[{"status":"FAILURE","message":"No allowed transitions found
  //     for given status","id":"TWA-1"}],"totalCount":1,"successCount":0}
  //
  // which is why this reads the payload, and why it demands to be *told* the
  // move succeeded rather than merely failing to find a complaint. An earlier
  // version looked for an `error` key, found none in the above, and reported a
  // refusal as a success — the one failure this board must never have, since its
  // entire job is telling the user their statuses say things that aren't true.
  //
  // The polarity matters more than the parsing: a false failure costs a
  // confusing toast beside a row the refresh has already corrected, while a
  // false success is a lie the user has no way to catch.
  readTransitionReport(stdout, key, status);
}

/**
 * Whether `acli` said the move happened. Throws `JiraTransitionError` when it
 * did not, or when it did not say. Exported because the payload shapes are the
 * whole contract here and `test/jira.test.ts` records the real ones.
 */
export function readTransitionReport(stdout: string, key: string, status: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new JiraTransitionError(
      `acli did not say whether ${key} moved (${stdout.trim().slice(0, 120) || 'no output'}) — check Jira`,
    );
  }

  const report = isRecord(parsed) ? parsed : {};
  const results = Array.isArray(report.results) ? report.results : [];

  for (const entry of results) {
    if (!isRecord(entry)) continue;
    const outcome = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
    if (outcome === 'SUCCESS') continue;
    const detail = typeof entry.message === 'string' && entry.message !== '' ? entry.message : `Jira refused the move to ${status}`;
    throw new JiraTransitionError(detail);
  }

  // Nothing said FAILURE, but silence is not consent: require a count that
  // accounts for the one item asked about, so an acli that reports outcomes some
  // other way reads as "could not tell" rather than as agreement.
  const succeeded = typeof report.successCount === 'number' ? report.successCount : results.length;
  if (succeeded < 1) {
    throw new JiraTransitionError(`acli reported no successful move for ${key} — check Jira`);
  }
}
