/**
 * Whether the store's links into the repo point at this checkout.
 *
 * `npm run init` links `prompt.md`, `items.schema.json` and `assistant.md` into the
 * store from whichever checkout it runs in. Run it from a worktree that is later
 * left behind and the links keep pointing there: the morning agent goes on following
 * that copy of its instructions while this checkout's moves on, and the briefs look
 * no different. `npm run audit` reports it, but only when someone runs it, so the
 * dashboard checks every time it builds state. Three `lstat`s are cheap, and the
 * store watcher rebuilds the moment `npm run init` relinks.
 *
 * A real file where a link should be is someone's own prompt, put there on purpose;
 * init and audit leave it alone, and so does this.
 */

import { lstat, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

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
  sentences.push(`Run \`npm run init\` in \`${checkout}\` to relink ${count === 1 ? 'it' : 'them'}.`);
  return sentences.join(' ');
}
