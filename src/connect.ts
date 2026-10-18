/**
 * Connecting GitHub or Jira from the page: getting the CLI the dashboard reads
 * through, and signing it in.
 *
 * Both services are optional, and connecting one only ever starts from a click.
 * It does as little as it has to. A CLI that isn't there is fetched from its
 * maker (`tools.ts`); one already signed in is left as it is; only then does it
 * sign in, each the way its CLI allows without a terminal:
 *
 * - gh's `auth login --web` prints a one-time code and GitHub's device page, and
 *   waits for the code to be entered there. The page shows both. gh makes the
 *   account signed in as its active one.
 * - acli's `jira auth login --web` opens the browser itself, on Atlassian's
 *   consent page, and waits for it to come back to a server of its own on
 *   localhost, so the browser has to be on this machine. Should it want a
 *   terminal after that, the page says which command to run in one.
 *
 * Either way the CLI keeps the session where it always does, so a terminal's
 * gh or acli sees the same one, and so do the boards, the agent and the
 * assistant. One connection at a time per service, stopped with the dashboard.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import type { Config } from './config.ts';
import { listGhAccounts } from './github.ts';
import { launchFor, stopProcess } from './launch.ts';
import { fetchTool, realFetchDeps, resolveTool, type FetchDeps, type ToolName } from './tools.ts';
import type { ConnectionState, Service } from './types.ts';

const run = promisify(execFile);

/** GitHub's device code lasts fifteen minutes; Atlassian's consent page is given as long. */
const SIGN_IN_TIMEOUT_MS = 16 * 60_000;

/** Where GitHub asks for the code, should gh's line about it ever change. */
const DEVICE_URL = 'https://github.com/login/device';

/** Which CLI each service reads through, and how it is set. */
const CLI: Record<Service, ToolName> = { github: 'gh', jira: 'acli' };

/** How each CLI signs in. */
const LOGIN: Record<Service, string[]> = {
  github: ['auth', 'login', '--web', '--hostname', 'github.com'],
  jira: ['jira', 'auth', 'login', '--web'],
};

export interface ConnectionDeps {
  /** Something changed that the page should show. */
  onChange(): void;
  /** The CLI has a session it didn't: whatever reads through it should look again. */
  onConnected(): void;
  spawnFn?: typeof spawn;
  fetchDeps?: FetchDeps;
}

/** The setting for the service's CLI, and where fetched CLIs live. */
type ConnectionConfig = Pick<Config, 'toolsDir'> & { github: Pick<Config['github'], 'ghPath'>; jira: Pick<Config['jira'], 'acliPath'> };

export class Connection {
  readonly #service: Service;
  readonly #config: ConnectionConfig;
  readonly #deps: ConnectionDeps;
  readonly #spawn: typeof spawn;
  #state: Omit<ConnectionState, 'cli'>;
  #child: ChildProcess | null = null;
  /** Settles once whatever is under way has finished and its end is recorded. */
  #done: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #cancelled = false;

  constructor(service: Service, config: ConnectionConfig, deps: ConnectionDeps) {
    this.#service = service;
    this.#config = config;
    this.#deps = deps;
    this.#spawn = deps.spawnFn ?? spawn;
    this.#state = { status: 'idle', code: null, url: null, login: null, error: null, command: null };
  }

  /** Whether it is fetching or waiting: a restart would throw the work away. */
  get busy(): boolean {
    return this.#state.status === 'fetching' || this.#state.status === 'starting' || this.#state.status === 'waiting';
  }

