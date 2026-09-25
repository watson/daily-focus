/**
 * How the client is built: `client/main.ts` and everything it imports, Preact
 * included, into the one file `public/index.html` loads. Shared by the one-shot
 * build and the dev watcher so the two can't drift.
 */

import { fileURLToPath } from 'node:url';

import type { BuildOptions } from 'esbuild';

const root = new URL('../', import.meta.url);

export const bundleOptions: BuildOptions = {
  entryPoints: [fileURLToPath(new URL('client/main.ts', root))],
  outfile: fileURLToPath(new URL('public/app.js', root)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  // A map rather than readable output: the bundle is what the browser runs and
  // what its stack traces name, and the map points them back at `client/`.
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
};
