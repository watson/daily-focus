import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

import type { Config } from './config.ts';
import type { IdleProbe } from './presence.ts';
import type {
  Agenda,
  SessionEnd,
  SessionState,
  StoredSession,
  UnattendedClose,
} from './types.ts';
import { parseISO } from './time.ts';

/**
 * Focus sessions: a server-side timer that records what was actually worked on.
 *
 * Deliberately not called a pomodoro. None of that technique's machinery is here —
 * no enforced interval, no mandatory break, no four-then-a-long-one cycle. What
 * remains is the part that plausibly helps: declaring one thing, keeping that
 * declaration visible, and writing down where the time went. The duration is a
 * check-in prompt, not a rule.
 *
 * Server-side for two reasons. The dashboard reloads itself whenever the UI
 * changes, which would silently destroy a client-side timer — and a timer that
 * dies without saying so is worse than none. And a session that survives closing
 * the tab is the difference between a gadget and a record.
 *
 * The timer is deliberately *advisory*. When the planned time is up it says so and
 * keeps counting; it never stops the work or forces a break. A fixed interruption
 * at 25 minutes is as likely to cut across a run that was finally going well as it
 * is to help, and that trade shouldn't be made on the user's behalf.
 *
 * The one thing it will do on its own is stop when nobody's there. Not stopping was
 * the worse failure: walking away with the timer going wrote 120
 * minutes of "focus" into the record, of which the last 36 were an empty desk. The
 * log exists to be reasoned about by something else, so a session that quietly
 * inflates is more expensive than a session that never got recorded — see
 * `reconcileSession`, which decides that, and does it retroactively.
 *
 * Two files, both owned here:
 *   session.json    the one running session, or absent
 *   sessions.jsonl  append-only history, which the briefing agent reads
 */

/**
 * The backstop for when nothing can say whether anyone was at the machine.
 *
 * Since presence is checked directly this is rarely what stops a session, and that
 * matters: truncating to two hours never made the number true, it only bounded how
 * untrue it was. Kept for the cases the probe can't cover — another OS, a machine
 * that won't answer — where a bounded lie still beats an unbounded one.
 */
const MAX_SESSION_MINUTES = 120;

/** A session is only "real" once it has run this long — guards against a misclick. */
const MIN_LOGGABLE_MINUTES = 1;

export interface StartOptions {
  id: string;
  title: string;
  minutes: number;
  advancesObjective: boolean;
  now?: Date;
}

/** One line in sessions.jsonl. */
export interface LoggedSession {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  plannedMinutes: number;
  actualMinutes: number;
  reachedTarget: boolean;
  advancesObjective: boolean;
  /** Absent on sessions logged before this was recorded. */
  endedBy?: SessionEnd;
}

async function readActive(config: Config): Promise<StoredSession | null> {
  try {
    return JSON.parse(await readFile(config.sessionFile, 'utf8')) as StoredSession;
  } catch {
    return null;
  }
}

