/**
 * `focus.md` and `sources.md` as the dashboard edits them.
 *
 * Both are the user's words. The dashboard writes them only when the user saves
 * them, and they can still be edited by hand, so there are two hands on one file
 * and no lock. A save therefore carries the version of the text it started from,
 * and is refused if the file has changed since: the editor reloads, and nothing
 * the user typed in another window is lost to a save from this one.
 *
 * The full text, private part included, reaches the browser only through the
 * editor that asked for it. The state every tab is sent carries the public half
 * of the objective and nothing of the source list; see `toPublicFocus`.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { tempPathFor } from './fs.ts';

/** What a file that doesn't exist yet is versioned as, so the first save can say it expected none. */
export const ABSENT = 'absent';

/** A short fingerprint of the text, or `absent`. */
export function versionOf(text: string | null): string {
  return text === null ? ABSENT : createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export async function readEditable(path: string): Promise<{ text: string | null; version: string }> {
  try {
    const text = await readFile(path, 'utf8');
    return { text, version: versionOf(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, version: ABSENT };
    throw error;
  }
}

export type SaveResult = { saved: true; version: string } | { saved: false; text: string | null; version: string };

/** The save in progress for each file, so that the next waits for it. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Save `text` if the file is still at `expected`, through a sibling temp file and
 * a rename so the agent never reads half of it. Otherwise hand back what is there
 * now, for the editor to show.
 *
 * Saves of one file run one at a time, so two tabs saving at once compare against
 * each other's result rather than both against the file before either, and never
 * share the temp file. A hand edit can still land in the moment between the check
 * and the rename, the time it takes to write a few kilobytes; nothing short of a
 * lock the editor would also have to honour closes that.
 */
export function saveEditable(path: string, text: string, expected: string): Promise<SaveResult> {
  const next = (saving.get(path) ?? Promise.resolve()).catch(() => {}).then(() => saveNow(path, text, expected));
  saving.set(path, next);
  void next.finally(() => {
    if (saving.get(path) === next) saving.delete(path);
  }).catch(() => {});
  return next;
}

async function saveNow(path: string, text: string, expected: string): Promise<SaveResult> {
  const current = await readEditable(path);
  if (current.version !== expected) return { saved: false, ...current };
  const normalised = text.endsWith('\n') ? text : `${text}\n`;
  const temp = tempPathFor(path);
  await writeFile(temp, normalised, 'utf8');
  await rename(temp, path);
  return { saved: true, version: versionOf(normalised) };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

/** One line, since a frontmatter value can't hold more. */
function oneLine(value: string | null): string {
  return (value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Set `objective` and `blocker` in focus.md's frontmatter and leave every other
 * line as it was: the prose, the private part, keys this dashboard doesn't know.
 * A file with no frontmatter gets one at the top, and a missing file starts from
 * `template`. Null or blank clears a field, which is how an objective is put down.
 */
export function setFocusFields(text: string | null, fields: { objective: string | null; blocker: string | null }, template: string): string {
  const source = text ?? template;
  const wanted = { objective: oneLine(fields.objective), blocker: oneLine(fields.blocker) };
  const line = (key: 'objective' | 'blocker') => (wanted[key] === '' ? `${key}:` : `${key}: ${wanted[key]}`);
  const match = FRONTMATTER.exec(source);
  if (!match) return `---\n${line('objective')}\n${line('blocker')}\n---\n\n${source}`;
  const seen = new Set<string>();
  const lines = (match[1] ?? '').split(/\r?\n/).map((existing) => {
    const key = existing.slice(0, existing.indexOf(':')).trim().toLowerCase();
    if (existing.includes(':') && (key === 'objective' || key === 'blocker')) {
      seen.add(key);
      return line(key);
    }
    return existing;
  });
  for (const key of ['objective', 'blocker'] as const) {
    if (!seen.has(key)) lines.push(line(key));
  }
  return `---\n${lines.join('\n')}\n---${match[2] ?? '\n'}${source.slice(match[0].length)}`;
}
