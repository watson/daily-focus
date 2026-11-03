/**
 * The merge helper: a small program of the user's own that merges a pull
 * request the way their company does.
 *
 * Many companies merge through a queue of their own, driven by a bot command or
 * an internal tool, and decide per repository, sometimes per branch, whether it
 * is used. GitHub's merge button may even be refused there. Daily Focus names no
 * such tool. It asks a program the user plugs in, the way git asks a credential
 * helper, and speaks this protocol to it, each call a process of its own:
 *
 *   <helper> check <pr-url> <base-branch>
 *       One line of JSON: `{"queue": true, "label": "Add to merge queue",
 *       "stacks": true}` or `{"queue": false}`. `label` is the button, and
 *       `stacks` says it can merge a whole stack from its top pull request.
 *   <helper> merge <pr-url>
 *   <helper> merge --stack <top-pr-url>
 *       Queue or merge one pull request, or a stack bottom-up. Exit 0 means it
 *       took it, and the first line it prints is what the page says; anything
 *       else is a refusal, in the first line of what it printed to stderr.
 *   <helper> status <pr-url>
 *       `{"queued": true}` or `{"queued": false}`: whether a pull request it
 *       was handed is still in its queue.
 *
 * `merge` runs only from a click on a row, as GitHub's merge does. `check` and
 * `status` are the helper's questions, asked after the board's polls; the
 * protocol says they must change nothing, which the dashboard can't enforce.
 *
 * Every run is the same, careful launch (`runMergeHelper`): no shell, no
 * terminal and no standard input, so it can never wait on a prompt; a fresh
 * empty folder to run in, outside any git checkout even when the home folder is
 * one; the CLIs' environment; and a time limit. Nothing is written to the store
 * or the install directory. What the helper said is kept in memory only.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalId } from './ids.ts';
import { launchFor, stopProcess } from './launch.ts';
import type { MergeHelperView, PullRequest } from './types.ts';

/** How long `check` and `status` may take: questions, asked with nobody waiting. */
export const QUESTION_TIMEOUT_MS = 30_000;
/** How long `merge` may take: somebody is waiting, but a queue's bot may be slow to answer. */
export const MERGE_TIMEOUT_MS = 120_000;
/** How long a `check` answer is trusted before it is asked again. */
export const CHECK_FRESH_MS = 24 * 3_600_000;
/**
 * How long after the helper took a pull request before `status` is asked about
 * it: a queue run by a bot may take a moment to notice a command, and a "no"
 * meanwhile would offer the button again for a pull request on its way in.
 */
export const STATUS_AFTER_MS = 2 * 60_000;
/** The button when the helper names none. */
export const DEFAULT_LABEL = 'Add to merge queue';

/** A label longer than this is cut: it is a button. */
const MAX_LABEL = 60;
/** What is kept of each stream: enough for a line and an error, not a runaway log. */
const MAX_OUTPUT = 64 * 1024;
/** How long a stopped helper gets to exit before its folder is removed regardless. */
const STOP_GRACE_MS = 5_000;

/** How one run ended: its exit, and what it printed. */
export interface HelperRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  /** The environment it runs with: the CLIs' (`cliEnvironment`), to which the launch adds its own few. */
  env: NodeJS.ProcessEnv;
  /** Where its empty folder is made. The system's temporary folder, unless a test says otherwise. */
  tmpRoot?: string;
}

/** Runs the helper once. Rejects only when it can't be started or takes too long; any exit is an answer. */
export type RunHelper = (helper: string, args: readonly string[], options: RunOptions) => Promise<HelperRun>;

/** The helper couldn't be asked, or its answer can't be read. */
export class HelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

/** The helper answered `merge`, and said no. The message is its own. */
export class HelperRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperRefusal';
  }
}

/**
 * Run the helper once, carefully.
 *
 * - Its arguments go to it as they are, never through a shell (`launchFor`, so
 *   an npm-installed helper's `.cmd` works on Windows).
 * - Standard input is closed, and elsewhere than Windows it runs in a session
 *   of its own, which has no controlling terminal: nothing it starts can open
 *   one to ask for a password and wait forever.
 * - It runs in a new, empty folder, removed afterwards, with git told not to
 *   look above it (`GIT_CEILING_DIRECTORIES`): a tool that acts on the checkout
 *   it is run in finds none, even when the temporary folder is inside one, as it
 *   is when the home folder is a git repository.
 * - It has `timeoutMs`, after which it is stopped with everything it started.
 */
