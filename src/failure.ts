/**
 * How a failed read reaches the page: one line that says what happened, and the
 * detail under it, folded away until somebody asks.
 *
 * The three pollers — GitHub, Jira, the calendar — used to hand the page one line
 * each, and often the least useful one there was. Node's fetch says "fetch failed"
 * whatever went wrong and keeps the reason in `cause`; acli's first line of stderr
 * stood in for the rest of it; and a calendar helper that wouldn't launch said
 * only that the server log had the detail. The line stays short, so a failure
 * costs the page what it did, and the detail rides along beside it verbatim.
 */

import type { ReadFailure } from './types.ts';

/** A stack or a screenful of stderr is worth sending; a log is not. */
const MAX_DETAIL = 4000;

/** What one failed attempt said: the line for the page, and what was under it. */
export interface Failure {
  message: string;
  detail: string;
}

/** An unbroken run of failed attempts. A success ends it. */
export interface Streak {
  /** Epoch milliseconds of the first. */
  since: number;
  attempts: number;
}

/** One more failed attempt, starting a run if there wasn't one going. */
export function extend(streak: Streak | null, at = Date.now()): Streak {
  return streak ? { since: streak.since, attempts: streak.attempts + 1 } : { since: at, attempts: 1 };
}

/** A failure as the page gets it. `retryAt` is epoch milliseconds, or null when nothing is scheduled. */
export function toReadFailure(failure: Failure, streak: Streak | null, retryAt: number | null, retrying: boolean): ReadFailure {
  return {
    message: failure.message,
    detail: failure.detail,
    since: new Date(streak?.since ?? Date.now()).toISOString(),
    attempts: streak?.attempts ?? 1,
    retryAt: retrying || retryAt === null ? null : new Date(retryAt).toISOString(),
    retrying,
  };
}

/**
 * Everything an error says beyond its message: a `detail` its thrower attached,
 * such as a command and what it printed, then each `cause` under it with the
 * codes the system put on it — where "fetch failed" keeps its reason.
 */
export function errorDetail(err: unknown): string {
  const parts: string[] = [];
  const own = (err as { detail?: unknown } | null)?.detail;
  if (typeof own === 'string' && own.trim() !== '') parts.push(own.trim());
  let cause = (err as { cause?: unknown } | null)?.cause;
  // Bounded, because nothing stops a chain from being a loop.
  for (let depth = 0; cause !== undefined && cause !== null && depth < 5; depth++) {
    parts.push(`caused by ${describe(cause)}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  return clip(parts.join('\n'));
}

/** The whole of an error nobody planned for: its stack, then whatever errorDetail finds. */
export function unexpectedDetail(err: unknown): string {
  const head = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  const rest = errorDetail(err);
  return clip(rest ? `${head}\n${rest}` : head);
}

/** The codes a system error carries, which say more than its message to anyone searching for them. */
const FACTS = ['code', 'syscall', 'hostname', 'address', 'port'] as const;

function describe(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  const record = value as unknown as Record<string, unknown>;
  const facts = FACTS.flatMap((key) => {
    const fact = record[key];
    return typeof fact === 'string' || typeof fact === 'number' ? [`${key} ${fact}`] : [];
  });
  let line = `${value.name}: ${value.message}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`;
  // A connection tries every address a name resolves to, and fails with all of them.
  if (value instanceof AggregateError) line += value.errors.map((error) => `\n  - ${describe(error)}`).join('');
  return line;
}

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text;
}

/**
 * Why a `fetch` to `host` got no answer, in words.
 *
 * Read from the `cause`, since the error itself says "fetch failed" every time.
 * Worth telling apart because each wants something different done: a lookup that
 * fails is a machine that is offline, or asleep a moment ago, and a refused
 * certificate is almost always a proxy in the way.
 */
export function unreachable(err: unknown, host: string): string {
  const error = err as { name?: unknown; message?: unknown; cause?: unknown } | null;
  if (error?.name === 'TimeoutError') return `${host} did not answer in time`;
  if (error?.name === 'AbortError') return `the request to ${host} was cancelled`;

  const cause = error?.cause as { code?: unknown; message?: unknown; errors?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : firstCode(cause?.errors);
  const why = code ? reasonFor(code) : null;
  const fallback = typeof cause?.message === 'string' && cause.message ? cause.message : String(error?.message ?? err);
  return `couldn't reach ${host} (${why ?? fallback})`;
}

function firstCode(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const code = (errors[0] as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function reasonFor(code: string): string | null {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return 'the DNS lookup failed — is this machine online?';
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
      return 'no network route to it — is this machine online?';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'the connection timed out';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return 'the connection was cut off';
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS/.test(code)) {
    return `its certificate was refused, ${code} — a proxy in the way?`;
  }
  return null;
}
