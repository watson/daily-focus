/**
 * Signing in to GitHub from the page, through gh's own browser sign-in.
 *
 * Run with no terminal, `gh auth login --web` prints a one-time code and
 * GitHub's device page, opens no browser, and waits until the code has been
 * entered there. The page shows both; gh stores the token where it always
 * does, so a gh in a terminal sees the same login, and the boards, the agent
 * and the assistant all read through it. This is how the Mac app's own gh gets
 * a login at all, since nobody can type `gh auth login` for it, and how any gh
 * signs in again later.
 *
 * gh makes the account signed in as its active one, which is what the board
 * reads as when Settings names none: the page says so beside the button.
 *
 * Only ever started by a click, one at a time, and stopped with the dashboard.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { GitHubConfig } from './config.ts';
import { launchFor, stopProcess } from './launch.ts';
import type { GitHubSignInState } from './types.ts';

/** GitHub's device code lasts fifteen minutes, after which gh gives up by itself; this is in case it doesn't. */
const SIGN_IN_TIMEOUT_MS = 16 * 60_000;

/** Where GitHub asks for the code, should gh's line about it ever change. */
const DEVICE_URL = 'https://github.com/login/device';

export interface GitHubSignInDeps {
  /** Something changed that the page should show. */
  onChange(): void;
  /** gh has a new login: whatever reads through it should look again. */
  onSignedIn(): void;
  spawnFn?: typeof spawn;
}

export class GitHubSignIn {
  readonly #github: Pick<GitHubConfig, 'ghPath' | 'ghBundled'>;
  readonly #deps: GitHubSignInDeps;
  readonly #spawn: typeof spawn;
  #state: GitHubSignInState;
  #child: ChildProcess | null = null;
  /** Settles once the gh under way has exited and its end is recorded. */
  #exited: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #cancelled = false;

  constructor(github: Pick<GitHubConfig, 'ghPath' | 'ghBundled'>, deps: GitHubSignInDeps) {
    this.#github = github;
    this.#deps = deps;
    this.#spawn = deps.spawnFn ?? spawn;
    this.#state = { bundled: github.ghBundled, status: 'idle', code: null, url: null, login: null, error: null };
  }

  /** Whether gh is waiting on GitHub: a restart would throw the code away. */
  get busy(): boolean {
    return this.#child !== null;
  }

  view(): GitHubSignInState {
    return { ...this.#state };
  }

  /** Start gh's sign-in, unless one is under way already, in which case the page is shown that one. */
  start(): void {
    if (this.#child) return;
    this.#cancelled = false;
    this.#state = { ...this.#state, status: 'starting', code: null, url: null, login: null, error: null };
    let child: ChildProcess;
    try {
      const launch = launchFor(this.#github.ghPath, ['auth', 'login', '--web', '--hostname', 'github.com']);
      child = this.#spawn(launch.file, launch.args, {
        // Prompts off, so gh never waits on a keypress nobody can give; no
        // update nag, which would land among the lines read here.
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.#end('failed', (err as Error).message);
      return;
    }
    this.#child = child;
    this.#exited = new Promise((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    let said = '';
    const read = (chunk: Buffer | string): void => {
      said += chunk.toString();
      const code = deviceCode(said);
      const login = /Logged in as\s+(\S+)/.exec(said)?.[1] ?? null;
      if (code && this.#state.code !== code) {
        const url = /(https:\/\/\S+\/login\/device)\b/.exec(said)?.[1] ?? DEVICE_URL;
        this.#state = { ...this.#state, status: 'waiting', code, url };
        this.#deps.onChange();
      }
      if (login) this.#state = { ...this.#state, login };
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    this.#timer = setTimeout(() => void this.cancel(), SIGN_IN_TIMEOUT_MS);
    this.#timer.unref();
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.#child = null;
      this.#end(
        'failed',
        err.code === 'ENOENT' || err.code === 'EACCES'
          ? `could not run \`${this.#github.ghPath}\` — install the GitHub CLI or set DAILY_FOCUS_GH to its path`
          : err.message,
      );
    });
    child.on('close', (code) => {
      // `error` may already have ended it: gh never started.
      if (this.#child !== child) return;
      this.#child = null;
      if (code === 0) {
        this.#end('done', null);
        this.#deps.onSignedIn();
      } else {
        this.#end('failed', this.#cancelled ? null : lastWords(said) || `gh exited with ${code}`);
      }
    });
    this.#deps.onChange();
  }

  /**
   * Stop waiting on GitHub. The code the page showed stops working with it.
   * Resolves once gh has gone, so a reply built after it shows the button again
   * rather than a code that no longer works.
   */
  cancel(): Promise<void> {
    if (!this.#child) return Promise.resolve();
    this.#cancelled = true;
    stopProcess(this.#child, 'SIGTERM', process.platform, this.#spawn);
    return this.#exited;
  }

  /** For the dashboard's close: nothing lands after it. */
  stop(): void {
    void this.cancel();
    if (this.#timer) clearTimeout(this.#timer);
  }

  #end(status: 'done' | 'failed', error: string | null): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // A sign-in stopped from the page is no failure: it goes back to the button.
    const cancelled = status === 'failed' && error === null;
    this.#state = { ...this.#state, status: cancelled ? 'idle' : status, code: null, url: null, error };
    this.#deps.onChange();
  }
}

/**
 * The code on gh's line about it. Its words change between releases, and the Mac
 * app carries whichever is newest: "First copy your one-time code: AB12-CD34" up
 * to 2.98, "One-time code (AB12-CD34) copied to clipboard" by 2.102.
 */
export function deviceCode(said: string): string | null {
  const line = said.split('\n').find((each) => /one-time code/i.test(each));
  return line ? (/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(line)?.[1] ?? null) : null;
}

/** What gh said last, without the code and the link it said first: the part that says what went wrong. */
function lastWords(said: string): string {
  const lines = said
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/one-time code|login\/device/i.test(line));
  return lines.slice(-3).join('\n');
}