  /** Which copy of the CLI is in use, looked at now. */
  #cli(): ReturnType<typeof resolveTool> {
    const name = CLI[this.#service];
    return resolveTool(name, name === 'gh' ? this.#config.github.ghPath : this.#config.jira.acliPath, this.#config.toolsDir);
  }

  view(): ConnectionState {
    const { found, fetched } = this.#cli();
    return { ...this.#state, cli: { found, fetched } };
  }

  /**
   * Connect, unless a connection is under way already, in which case the page is
   * shown that one. `again` signs in even when the CLI is signed in already: to
   * renew a session, or to add an account.
   */
  start(again = false): void {
    if (this.busy) return;
    this.#cancelled = false;
    this.#done = this.#connect(again);
  }

  async #connect(again: boolean): Promise<void> {
    this.#set({ status: 'starting', code: null, url: null, login: null, error: null, command: null });
    let cli = this.#cli();
    if (!cli.found) {
      this.#set({ status: 'fetching' });
      try {
        await fetchTool(CLI[this.#service], this.#config.toolsDir, this.#deps.fetchDeps ?? realFetchDeps);
      } catch (err) {
        return this.#end('failed', (err as Error).message);
      }
      if (this.#cancelled) return this.#end('idle', null);
      cli = this.#cli();
      this.#set({ status: 'starting' });
    }
    // Signed in already, as a user's own CLI often is: nothing more to do.
    if (!again && (await this.#signedIn(cli.path))) {
      this.#end('done', null);
      this.#deps.onConnected();
      return;
    }
    if (this.#cancelled) return this.#end('idle', null);
    await this.#signIn(cli.path);
  }

  /**
   * Whether the CLI holds a session, judged as the boards judge it: gh by the
   * accounts it lists, as the pull request board reads them (a token alone in
   * the keychain, with no account to it, is not one), acli by its own status.
   */
  async #signedIn(path: string): Promise<boolean> {
    if (this.#service === 'github') return (await listGhAccounts(path).catch(() => [])).length > 0;
    try {
      const launch = launchFor(path, ['jira', 'auth', 'status']);
      await run(launch.file, launch.args, { env: this.#env(), timeout: 30_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Prompts off, so a CLI never waits on a keypress nobody can give; no colour or update nag among the lines read. */
  #env(): NodeJS.ProcessEnv {
    return { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  }

  #signIn(path: string): Promise<void> {
    const args = LOGIN[this.#service];
    const command = [path, ...args].map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `"${word}"`)).join(' ');
    return new Promise((settle) => {
      let child: ChildProcess;
      try {
        const launch = launchFor(path, args);
        child = this.#spawn(launch.file, launch.args, { env: this.#env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        this.#end('failed', (err as Error).message);
        return settle();
      }
      this.#child = child;
      // Both streams for what it is waiting on; what went wrong is on stderr, apart from acli's spinner.
      let said = '';
      let complained = '';
      child.stderr?.on('data', (chunk: Buffer | string) => (complained += chunk.toString()));
      const read = (chunk: Buffer | string): void => {
        said += chunk.toString();
        const login = /Logged in as\s+(\S+)/.exec(said)?.[1] ?? null;
        if (login) this.#state = { ...this.#state, login };
        if (this.#service !== 'github') return;
        const code = deviceCode(said);
        if (code && this.#state.code !== code) {
          const url = /(https:\/\/\S+\/login\/device)\b/.exec(said)?.[1] ?? DEVICE_URL;
          this.#set({ status: 'waiting', code, url });
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      // acli says nothing to wait on: its browser is open as soon as it starts.
      if (this.#service === 'jira') this.#set({ status: 'waiting' });
      this.#timer = setTimeout(() => void this.cancel(), SIGN_IN_TIMEOUT_MS);
      this.#timer.unref();
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (this.#child !== child) return;
        this.#child = null;
        this.#end('failed', err.message);
        settle();
      });
      child.once('close', (code) => {
        if (this.#child !== child) return;
        this.#child = null;
        if (code === 0) {
          this.#end('done', null);
          this.#deps.onConnected();
        } else if (this.#cancelled) {
          this.#end('idle', null);
        } else {
          this.#end('failed', lastWords(complained) || lastWords(said) || `it exited with ${code}`, command);
        }
        settle();
      });
    });
  }

  /**
   * Stop connecting. A code or a consent page the page showed stops working with
   * it. Resolves once it has stopped, so a reply built after it shows the button
   * again rather than something that no longer works.
   */
  cancel(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    this.#cancelled = true;
    if (this.#child) stopProcess(this.#child, 'SIGTERM', process.platform, this.#spawn);
    return this.#done;
  }

  /** For the dashboard's close: nothing lands after it. */
  stop(): void {
    void this.cancel();
    if (this.#timer) clearTimeout(this.#timer);
  }

  #set(change: Partial<Omit<ConnectionState, 'cli'>>): void {
    this.#state = { ...this.#state, ...change };
    this.#deps.onChange();
  }

  #end(status: 'done' | 'failed' | 'idle', error: string | null, command: string | null = null): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#set({ status, code: null, url: null, error, command });
  }
}

/**
 * The code on gh's line about it. Its words change between releases, and a CLI
 * fetched for the user is whichever is newest: "First copy your one-time code:
 * AB12-CD34" up to 2.98, "One-time code (AB12-CD34) copied to clipboard" by 2.102.
 */
export function deviceCode(said: string): string | null {
  const line = said.split('\n').find((each) => /one-time code/i.test(each));
  return line ? (/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(line)?.[1] ?? null) : null;
}

/** What the CLI said last, without the code and the link it said first: the part that says what went wrong. */
function lastWords(said: string): string {
  const lines = said
    // acli redraws a spinner with escape codes and braille frames, with no newline between.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\u2800-\u28ff]\s*Authenticating\.\.\./g, '')
    .split('\n')
    .map((line) => line.replace(/^.*\r/, '').trim())
    .filter((line) => line !== '' && !/one-time code|login\/device/i.test(line));
  return lines.slice(-3).join('\n').replace(/^✗\s*(Error:\s*)?/m, '');
}
