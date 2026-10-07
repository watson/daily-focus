/**
 * Version numbers and release notes, worked out from Conventional Commits.
 *
 *   node scripts/release.ts check-title "feat(board): show draft pull requests"
 *   node scripts/release.ts version --dev
 *   node scripts/release.ts version [--set 1.0.0]
 *   node scripts/release.ts notes 0.2.0
 *
 * Every change reaches main as one squash commit titled with its pull request's
 * title, which CI checks with `check-title`. So main's history is a list of
 * Conventional Commits (https://www.conventionalcommits.org/), and a `vX.Y.Z` tag
 * marks each stable release. The next version is the last release's, bumped by
 * the largest change since: a breaking change (`feat!:`, or a `BREAKING CHANGE:`
 * footer) bumps the major, a `feat` the minor, anything else the patch. Below
 * 1.0.0 a breaking change bumps the minor, since npm's caret ranges treat that as
 * the major there, and 1.0.0 is a decision, made with `--set`.
 *
 * A development build, made for every push to main, is that version with
 * `-dev.N` after it, N counting the commits since the last release, so it sorts
 * below the release it leads to and above every build before it.
 *
 * Nothing here writes: the Release workflow stamps the version into package.json
 * and makes the tag. The version in a checkout's package.json is a placeholder.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { ranDirectly } from '../src/install.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

/** The types a title may have: the Angular convention's, which commitlint and release-please also use. */
export const TYPES = ['feat', 'fix', 'perf', 'revert', 'docs', 'refactor', 'test', 'build', 'ci', 'chore', 'style'] as const;

export type Commit = {
  sha: string;
  type: string;
  scope: string | null;
  breaking: boolean;
  /** What a `BREAKING CHANGE:` footer says, when there is one. */
  breakingNote: string | null;
  description: string;
  /** False for a subject that isn't a Conventional Commit, which only history from before the convention has. */
  conventional: boolean;
};

export type Bump = 'major' | 'minor' | 'patch';
type Version = [number, number, number];

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<description>\S.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: *(.*)$/m;
const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Why `title` isn't a Conventional Commit with one of `TYPES`, or null when it is. */
export function titleProblem(title: string): string | null {
  const match = HEADER.exec(title.trim());
  if (!match?.groups) {
    return 'it should read "type: description" or "type(scope): description", with "!" before the colon for a breaking change';
  }
  const type = match.groups.type ?? '';
  if (!(TYPES as readonly string[]).includes(type)) return `"${type}" is not one of the types: ${TYPES.join(', ')}`;
  return null;
}

/** A commit message as a release sees it. */
export function parseCommit(sha: string, message: string): Commit {
  const [subject = '', ...rest] = message.trim().split('\n');
  const body = rest.join('\n');
  const footer = BREAKING_FOOTER.exec(body);
  const match = HEADER.exec(subject.trim());
  if (!match?.groups) {
    return { sha, type: '', scope: null, breaking: Boolean(footer), breakingNote: footer?.[1]?.trim() || null, description: subject.trim(), conventional: false };
  }
  return {
    sha,
    type: match.groups.type ?? '',
    scope: match.groups.scope?.trim() || null,
    breaking: Boolean(match.groups.bang || footer),
    breakingNote: footer?.[1]?.trim() || null,
    description: match.groups.description?.trim() ?? '',
    conventional: true,
  };
}

