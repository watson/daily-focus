/**
 * The store's links into this checkout, and whether they still point here.
 *
 * `prompt.md`, `items.schema.json` and `assistant.md` live in the repo, or in the
 * installed package, and are linked into the store so the briefing agent needs
 * nothing outside its own directory. A link rather than a copy, because two
 * copies of a long prompt drift apart silently, and the first symptom is a brief
 * that carefully followed a rule replaced a month ago.
 *
 * The dashboard links them to its own copy each time it starts (`linkStore`), so
 * whichever version is running is the one the agent follows, wherever it was
 * installed from. Something else can still repoint them while it runs — `npm run
 * init` from another worktree, or a second dashboard on the same store — and the
 * briefs would look no different, so the dashboard also checks every time it
 * builds state (`storeLinkWarning`). Three `lstat`s are cheap.
 *
 * A real file where a link should be is someone's own prompt, put there on purpose,
 * and everything here leaves it alone.
 *
 * Windows makes a link only with Developer Mode on or for an elevated process, so
 * there the file is copied instead, and the copy's hash recorded in `copies.json`.
 * A file with the recorded hash is the dashboard's copy, refreshed at every start
 * as a link is repointed; one without it is someone's own, edited copies included.
 */

import { createHash } from 'node:crypto';
import { copyFile, lstat, readFile, readlink, rename, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

import type { Config } from './config.ts';
import { writeJsonAtomic } from './fs.ts';

export type LinkState =
  /** A link here, or on Windows the dashboard's copy of this checkout's file. */
  | { state: 'linked' }
  /** A real file, not a link: someone's own copy. */
  | { state: 'own' }
  /** The dashboard's copy, on Windows, of a file that has changed since: another version's. */
  | { state: 'stale' }
  | { state: 'missing' }
  /** A link to a file that no longer exists. */
  | { state: 'dangling'; target: string }
  /** A link to some other file, usually the same one in another checkout. */
  | { state: 'elsewhere'; target: string };

/** The SHA-256 of a file's contents, which is what `copies.json` records. */
async function hashOf(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** The copies the dashboard made in place of links, by name; none when it never had to. */
async function readCopies(file: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * What the link at `link` points at, compared with the repo file it should point
 * at. `copied` is the hash `copies.json` holds for it, if the dashboard copied it.
 */
export async function linkState(link: string, source: string, copied?: string): Promise<LinkState> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) {
      if (!copied || (await hashOf(link)) !== copied) return { state: 'own' };
      return (await hashOf(source)) === copied ? { state: 'linked' } : { state: 'stale' };
    }
  } catch {
    return { state: 'missing' };
  }
  const target = resolve(dirname(link), await readlink(link));
  if (target === source) return { state: 'linked' };
  try {
    await stat(target);
  } catch {
    return { state: 'dangling', target };
  }
  return { state: 'elsewhere', target };
}

interface StoreLink {
  name: string;
  link: string;
  source: string;
  /** Who follows the file, for saying what a wrong link does. */
  reader: 'the morning agent' | 'the assistant';
  /**
   * Whether a missing or dangling link is harmless. The server falls back to the
   * repo's copy of the assistant's instructions, so only a link to another copy
   * changes what the assistant reads.
   */
  fallsBack: boolean;
}

/** The links something here actually reads: the agent's when it runs, the assistant's when it's on. */
function linksInUse(config: Config): StoreLink[] {
  const links: StoreLink[] = [];
  if (config.agent.cli) {
    const reader = 'the morning agent';
    links.push({ name: 'prompt.md', link: config.promptFile, source: config.promptSource, reader, fallsBack: false });
    links.push({ name: 'items.schema.json', link: config.schemaFile, source: config.schemaSource, reader, fallsBack: false });
  }
  if (config.assistant.agent) {
    links.push({
      name: 'assistant.md',
      link: config.assistantPromptFile,
      source: config.assistantPromptSource,
      reader: 'the assistant',
      fallsBack: true,
    });
  }
  return links;
}

