/**
 * What a new store still needs before a morning brief can work, for the setup
 * screen and for Today until the first brief exists.
 *
 * Only facts the dashboard can check for itself: whether a file exists, whether
 * a program is installed, how many of the template's placeholders the source list
 * still holds. Whether a CLI is logged in, or a connector reachable, is something
 * only a run can find out: the setup screen's sessions are the first to try.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CLI_NAMES, type CliName, type Config } from './config.ts';
import { command } from './install.ts';
import { findExecutable } from './launch.ts';
import { resolveTool } from './tools.ts';
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
 * archive. Until one exists the setup screen shows until it is finished, and the
 * morning agent's clock waits for the first brief to come from its last button. Otherwise
 * choosing a CLI after seven would start a run before the source list it needs.
 */
export async function firstBriefPending(config: Config): Promise<boolean> {
  return !(await exists(config.itemsFile)) && !(await hasArchive(config));
}

/**
 * What the setup screen and Today's first-brief card need that the rest of the
 * state doesn't already say.
 */
export async function setupState(config: Config): Promise<SetupState> {
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
    sources: { exists: sources !== null, placeholders: sources === null ? 0 : placeholdersIn(sources) },
    clis: await findClis(config),
    calendar: {
      supported,
      built: supported && (await exists(config.calendar.appPath)),
      chosen: config.calendar.names.length,
      buildCommand: command('build-calendar'),
    },
  };
}

/** Who the user is, as far as gh and git can say, for filling in a new source list. */
export interface Identity {
  name: string | null;
  /** The account gh uses now, or the first one set for the board. */
  login: string | null;
  /** Every github.com account gh is logged in to, the active one first: a work and a personal one, say. */
  logins: string[];
  email: string | null;
}

let identity: Promise<Identity> | null = null;

/**
 * The github.com accounts gh holds, active first, from `gh auth status --json
 * hosts`; empty when gh is too old to say, or says nothing.
 */
export function ghLogins(json: string): string[] {
  try {
    const hosts = (JSON.parse(json) as { hosts?: Record<string, unknown> }).hosts ?? {};
    const accounts = Array.isArray(hosts['github.com']) ? (hosts['github.com'] as { login?: unknown; active?: unknown; state?: unknown }[]) : [];
    return accounts
      .filter((account) => typeof account.login === 'string' && account.state !== 'error')
      .sort((a, b) => Number(b.active === true) - Number(a.active === true))
      .map((account) => account.login as string);
  } catch {
    return [];
  }
}

/**
 * Asked once per process, and only when a new source list is opened or setup
 * asks. Each part is a guess the user reviews before saving, so a CLI that is
 * missing, slow or logged out just leaves its placeholder where it was.
 */
export function detectIdentity(config: Config): Promise<Identity> {
  identity ??= (async () => {
    const gh = resolveTool('gh', config.github.ghPath, config.toolsDir).path;
    const [user, logins, email] = await Promise.all([
      run(gh, ['api', 'user', '--jq', '[.login, .name // ""] | join("\\n")'], { timeout: 5_000 }).then(
        ({ stdout }) => stdout.split('\n'),
        () => [],
      ),
      run(gh, ['auth', 'status', '--json', 'hosts'], { timeout: 5_000 }).then(
        ({ stdout }) => ghLogins(stdout),
        () => [],
      ),
      run('git', ['config', '--global', 'user.email'], { timeout: 2_000 }).then(
        ({ stdout }) => stdout.trim() || null,
        () => null,
      ),
    ]);
    const login = config.github.accounts[0] ?? (user[0]?.trim() || null);
    return {
      login,
      logins: logins.length ? logins : login ? [login] : [],
      name: user[1]?.trim() || null,
      email,
    };
  })();
  return identity;
}

/** Ask again next time: gh has signed in since, and holds an account it didn't. */
export function forgetIdentity(): void {
  identity = null;
}

/** The template with whatever is known about the user in place of its placeholders. */
export function fillIdentity(template: string, who: Identity): string {
  let text = template;
  if (who.name) text = text.replaceAll('`Your Name`', `\`${who.name}\``);
  if (who.email) text = text.replaceAll('`you@example.com`', `\`${who.email}\``).replaceAll('`you@personal.example`', `\`${who.email}\``);
  if (who.login) text = text.replaceAll('`your-github-login`', `\`${who.login}\``);
  return text;
}
