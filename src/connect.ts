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
 *   localhost, so the browser has to be on this machine. Then it asks, in a
 *   terminal prompt, which of the user's sites to sign in to, the one they
 *   picked on that page. Its prompts draw themselves into a pipe and take keys
 *   from one, so the page reads the sites off what it drew, asks the user, and
 *   types the answer: Down as many times as it takes, then Enter. With one site
 *   there is nothing to ask. On Windows its prompts read keys from a console and
 *   refuse a pipe ("failed to capture input"), so there it runs in a window of
 *   its own, where the user picks the site, and its status says how that went.
 *   Should it fail anyway, the page says which command to run in a terminal.
 *
 * Either way the CLI keeps the session where it always does, so a terminal's
 * gh or acli sees the same one, and so do the boards, the agent and the
 * assistant. One connection at a time per service, stopped with the dashboard.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import type { Config } from './config.ts';
import { listGhAccounts } from './github.ts';
import { findExecutable, launchFor, stopProcess } from './launch.ts';
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
  /** Which platform's way to sign in: a test runs either on any. */
  platform?: NodeJS.Platform;
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
    this.#state = { status: 'idle', choices: null, inWindow: false, code: null, url: null, login: null, error: null, command: null };
  }

  /** Whether it is fetching or waiting on the user: a restart would throw the work away. */
  get busy(): boolean {
    return ['fetching', 'starting', 'waiting', 'choosing'].includes(this.#state.status);
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
    this.#set({ status: 'starting', choices: null, inWindow: false, code: null, url: null, login: null, error: null, command: null });
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
    if (this.#service === 'jira' && (this.#deps.platform ?? process.platform) === 'win32') return this.#signInInWindow(path, command);
    return new Promise((settle) => {
      let child: ChildProcess;
      try {
        const launch = launchFor(path, args);
        // acli is typed into, to answer which site; gh is asked nothing.
        const input = this.#service === 'jira' ? 'pipe' : 'ignore';
        child = this.#spawn(launch.file, launch.args, { env: this.#env(), stdio: [input, 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        this.#end('failed', (err as Error).message);
        return settle();
      }
      this.#child = child;
      // Both streams for what it is waiting on; what went wrong is on stderr, apart from acli's spinner.
      let said = '';
      let complained = '';
      // Where in what it said the site question last answered was, so a redraw isn't asked twice.
      let asked = -1;
      child.stderr?.on('data', (chunk: Buffer | string) => (complained += chunk.toString()));
      const read = (chunk: Buffer | string): void => {
        said += chunk.toString();
        const login = /Logged in as\s+(\S+)/.exec(said)?.[1] ?? null;
        if (login) this.#state = { ...this.#state, login };
        if (this.#service === 'jira') {
          const prompt = sitePrompt(said);
          if (prompt && prompt.at > asked && this.#state.status !== 'choosing') {
            asked = prompt.at;
            // One site is the one chosen in the browser: nothing to ask.
            if (prompt.sites.length === 1) child.stdin?.write('\r');
            else this.#set({ status: 'choosing', choices: prompt.sites });
          }
          return;
        }
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
        // Cancelled is cancelled, whatever the CLI made of being stopped.
        if (this.#cancelled) {
          this.#end('idle', null);
        } else if (code === 0) {
          this.#end('done', null);
          this.#deps.onConnected();
        } else {
          this.#end('failed', lastWords(complained) || lastWords(said) || `it exited with ${code}`, command);
        }
        settle();
      });
    });
  }

  /**
   * acli's sign-in in a console window of its own, on Windows: PowerShell starts
   * it there and waits for it. Its exit code only says the window closed, so its
   * status says whether that left a session. The path is quoted as PowerShell
   * quotes, and the script goes encoded, so no character in it is read twice.
   */
  #signInInWindow(path: string, command: string): Promise<void> {
    const found = findExecutable(path) ?? path;
    const script =
      `$p = Start-Process -FilePath '${found.replace(/'/g, "''")}' -ArgumentList ${LOGIN.jira.map((arg) => `'${arg}'`).join(',')} -Wait -PassThru; ` +
      'exit $p.ExitCode';
    return new Promise((settle) => {
      let child: ChildProcess;
      try {
        child = this.#spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { env: this.#env(), stdio: 'ignore', windowsHide: true },
        );
      } catch (err) {
        this.#end('failed', (err as Error).message);
        return settle();
      }
      this.#child = child;
      this.#set({ status: 'waiting', inWindow: true });
      this.#timer = setTimeout(() => void this.cancel(), SIGN_IN_TIMEOUT_MS);
      this.#timer.unref();
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (this.#child !== child) return;
        this.#child = null;
        this.#end('failed', err.message, command);
        settle();
      });
      child.once('close', () => {
        if (this.#child !== child) return;
        this.#child = null;
        if (this.#cancelled) {
          this.#end('idle', null);
          return settle();
        }
        void this.#signedIn(path).then((signedIn) => {
          if (signedIn) {
            this.#end('done', null);
            this.#deps.onConnected();
          } else {
            this.#end('failed', 'the window closed before acli had signed in', command);
          }
          settle();
        });
      });
    });
  }

  /**
   * Answer acli's question of which site, with one of those it offered: the one
   * the user chose on Atlassian's page. Its list starts on the first, so that
   * many Downs and an Enter. The reason when there is no such question now.
   */
  choose(choice: string): string | null {
    const index = this.#state.status === 'choosing' ? (this.#state.choices ?? []).indexOf(choice) : -1;
    if (index === -1 || !this.#child?.stdin) return `${choice} isn't one of the sites to choose from now`;
    this.#child.stdin.write(`${'\x1b[B'.repeat(index)}\r`);
    this.#set({ status: 'waiting', choices: null });
    return null;
  }

  /**
   * Stop connecting. A code or a consent page the page showed stops working with
   * it. Resolves once it has stopped, so a reply built after it shows the button
   * again rather than something that no longer works. Killed, not asked: acli
   * takes being asked to stop as choosing whichever site is highlighted.
   */
  cancel(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    this.#cancelled = true;
    if (this.#child) stopProcess(this.#child, 'SIGKILL', process.platform, this.#spawn);
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
    this.#set({ status, choices: null, inWindow: false, code: null, url: null, error, command });
  }
}

/**
 * acli's question of which site to sign in to, when it has drawn one: the sites,
 * in the order it lists them, and where in `said` the question is. Drawn as its
 * prompts all are, a bar down the left and `>` at the highlighted option:
 *
 *   ┃ Select the site to login
 *   ┃ > acme.atlassian.net
 *   ┃   acme-sandbox.atlassian.net
 *
 *   ↑ up • ↓ down • / filter • enter submit
 *
 * Only once it has drawn the keys line under the list, so a list arriving in
 * pieces isn't taken for a shorter one.
 */
export function sitePrompt(said: string): { sites: string[]; at: number } | null {
  const plain = said.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const at = plain.lastIndexOf('Select the site to login');
  if (at === -1) return null;
  const after = plain.slice(at).split(/\r?\n/).slice(1);
  const sites: string[] = [];
  for (const line of after.map((each) => each.replace(/^\r+/, ''))) {
    const option = /^┃ (?:> |  )(\S.*?)\s*$/.exec(line);
    if (!option) break;
    sites.push(option[1]!);
  }
  if (sites.length === 0 || !/enter submit/.test(plain.slice(at))) return null;
  return { sites, at };
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