/** `~/code/x` rather than `/Users/me/code/x`. */
function shown(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The checkout a repo file lives in, when it is one of the files init links. */
function checkoutOf(target: string): string {
  const folder = dirname(target);
  return ['prompts', 'schema'].includes(basename(folder)) ? dirname(folder) : target;
}

function names(list: string[]): string {
  const code = list.map((name) => `\`${name}\``);
  return code.length <= 1 ? code.join('') : `${code.slice(0, -1).join(', ')} and ${code.at(-1)}`;
}

/**
 * One warning naming every link in use that doesn't point at this checkout, with
 * the command that fixes them all, or null when they all do. Markdown, for the
 * file names and the command.
 */
export async function storeLinkWarning(config: Config, home: string = homedir()): Promise<string | null> {
  const elsewhere: Array<{ name: string; target: string; reader: StoreLink['reader'] }> = [];
  const stale: Array<{ name: string; reader: StoreLink['reader'] }> = [];
  const dangling: Array<{ name: string; target: string }> = [];
  const missing: string[] = [];
  const copies = await readCopies(config.copiesFile);
  for (const entry of linksInUse(config)) {
    const found = await linkState(entry.link, entry.source, copies[entry.name]);
    if (found.state === 'elsewhere') elsewhere.push({ name: entry.name, target: found.target, reader: entry.reader });
    else if (found.state === 'stale') stale.push({ name: entry.name, reader: entry.reader });
    else if (entry.fallsBack) continue;
    else if (found.state === 'dangling') dangling.push({ name: entry.name, target: found.target });
    else if (found.state === 'missing') missing.push(entry.name);
  }

  const sentences: string[] = [];
  if (elsewhere.length > 0) {
    const one = elsewhere.length === 1;
    const readers = [...new Set(elsewhere.map((e) => e.reader))];
    sentences.push(
      `${names(elsewhere.map((e) => e.name))} in the store ${one ? 'links' : 'link'} to another checkout ` +
        `(\`${shown(checkoutOf(elsewhere[0]!.target), home)}\`), so ${readers.join(' and ')} ` +
        `${readers.length === 1 ? 'follows' : 'follow'} that copy, not this one.`,
    );
  }
  if (stale.length > 0) {
    const one = stale.length === 1;
    const readers = [...new Set(stale.map((e) => e.reader))];
    sentences.push(
      `${names(stale.map((e) => e.name))} in the store ${one ? 'is a copy' : 'are copies'} of another version's, so ` +
        `${readers.join(' and ')} ${readers.length === 1 ? 'follows' : 'follow'} ${one ? 'that' : 'those'}, not this one's.`,
    );
  }
  if (dangling.length > 0) {
    const one = dangling.length === 1;
    sentences.push(
      `${names(dangling.map((d) => d.name))} in the store ${one ? 'links to a file that' : 'link to files that'} no longer ` +
        `${one ? 'exists' : 'exist'} (\`${shown(dangling[0]!.target, home)}\`), so the morning agent can't read ${one ? 'it' : 'them'}.`,
    );
  }
  if (missing.length > 0) {
    const one = missing.length === 1;
    sentences.push(`${names(missing)} ${one ? 'is' : 'are'} missing from the store, so the morning agent can't read ${one ? 'it' : 'them'}.`);
  }
  if (sentences.length === 0) return null;

  const count = elsewhere.length + stale.length + dangling.length + missing.length;
  const checkout = shown(dirname(dirname(config.promptSource)), home);
  sentences.push(`Restart the dashboard to link ${count === 1 ? 'it' : 'them'} back to \`${checkout}\`.`);
  return sentences.join(' ');
}

/** What became of one link when the store was linked. */
export interface LinkOutcome {
  name: string;
  /**
   * `linked` means it was made or repointed just now, and `copied` that Windows
   * wouldn't make one, so the file was copied instead; `kept` that it already
   * pointed here, or was already the dashboard's copy of this checkout's file.
   */
  result: 'linked' | 'copied' | 'kept' | 'own' | 'failed';
  /** Where it pointed before being repointed, or why it failed. */
  detail: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Point `target` in the store at `source` in this checkout. A link pointing
 * anywhere else is repointed, since a stale link is a stale prompt, and so is the
 * dashboard's own copy of an older file; any other real file is left strictly
 * alone. `copies` is what `copies.json` holds, updated here.
 */
async function linkOne(
  name: string,
  target: string,
  source: string,
  copies: Record<string, string>,
  platform: NodeJS.Platform,
  symlinkFn: typeof symlink,
): Promise<LinkOutcome> {
  let before: string | null = null;
  try {
    const stats = await lstat(target);
    if (!stats.isSymbolicLink()) {
      if (!copies[name] || (await hashOf(target)) !== copies[name]) return { name, result: 'own', detail: null };
      if ((await hashOf(source)) === copies[name]) return { name, result: 'kept', detail: null };
    } else {
      before = resolve(dirname(target), await readlink(target));
      if (before === source) {
        delete copies[name];
        return { name, result: 'kept', detail: null };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { name, result: 'failed', detail: message(error) };
  }
  // The new link is made beside the old one and renamed over it, so the agent
  // never finds no link at all, and a link that can't be made leaves the old one.
  const staged = `${target}.${process.pid}.link`;
  try {
    await unlink(staged).catch(() => {});
    await symlinkFn(source, staged);
    await rename(staged, target);
    delete copies[name];
    return { name, result: 'linked', detail: before };
  } catch (error) {
    await unlink(staged).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) return { name, result: 'failed', detail: message(error) };
  }
  // Windows without Developer Mode: a copy, staged and renamed into place the same way.
  try {
    await copyFile(source, staged);
    copies[name] = await hashOf(staged);
    await rename(staged, target);
    return { name, result: 'copied', detail: before };
  } catch (error) {
    await unlink(staged).catch(() => {});
    delete copies[name];
    return { name, result: 'failed', detail: message(error) };
  }
}

/**
 * Link the prompt for this profile, the schema and the assistant's instructions
 * into the store, from wherever this code is running. All three, whether or not
 * the agent and the assistant are on today, so switching one on needs nothing more.
 * `copies.json` is written only when a copy was made or replaced.
 */
export async function linkStore(config: Config, platform: NodeJS.Platform = process.platform, symlinkFn: typeof symlink = symlink): Promise<LinkOutcome[]> {
  const copies = await readCopies(config.copiesFile);
  const recorded = JSON.stringify(copies);
  const outcomes = [
    await linkOne('prompt.md', config.promptFile, config.promptSource, copies, platform, symlinkFn),
    await linkOne('items.schema.json', config.schemaFile, config.schemaSource, copies, platform, symlinkFn),
    await linkOne('assistant.md', config.assistantPromptFile, config.assistantPromptSource, copies, platform, symlinkFn),
  ];
  if (JSON.stringify(copies) !== recorded) await writeJsonAtomic(config.copiesFile, copies);
  return outcomes;
}

/** `prompt.md → prompts/morning-brief-work.md`, for saying what was linked. */
export function describeLink(config: Config, outcome: LinkOutcome): string {
  const source = {
    'prompt.md': config.promptSource,
    'items.schema.json': config.schemaSource,
    'assistant.md': config.assistantPromptSource,
  }[outcome.name];
  return source ? `${outcome.name} → ${relative(dirname(dirname(config.promptSource)), source)}` : outcome.name;
}