/** The largest change among `commits`; a patch when there is none to speak of, since every build needs a new version. */
export function bumpFor(commits: Commit[]): Bump {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

export function parseVersion(text: string): Version | null {
  const match = STABLE.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function nextVersion(base: string, bump: Bump): string {
  const [major, minor, patch] = parseVersion(base) ?? [0, 0, 0];
  if (bump === 'major' && major > 0) return `${major + 1}.0.0`;
  if (bump === 'major' || bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The highest stable release among `tags`, below `below` when given; prerelease tags don't count. */
export function lastRelease(tags: string[], below?: string): string | null {
  const ceiling = below ? parseVersion(below) : null;
  let best: Version | null = null;
  for (const tag of tags) {
    if (!tag.startsWith('v')) continue;
    const version = parseVersion(tag);
    if (!version || (ceiling && compare(version, ceiling) >= 0)) continue;
    if (!best || compare(version, best) > 0) best = version;
  }
  return best ? best.join('.') : null;
}

/** The repository's web address, from package.json: `https://github.com/owner/name`. */
export function repositoryUrl(manifest: { repository?: string | { url?: string } }): string {
  const url = typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? '');
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** Sections in order of what a reader most needs to know; types not listed stay out of the notes. */
const SECTIONS: { type: string; title: string }[] = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Bug Fixes' },
  { type: 'perf', title: 'Performance Improvements' },
  { type: 'revert', title: 'Reverts' },
];

/**
 * Release notes in conventional-changelog's layout, the one release-please and
 * semantic-release write: breaking changes first, then features, fixes,
 * performance and reverts. Housekeeping (docs, refactor, test, build, ci, chore,
 * style) is left out. A subject that isn't a Conventional Commit is listed last,
 * under Other Changes, rather than dropped.
 */
export function renderNotes(options: { version: string; previous: string | null; date: string; repository: string; commits: Commit[] }): string {
  const { version, previous, date, repository, commits } = options;
  const heading = previous ? `[${version}](${repository}/compare/v${previous}...v${version})` : version;
  const entry = (commit: Commit, text: string) =>
    `* ${commit.scope ? `**${commit.scope}:** ` : ''}${text} ([${commit.sha.slice(0, 7)}](${repository}/commit/${commit.sha}))`;

  const sections: string[] = [];
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length) {
    sections.push(['### ⚠ BREAKING CHANGES', '', ...breaking.map((commit) => entry(commit, commit.breakingNote ?? commit.description))].join('\n'));
  }
  for (const { type, title } of SECTIONS) {
    const listed = commits.filter((commit) => commit.conventional && commit.type === type);
    if (listed.length) sections.push([`### ${title}`, '', ...listed.map((commit) => entry(commit, commit.description))].join('\n'));
  }
  const other = commits.filter((commit) => !commit.conventional);
  if (other.length) sections.push(['### Other Changes', '', ...other.map((commit) => entry(commit, commit.description))].join('\n'));
  if (!sections.length) sections.push('No user-facing changes.');

  const install = `Download **Daily-Focus.dmg** below for the menu bar app (Apple silicon, macOS 13.5 or newer), or run \`npx daily-focus@${version}\`.`;
  // Only a stable release is notarised; see .github/workflows/release.yml.
  const unnotarised =
    'This development build is signed but not notarised, so macOS refuses to open it at first: open it once, then allow it under System Settings → Privacy & Security → Open Anyway.';
  const footer = version.includes('-') ? [install, unnotarised] : [install];
  return [`## ${heading} (${date})`, ...sections, '---', ...footer].join('\n\n') + '\n';
}

/** Git in the working directory's repository, which the workflows start in. */
async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function tags(): Promise<string[]> {
  return (await git('tag', '--list', 'v*')).split('\n').filter(Boolean);
}

/** The commits after `base`, a stable version, up to HEAD; every commit when there is no base. */
async function commitsSince(base: string | null): Promise<Commit[]> {
  const range = base ? [`v${base}..HEAD`] : ['HEAD'];
  const log = await git('log', '--no-merges', '--format=%H%x1f%B%x1e', ...range);
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', message = ''] = record.split('\x1f');
      return parseCommit(sha, message);
    });
}

/** The stable release HEAD is already tagged with, so a rerun of a release finishes it instead of cutting another. */
async function releasedAtHead(): Promise<string | null> {
  return lastRelease((await git('tag', '--points-at', 'HEAD')).split('\n').filter(Boolean));
}

async function version(options: { dev: boolean; set: string }): Promise<string> {
  const base = lastRelease(await tags());
  if (options.dev) {
    const commits = await commitsSince(base);
    return `${nextVersion(base ?? '0.0.0', bumpFor(commits))}-dev.${commits.length}`;
  }
  const tagged = await releasedAtHead();
  if (options.set) {
    const wanted = parseVersion(options.set);
    if (!wanted) throw new Error(`"${options.set}" is not a version: it should read like 1.0.0`);
    const wantedText = wanted.join('.');
    if (tagged === wantedText) return wantedText;
    if (tagged) throw new Error(`this commit is already released, as v${tagged}`);
    if (base && compare(wanted, parseVersion(base)!) <= 0) throw new Error(`${wantedText} is not after the last release, v${base}`);
    return wantedText;
  }
  if (tagged) return tagged;
  return nextVersion(base ?? '0.0.0', bumpFor(await commitsSince(base)));
}

async function notes(versionText: string): Promise<string> {
  // The release before this one, whether or not this one has been tagged yet.
  const stable = versionText.split('-')[0] ?? versionText;
  const previous = lastRelease(await tags(), stable);
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { repository?: string | { url?: string } };
  return renderNotes({
    version: versionText,
    previous,
    date: new Date().toISOString().slice(0, 10),
    repository: repositoryUrl(manifest),
    commits: await commitsSince(previous),
  });
}

if (ranDirectly(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { dev: { type: 'boolean', default: false }, set: { type: 'string', default: '' } },
  });
  const [command, argument] = positionals;
  try {
    if (command === 'check-title' && argument !== undefined) {
      const problem = titleProblem(argument);
      if (problem) {
        console.error(`The pull request's title becomes the commit on main, so it must be a Conventional Commit: ${problem}.`);
        console.error('For example: "feat(board): show draft pull requests" or "fix: keep the last good read when Jira fails".');
        process.exitCode = 1;
      } else {
        console.log(`"${argument}" is a Conventional Commit`);
      }
    } else if (command === 'version') {
      console.log(await version(values));
    } else if (command === 'notes' && argument) {
      process.stdout.write(await notes(argument));
    } else {
      console.error('usage: node scripts/release.ts check-title <title> | version [--dev] [--set X.Y.Z] | notes <version>');
      process.exitCode = 64;
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
