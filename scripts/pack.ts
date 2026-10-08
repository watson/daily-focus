/**
 * The package as npm would install it, for the builds that carry one: `npm pack`
 * into a temporary directory, and the tarball unpacked there. The Mac app and the
 * Linux and Windows executables are built around that copy, so neither can carry
 * a file the package doesn't, or miss one it does. `prepack` builds the page and
 * the bundle on the way, as it does for a publish.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

/** A packed, unpacked copy of this checkout's package: `dir` is its root, and `done` removes it. */
export async function packServer(): Promise<{ dir: string; done: () => Promise<void> }> {
  const work = await mkdtemp(join(tmpdir(), 'daily-focus-pack-'));
  try {
    await run('npm', ['pack', '--pack-destination', work], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const tarball = (await readdir(work)).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack wrote no tarball');
    await run('tar', ['-xzf', join(work, tarball), '-C', work]);
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
  // `package/` is the directory npm unpacks into, so it is the package as installed.
  return { dir: join(work, 'package'), done: () => rm(work, { recursive: true, force: true }) };
}
