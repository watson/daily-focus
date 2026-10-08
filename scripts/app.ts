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
import { join, resolve } from 'node:path';

import { packServer } from './pack.ts';

const root = resolve(import.meta.dirname, '..');

if (process.platform !== 'darwin') {
  console.error('the menu bar app is macOS-only');
  process.exit(1);
}

const packed = await packServer();
try {
  const build = execFile('/bin/sh', [join(root, 'macos', 'build.sh'), '--server', packed.dir, ...process.argv.slice(2)], {
    cwd: root,
  });
  build.stdout?.pipe(process.stdout);
  build.stderr?.pipe(process.stderr);
  const code = await new Promise<number | null>((done) => build.on('exit', done));
  process.exitCode = code ?? 1;
} finally {
  await packed.done();
}
