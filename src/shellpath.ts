/**
 * The PATH your terminal has, for a dashboard that wasn't started from one.
 *
 * Everything the dashboard runs is found on PATH: `gh`, `acli`, `claude`, `codex`,
 * and Node itself for the CLIs that start with `#!/usr/bin/env node`. A terminal
 * has a PATH built by your shell's startup files; launchd, a menu bar app and
 * anything else started from the GUI get `/usr/bin:/bin:/usr/sbin:/sbin`, which
 * has none of them. So at startup the dashboard asks your login shell for its
 * PATH, the way T3 Code does: run it interactively, print PATH between two
 * markers so whatever the startup files print can't be mistaken for it, and give
 * up after five seconds. If no shell answers, macOS keeps a PATH for GUI apps in
 * launchd, which is better than nothing. Either way the result goes in front of
 * the PATH the process already had, which stays as the fallback.
 *
 * Read at every start rather than captured once at install, so a CLI installed
 * since is found the next time the dashboard starts.
 */

import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

const START = '__DAILY_FOCUS_PATH_START__';
const END = '__DAILY_FOCUS_PATH_END__';

/** How long a shell gets to start up and answer. */
const SHELL_TIMEOUT_MS = 5_000;

/** Runs a program and resolves with what it printed, or rejects when it fails or takes longer than `timeout`. */
export type ExecFile = (file: string, args: readonly string[], options: { timeout: number }) => Promise<string>;

/**
 * Run a program in a session of its own, with no terminal to take.
 *
 * An interactive shell started with the terminal of the process that started it
 * makes itself that terminal's foreground, and on the way out hands it to its
 * parent's process group rather than back to whoever had it. Started from a
 * terminal, that left Ctrl-C going to the dashboard alone, or to nobody, instead
 * of to what the user ran. A new session has no controlling terminal, so the
 * shell reads its startup files and prints PATH, and the terminal is untouched.
 */
const defaultExec: ExecFile = (file, args, { timeout }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      // The whole session: an interactive shell may have started things of its own.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      finish(new Error(`${file} took longer than ${timeout} ms`));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => finish(error));
    child.on('close', () => finish(null));
  });

/** The shells worth asking, in order, without repeats: `$SHELL`, your login shell, then the platform's own. */
export function shellCandidates(envShell: string | undefined, loginShell: string | undefined, platform: NodeJS.Platform): string[] {
  const fallback = platform === 'darwin' ? '/bin/zsh' : platform === 'linux' ? '/bin/bash' : undefined;
  const shells: string[] = [];
  for (const shell of [envShell, loginShell, fallback]) {
    const trimmed = shell?.trim();
    if (trimmed && !shells.includes(trimmed)) shells.push(trimmed);
  }
  return shells;
}

/** The text between the markers, or null when the shell never got as far as printing them. */
export function pathBetweenMarkers(output: string): string | null {
  const start = output.indexOf(START);
  if (start === -1) return null;
  const from = start + START.length;
  const end = output.indexOf(END, from);
  if (end === -1) return null;
  const value = output.slice(from, end).trim();
  return value === '' ? null : value;
}

/** `preferred` first, then whatever of `inherited` it lacks, without empties or repeats. */
export function mergePaths(preferred: string | null | undefined, inherited: string | null | undefined): string {
  const entries: string[] = [];
  for (const value of [preferred, inherited]) {
    for (const entry of (value ?? '').split(':')) {
      if (entry !== '' && !entries.includes(entry)) entries.push(entry);
    }
  }
  return entries.join(':');
}

async function readLoginShellPath(shell: string, exec: ExecFile): Promise<string | null> {
  const command = `printf '%s\\n' '${START}'; printenv PATH || true; printf '%s\\n' '${END}'`;
  return pathBetweenMarkers(await exec(shell, ['-ilc', command], { timeout: SHELL_TIMEOUT_MS }));
}

async function readLaunchctlPath(exec: ExecFile): Promise<string | null> {
  try {
    const value = (await exec('/bin/launchctl', ['getenv', 'PATH'], { timeout: 2_000 })).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

function currentLoginShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Put the login shell's PATH in front of `env.PATH`. Does nothing on Windows,
 * where PATH comes from the registry and a GUI process has the same one.
 * Returns the shell it came from, or null when none answered.
 */
export async function hydratePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFile = defaultExec,
  loginShell: string | undefined = currentLoginShell(),
): Promise<string | null> {
  if (platform === 'win32') return null;
  let found: string | null = null;
  let from: string | null = null;
  for (const shell of shellCandidates(env.SHELL, loginShell, platform)) {
    try {
      found = await readLoginShellPath(shell, exec);
    } catch {
      // Missing, too slow, or broken startup files: try the next one.
    }
    if (found) {
      from = shell;
      break;
    }
  }
  if (!found && platform === 'darwin') {
    found = await readLaunchctlPath(exec);
    if (found) from = 'launchctl';
  }
  const merged = mergePaths(found, env.PATH);
  if (merged !== '') env.PATH = merged;
  return from;
}
