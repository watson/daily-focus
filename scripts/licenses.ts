/**
 * The licences of what the npm package ships that others wrote, in one file:
 * `dist/third-party-licenses.txt`, written by `scripts/package.ts`.
 *
 * Which npm packages that is comes from esbuild's own account of each bundle,
 * not from a list kept by hand: every file it read from `node_modules` belongs
 * to a package whose licence is due, so a dependency added later is credited
 * without anyone remembering to. A package with no licence file stops the build
 * rather than shipping uncredited, and so does one under a copyleft licence,
 * which would ask for the dashboard to be released under its terms instead of
 * MIT (`copyleft`). The fonts are the one thing the package carries from
 * elsewhere, and are named here.
 *
 * The Mac app shows this file in its Acknowledgements window, with Node's and
 * the GitHub CLI's (`macos/build.sh`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { Metafile } from 'esbuild';

/** What the package carries that isn't an npm package: the fonts, with their licence beside them. */
const ASSETS: readonly { name: string; url: string; licence: string; file: string }[] = [
  { name: 'IBM Plex', url: 'https://github.com/IBM/plex', licence: 'OFL-1.1', file: 'public/fonts/OFL.txt' },
];

/**
 * Licences, by SPDX identifier, that reach past their own code into the work
 * that includes them: the GPL family, and its kin. Weak copyleft (MPL, EPL,
 * CDDL) is here too, for bundled code: each one needs a decision, not a build.
 */
const COPYLEFT = /^(A|L)?GPL|^SSPL|^EUPL|^OSL|^CC-BY-SA|^MPL|^EPL|^CDDL/i;

/**
 * Whether an SPDX expression holds the package to a copyleft licence: every
 * alternative it offers is one, so `MIT OR GPL-3.0` can still be taken as MIT.
 */
export function copyleft(licence: string): boolean {
  const alternatives = licence.replace(/[()]/g, ' ').split(/\s+OR\s+/i).map((each) => each.trim()).filter(Boolean);
  return alternatives.length > 0 && alternatives.every((each) => each.split(/\s+AND\s+/i).some((part) => COPYLEFT.test(part.trim())));
}

export interface Credit {
  name: string;
  version: string | null;
  url: string | null;
  licence: string;
  text: string;
}

/**
 * The folders of the npm packages a build read from, from its metafile's inputs,
 * which are relative to `cwd`. A nested copy is a package of its own.
 */
export function bundledPackageDirs(inputs: Iterable<string>, cwd: string): string[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const path = resolve(cwd, input);
    const marker = `${sep}node_modules${sep}`;
    const at = path.lastIndexOf(marker);
    if (at === -1) continue;
    const rest = path.slice(at + marker.length).split(sep);
    const name = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
    dirs.add(path.slice(0, at + marker.length) + name.join(sep));
  }
  return [...dirs].sort();
}

/** One package's name, version and licence, from its own folder. Throws when it has no licence file. */
export async function packageCredit(dir: string): Promise<Credit> {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version?: string;
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
  };
  if (manifest.license && copyleft(manifest.license)) {
    throw new Error(`${manifest.name} is under ${manifest.license}, a copyleft licence Daily Focus can't ship under MIT; see AGENTS.md`);
  }
  const file = (await readdir(dir)).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry));
  if (!file) throw new Error(`${manifest.name} has no licence file in ${dir}; credit it by hand before shipping it`);
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return {
    name: manifest.name,
    version: manifest.version ?? null,
    url: manifest.homepage ?? repository?.replace(/^git\+/, '').replace(/\.git$/, '') ?? null,
    licence: manifest.license ?? 'see below',
    text: (await readFile(join(dir, file), 'utf8')).trim(),
  };
}

/** Every credit the package owes: the npm packages its builds read from, then the assets. */
export async function packageCredits(metafiles: readonly Metafile[], root: string, cwd: string = process.cwd()): Promise<Credit[]> {
  const dirs = bundledPackageDirs(metafiles.flatMap((metafile) => Object.keys(metafile.inputs)), cwd);
  const credits = await Promise.all(dirs.map((dir) => packageCredit(dir)));
  for (const asset of ASSETS) {
    credits.push({ name: asset.name, version: null, url: asset.url, licence: asset.licence, text: (await readFile(join(root, asset.file), 'utf8')).trim() });
  }
  return credits;
}

/** The file: a heading for each, then its licence as it wrote it. */
export function licensesText(credits: readonly Credit[]): string {
  const parts = ['Daily Focus dashboard: third-party software', '', 'The dashboard is built with the following, each under its own licence.'];
  for (const credit of credits) {
    const title = credit.version ? `${credit.name} ${credit.version}` : credit.name;
    parts.push('', '', title, '='.repeat(title.length), [credit.licence, credit.url].filter(Boolean).join(' · '), '', credit.text);
  }
  return `${parts.join('\n')}\n`;
}
