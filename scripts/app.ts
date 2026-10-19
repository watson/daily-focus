/**
 * `npm run app`: build the menu bar app with this checkout's dashboard inside it.
 *
 *   npm run app
 *   npm run app -- --test
 *
 * The dashboard inside the app is exactly what `npm publish` would ship: this
 * packs it, unpacks the tarball, and hands that to `macos/build.sh`, so the app
 * can never carry a file the package doesn't, or miss one it does. Any arguments
 * go to the build script. See `macos/build.sh` for signing and notarisation.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

if (process.platform !== 'darwin') {
  console.error('the menu bar app is macOS-only');
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), 'daily-focus-app-'));
try {
  // prepack builds the page and the bundle, as it does for a publish.
  await run('npm', ['pack', '--pack-destination', work], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const tarball = (await readdir(work)).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack wrote no tarball');
  await run('tar', ['-xzf', join(work, tarball), '-C', work]);
  // `package/` is the directory npm unpacks into, so it is the package as installed.
  const build = execFile('/bin/sh', [join(root, 'macos', 'build.sh'), '--server', join(work, 'package'), ...process.argv.slice(2)], {
    cwd: root,
  });
  build.stdout?.pipe(process.stdout);
  build.stderr?.pipe(process.stderr);
  const code = await new Promise<number | null>((done) => build.on('exit', done));
  process.exitCode = code ?? 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
