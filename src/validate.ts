import type { Brief, Item, ItemKind, Source } from './types.ts';

/**
 * items.json is written by an LLM, so it will occasionally be wrong in small ways.
 * The rule here: never lose a whole brief over one bad item. Salvage what parses,
 * report the rest as warnings the UI can show, and only hard-fail when the payload
 * has no usable shape at all.
 */

const SOURCES: ReadonlySet<string> = new Set([
  'github',
  'email',
  'calendar',
  'jira',
  'slack',
  'workday',
  'tasks',
  'atlassian',
  'other',
]);

const KINDS: ReadonlySet<string> = new Set(['task', 'event', 'info']);

/** Aliases the agent is likely to emit, mapped onto canonical sources. */
const SOURCE_ALIASES: Readonly<Record<string, Source>> = {
  gmail: 'email',
  mail: 'email',
  gcal: 'calendar',
  'google-calendar': 'calendar',
  'google-tasks': 'tasks',
  gtasks: 'tasks',
  todo: 'tasks',
  pr: 'github',
  gh: 'github',
  confluence: 'atlassian',
};

export interface ParseResult {
  brief: Brief | null;
  /** Set when nothing usable could be read. */
  error: string | null;
  warnings: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function optionalStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return out.length > 0 ? out : undefined;
}

function normalizeSource(v: unknown): Source {
  if (typeof v !== 'string') return 'other';
  const key = v.trim().toLowerCase();
  if (SOURCES.has(key)) return key as Source;
  return SOURCE_ALIASES[key] ?? 'other';
}

/**
 * Infer kind when the agent omits it: anything with a start time is an event,
 * everything else is a task. Guessing `task` is the safe default — worst case the
 * user gets a "done" button they don't need.
 */
function normalizeKind(v: unknown, hasStart: boolean): ItemKind {
  if (typeof v === 'string' && KINDS.has(v.trim().toLowerCase())) {
    return v.trim().toLowerCase() as ItemKind;
  }
  return hasStart ? 'event' : 'task';
}

/**
 * Read a local time-of-day as "HH:MM".
 *
 * Also accepts a full ISO timestamp, since an agent asked for a time will
 * reasonably often hand back a date — take the local clock time off it rather than
 * rejecting something whose meaning is perfectly clear.
 */
function parseClockTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();

  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return undefined;
    return `${String(hour).padStart(2, '0')}:${clock[2]}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

function parseItem(raw: unknown, index: number, warnings: string[]): Item | null {
  if (!isObject(raw)) {
    warnings.push(`items[${index}] is not an object; skipped`);
    return null;
  }

  const id = optionalString(raw.id);
  if (!id) {
    warnings.push(`items[${index}] has no "id"; skipped (ids are how actions stay attached)`);
    return null;
  }

  const title = optionalString(raw.title);
  if (!title) {
    warnings.push(`items[${index}] (${id}) has no "title"; skipped`);
    return null;
  }

  const start = optionalString(raw.start);
  const item: Item = {
    id,
    title,
    source: normalizeSource(raw.source),
    kind: normalizeKind(raw.kind, start !== undefined),
  };

  const detail = optionalString(raw.detail);
  if (detail) item.detail = detail;

  const url = optionalString(raw.url);
  // Only http(s) links are rendered, so a stray javascript: URL can never reach the DOM.
  if (url && /^https?:\/\//i.test(url)) item.url = url;
  else if (url) warnings.push(`items[${index}] (${id}) has a non-http url; dropped`);

  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) {
    item.priority = raw.priority;
  }

  const due = optionalString(raw.due);
  if (due) item.due = due;
  if (start) item.start = start;
  const end = optionalString(raw.end);
  if (end) item.end = end;

  // Only an explicit `false` frees the slot. Same reasoning as advancesObjective:
  // a truthy string must not quietly change the day's arithmetic — and here the
  // safe direction is to keep time reserved rather than invent a focus window.
  if (raw.blocking === false) item.blocking = false;

  const tags = optionalStringArray(raw.tags);
  if (tags) item.tags = tags;
  const people = optionalStringArray(raw.people);
  if (people) item.people = people;

  const firstSeen = optionalString(raw.firstSeen);
  if (firstSeen) item.firstSeen = firstSeen;

  // Only a real boolean counts. A truthy string here would quietly inflate the
  // progress metric, which is worse than the flag being absent.
  if (raw.advancesObjective === true) item.advancesObjective = true;

  return item;
}

/** Parse the raw text of items.json. */
export function parseBrief(text: string): ParseResult {
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      brief: null,
      error: `items.json is not valid JSON: ${(err as Error).message}`,
      warnings,
    };
  }

  if (!isObject(raw)) {
    return { brief: null, error: 'items.json must contain a JSON object', warnings };
  }

  if (raw.version !== undefined && raw.version !== 1) {
    warnings.push(`items.json declares version ${String(raw.version)}; this dashboard understands version 1`);
  }

  if (!Array.isArray(raw.items)) {
    return { brief: null, error: 'items.json must have an "items" array', warnings };
  }

  const items: Item[] = [];
  const seen = new Set<string>();
  raw.items.forEach((entry, i) => {
    const item = parseItem(entry, i, warnings);
    if (!item) return;
    if (seen.has(item.id)) {
      // Duplicate ids would make one action affect two rows, so keep only the first.
      warnings.push(`items[${i}] repeats id "${item.id}"; kept the first occurrence`);
      return;
    }
    seen.add(item.id);
    items.push(item);
  });

  const generatedAt = optionalString(raw.generatedAt) ?? new Date().toISOString();
  if (!optionalString(raw.generatedAt)) {
    warnings.push('items.json has no "generatedAt"; assuming it was written just now');
  }

  const brief: Brief = { version: 1, generatedAt, items };
  const generatedBy = optionalString(raw.generatedBy);
  if (generatedBy) brief.generatedBy = generatedBy;
  const date = optionalString(raw.date);
  if (date) brief.date = date;
  const headline = optionalString(raw.headline);
  if (headline) brief.headline = headline;

  const dayStart = parseClockTime(raw.dayStart);
  if (dayStart) brief.dayStart = dayStart;
  const dayEnd = parseClockTime(raw.dayEnd);
  if (dayEnd) brief.dayEnd = dayEnd;
  if (raw.dayStart !== undefined && !dayStart) warnings.push('items.json has an unreadable "dayStart"; using the default');
  if (raw.dayEnd !== undefined && !dayEnd) warnings.push('items.json has an unreadable "dayEnd"; using the default');

  return { brief, error: null, warnings };
}

/** Parse one line of actions.jsonl. Returns null for anything unusable. */
export function parseActionLine(line: string): import('./types.ts').Action | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;

  const id = optionalString(raw.id);
  const action = optionalString(raw.action);
  if (!id || !action) return null;
  if (!['done', 'snooze', 'dismiss', 'reopen', 'note'].includes(action)) return null;

  const result: import('./types.ts').Action = {
    id,
    action: action as import('./types.ts').ActionType,
    at: optionalString(raw.at) ?? new Date(0).toISOString(),
  };
  const until = optionalString(raw.until);
  if (until) result.until = until;
  const text = optionalString(raw.text);
  if (text) result.text = text;
  return result;
}