async function writeActive(config: Config, session: StoredSession): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const temp = `${config.sessionFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await rename(temp, config.sessionFile);
}

async function clearActive(config: Config): Promise<void> {
  try {
    await unlink(config.sessionFile);
  } catch {
    // Already gone; nothing to do.
  }
}

/** Append a finished session to the history the agent reads. */
async function logSession(
  config: Config,
  session: StoredSession,
  endedAt: Date,
  endedBy: SessionEnd,
): Promise<LoggedSession | null> {
  const startedAt = parseISO(session.startedAt);
  if (!startedAt) return null;

  const actualMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);
  // A few seconds of "oops, wrong item" isn't worth a line in the record.
  if (actualMinutes < MIN_LOGGABLE_MINUTES) return null;

  const entry: LoggedSession = {
    id: session.id,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: endedAt.toISOString(),
    plannedMinutes: session.minutes,
    actualMinutes,
    reachedTarget: actualMinutes >= session.minutes,
    advancesObjective: session.advancesObjective,
    endedBy,
  };

  await mkdir(config.dataDir, { recursive: true });
  await appendFile(config.sessionsLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** Start a session, replacing any that was already running. Only one at a time — that's the point. */
export async function startSession(config: Config, opts: StartOptions): Promise<void> {
  const now = opts.now ?? new Date();
  await stopSession(config, now);

  await writeActive(config, {
    id: opts.id,
    title: opts.title,
    startedAt: now.toISOString(),
    minutes: opts.minutes,
    advancesObjective: opts.advancesObjective,
    // The click that got here is itself the first evidence of a person.
    lastActiveAt: now.toISOString(),
  });
}

/** Stop the running session and record it. Returns what was logged, if anything. */
export async function stopSession(
  config: Config,
  now = new Date(),
  endedBy: SessionEnd = 'user',
): Promise<StoredSession | null> {
  const active = await readActive(config);
  if (!active) return null;

  await logSession(config, active, now, endedBy);
  await clearActive(config);
  return active;
}

/**
 * Check whether the running session still has a person attached to it, and close it
 * where they left off if it doesn't.
 *
 * The rule: a session ends at the last moment there was evidence of a person, never
 * at the moment we noticed there wasn't one. So the threshold decides only how
 * quickly we catch on — it has no say in what gets written down, which is what lets
 * it be generous. Ten still minutes spent reading a design doc is not a walk-out,
 * and closing the session *at* the ten-minute mark would invent time just as surely
 * as leaving it running does.
 *
 * The absence of a checkpoint is a signal in its own right, and the more useful one.
 * Shutting the laptop stops this being called at all, so nothing here has to detect
 * sleep — the gap does it, and the same gap covers the server being down or the
 * process being killed.
 *
 * A probe that can't answer counts as "nobody proved they left": the checkpoint stays
 * fresh, and this quietly degrades to the old two-hour behaviour on any machine that
 * can't see idle time, while still catching sleep and downtime, since those stop the
 * polling too. Erring that way is deliberate — under-recording real work is a
 * nuisance, but over-recording it is the specific self-deception this whole store is
 * built to prevent.
 *
 * Takes the probe instead of calling it directly, so no process is spawned unless
 * there's a session to ask about, and so tests can state the answer rather than
 * impersonate a Mac.
 */
export async function reconcileSession(
  config: Config,
  probe: IdleProbe,
  now = new Date(),
): Promise<LoggedSession | null> {
  if (config.awayAfterMinutes <= 0) return null;

  const active = await readActive(config);
  if (!active) return null;

  const startedAt = parseISO(active.startedAt);
  if (!startedAt) {
    // Nothing can be derived from an unparseable start and nothing can be counted
    // from it either, so don't leave it running for ever.
    await clearActive(config);
    return null;
  }

  const awayAfterMs = config.awayAfterMinutes * 60_000;
  const previous = parseISO(active.lastActiveAt) ?? startedAt;

  // The hole in the evidence is checked first, and against the checkpoint alone.
  // Touching the trackpad right now says nothing about the hour this process spent
  // asleep, and must not be allowed to vouch for it after the fact — reading the
  // probe first would let one keypress on waking revive a session abandoned before
  // lunch. Idleness lands here too: while nobody types, the checkpoint stops
  // advancing, and the gap it leaves is the same gap.
  if (now.getTime() - previous.getTime() > awayAfterMs) {
    // Ending at `previous` is the whole point: the lunch break, the afternoon out and
    // the entire evening never enter the record.
    const logged = await logSession(config, active, previous, 'away');
    await clearActive(config);
    return logged;
  }

  const idleSeconds = await probe();
  const lastInput =
    idleSeconds === null ? now : new Date(now.getTime() - Math.max(0, idleSeconds) * 1_000);

  // The checkpoint only moves forward, and never past now.
  const confirmed = lastInput.getTime() > previous.getTime() ? lastInput : previous;
  if (confirmed.toISOString() !== active.lastActiveAt) {
    await writeActive(config, { ...active, lastActiveAt: confirmed.toISOString() });
  }
  return null;
}

/**
 * Close a session that has outrun the backstop.
 *
 * Deliberately blind to the presence checkpoint. This path is what's left when
 * nobody can say whether anyone was here, and a stale checkpoint is not evidence of
 * absence — it's the same absence of evidence, and treating it as a verdict would
 * make a plain read of the state depend on how recently something happened to poll.
 * Where presence *is* knowable, `reconcileSession` has already closed the session
 * long before two hours are up, so this only ever fires with nothing better to go
 * on. Hence a flat ceiling, and an `endedBy` that says not to trust the number.
 */
async function closeIfPastBackstop(
  config: Config,
  active: StoredSession | null,
  now: Date,
): Promise<StoredSession | null> {
  if (!active) return null;

  const startedAt = parseISO(active.startedAt);
  const elapsed = startedAt ? (now.getTime() - startedAt.getTime()) / 60_000 : Infinity;
  // Left running overnight or forgotten after a meeting — close it out rather
  // than logging a six-hour "focus session" that never happened.
  if (elapsed <= MAX_SESSION_MINUTES) return active;

  const ceiling = new Date((startedAt?.getTime() ?? now.getTime()) + MAX_SESSION_MINUTES * 60_000);
  await stopSession(config, ceiling, 'limit');
  return null;
}

/**
 * The self-closed session to own up to, when it's still the last thing that happened.
 *
 * Only the newest entry qualifies. Once something else has been worked on the notice
 * has been overtaken by events, and a dashboard that keeps announcing old news is one
 * you stop reading.
 */
function lastUnattendedClose(todayLog: LoggedSession[]): UnattendedClose | null {
  const last = todayLog.at(-1);
  if (!last || last.endedBy === undefined || last.endedBy === 'user') return null;

  return {
    id: last.id,
    title: last.title,
    endedAt: last.endedAt,
    actualMinutes: last.actualMinutes,
    reason: last.endedBy,
  };
}

/**
 * The running session as the client needs to see it, closing it out first if it
 * has been left running far past its target.
 */
export async function readSessionState(
  config: Config,
  agenda: Agenda,
  now = new Date(),
): Promise<SessionState> {
  const active = await closeIfPastBackstop(config, await readActive(config), now);

  // Read the log *after* that close, so a session which just ended lands in today's
  // tally on this render rather than the next one.
  const todayLog = await readTodaysSessions(config, now);
  const completedToday = todayLog.length;
  const minutesToday = todayLog.reduce((sum, entry) => sum + entry.actualMinutes, 0);
  const unattendedClose = active ? null : lastUnattendedClose(todayLog);

  if (!active) {
    return { active: null, completedToday, minutesToday, unattendedClose };
  }

  const startedAt = parseISO(active.startedAt)!;
  const endsAt = new Date(startedAt.getTime() + active.minutes * 60_000);
  const remainingSeconds = Math.round((endsAt.getTime() - now.getTime()) / 1000);

  // Warn when the session runs into the next meeting — the one thing a kitchen
  // timer can't know, and the most common reason a session gets abandoned.
  const nextEvent = agenda.events
    .map((event) => parseISO(event.start))
    .filter((start): start is Date => start !== null && start.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    active: {
      id: active.id,
      title: active.title,
      startedAt: active.startedAt,
      advancesObjective: active.advancesObjective,
      lastActiveAt: active.lastActiveAt,
      endsAt: endsAt.toISOString(),
      minutes: active.minutes,
      remainingSeconds,
      overrun: remainingSeconds < 0,
      collidesWithNextEvent: nextEvent ? nextEvent.getTime() < endsAt.getTime() : false,
      nextEventAt: nextEvent ? nextEvent.toISOString() : null,
    },
    completedToday,
    minutesToday,
    unattendedClose,
  };
}

/** Read the whole session history. Small file; the agent reads it the same way. */
export async function readSessions(config: Config): Promise<LoggedSession[]> {
  let text: string;
  try {
    text = await readFile(config.sessionsLogFile, 'utf8');
  } catch {
    return [];
  }

  const sessions: LoggedSession[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as LoggedSession;
      if (entry?.id && entry.startedAt) sessions.push(entry);
    } catch {
      // One bad line shouldn't hide the rest of the history.
    }
  }
  return sessions;
}

async function readTodaysSessions(config: Config, now: Date): Promise<LoggedSession[]> {
  const all = await readSessions(config);
  return all.filter((entry) => {
    const started = parseISO(entry.startedAt);
    return (
      started !== null &&
      started.getFullYear() === now.getFullYear() &&
      started.getMonth() === now.getMonth() &&
      started.getDate() === now.getDate()
    );
  });
}
