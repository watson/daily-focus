/**
 * Finding a program and starting it, the same on Windows as elsewhere.
 *
 * Windows finds a program by trying each extension `PATHEXT` names, so `codex`
 * on PATH is `codex.cmd` and `claude` is `claude.exe`. Node's `spawn` tries only
 * `.com` and `.exe`, and refuses a `.cmd` outright unless it goes through a shell.
 * A shell is no answer here: the prompt, the schema and Codex's settings are all
 * arguments, the user's own question among them, and through `cmd.exe` they would
 * be read as commands, lose their quotes and be cut off at 8,191 characters.
 *
 * So on Windows a program is looked up the way the shell would, and an npm
 * wrapper is read for the program it wraps, which is then started directly. npm
 * installs every CLI's command as such a wrapper (`cmd-shim`): Codex's runs its
 * script with Node, and Claude Code's runs its own `claude.exe`.
 *
 * Stopping differs too: Windows has no signals, so a CLI is stopped together with
 * everything it started (`stopProcess`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

/** What Windows runs by name, in `PATHEXT`'s order. PowerShell scripts and the rest need a host to run them. */
const WINDOWS_RUNNABLE = ['.com', '.exe', '.bat', '.cmd'];

/**
 * Where `name` would run from, as a shell would find it, or null. A path is
 * checked as it is, save that on Windows a name without a runnable extension is
 * tried with each: npm puts an extensionless shell script beside its `.cmd`
 * wrapper, which Windows itself can't run.
 */
export function findExecutable(name: string, path: string = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === 'win32';
  const names = windows && !WINDOWS_RUNNABLE.includes(extname(name).toLowerCase()) ? WINDOWS_RUNNABLE.map((ext) => `${name}${ext}`) : [name];
  const dirs = isAbsolute(name) ? [''] : path.split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names.map((each) => (dir ? join(dir, each) : each))) {
      try {
        // Windows has no execute bit: a file there runs by its extension.
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/** A program to start and its arguments. */
export interface Launch {
  file: string;
  args: string[];
}

/**
 * The program an npm wrapper starts, relative to the wrapper: the last
 * `"%dp0%\…"` path in it. Earlier ones only ask whether a `node.exe` sits beside it.
 */
export function wrappedProgram(wrapper: string): string | null {
  return [...wrapper.matchAll(/"%dp0%\\([^"]+)"/g)].at(-1)?.[1] ?? null;
}

/**
 * How to start `bin` with `args`. Anywhere but Windows, exactly that. On Windows,
 * `bin` is found the way the shell would find it, and an npm wrapper becomes the
 * program it wraps: its `.exe`, or this dashboard's Node running its script.
 * Throws for a batch file that isn't such a wrapper rather than run it through
 * `cmd.exe`. Synchronous, so it goes right before a `spawn` without changing when
 * the child starts.
 */
export function launchFor(bin: string, args: readonly string[], platform: NodeJS.Platform = process.platform, path?: string): Launch {
  if (platform !== 'win32') return { file: bin, args: [...args] };
  const found = findExecutable(bin, path, platform) ?? bin;
  if (!['.cmd', '.bat'].includes(extname(found).toLowerCase())) return { file: found, args: [...args] };
  const program = wrappedProgram(readFileSync(found, 'utf8'));
  if (!program) {
    throw new Error(
      `${basename(found)} is a batch file, and Daily Focus won't pass arguments through cmd.exe. ` +
        'Set the path to the program it starts instead.',
    );
  }
  const target = join(dirname(found), ...program.split('\\'));
  if (['.exe', '.com'].includes(extname(target).toLowerCase())) return { file: target, args: [...args] };
  return { file: process.execPath, args: [target, ...args] };
}

/**
 * Stop `child` and everything it started. Elsewhere that is a signal, which the
 * CLIs pass on to what they started. Windows has no signals, and `kill()` ends
 * that one process. Node and Bun put what they start in a job that ends with
 * them, so that is enough for Codex's npm launcher and for Claude Code, but a
 * native CLI started directly, such as Codex's own `codex.exe`, leaves its tool
 * servers and commands running. So there `taskkill /T` ends the whole tree, at
 * once whichever signal was asked for, and `kill()` is the fallback: `taskkill`
 * needs a desktop session's rights, which a service or an SSH session lacks.
 */
export function stopProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): void {
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  const taskkill = spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  taskkill.on('error', () => child.kill(signal));
  taskkill.on('exit', (code) => {
    if (code !== 0) child.kill(signal);
  });
}
