/**
 * Whether a ticket's pull requests finish it: the done check.
 *
 * A pull request linked to a ticket doesn't always finish it. The ticket asks
 * for three things and the pull request does two, or a second repository is
 * still to come. So the dashboard has the assistant's CLI read the ticket's
 * description and its pull requests' diffs, and judge whether together they do
 * everything the ticket asks: `complete`, `work-left` with what is left, or
 * `unclear` with why it can't tell. The answer is JSON whose schema the
 * dashboard fixes, as setup's proposals are (`onboarding.ts`); the CLI only
 * fills it in, and anything else it says is a failed check, never a verdict.
 *
 * A verdict is advice. It is shown on the ticket's row and on its card in
 * Projects, and does nothing else: it never moves, hides or marks a row, never
 * changes a status, and Move to Done stays the user's click.
 *
 * What is checked, and when:
 *
 *  - Only the user's own unfinished tickets, as the ticket board reads them,
 *    with at least one pull request GitHub has for them, merged, open or a
 *    draft, each at a known head commit. Never a teammate's.
 *  - A verdict is about a key: the ticket, a hash of its description, and each
 *    of its pull requests at its head commit (`checkKey`). A new pull request,
 *    a push to one, or a reworded description is a new key. A comment, a review,
 *    a label or a merge is not. A key that has been checked is never checked on
 *    its own again, however it went, unless the dashboard going away cut it
 *    short; Check now on the row asks again.
 *  - On its own only through `AutoCheck` in `autoask.ts`, behind the switch
 *    asking ahead has: once the key has been still for a while, one at a time,
 *    only while a page is open, and no more than `DAILY_FOCUS_DONE_CHECK_LIMIT`
 *    a day, failed ones included, the most useful first (`checkRank`).
 *  - Check now starts one from a click: with the switch off too, and outside
 *    the day's count.
 *
 * It runs through the assistant's runner (`Assistant.check`): in its empty
 * directory, with the editing tools denied and Claude Code held to the reads in
 * `DONE_CHECK_TOOLS`; under Codex, the connector rules every turn gets, and no
 * draft. On the newest flagship model at high effort, whatever the assistant's
 * own settings say, since a wrong "complete" costs more than a slow one.
 *
 * `donecheck.jsonl` is this file's alone, appended and never compacted: each
 * check's start, then its verdict or why there is none, and how long it took.
 * A failed check never takes the last verdict with it.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';

import { RESTARTED, SHUT_DOWN, type Assistant } from './assistant.ts';
import { codexLatestModel } from './codex.ts';
import type { CliName, Config } from './config.ts';
import { CODEX_FALLBACK_MODEL, SESSION_MODEL } from './onboarding.ts';
import type { ExecFile } from './shellpath.ts';
import { localDateKey } from './time.ts';
import type { BoardRow, DoneCheckState, DoneCheckTicket, DoneVerdict, LinkedPull, Ticket } from './types.ts';

/**
 * A check that runs longer than this is stopped. Longer than the assistant's
 * ten minutes: at high effort, across several diffs, a thorough read takes a
 * while, and nobody is waiting on the answer.
 */
const CHECK_TIMEOUT_MS = 15 * 60_000;

/** How much of a verdict's line is kept. One line is asked for; this is what one line may be. */
const LINE_LENGTH = 200;

/** The effort every check runs at, whatever the assistant's own setting says. */
export const CHECK_EFFORT = 'high';

/**
 * What a check may call under Claude Code: reading a ticket and reading pull
 * requests, by subcommand, and nothing that writes. Narrower than the
 * assistant's list, since nothing here is ever drafted or sent. Codex has no
 * such list; its connector rules refuse writes, and its prompt forbids the rest.
 */
export const DONE_CHECK_TOOLS: readonly string[] = [
  'Bash(gh pr view *)',
  'Bash(gh pr diff *)',
  'Bash(gh pr list *)',
  'Bash(gh pr checks *)',
  'Bash(gh repo view *)',
  'Bash(gh search prs *)',
  'Bash(acli jira workitem view *)',
  'Bash(acli jira workitem search *)',
  'Bash(acli jira workitem comment list *)',
];

/** The verdicts, in the words the schema and the log use. */
export const DONE_VERDICTS: readonly DoneVerdict[] = ['complete', 'work-left', 'unclear'];

/** The answer a check must give. Every property required, as Codex's structured output asks. */
export const DONE_CHECK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: [...DONE_VERDICTS],
      description: 'complete: the pull requests together do everything the ticket asks. work-left: something it asks for is not in them. unclear: you cannot tell.',
    },
    line: {
      type: 'string',
      description: 'One line, under fifteen words. For work-left, what is left; for unclear, why you cannot tell; for complete, empty.',
    },
  },
  required: ['verdict', 'line'],
  additionalProperties: false,
};

