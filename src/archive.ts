import { readFile, readdir } from 'node:fs/promises';

import { writeJsonAtomic } from './fs.ts';
import { resolve } from 'node:path';

import type { Action, Brief, ObjectiveProgress } from './types.ts';
import type { Config } from './config.ts';
import { isWorkingDay, localDateKey, parseISO, workingDaysSince, type DayTest } from './time.ts';
import { canonicalId } from './ids.ts';

/**
 * A dated snapshot of every brief, kept so the dashboard can answer a question no
 * inbound source ever will: how long has it been since anything actually moved the
 * standing objective?
 *
 * The server writes these, not the agent. The agent runs once a day and would have
 * to be trusted to get it right every time; the server sees every change to
 * items.json and also sweeps on startup, so a brief written while the dashboard was
 * closed still gets captured the next time it opens. It's self-healing rather than
 * dependent on prompt compliance.
 *
 * Nothing prunes these. A year of briefs is a couple of megabytes, and the whole
 * point is to still have them at review time.
 */

const ARCHIVE_FILE = /^items-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * How far back to look when resolving which completed items advanced the objective.
 *
 * Bounded so getState stays cheap on every SSE push. Six months of working days is
 * far more history than "days since progress" can meaningfully report on.
 */
const MAX_ARCHIVE_FILES = 130;

/** Recent-activity window for the "completed lately" count, in working days. */
const RECENT_WINDOW_DAYS = 14;

function archivePath(config: Config, dateKey: string): string {
  return resolve(config.archiveDir, `items-${dateKey}.json`);
}

/** The local date a brief belongs to: its own `date`, else the day it was generated. */
export function briefDateKey(brief: Brief): string {
  if (brief.date && /^\d{4}-\d{2}-\d{2}$/.test(brief.date)) return brief.date;
  const generated = parseISO(brief.generatedAt);
  return localDateKey(generated ?? new Date());
}

/**
 * Snapshot a brief under its own date, if we haven't already got that day at this
 * generation or newer.
 *
 * Idempotent: several runs on the same day collapse to the last one, and re-observing
 * an unchanged file is a no-op. Returns true when something was written.
 */
export async function archiveBrief(config: Config, brief: Brief): Promise<boolean> {
  const dateKey = briefDateKey(brief);
  const target = archivePath(config, dateKey);

  try {
    const existing = JSON.parse(await readFile(target, 'utf8')) as Brief;
    const existingAt = parseISO(existing.generatedAt)?.getTime() ?? 0;
    const incomingAt = parseISO(brief.generatedAt)?.getTime() ?? 0;
    if (existingAt >= incomingAt) return false;
  } catch {
    // Missing or unreadable — either way, write it.
  }

  await writeJsonAtomic(target, brief);
  return true;
}

/** What an archived item tells us about an id we've raised before. */
export interface ArchivedItem {
  title: string;
  advancesObjective: boolean;
  /** The oldest firstSeen we've recorded, so a later reset is detectable. */
  firstSeen?: string | undefined;
}

/**
 * Every date we hold a snapshot for, oldest first.
 *
 * Just the dates, off the filenames — no file is opened, so the index below can
 * pick the newest snapshots before reading any of them.
 */
export async function listArchivedDates(config: Config): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(config.archiveDir);
  } catch {
    return [];
  }

  return names
    .map((name) => ARCHIVE_FILE.exec(name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort();
}

/**
 * Build id → {title, advancesObjective} from the most recent archives.
 *
 * Newest first, so when an item's wording or flag changed over time the latest
 * description wins.
 */
export async function readArchiveIndex(config: Config): Promise<Map<string, ArchivedItem>> {
  const index = new Map<string, ArchivedItem>();

  const dated = (await listArchivedDates(config)).reverse().slice(0, MAX_ARCHIVE_FILES);

  for (const date of dated) {
    let brief: Brief;
    try {
      brief = JSON.parse(await readFile(archivePath(config, date), 'utf8')) as Brief;
    } catch {
      continue; // One corrupt snapshot shouldn't blind the whole metric.
    }
    for (const item of brief.items ?? []) {
      if (!item?.id) continue;
      const existing = index.get(item.id);
      if (!existing) {
        index.set(item.id, {
          title: item.title ?? item.id,
          advancesObjective: item.advancesObjective === true,
          firstSeen: item.firstSeen,
        });
        continue;
      }
      // Walking newest-first, so the newest title wins but the *oldest* firstSeen
      // does — that's the one a later run would be resetting.
      if (item.firstSeen && (!existing.firstSeen || item.firstSeen < existing.firstSeen)) {
        existing.firstSeen = item.firstSeen;
      }
    }
  }

  return index;
}

/**
 * How long since the objective last moved.
 *
 * Joins the archive (which items advanced the objective) with the action log (which
 * ids the user actually completed, and when). Neither file can answer this alone.
 *
 * `counts` decides which days are working days, so the headline number agrees with
 * the rest of the dashboard about when the weekend is.
 */
export function computeObjectiveProgress(
  index: Map<string, ArchivedItem>,
  actions: readonly Action[],
  now: Date,
  counts: DayTest = isWorkingDay,
): ObjectiveProgress {
  /** Last action per id wins, exactly as the dashboard resolves status. */
  const lastAction = new Map<string, Action>();
  for (const action of actions) {
    if (action.action === 'note') continue;
    lastAction.set(canonicalId(action.id), action);
  }

  // Match ids case-insensitively, same as the status fold.
  const byCanonical = new Map<string, ArchivedItem>();
  for (const [id, entry] of index) byCanonical.set(canonicalId(id), entry);

  let lastAt: Date | null = null;
  let lastTitle: string | null = null;
  let recentCount = 0;

  for (const [id, action] of lastAction) {
    if (action.action !== 'done') continue;
    if (!byCanonical.get(id)?.advancesObjective) continue;

    const at = parseISO(action.at);
    if (!at) continue;

    if (workingDaysSince(at, now, counts) <= RECENT_WINDOW_DAYS) recentCount++;
    if (!lastAt || at.getTime() > lastAt.getTime()) {
      lastAt = at;
      lastTitle = byCanonical.get(id)?.title ?? null;
    }
  }

  return {
    workingDaysSince: lastAt ? workingDaysSince(lastAt, now, counts) : null,
    lastAt: lastAt ? lastAt.toISOString() : null,
    lastTitle,
    recentCount,
    windowDays: RECENT_WINDOW_DAYS,
  };
}