export async function runMergeHelper(helper: string, args: readonly string[], options: RunOptions): Promise<HelperRun> {
  // The real path: macOS's temporary folder is behind a symlink, and git
  // compares the ceiling with the real path of where it is.
  const dir = await realpath(await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'daily-focus-helper-')));
  try {
    const pathKey = Object.keys(options.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    let launch: ReturnType<typeof launchFor>;
    try {
      launch = launchFor(helper, args, process.platform, options.env[pathKey]);
    } catch (err) {
      // On Windows, a batch file that isn't an npm wrapper, which would need cmd.exe.
      throw new HelperError(`could not run ${helper}: ${(err as Error).message}`);
    }
    return await new Promise<HelperRun>((resolve, reject) => {
      const windows = process.platform === 'win32';
      const child = spawn(launch.file, launch.args, {
        cwd: dir,
        env: {
          ...options.env,
          GIT_CEILING_DIRECTORIES: dirname(dir),
          // Belt and braces for the two prompts a helper is likeliest to reach.
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !windows,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let exited = false;
      const keep = (kept: string, chunk: string): string => (kept.length >= MAX_OUTPUT ? kept : (kept + chunk).slice(0, MAX_OUTPUT));
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = keep(stdout, chunk)));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr, chunk)));
      child.on('exit', () => (exited = true));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop(child.pid, windows, () => stopProcess(child, 'SIGKILL'));
        const fail = () => reject(new HelperError(`took longer than ${seconds(options.timeoutMs)} and was stopped`));
        if (exited) return fail();
        // Its folder goes once it has gone: Windows won't remove a folder a process is in.
        const grace = setTimeout(fail, STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(grace);
          fail();
        });
      }, options.timeoutMs);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new HelperError(`could not run ${helper}: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Stop a helper and whatever it started: its whole session elsewhere, its process tree on Windows. */
function stop(pid: number | undefined, windows: boolean, fallback: () => void): void {
  if (windows || pid === undefined) return fallback();
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

function seconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/* ---------- reading its answers ---------- */

/** The first line with anything on it, trimmed and kept short: what the page shows of what it said. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== '')?.trim() ?? '';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** Why a run that didn't exit 0 failed, in its own words when it gave any. */
function exitedBadly(run: HelperRun): string {
  const said = firstLine(run.stderr) || firstLine(run.stdout);
  const how = run.signal ? `was stopped by ${run.signal}` : `exited with code ${run.code}`;
  return said ? `${how}: ${said}` : how;
}

/** The JSON object an answer printed: its last line with anything on it. */
function answer(run: HelperRun, expected: string): Record<string, unknown> {
  if (run.code !== 0) throw new HelperError(exitedBadly(run));
  const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const line = lines.at(-1)?.trim() ?? '';
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HelperError(line ? `printed ${JSON.stringify(firstLine(line))}, not ${expected}` : `printed nothing, not ${expected}`);
  }
  return value as Record<string, unknown>;
}

/** What `check` says about a repository's branch. */
export interface HelperCheck {
  queue: boolean;
  label: string;
  stacks: boolean;
}

/** `check`'s answer. Throws `HelperError` for a failed run or one whose answer can't be read. */
export function readCheck(run: HelperRun): HelperCheck {
  const value = answer(run, '{"queue": true} or {"queue": false}');
  if (typeof value.queue !== 'boolean') throw new HelperError('said nothing about "queue", which must be true or false');
  const label = typeof value.label === 'string' ? value.label.replace(/\s+/g, ' ').trim() : '';
  return {
    queue: value.queue,
    label: label === '' ? DEFAULT_LABEL : label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label,
    stacks: value.stacks === true,
  };
}

/** `status`'s answer: whether the pull request is still in its queue. Throws as `readCheck` does. */
export function readStatus(run: HelperRun): boolean {
  const value = answer(run, '{"queued": true} or {"queued": false}');
  if (typeof value.queued !== 'boolean') throw new HelperError('said nothing about "queued", which must be true or false');
  return value.queued;
}

/**
 * `merge`'s answer: the line the page shows, empty when it printed nothing.
 * Throws `HelperRefusal` with its first line of stderr, or of stdout, when it
 * exited with anything but 0.
 */
export function readMerge(run: HelperRun): string {
  if (run.code === 0) return firstLine(run.stdout);
  const said = firstLine(run.stderr) || firstLine(run.stdout);
  throw new HelperRefusal(said || `the merge helper ${run.signal ? `was stopped by ${run.signal}` : `exited with code ${run.code}`}`);
}

/* ---------- what it said, kept ---------- */

/** A pull request handed to the helper from the dashboard. */
export interface Handed {
  id: string;
  url: string;
  repo: string;
  number: number;
}

/** The key one `check` answer is kept under: a repository and a branch. */
function branchKey(repo: string, base: string): string {
  return `${repo.toLowerCase()}\n${base}`;
}

/**
 * The merge helper as the board sees it: what `check` said about each branch,
 * the pull requests handed to it and whether `status` says they are still
 * queued, and the runs themselves. Memory only, and from one start to the next
 * it asks again.
 *
 * Nothing here throws past `ask`: it runs after a poll with nobody awaiting it,
 * and a helper that fails becomes a warning on the board.
 */
export class MergeHelper {
  readonly path: string;
  readonly #run: RunHelper;
  readonly #env: () => NodeJS.ProcessEnv;
  readonly #now: () => number;

  /** `check`'s answers, by branch, with when each came. */
  readonly #checks = new Map<string, { check: HelperCheck; at: number }>();
  /** Branches whose last `check` failed, with why: the board says so and offers GitHub's merge meanwhile. */
  readonly #failed = new Map<string, { repo: string; base: string; why: string }>();
  /** Branches being asked about now. */
  readonly #asking = new Set<string>();
  /** Pull requests handed to it from the dashboard and not yet known to be out of its queue, by canonical id, with when. */
  readonly #handed = new Map<string, Handed & { queued: boolean; at: number }>();
  /** Handed pull requests whose last `status` failed, with why. */
  readonly #statusFailed = new Map<string, string>();

  constructor(path: string, run: RunHelper, env: () => NodeJS.ProcessEnv, now: () => number = Date.now) {
    this.path = path;
    this.#run = run;
    this.#env = env;
    this.#now = now;
  }

  /**
   * What the board knows about how `repo`'s `base` merges: through the helper,
   * still being asked, or null for GitHub's own merge, which is also the answer
   * while a failed `check` waits to be asked again. A stale answer stands while
   * the next one is on its way.
   */
  view(repo: string, base: string): MergeHelperView | null {
    const key = branchKey(repo, base);
    if (this.#failed.has(key)) return null;
    const known = this.#checks.get(key);
    if (known) return known.check.queue ? { kind: 'queue', label: known.check.label, stacks: known.check.stacks } : null;
    return { kind: 'asking' };
  }

  /** Whether a pull request handed to it from the dashboard is still in its queue, as far as it last said. */
  queued(id: string): boolean {
    return this.#handed.get(canonicalId(id))?.queued ?? false;
  }

  /** What the board should say about the helper: each check and status that failed. */
  warnings(): string[] {
    const warnings = [...this.#failed.values()].map(
      ({ repo, base, why }) =>
        `The merge helper couldn't say how ${repo} merges into ${base}: it ${why}. Its pull requests offer GitHub's merge until it can.`,
    );
    for (const [id, why] of this.#statusFailed) {
      const handed = this.#handed.get(id);
      if (handed) warnings.push(`The merge helper couldn't say whether ${handed.repo}#${handed.number} is still in its queue: it ${why}.`);
    }
    return warnings;
  }

  /**
   * After a poll: ask `check` about every branch the board's pull requests
   * target as their default branch that has no fresh answer, and `status` about
   * every pull request handed to it that GitHub still reports open, from
   * `STATUS_AFTER_MS` after it was handed. One GitHub no longer lists has merged
   * or closed, and is forgotten without asking. Resolves once every answer is
   * in, and never rejects.
   */
  async ask(pulls: readonly PullRequest[]): Promise<void> {
    const branches = new Map<string, { repo: string; base: string; url: string }>();
    for (const pull of pulls) {
      if (!pull.defaultBranch || pull.baseRef !== pull.defaultBranch) continue;
      const key = branchKey(pull.repo, pull.baseRef);
      if (!branches.has(key)) branches.set(key, { repo: pull.repo, base: pull.baseRef, url: pull.url });
    }
    // A branch no pull request targets any more has nothing to warn about.
    for (const key of this.#failed.keys()) if (!branches.has(key)) this.#failed.delete(key);

    const open = new Set(pulls.map((pull) => canonicalId(pull.id)));
    for (const id of this.#handed.keys()) {
      if (!open.has(id)) {
        this.#handed.delete(id);
        this.#statusFailed.delete(id);
      }
    }

    const now = this.#now();
    const checks = [...branches].filter(([key]) => {
      const known = this.#checks.get(key);
      return !this.#asking.has(key) && (!known || now - known.at >= CHECK_FRESH_MS || this.#failed.has(key));
    });
    await Promise.all([
      ...checks.map(([key, branch]) => this.#check(key, branch)),
      ...[...this.#handed.values()].filter((handed) => now - handed.at >= STATUS_AFTER_MS).map((handed) => this.#status(handed)),
    ]);
  }

  async #check(key: string, branch: { repo: string; base: string; url: string }): Promise<void> {
    this.#asking.add(key);
    try {
      const check = readCheck(await this.#run(this.path, ['check', branch.url, branch.base], { timeoutMs: QUESTION_TIMEOUT_MS, env: this.#env() }));
      this.#checks.set(key, { check, at: this.#now() });
      this.#failed.delete(key);
    } catch (err) {
      // Never kept as "GitHub's merge": the next poll asks again.
      this.#checks.delete(key);
      this.#failed.set(key, { repo: branch.repo, base: branch.base, why: (err as Error).message });
    } finally {
      this.#asking.delete(key);
    }
  }

  async #status(handed: Handed & { queued: boolean; at: number }): Promise<void> {
    const id = canonicalId(handed.id);
    try {
      const queued = readStatus(await this.#run(this.path, ['status', handed.url], { timeoutMs: QUESTION_TIMEOUT_MS, env: this.#env() }));
      this.#statusFailed.delete(id);
      // Out of its queue, and still open: something took it out, and the row is
      // the user's to look at again. Asked about no more.
      if (queued) handed.queued = true;
      else this.#handed.delete(id);
    } catch (err) {
      // What it said last stands until it can say again.
      if (this.#handed.has(id)) this.#statusFailed.set(id, (err as Error).message);
    }
  }

  /**
   * Hand one pull request to the helper, or with `stack`, the stack it tops.
   * `heads` are the commits the user said yes to, one per pull request, passed
   * as `--head <pr-url>=<commit>`: the helper is to refuse when one has moved.
   * Resolves with the line it printed; rejects with `HelperRefusal` in its own
   * words when it says no, and `HelperError` when it can't be asked or takes too
   * long, which leaves open whether it took the pull request.
   */
  async merge(url: string, stack: boolean, heads: readonly { url: string; head: string }[]): Promise<string> {
    const args = [
      ...(stack ? ['merge', '--stack', url] : ['merge', url]),
      ...heads.flatMap((each) => ['--head', `${each.url}=${each.head}`]),
    ];
    const run = await this.#run(this.path, args, { timeoutMs: MERGE_TIMEOUT_MS, env: this.#env() }).catch((err: unknown) => {
      throw err instanceof HelperError && /took longer/.test(err.message)
        ? new HelperError(`the merge helper ${err.message}; look on GitHub to see whether it took it`)
        : err;
    });
    return readMerge(run);
  }

  /** Pull requests the helper took: in its queue until GitHub or `status` says otherwise. */
  handed(pulls: readonly Handed[]): void {
    for (const pull of pulls) {
      const id = canonicalId(pull.id);
      this.#handed.set(id, { ...pull, queued: true, at: this.#now() });
      this.#statusFailed.delete(id);
    }
  }
}