/* ---------- the key ---------- */

/**
 * The pull requests a check is about: merged, open and drafts. One closed
 * without merging was abandoned and finishes nothing, and so is left out of
 * the check and its key.
 */
export function countedPulls(ticket: Ticket): LinkedPull[] {
  return (ticket.pulls ?? []).filter((pull) => pull.state !== 'closed');
}

/**
 * What a verdict is about: the ticket's key, a hash of its description, and its
 * pull requests at their head commits, sorted. Null when the ticket can't be
 * checked: no pull request GitHub has for it, or one whose head commit isn't
 * known, as in a cache from before head commits were read.
 *
 * Only what the work is made of is in it. A comment, a review, a label or a
 * merge changes none of it: a merge keeps the head commit it merged.
 */
export function checkKey(ticket: Ticket): string | null {
  const pulls = countedPulls(ticket);
  if (pulls.length === 0 || pulls.some((pull) => !pull.headSha)) return null;
  const heads = pulls.map((pull) => `${pull.repo}#${pull.number}@${pull.headSha}`).sort();
  return [ticket.key.toUpperCase(), ticket.descriptionHash ?? '-', heads.join(',')].join(' ');
}

/**
 * How useful a check is now, most first, for when more are owed than the day
 * allows: 0 when every pull request has merged, so the ticket is most likely
 * finished and only its status is left; 1 when its last open pull request is
 * ready to merge, by the pull request board; 2 for the rest.
 */
export function checkRank(ticket: Ticket, rows: readonly BoardRow[]): number {
  const pulls = countedPulls(ticket);
  const open = pulls.filter((pull) => pull.state === 'open' || pull.state === 'draft');
  if (pulls.length > 0 && open.length === 0) return 0;
  if (open.length === 1 && rows.find((row) => row.url === open[0]!.url)?.court === 'ready') return 1;
  return 2;
}

/* ---------- the answer ---------- */

/** A verdict as a check gave it. */
export interface ParsedVerdict {
  verdict: DoneVerdict;
  line: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The verdict in a check's answer, or null when there isn't one.
 *
 * Forgiving about everything but the one thing that matters. The JSON may come
 * fenced or with a sentence around it, the line under another name, and the two
 * verdicts that say "not finished" in other words. `complete` is taken only as
 * itself: "done", "completed" or "yes" are not read as it, since a ticket
 * wrongly called finished is the one mistake the user has no way to catch.
 */
export function parseVerdict(reply: string): ParsedVerdict | null {
  const value = readJson(reply);
  if (!isRecord(value)) return null;
  const verdict = readVerdict(value.verdict);
  if (!verdict) return null;
  const said = [value.line, value.reason, value.why, value.left].find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
  return { verdict, line: oneLine(typeof said === 'string' ? said : '') };
}

function readJson(reply: string): unknown {
  const text = reply.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1];
  for (const candidate of [fenced ?? text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next.
    }
  }
  return null;
}

function readVerdict(value: unknown): DoneVerdict | null {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (word === 'complete') return 'complete';
  if (['work-left', 'workleft', 'incomplete', 'not-complete'].includes(word)) return 'work-left';
  if (['unclear', 'cant-tell', "can't-tell", 'unknown', 'uncertain'].includes(word)) return 'unclear';
  return null;
}

/** The first line that says something, less a list marker, and no longer than `LINE_LENGTH`. */
function oneLine(text: string): string {
  const line = (text.split('\n').find((candidate) => candidate.trim() !== '') ?? '').replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
  return line.length > LINE_LENGTH ? `${line.slice(0, LINE_LENGTH - 1)}…` : line;
}

/* ---------- the prompt ---------- */

/**
 * What a check is told: the instructions, then the ticket and its pull requests
 * as the ticket board last read them. The description and the diffs it reads
 * itself, so the verdict is about them as they are, not as a summary put them.
 */
export function composeCheckPrompt(instructions: string, ticket: Ticket, profile: string, now: Date): string {
  const facts = {
    key: ticket.key,
    summary: ticket.summary,
    url: ticket.url,
    status: ticket.workflowStatus,
    type: ticket.issueType,
    pullRequests: countedPulls(ticket).map((pull) => ({
      repo: pull.repo,
      number: pull.number,
      url: pull.url,
      title: pull.title,
      state: pull.state,
      headSha: pull.headSha ?? null,
    })),
  };
  return [
    instructions.trim(),
    '',
    '## The ticket',
    '',
    `- Profile: ${profile}`,
    `- Today: ${now.toISOString().slice(0, 10)}`,
    '',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
  ].join('\n');
}

