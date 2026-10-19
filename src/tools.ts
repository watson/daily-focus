/**
 * The GitHub CLI and the Atlassian CLI, fetched for a user who doesn't have them.
 *
 * Both are optional: the pull request board, the ticket board and the brief's
 * GitHub and Jira read through them, and a user who uses neither needs neither.
 * Someone who does, but hasn't installed one, can have the dashboard fetch it
 * from its makers rather than open a terminal: GitHub's newest release of gh,
 * Atlassian's newest acli. Only ever from a click, never on a state read or a
 * schedule. Nothing is bundled: Atlassian's terms forbid passing acli on, and a
 * download reaches the npm package and every platform the CLIs are built for.
 *
 * A CLI of the user's own always wins. A setting that names one is used as it
 * is; otherwise the one on PATH; only when there is none the copy fetched here,
 * which lives in the data folder (`Config.toolsDir`), beside the stores, so both
 * profiles share it. `bin/` there holds nothing else, which is why the CLIs the
 * dashboard runs can have it on the end of their PATH (`cliEnvironment`).
 *
 * What is fetched is checked before it is put in place: gh against the checksums
 * its release publishes, on macOS both against their makers' Developer ID, and
 * on Windows gh against GitHub's Authenticode signature. Atlassian publishes no
 * checksums for acli and signs no Windows build of it, so on Windows and Linux
 * it has only HTTPS, as it does when installed by Atlassian's own instructions.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { findExecutable } from './launch.ts';

export type ToolName = 'gh' | 'acli';

export const TOOL_LABEL: Record<ToolName, string> = { gh: 'the GitHub CLI', acli: 'the Atlassian CLI' };

/** The Apple team each maker signs with, which a fetched copy must carry on macOS. */
const APPLE_TEAMS: Record<ToolName, string> = { gh: 'VEKTX9H2N7', acli: 'UPXU4CQZ5P' };

/** Whose Authenticode signature a fetched copy must carry on Windows, where its maker signs one. */
const WINDOWS_SIGNERS: Record<ToolName, string | null> = { gh: 'GitHub, Inc.', acli: null };

/** Long enough for a slow connection to bring fifteen megabytes. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The file a tool runs as, by platform. */
function fileName(name: ToolName, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** Where the copy fetched here lives, whether or not it has been fetched. */
export function fetchedPath(name: ToolName, toolsDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(toolsDir, 'bin', fileName(name, platform));
}

/** The folder of fetched CLIs, which holds nothing else and so can go on a PATH. */
export function fetchedBin(toolsDir: string): string {
  return join(toolsDir, 'bin');
}

export interface ResolvedTool {
  /** What to run: the setting, the bare name for PATH, or the fetched copy. */
  path: string;
  /** Whether it is there to run at all. */
  found: boolean;
  /** Whether it is the copy Daily Focus fetched, there being none of the user's. */
  fetched: boolean;
}

/**
 * Which copy of `name` to run. `configured` is the setting, or the bare name
 * when there is none. Looked at on every use rather than once at the start, so
 * a copy fetched a moment ago is used at once, without a restart.
 */
export function resolveTool(
  name: ToolName,
  configured: string,
  toolsDir: string,
  { onPath = (bin: string) => findExecutable(bin) !== null, exists = existsSync, platform = process.platform }: {
    onPath?: (bin: string) => boolean;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): ResolvedTool {
  if (configured !== name) return { path: configured, found: exists(configured) || onPath(configured), fetched: false };
  if (onPath(name)) return { path: name, found: true, fetched: false };
  const fetched = fetchedPath(name, toolsDir, platform);
  if (exists(fetched)) return { path: fetched, found: true, fetched: true };
  return { path: name, found: false, fetched: false };
}

/** What fetching needs from the world, gathered so a test can supply its own. */
export interface FetchDeps {
  fetch: typeof fetch;
  /** Runs a program and resolves with what it printed; rejects when it fails. */
  run(file: string, args: readonly string[]): Promise<string>;
  platform: NodeJS.Platform;
  arch: string;
}

const execFileAsync = promisify(execFile);

export const realFetchDeps: FetchDeps = {
  fetch: (...args) => fetch(...args),
  run: async (file, args) => (await execFileAsync(file, [...args], { timeout: 60_000, maxBuffer: 4 << 20 })).stdout,
  platform: process.platform,
  arch: process.arch,
};

/** A fetch that went wrong, in words for the page. */
export class ToolFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolFetchError';
  }
}

/** Each maker's name for this platform and processor, or null where it builds none. */
function target(name: ToolName, platform: NodeJS.Platform, arch: string): { os: string; arch: string } | null {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!cpu) return null;
  if (name === 'gh') {
    const os = { darwin: 'macOS', linux: 'linux', win32: 'windows' }[platform as string];
    return os ? { os, arch: cpu } : null;
  }
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as string];
  return os ? { os, arch: cpu } : null;
}

