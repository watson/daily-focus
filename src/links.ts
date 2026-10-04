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
 */

import { lstat, readlink, rename, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

import type { Config } from './config.ts';

export type LinkState =
  | { state: 'linked' }
  /** A real file, not a link: someone's own copy. */
  | { state: 'own' }
  | { state: 'missing' }
  /** A link to a file that no longer exists. */
  | { state: 'dangling'; target: string }
  /** A link to some other file, usually the same one in another checkout. */
  | { state: 'elsewhere'; target: string };

/** What the link at `link` points at, compared with the repo file it should point at. */
export async function linkState(link: string, source: string): Promise<LinkState> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return { state: 'own' };
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
  const dangling: Array<{ name: string; target: string }> = [];
  const missing: string[] = [];
  for (const entry of linksInUse(config)) {
    const found = await linkState(entry.link, entry.source);
    if (found.state === 'elsewhere') elsewhere.push({ name: entry.name, target: found.target, reader: entry.reader });
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

  const count = elsewhere.length + dangling.length + missing.length;
  const checkout = shown(dirname(dirname(config.promptSource)), home);
  sentences.push(`Restart the dashboard to link ${count === 1 ? 'it' : 'them'} back to \`${checkout}\`.`);
  return sentences.join(' ');
}

/** What became of one link when the store was linked. */
export interface LinkOutcome {
  name: string;
  /** `linked` means it was made or repointed just now; `kept` that it already pointed here. */
  result: 'linked' | 'kept' | 'own' | 'failed';
  /** Where it pointed before being repointed, or why it failed. */
  detail: string | null;
}

/**
 * Point `target` in the store at `source` in this checkout. A link pointing
 * anywhere else is repointed, since a stale link is a stale prompt; a real file is
 * left strictly alone.
 */
async function linkOne(name: string, target: string, source: string): Promise<LinkOutcome> {
  let before: string | null = null;
  try {
    const stats = await lstat(target);
    if (!stats.isSymbolicLink()) return { name, result: 'own', detail: null };
    before = resolve(dirname(target), await readlink(target));
    if (before === source) return { name, result: 'kept', detail: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { name, result: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  // The new link is made beside the old one and renamed over it, so the agent
  // never finds no link at all, and a link that can't be made leaves the old one.
  const staged = `${target}.${process.pid}.link`;
  try {
    await unlink(staged).catch(() => {});
    await symlink(source, staged);
    await rename(staged, target);
    return { name, result: 'linked', detail: before };
  } catch (error) {
    await unlink(staged).catch(() => {});
    // Windows needs Developer Mode or an elevated shell for this. Copying would
    // work, so say so rather than leaving the store half set up with no hint why.
    const code = (error as NodeJS.ErrnoException).code;
    const hint = code === 'EPERM' || code === 'EACCES' ? '; copy it there by hand instead' : '';
    return { name, result: 'failed', detail: `${error instanceof Error ? error.message : String(error)}${hint}` };
  }
}

/**
 * Link the prompt for this profile, the schema and the assistant's instructions
 * into the store, from wherever this code is running. All three, whether or not
 * the agent and the assistant are on today, so switching one on needs nothing more.
 */
export async function linkStore(config: Config): Promise<LinkOutcome[]> {
  return [
    await linkOne('prompt.md', config.promptFile, config.promptSource),
    await linkOne('items.schema.json', config.schemaFile, config.schemaSource),
    await linkOne('assistant.md', config.assistantPromptFile, config.assistantPromptSource),
  ];
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
