/**
 * What a new store still needs before a morning brief can work, for the setup
 * steps the Today tab shows until the first brief exists.
 *
 * Only facts the dashboard can check for itself: whether a file exists, whether
 * a program is installed, how many of the template's placeholders the source list
 * still holds. Whether a CLI is logged in, or a connector reachable, is something
 * only a run can find out, and the first run's report says so.
 */

import { execFile } from 'node:child_process';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { CLI_NAMES, type CliName, type Config } from './config.ts';
import type { SetupState } from './types.ts';

const run = promisify(execFile);

/**
 * The template's placeholders, as they read in `src/templates.ts`. A source list
 * still holding one sends the agent looking for `Your Name`, which is worse than
 * no source list at all.
 */
export const PLACEHOLDERS: readonly string[] = [
  'Your Name',
  'you@example.com',
  'you@personal.example',
  'your-github-login',
  'Some Shared Calendar',
  'Some Noisy Calendar',
  '<where your colleagues are>',
  '<where you are>',
  '<where you live>',
  '<document id>',
];

export function placeholdersIn(text: string): number {
  return PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)).length;
}

/** Where `name` would run from, as a shell would find it, or null. A path is checked as it is. */
export async function findExecutable(name: string, path: string = process.env.PATH ?? ''): Promise<string | null> {
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/**
 * Where each CLI the dashboard can run is installed: a path set for the agent or
 * the assistant when that one is set to this CLI, whatever the file is called,
 * then the CLI's own name on PATH.
 */
async function findClis(config: Config): Promise<Record<CliName, string | null>> {
  const found = {} as Record<CliName, string | null>;
  for (const cli of CLI_NAMES) {
    const candidates = [
      config.agent.cli === cli ? config.agent.binPath : null,
      config.assistant.agent === cli ? config.assistant.binPath : null,
      cli,
    ].filter((candidate): candidate is string => candidate !== null);
    found[cli] = null;
    for (const candidate of candidates) {
      found[cli] = await findExecutable(candidate);
      if (found[cli]) break;
    }
  }
  return found;
}

async function hasArchive(config: Config): Promise<boolean> {
  try {
    return (await readdir(config.archiveDir)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this store has never had a brief: no `items.json`, and nothing in the
 * archive. Until one exists the setup steps show, and the morning agent's clock
 * waits for the first brief to come from the button that ends them. Otherwise
 * choosing a CLI after seven would start a run before the source list it needs.
 */
export async function firstBriefPending(config: Config): Promise<boolean> {
  return !(await exists(config.itemsFile)) && !(await hasArchive(config));
}

/**
 * Everything the setup steps show that the rest of the state doesn't already say.
 * The objective, the agent and the boards are in the state anyway.
 */
export async function setupState(config: Config, opts: { profileChosen: boolean }): Promise<SetupState> {
  let sources: string | null = null;
  try {
    sources = await readFile(config.sourcesFile, 'utf8');
  } catch {
    sources = null;
  }
  const supported = process.platform === 'darwin';
  return {
    // The file, not whether it parsed: a brief that is there but broken is a
    // problem for its banner to report, not a store to set up from scratch. The
    // agent's clock asks the same question.
    needed: await firstBriefPending(config),
    profile: config.profile,
    profileChosen: opts.profileChosen,
    sources: { exists: sources !== null, placeholders: sources === null ? 0 : placeholdersIn(sources) },
    clis: await findClis(config),
    calendar: {
      supported,
      built: supported && (await exists(config.calendar.appPath)),
      chosen: config.calendar.names.length,
    },
  };
}

/** Who the user is, as far as gh and git can say, for filling in a new source list. */
export interface Identity {
  name: string | null;
  login: string | null;
  email: string | null;
}

let identity: Promise<Identity> | null = null;

/**
 * Asked once per process, and only when a new source list is opened. Each part
 * is a guess the user reviews before saving, so a CLI that is missing, slow or
 * logged out just leaves its placeholder where it was.
 */
export function detectIdentity(config: Config): Promise<Identity> {
  identity ??= (async () => {
    const [user, email] = await Promise.all([
      run(config.github.ghPath, ['api', 'user', '--jq', '[.login, .name // ""] | join("\\n")'], { timeout: 5_000 }).then(
        ({ stdout }) => stdout.split('\n'),
        () => [],
      ),
      run('git', ['config', '--global', 'user.email'], { timeout: 2_000 }).then(
        ({ stdout }) => stdout.trim() || null,
        () => null,
      ),
    ]);
    return {
      login: config.github.accounts[0] ?? (user[0]?.trim() || null),
      name: user[1]?.trim() || null,
      email,
    };
  })();
  return identity;
}

/** The template with whatever is known about the user in place of its placeholders. */
export function fillIdentity(template: string, who: Identity): string {
  let text = template;
  if (who.name) text = text.replaceAll('`Your Name`', `\`${who.name}\``);
  if (who.email) text = text.replaceAll('`you@example.com`', `\`${who.email}\``).replaceAll('`you@personal.example`', `\`${who.email}\``);
  if (who.login) text = text.replaceAll('`your-github-login`', `\`${who.login}\``);
  return text;
}