/* ---------- the log ---------- */

/** Who started a check: the dashboard on its own, or a click on Check now. */
export type CheckedBy = 'auto' | 'click';

/** One line in donecheck.jsonl. */
type LogRecord =
  | { event: 'started'; check: string; ticket: string; key: string; by: CheckedBy; agent: CliName; at: string }
  | { event: 'finished'; check: string; verdict: DoneVerdict; line: string; model: string | null; ms: number; at: string }
  | { event: 'failed'; check: string; error: string; model?: string | null; ms: number | null; at: string };

/** One check, folded from its lines. */
export interface CheckRecord {
  id: string;
  /** The ticket's key, upper-cased. */
  ticket: string;
  /** What it was about: see `checkKey`. */
  key: string;
  by: CheckedBy;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed';
  verdict: DoneVerdict | null;
  line: string;
  error: string | null;
  ms: number | null;
}

/**
 * Fold the log into checks, in the order they started. Forgiving line by line,
 * as the assistant's log is: one broken line costs that line.
 */
export function foldCheckLog(text: string): Map<string, CheckRecord> {
  const checks = new Map<string, CheckRecord>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Partial<Record<string, unknown>>;
    try {
      record = JSON.parse(line) as Partial<Record<string, unknown>>;
    } catch {
      continue;
    }
    if (!isRecord(record) || typeof record.check !== 'string' || typeof record.at !== 'string') continue;
    if (record.event === 'started') {
      if (typeof record.ticket !== 'string' || typeof record.key !== 'string') continue;
      checks.set(record.check, {
        id: record.check,
        ticket: record.ticket.toUpperCase(),
        key: record.key,
        by: record.by === 'click' ? 'click' : 'auto',
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        verdict: null,
        line: '',
        error: null,
        ms: null,
      });
      continue;
    }
    const check = checks.get(record.check);
    if (!check) continue;
    check.endedAt = record.at;
    check.ms = typeof record.ms === 'number' ? record.ms : null;
    const verdict = record.event === 'finished' ? readVerdict(record.verdict) : null;
    if (verdict) {
      check.status = 'done';
      check.verdict = verdict;
      check.line = typeof record.line === 'string' ? oneLine(record.line) : '';
      check.error = null;
    } else {
      // A finished line whose verdict doesn't read is no verdict, and must not become one.
      check.status = 'failed';
      check.verdict = null;
      check.error = typeof record.error === 'string' ? record.error : 'its verdict could not be read back';
    }
  }
  return checks;
}

/** Cut short by the dashboard going away rather than by anything it found: asked again on its own. */
function cutShort(check: CheckRecord): boolean {
  return check.status === 'failed' && (check.error === RESTARTED || check.error === SHUT_DOWN);
}

/* ---------- the checker ---------- */

/** What the done check needs of the assistant. */
export type CheckRunner = Pick<Assistant, 'enabled' | 'check'>;

export interface DoneCheckDeps {
  config: Config;
  assistant: CheckRunner;
  /** The user's own unfinished tickets as the ticket board last read them. */
  tickets: () => readonly Ticket[];
  /** Something changed that a tab should see: a check started or ended. */
  onChange: () => void;
  /** Answers `codex debug models`, for a test. */
  execFn?: ExecFile;
  now?: () => Date;
}

/** Why Check now was refused, with the HTTP status that says so. */
export class DoneCheckRefusal extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DoneCheckRefusal';
    this.status = status;
  }
}

/** What automatic checks add to the view: whether they are on, and when each owed ticket's would start. */
export interface AutoCheckView {
  enabled: boolean;
  /** By upper-cased ticket key, for tickets whose key nobody has checked: when it will have settled. */
  due: ReadonlyMap<string, number>;
}

export class DoneCheck {
  readonly #deps: DoneCheckDeps;
  readonly #checks = new Map<string, CheckRecord>();
  /** Every key checked, however it went, but for checks the dashboard going away cut short. */
  readonly #checked = new Set<string>();
  #loading: Promise<void> | null = null;
  /** Tickets with a check going, by upper-cased key. */
  readonly #running = new Set<string>();
  #closed = false;
  /** Codex's flagship, from its catalog, until one fails for the account; then `CODEX_FALLBACK_MODEL`. */
  #codexModel: Promise<string | null> | null = null;

  constructor(deps: DoneCheckDeps) {
    this.#deps = deps;
  }

  /** There is a CLI to check with. Check now needs nothing more. */
  get enabled(): boolean {
    return this.#deps.assistant.enabled;
  }

