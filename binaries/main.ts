/**
 * What runs first in a Linux or Windows executable.
 *
 * Each executable is the official Node.js binary with this loader and the npm
 * package injected into it as a single-executable application; `build.ts` makes
 * them. Node runs the loader from inside the binary, where the package's files
 * are assets, not files: nothing can serve `public/` from there, and the store
 * links to `prompts/` and `schema/`. So the first run of a build unpacks the
 * package into the user's data directory, under a name made of its version and a
 * hash of its contents, and every run starts the package's own `dist/cli.js` from
 * there, exactly as `npx daily-focus` would. A later build unpacks beside it, and
 * nothing here deletes an earlier one: another dashboard may still be running
 * from it.
 *
 * Compiled to CommonJS, which is what Node runs from a single executable, and
 * kept to Node's own modules, which are all the `require` there reaches.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { pathToFileURL } from 'node:url';

/** What `build.ts` injects beside the package's files: which build this is, and what is in it. */
export interface Manifest {
  version: string;
  /** Of every file's path and content, so a rebuild of the same version that differs is unpacked apart. */
  hash: string;
  /** Every file in the package, as paths from its root with `/` between parts, which are also their asset keys. */
  files: string[];
}

/**
 * Where unpacked builds go: the user's data directory, as each platform has it.
 * The Mac app keeps the dashboards it downloads in Application Support too.
 */
export function dashboardsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'daily-focus', 'dashboards');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'daily-focus', 'dashboards');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'daily-focus', 'dashboards');
}

/** The directory `manifest`'s build unpacks into, under `dashboards`. */
export function unpackedDir(dashboards: string, manifest: Manifest): string {
  return join(dashboards, `${manifest.version}-${manifest.hash}`);
}

/**
 * The directory `manifest`'s package is unpacked in, with `package/` inside it,
 * unpacking it from `read` first when it isn't there yet. Unpacked beside its
 * place and renamed into it, so a build is either there whole or not at all,
 * and two copies starting at the same moment both end up with the one unpacking.
 */
export function unpack(dashboards: string, manifest: Manifest, read: (key: string) => ArrayBuffer | Uint8Array): string {
  const dir = unpackedDir(dashboards, manifest);
  if (existsSync(dir)) return dir;
  mkdirSync(dashboards, { recursive: true });
  const staged = mkdtempSync(`${dir}.`);
  try {
    for (const file of manifest.files) {
      const parts = file.split('/');
      if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error(`refusing to unpack ${file}`);
      const target = join(staged, 'package', ...parts);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Uint8Array(read(file)));
    }
    writeFileSync(join(staged, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    try {
      renameSync(staged, dir);
    } catch (error) {
      // Another copy got there first, or something is wrong with the place itself.
      if (!existsSync(dir)) throw error;
      rmSync(staged, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function start(): void {
  const manifest = JSON.parse(getAsset('manifest.json', 'utf8')) as Manifest;
  const dashboards = dashboardsDir(process.platform, process.env, homedir());
  let dir: string;
  try {
    dir = unpack(dashboards, manifest, (key) => getAsset(key));
  } catch (error) {
    console.error(`daily-focus: couldn't unpack the dashboard into ${dashboards}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const cli = join(dir, 'package', 'dist', 'cli.js');
  // As `node dist/cli.js …` would have it: the CLI reads its arguments from the third on.
  process.argv[1] = cli;
  import(pathToFileURL(cli).href).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

if (isSea()) start();
