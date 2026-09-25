import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  Action,
  AgendaSource,
  Brief,
  CalendarState,
  DashboardState,
  ItemStatus,
  ResolvedItem,
} from './types.ts';
import type { Config } from './config.ts';
import { archiveBrief, computeObjectiveProgress, readArchiveIndex } from './archive.ts';
import { buildAgenda } from './agenda.ts';
import { parseFocus, toPublicFocus, type Focus } from './focus.ts';
import { parseActionLine, parseBrief } from './validate.ts';
import {
  calendarDaysBetween,
  isSameLocalDay,
  localDateKey,
  parseISO,
  startOfLocalDay,
  workingMsBetween,
} from './time.ts';
import { BRIEF_REFRESH_GRACE_HOURS, describeSchedule, nextRunDate, resolveSchedule, runsOn } from './schedule.ts';
import { canonicalId } from './ids.ts';
import { runContractChecks } from './checks.ts';
import { readSessionState } from './sessions.ts';

const READ_RETRIES = 3;
const READ_RETRY_MS = 40;

/**
 * The shared store. Reads straight from disk on every call — both files are small
 * and human-scale, and a cache would only add a way for the dashboard to disagree
 * with what the agent just wrote.
 */
export class Store {
  readonly config: Config;
  /** Appends are chained so two concurrent clicks can't interleave a half-written line. */
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: Config) {
    this.config = config;
  }

  async ensureDataDir(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
  }

  /**
   * Read and parse items.json.
   *
   * Retries a parse failure a couple of times: if the agent writes the file
   * non-atomically we can catch it mid-truncation, and a transient blank read
   * should not flash an error banner at the user.
   */
  async readBrief(): Promise<{ brief: Brief | null; error: string | null; warnings: string[] }> {
    let last: { brief: Brief | null; error: string | null; warnings: string[] } = {
      brief: null,
      error: 'items.json has not been written yet',
      warnings: [],
    };

    for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
      let text: string;
      try {
        text = await readFile(this.config.itemsFile, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            brief: null,
            error: `No brief yet — nothing has written ${this.config.itemsFile}`,
            warnings: [],
          };
        }
        return { brief: null, error: `Could not read items.json: ${(err as Error).message}`, warnings: [] };
      }

      last = parseBrief(text);
      if (last.error === null) return last;
      if (attempt < READ_RETRIES - 1) await delay(READ_RETRY_MS);
    }

    return last;
  }

  /** Read the whole action log, oldest first. */
  async readActions(): Promise<Action[]> {
    let text: string;
    try {
      text = await readFile(this.config.actionsFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const actions: Action[] = [];
    for (const line of text.split('\n')) {
      const action = parseActionLine(line);
      if (action) actions.push(action);
    }
    return actions;
  }

  /**
   * Snapshot the current brief into the archive if it isn't already there.
   *
   * Safe to call often — it's a no-op unless items.json is newer than what's on
   * file for that date. Called on startup and whenever the store changes, so a
   * brief written while the dashboard was closed still gets captured.
   */
  async archiveCurrentBrief(): Promise<boolean> {
    const { brief } = await this.readBrief();
    if (!brief) return false;
    try {
      return await archiveBrief(this.config, brief);
    } catch (err) {
      // Losing a snapshot degrades one metric; it must never break the dashboard.
      console.warn(`[daily-focus] could not archive the brief: ${(err as Error).message}`);
      return false;
    }
  }

  /** Read the standing objective. Returns null when focus.md hasn't been written. */
  async readFocus(): Promise<Focus | null> {
    try {
      return parseFocus(await readFile(this.config.focusFile, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // A focus.md that can't be read shouldn't take the dashboard down with it.
      console.warn(`[daily-focus] could not read focus.md: ${(err as Error).message}`);
      return null;
    }
  }

  /** Append one action. The log is append-only; corrections are new lines, never edits. */
  async appendAction(action: Action): Promise<void> {
    const line = `${JSON.stringify(action)}\n`;
    const write = this.#writeQueue.then(async () => {
      await this.ensureDataDir();
      await appendFile(this.config.actionsFile, line, 'utf8');
    });
    // Keep the chain alive even if this write rejects, so one failure doesn't
    // wedge every later append.
    this.#writeQueue = write.catch(() => {});
    await write;
  }

  /**
   * Read the store and fold it into everything the client needs.
   *
   * Everything except `assetVersion`, `board` and `tickets` — the first describes
   * the served UI, not the data, and the other two are fetched rather than read,
   * so the server owns all three and layers them on. Keeping them out here means
   * the store has no opinion about how it's being displayed, or about GitHub and
   * Jira.
   */
  async getState(
    now: Date = new Date(),
    actions?: readonly Action[],
    calendar?: CalendarState,
  ): Promise<Omit<DashboardState, 'assetVersion' | 'board' | 'tickets' | 'assistant' | 'agentRun'>> {
    const [{ brief, error, warnings }, readActions, focus] = await Promise.all([
      this.readBrief(),
      // The caller may have read the log already, to fold the board from the same
      // snapshot; two reads could straddle an append and disagree.
      actions ? Promise.resolve(actions) : this.readActions(),
      this.readFocus(),
    ]);
    actions = readActions;
    const schedule = resolveSchedule(this.config);

    // Which days the agent runs decides both halves of the staleness question, and
    // it's also the dashboard's only notion of a weekend — so the progress metric
    // below counts its working days the same way.
    const isRunDay = (d: Date) => runsOn(schedule, d);

    const items = brief ? resolveItems(brief.items, actions, now) : [];

    // The calendar wins when it has a real answer, including a real answer of
    // "nothing today". The brief's own events are the fallback, which is what
    // runs before the helper is built, when the permission is refused, and off
    // macOS entirely. They are folded through the same action log either way, so
    // dismissing an event sticks whichever source produced it.
    const live = calendar?.live === true;
    const agendaItems = live ? resolveItems(calendar!.events, actions, now) : items;
    const agendaSource: AgendaSource = {
      live,
      fetchedAt: calendar?.fetchedAt ?? null,
      problem: calendar?.problem ?? null,
      warnings: calendar?.warnings ?? [],
    };

    const agenda = buildAgenda(agendaItems, now, {
      freeWindows: this.config.freeWindows,
      workStartHour: this.config.workStartHour,
      workEndHour: this.config.workEndHour,
      minFreeWindowMinutes: this.config.minFreeWindowMinutes,
      // The brief's own bounds win: the agent read today's calendar, config didn't.
      dayStart: brief?.dayStart,
      dayEnd: brief?.dayEnd,
    });

    const generatedAt = brief ? parseISO(brief.generatedAt) : null;
    const ageHours = generatedAt ? Math.floor((now.getTime() - generatedAt.getTime()) / 3_600_000) : null;

    // Staleness is measured only in hours the agent was scheduled for. Friday's brief
    // read on Sunday is 48 hours old and still the newest there was ever going to be,
    // so flagging it warns about the calendar rather than about a missed run — and a
    // banner that fires every weekend by construction is one you stop reading by the
    // third. Discounting the days off puts the warning on the next scheduled morning,
    // at the hour a refresh is expected, followed by a short grace period.
    const scheduledAgeHours = generatedAt
      ? workingMsBetween(generatedAt, now, isRunDay) / 3_600_000
      : null;

    const refreshDue = scheduledAgeHours !== null && scheduledAgeHours >= this.config.staleAfterHours;
    const stale = scheduledAgeHours !== null &&
      scheduledAgeHours >= this.config.staleAfterHours + BRIEF_REFRESH_GRACE_HOURS;

    const visible = items.filter((item) => item.status === 'open');
    const todayStart = startOfLocalDay(now);

    // History is needed both for the progress metric and for the contract checks,
    // so read it once. Skipped entirely when there's no brief to check.
    const history = brief ? await readArchiveIndex(this.config) : new Map();

    const contractIssues = brief
      ? runContractChecks({ brief, items, focus, history })
      : [];

    // Only meaningful when there's an objective to measure progress against.
    let objectiveProgress = null;
    if (focus?.objective && brief) {
      // Today's brief may not be archived yet on a very first run, so fold it in.
      const withToday = new Map(history);
      for (const item of brief.items) {
        if (!withToday.has(item.id)) {
          withToday.set(item.id, {
            title: item.title,
            advancesObjective: item.advancesObjective === true,
            firstSeen: item.firstSeen,
          });
        }
      }
      objectiveProgress = computeObjectiveProgress(withToday, actions, now, isRunDay);
    }

    // Depends on the agenda, so it has to come after it.
    const session = await readSessionState(this.config, agenda, now);

    return {
      // toPublicFocus, not focus — the agent-only section must never be serialised.
      focus: focus ? toPublicFocus(focus) : null,
      objectiveProgress,
      session,
      schedule: {
        days: [...schedule.days],
        source: schedule.source,
        description: describeSchedule(schedule),
        runsToday: isRunDay(now),
        nextRunDate: nextRunDate(schedule, now),
      },
      brief: {
        generatedAt: brief?.generatedAt ?? null,
        generatedBy: brief?.generatedBy ?? null,
        date: brief?.date ?? (generatedAt ? localDateKey(generatedAt) : null),
        headline: brief?.headline ?? null,
        ageHours,
        refreshPending: refreshDue && !stale && isRunDay(now),
        stale,
      },
      items,
      agenda,
      agendaSource,
      stats: {
        open: visible.filter((item) => item.kind !== 'event').length,
        topPriority: visible.filter((item) => item.priority !== undefined).length,
        completedToday: items.filter((item) => {
          if (item.status !== 'done') return false;
          const at = parseISO(item.statusAt);
          return at !== null && isSameLocalDay(at, now);
        }).length,
        overdue: visible.filter((item) => {
          const due = parseISO(item.due);
          return due !== null && due.getTime() < todayStart.getTime();
        }).length,
      },
      problem: error,
      // Parser complaints and contract failures render the same way: both are
      // things the agent got wrong that you would not otherwise see.
      warnings: [...warnings, ...contractIssues],
      now: now.toISOString(),
    };
  }
}

/** What the action log says about one id, after folding. */
export interface FoldedActions {
  status: ItemStatus;
  snoozedUntil?: string;
  statusAt?: string;
  notes: { text: string; at: string }[];
}

/**
 * Fold the whole log, keyed on canonical id.
 *
 * The log is append-only and in chronological order, so the last action for an id
 * decides its status. A snooze whose date has arrived quietly reverts to open —
 * that is the whole point of snoozing. Shared by the brief and the pull request
 * board so there is exactly one reading of the log.
 */
export function foldActionLog(actions: readonly Action[], now: Date): Map<string, FoldedActions> {
  const folded = new Map<string, FoldedActions>();
  const today = startOfLocalDay(now);

  for (const action of actions) {
    // Keyed on the canonical id, so a difference of case or stray whitespace between
    // the logged action and today's item can't orphan a completed row.
    const key = canonicalId(action.id);
    let entry = folded.get(key);
    if (!entry) {
      entry = { status: 'open', notes: [] };
      folded.set(key, entry);
    }
    switch (action.action) {
      case 'note':
        if (action.text) entry.notes.push({ text: action.text, at: action.at });
        break;
      case 'done':
        entry.status = 'done';
        delete entry.snoozedUntil;
        entry.statusAt = action.at;
        break;
      case 'dismiss':
        entry.status = 'dismissed';
        delete entry.snoozedUntil;
        entry.statusAt = action.at;
        break;
      case 'snooze':
        entry.status = 'snoozed';
        if (action.until) entry.snoozedUntil = action.until;
        else delete entry.snoozedUntil;
        entry.statusAt = action.at;
        break;
      case 'reopen':
        entry.status = 'open';
        delete entry.snoozedUntil;
        entry.statusAt = action.at;
        break;
    }
  }

  for (const entry of folded.values()) {
    if (entry.status !== 'snoozed') continue;
    const until = parseISO(entry.snoozedUntil);
    // No date means "until further notice" — the agent decides when to resurface it.
    if (until && until.getTime() <= today.getTime()) {
      entry.status = 'open';
      delete entry.snoozedUntil;
    }
  }

  return folded;
}

/** Fold the action log over the brief's items. */
export function resolveItems(
  items: readonly import('./types.ts').Item[],
  actions: readonly Action[],
  now: Date,
): ResolvedItem[] {
  const folded = foldActionLog(actions, now);

  return items.map((item) => {
    const log = folded.get(canonicalId(item.id));
    const firstSeen = parseISO(item.firstSeen);
    const resolved: ResolvedItem = {
      ...item,
      status: log?.status ?? 'open',
      notes: log?.notes ?? [],
      ageDays: firstSeen ? Math.max(0, calendarDaysBetween(firstSeen, now)) : 0,
    };
    if (log?.snoozedUntil) resolved.snoozedUntil = log.snoozedUntil;
    if (log?.statusAt) resolved.statusAt = log.statusAt;
    return resolved;
  });
}