  /** A check is going, until its outcome is written down. */
  get busy(): boolean {
    return this.#running.size > 0;
  }

  /**
   * Read the log, and close any check the last process left running: cut short,
   * so asked again on its own. Cheap when the log doesn't exist. Once.
   */
  start(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    let text = '';
    try {
      text = await readFile(this.#deps.config.doneCheckLogFile, 'utf8');
    } catch {
      return;
    }
    for (const [id, check] of foldCheckLog(text)) this.#checks.set(id, check);
    for (const check of this.#checks.values()) {
      if (check.status === 'running') {
        check.status = 'failed';
        check.error = RESTARTED;
        check.endedAt = this.#now().toISOString();
        await this.#append({ event: 'failed', check: check.id, error: RESTARTED, ms: null, at: check.endedAt });
      }
      if (!cutShort(check)) this.#checked.add(check.key);
    }
  }

  /** Whether a key has been checked, however it went, unless the dashboard going away cut it short. */
  checked(key: string): boolean {
    return this.#checked.has(key);
  }

  /** Checks started on their own today, on the server's calendar, however they went. */
  usedToday(): number {
    const today = localDateKey(this.#now());
    return [...this.#checks.values()].filter((check) => check.by === 'auto' && localDateKey(new Date(check.startedAt)) === today).length;
  }

  /**
   * Check a ticket now, from a click: with automatic checks off too, and
   * outside the day's count. Resolves once the check has started; the verdict
   * lands through `onChange`.
   */
  async checkNow(key: string): Promise<void> {
    if (!this.enabled) throw new DoneCheckRefusal('the assistant is off; set DAILY_FOCUS_ASSISTANT to claude or codex', 409);
    if (this.#closed) throw new DoneCheckRefusal('the dashboard is shutting down', 409);
    await this.start();
    const ticket = this.#deps.tickets().find((candidate) => candidate.key.toUpperCase() === key.toUpperCase());
    if (!ticket) throw new DoneCheckRefusal(`${key} is not one of your unfinished tickets on the board`, 404);
    const checking = checkKey(ticket);
    if (!checking) {
      throw new DoneCheckRefusal(`${ticket.key} has no pull request to check, or the board hasn't read their head commits yet`, 409);
    }
    await this.begin(ticket, checking, 'click');
  }

  /**
   * Start a check of a ticket as `key` says it stands. Resolves once it has
   * started and is written down; the verdict lands through `onChange`. Check now
   * and `AutoCheck` are the only callers, each having decided it may start.
   */
  async begin(ticket: Ticket, key: string, by: CheckedBy): Promise<void> {
    const agent = this.#deps.config.assistant.agent;
    if (!agent) throw new DoneCheckRefusal('the assistant is off; set DAILY_FOCUS_ASSISTANT to claude or codex', 409);
    if (this.#closed) throw new DoneCheckRefusal('the dashboard is shutting down', 409);
    const name = ticket.key.toUpperCase();
    if (this.#running.has(name)) throw new DoneCheckRefusal(`${ticket.key} is being checked already`, 409);
    const check: CheckRecord = {
      id: randomUUID(),
      ticket: name,
      key,
      by,
      startedAt: this.#now().toISOString(),
      endedAt: null,
      status: 'running',
      verdict: null,
      line: '',
      error: null,
      ms: null,
    };
    this.#running.add(name);
    try {
      // Written before anything runs, so the day's count holds across a restart.
      await this.#append({ event: 'started', check: check.id, ticket: name, key, by, agent, at: check.startedAt });
    } catch (err) {
      this.#running.delete(name);
      throw err;
    }
    this.#checks.set(check.id, check);
    this.#checked.add(key);
    this.#deps.onChange();
    void this.#execute(check, ticket, agent)
      .catch((err: unknown) => {
        console.error(`[daily-focus] the done check on ${name} failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.#running.delete(name);
        this.#deps.onChange();
      });
  }

  /** The done check as the page shows it, for the tickets the board has now. */
  view(auto: AutoCheckView): DoneCheckState {
    const byTicket = new Map<string, CheckRecord[]>();
    for (const check of this.#checks.values()) byTicket.set(check.ticket, [...(byTicket.get(check.ticket) ?? []), check]);

    const out: Record<string, DoneCheckTicket> = {};
    for (const ticket of this.#deps.tickets()) {
      const name = ticket.key.toUpperCase();
      const key = checkKey(ticket);
      const checks = (byTicket.get(name) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      if (!key && checks.length === 0) continue;
      const verdict = checks.findLast((check) => check.status === 'done');
      const running = checks.findLast((check) => check.status === 'running');
      const ended = checks.filter((check) => check.status !== 'running').at(-1);
      const failure = ended?.status === 'failed' ? ended : null;
      const due = auto.enabled && key !== null && !running && !this.#checked.has(key) ? auto.due.get(name) : undefined;
      out[name] = {
        checkable: key !== null,
        verdict: verdict?.verdict
          ? { verdict: verdict.verdict, line: verdict.line, at: verdict.endedAt ?? verdict.startedAt, current: verdict.key === key }
          : null,
        running: running ? { since: running.startedAt, by: running.by } : null,
        failure: failure ? { error: failure.error ?? 'failed', at: failure.endedAt ?? failure.startedAt, current: failure.key === key } : null,
        dueAt: due === undefined ? null : new Date(due).toISOString(),
      };
    }
    return {
      enabled: this.enabled,
      auto: auto.enabled,
      limit: this.#deps.config.assistant.doneCheckLimit,
      usedToday: this.usedToday(),
      tickets: out,
    };
  }

  /** Start nothing more. A check going is the assistant's to stop, which its own close does. */
  close(): void {
    this.#closed = true;
  }

  /* ---------- running one ---------- */

  async #execute(check: CheckRecord, ticket: Ticket, agent: CliName): Promise<void> {
    const started = Date.now();
    const prompt = composeCheckPrompt(await this.#instructions(), ticket, this.#deps.config.profile, this.#now());
    let model = await this.#model(agent);
    const ask = (on: string | null) =>
      this.#deps.assistant.check({
        prompt,
        model: on,
        effort: CHECK_EFFORT,
        tools: DONE_CHECK_TOOLS,
        schema: DONE_CHECK_SCHEMA,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    let outcome = await ask(model);
    // A model the account can't use: once more on the one it can, kept to after, as setup does.
    if (agent === 'codex' && !outcome.ok && outcome.cause === 'model' && model !== CODEX_FALLBACK_MODEL) {
      this.#codexModel = Promise.resolve(CODEX_FALLBACK_MODEL);
      model = CODEX_FALLBACK_MODEL;
      outcome = await ask(model);
    }
    const ms = Date.now() - started;
    const at = this.#now().toISOString();
    const parsed = outcome.ok ? parseVerdict(outcome.reply) : null;
    if (parsed) {
      await this.#append({ event: 'finished', check: check.id, verdict: parsed.verdict, line: parsed.line, model, ms, at });
      Object.assign(check, { status: 'done', verdict: parsed.verdict, line: parsed.line, endedAt: at, ms });
    } else {
      const said = outcome.reply.trim().replace(/\s+/g, ' ');
      const error = outcome.ok
        ? `it answered, but not in the shape asked for${said ? `: “${said.length > 80 ? `${said.slice(0, 79)}…` : said}”` : ''}`
        : (outcome.error ?? 'failed');
      await this.#append({ event: 'failed', check: check.id, error, model, ms, at });
      Object.assign(check, { status: 'failed', error, endedAt: at, ms });
    }
    const on = model ?? `${agent}'s default model`;
    const result = parsed ? `${parsed.verdict}${parsed.line ? ` (${parsed.line})` : ''}` : `failed: ${check.error}`;
    console.log(`[daily-focus] done check on ${check.ticket} took ${Math.round(ms / 1000)} s on ${on}: ${result}`);
  }

  /**
   * The newest flagship, chosen as setup's sessions choose it (`SESSION_MODEL`):
   * Claude Code's `opus`, or the model Codex's catalog lists first.
   */
  #model(agent: CliName): Promise<string | null> {
    const fixed = SESSION_MODEL[agent].model;
    if (fixed || agent !== 'codex') return Promise.resolve(fixed);
    this.#codexModel ??= codexLatestModel(this.#deps.config.assistant.binPath, this.#deps.execFn);
    return this.#codexModel;
  }

  /** The prompt from this copy of the package, or a sentence that keeps the rules when it can't be read. */
  async #instructions(): Promise<string> {
    try {
      return await readFile(this.#deps.config.doneCheckPromptSource, 'utf8');
    } catch {
      return (
        'Read the Jira ticket below and the diffs of its pull requests, and judge whether together they do everything the ticket asks. ' +
        'Only read; never post, comment, edit, merge or change anything. Answer with the JSON the schema asks for.'
      );
    }
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /** Only this process writes the file, so memory is updated by the caller and never re-read from it. */
  async #append(record: LogRecord): Promise<void> {
    await mkdir(this.#deps.config.dataDir, { recursive: true });
    await appendFile(this.#deps.config.doneCheckLogFile, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
