/**
 * Finding a coding-agent CLI that will actually run: installed, new enough, and
 * logged in. The setup screen asks this first, and when one is ready it never
 * asks the user which: Codex if it is ready, then Claude Code.
 *
 * Found the way a terminal would find it, on the login shell's PATH, which
 * `shellpath.ts` puts in front at every start, the way T3 Code does. Then in the
 * places each installer puts it, for a CLI installed in a way that left the
 * shell's PATH alone. A path found there is saved with the setting that says
 * where the CLI is; a path on PATH needs no setting.
 *
 * Whether it is logged in, each CLI says for itself without a network round
 * trip worth waiting for: `codex login status`, `claude auth status`. Only a
 * definite no counts against it. A check that can't be read is not a reason to
 * refuse a CLI that may well work: its first session says if it doesn't.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { refusalFor } from './codex.ts';
import { CLI_NAMES, type CliName } from './config.ts';
import { findExecutable } from './setup.ts';

/** Which to use when both are ready. */
export const CLI_PREFERENCE: readonly CliName[] = ['codex', 'claude'];

/** How long `--version` and the login check each get. A CLI that takes longer is not one to start a brief with. */
const PROBE_TIMEOUT_MS = 10_000;

/** What running a CLI printed, and how it ended: null for a signal or a timeout. */
export interface ProbeResult {
  code: number | null;
  out: string;
}

/** Runs a program and reports what it printed, failing or not. Rejects only when it can't be started. */
export type Probe = (file: string, args: readonly string[]) => Promise<ProbeResult>;

const defaultProbe: Probe = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
      resolve({ code, out: `${stdout}\n${stderr}`.trim() });
    });
  });

/** One CLI as setup found it. */
export interface CliFound {
  /** Where it runs from, or null when it wasn't found. */
  path: string | null;
  version: string | null;
  /** Found by its name on PATH, so nothing needs saving to find it again. */
  onPath: boolean;
  /** Installed, new enough, and not known to be logged out. */
  ready: boolean;
  /** Why it isn't ready, in a sentence, when it isn't. */
  problem: string | null;
  /** The command that fixes it, when there is one. */
  fix: string | null;
}

export type CliReport = Record<CliName, CliFound>;

export const CLI_LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Where each CLI's own installers put it, for a shell whose PATH doesn't say. */
export function knownLocations(cli: CliName, home: string = homedir()): string[] {
  const common = [join(home, '.local', 'bin', cli), `/opt/homebrew/bin/${cli}`, `/usr/local/bin/${cli}`];
  return cli === 'codex'
    ? [join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'), ...common]
    : [...common, join(home, '.claude', 'local', 'claude')];
}

const VERSION = /(\d+\.\d+\.\d+)/;

/** Which CLI `--version` printed: Claude Code says so, Codex calls itself codex-cli. */
export function identify(output: string): CliName | null {
  if (/claude code/i.test(output)) return 'claude';
  if (/\bcodex(-cli)?\b/i.test(output)) return 'codex';
  return null;
}

/** Whether the CLI says it is logged in: true, false, or null when it can't be told. */
function loggedIn(cli: CliName, result: ProbeResult): boolean | null {
  if (cli === 'claude') {
    const json = /\{[\s\S]*\}/.exec(result.out)?.[0];
    try {
      const status = json ? (JSON.parse(json) as { loggedIn?: unknown }) : null;
      return typeof status?.loggedIn === 'boolean' ? status.loggedIn : null;
    } catch {
      return null;
    }
  }
  if (/not logged in|logged out/i.test(result.out)) return false;
  if (/logged in/i.test(result.out)) return true;
  return result.code !== null && result.code !== 0 ? false : null;
}

const LOGIN: Record<CliName, { args: string[]; fix: string }> = {
  claude: { args: ['auth', 'status'], fix: 'claude auth login' },
  codex: { args: ['login', 'status'], fix: 'codex login' },
};

/**
 * What the program at `path` is, and whether it will run a brief. `expected`
 * is the CLI it was looked for as; a path the user typed is taken for whichever
 * it turns out to be.
 */
export async function probeCli(path: string, expected: CliName | null, onPath: boolean, probe: Probe = defaultProbe): Promise<{ cli: CliName | null; found: CliFound }> {
  const missing = (problem: string): { cli: CliName | null; found: CliFound } => ({
    cli: expected,
    found: { path, version: null, onPath, ready: false, problem, fix: null },
  });
  let version: ProbeResult;
  try {
    version = await probe(path, ['--version']);
  } catch {
    return missing(`Nothing runs at ${path}`);
  }
  const cli = identify(version.out) ?? expected;
  if (version.code !== 0 || !cli) {
    const said = version.out.split('\n')[0]?.slice(0, 120) || 'nothing';
    return missing(cli ? `${path} didn't say its version` : `${path} isn't Codex or Claude Code: it says “${said}”`);
  }
  const number = VERSION.exec(version.out)?.[1] ?? null;
  const tooOld = cli === 'codex' ? refusalFor(number) : null;
  if (tooOld) {
    return { cli, found: { path, version: number, onPath, ready: false, problem: tooOld, fix: 'codex update' } };
  }
  let login: boolean | null = null;
  try {
    login = loggedIn(cli, await probe(path, LOGIN[cli].args));
  } catch {
    login = null;
  }
  return {
    cli,
    found:
      login === false
        ? { path, version: number, onPath, ready: false, problem: `${CLI_LABEL[cli]} is installed but not logged in`, fix: LOGIN[cli].fix }
        : { path, version: number, onPath, ready: true, problem: null, fix: null },
  };
}

/**
 * Look for both CLIs: a path already set for one first, then its name on PATH,
 * then where its installers put it. The first candidate that runs is the one
 * reported, ready or not, so a CLI that is logged out says so rather than being
 * passed over for a copy elsewhere.
 */
export async function detectClis(
  configured: Partial<Record<CliName, string>> = {},
  opts: { probe?: Probe; path?: string; locations?: (cli: CliName) => string[] } = {},
): Promise<CliReport> {
  const report = {} as CliReport;
  await Promise.all(
    CLI_NAMES.map(async (cli) => {
      const onPath = await findExecutable(cli, opts.path);
      const candidates = [
        ...(configured[cli] ? [await findExecutable(configured[cli]!, opts.path)] : []),
        onPath,
        ...(await Promise.all((opts.locations ?? knownLocations)(cli).map((location) => findExecutable(location)))),
      ];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        const { found } = await probeCli(candidate, cli, candidate === onPath, opts.probe);
        // Something that isn't this CLI at all is passed over; anything else is the answer.
        if (found.version !== null || found.ready) {
          report[cli] = found;
          return;
        }
      }
      report[cli] = { path: null, version: null, onPath: false, ready: false, problem: `${CLI_LABEL[cli]} isn't installed`, fix: null };
    }),
  );
  return report;
}

/** The CLI setup uses without asking: the first ready one in order of preference. */
export function preferredCli(report: CliReport): CliName | null {
  return CLI_PREFERENCE.find((cli) => report[cli].ready) ?? null;
}