async function download(deps: FetchDeps, url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new ToolFetchError(`couldn't reach ${new URL(url).host}: ${(err as Error).message}`, { cause: err });
  }
  if (!res.ok) throw new ToolFetchError(`${new URL(url).host} answered ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** gh's newest release, from where GitHub's "latest" page redirects to: no API, so no rate limit. */
async function newestGh(deps: FetchDeps): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch('https://github.com/cli/cli/releases/latest', { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ToolFetchError(`couldn't reach github.com: ${(err as Error).message}`, { cause: err });
  }
  const tag = /\/tag\/(v\d+\.\d+\.\d+)$/.exec(res.headers.get('location') ?? '')?.[1];
  if (!tag) throw new ToolFetchError("couldn't tell which release of the GitHub CLI is the newest");
  return tag;
}

/** That `program` is signed by its maker, where the platform has a way to say and the maker signs. */
async function checkSigner(name: ToolName, program: string, deps: FetchDeps): Promise<void> {
  const refuse = (cause?: unknown): never => {
    throw new ToolFetchError(`${TOOL_LABEL[name]} that was downloaded isn't signed by its maker`, { cause });
  };
  if (deps.platform === 'darwin') {
    await deps
      .run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=anchor apple generic and certificate leaf[subject.OU] = "${APPLE_TEAMS[name]}"`, program])
      .catch(refuse);
  } else if (deps.platform === 'win32' && WINDOWS_SIGNERS[name]) {
    // The path is one this module made, but quoted as PowerShell quotes all the same.
    const said = await deps
      .run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath '${program.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ])
      .catch(refuse);
    const [status, subject = ''] = said.trim().split('|');
    if (status !== 'Valid' || !subject.includes(`O="${WINDOWS_SIGNERS[name]}"`)) refuse(new Error(said.trim()));
  }
}

/** Find `file` anywhere under `dir`: gh's archives put it at different depths by platform. */
async function findFile(dir: string, file: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, file);
      if (found) return found;
    } else if (entry.name === file && dir.endsWith('bin')) {
      return path;
    }
  }
  return null;
}

/**
 * Fetch `name` into the tools folder, checked, and return what it says its
 * version is. Replaces a copy fetched before; never touches one of the user's.
 * Two dashboards fetching at once each work in a folder of their own and the
 * later rename wins, which is the same program either way.
 */
export async function fetchTool(name: ToolName, toolsDir: string, deps: FetchDeps = realFetchDeps): Promise<string> {
  const where = target(name, deps.platform, deps.arch);
  if (!where) throw new ToolFetchError(`${TOOL_LABEL[name]} isn't made for ${deps.platform} on ${deps.arch}`);
  const file = fileName(name, deps.platform);
  const work = join(toolsDir, `.fetching-${randomBytes(4).toString('hex')}`);
  await mkdir(work, { recursive: true });
  try {
    let program: string;
    if (name === 'gh') {
      const tag = await newestGh(deps);
      const version = tag.slice(1);
      const asset = `gh_${version}_${where.os}_${where.arch}.${deps.platform === 'linux' ? 'tar.gz' : 'zip'}`;
      const base = `https://github.com/cli/cli/releases/download/${tag}`;
      const [archive, sums] = await Promise.all([download(deps, `${base}/${asset}`), download(deps, `${base}/gh_${version}_checksums.txt`)]);
      const expected = sums
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, named]) => named === asset)?.[0];
      const actual = createHash('sha256').update(archive).digest('hex');
      if (!expected || expected !== actual) throw new ToolFetchError(`${asset} doesn't match the checksum its release publishes`);
      await writeFile(join(work, asset), archive);
      // bsdtar reads zip as well as tar: macOS's and Windows' own tar are both it.
      await deps.run('tar', ['-xf', join(work, asset), '-C', work]);
      const found = await findFile(work, file);
      if (!found) throw new ToolFetchError(`${asset} has no ${file} in it`);
      program = found;
    } else {
      const url = `https://acli.atlassian.com/${where.os}/latest/acli_${where.os}_${where.arch}/${file}`;
      program = join(work, file);
      await writeFile(program, await download(deps, url));
    }
    await chmod(program, 0o755);
    await checkSigner(name, program, deps);
    const said = await deps.run(program, ['--version']).catch((err: unknown) => {
      throw new ToolFetchError(`the downloaded ${file} wouldn't run: ${(err as Error).message}`, { cause: err });
    });
    const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(said)?.[1] ?? 'unknown';
    await mkdir(fetchedBin(toolsDir), { recursive: true });
    await rename(program, fetchedPath(name, toolsDir, deps.platform));
    return version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
