/**
 * Build the npm package's JavaScript: `npm run package`, and `npm pack` and
 * `npm publish` through `prepack`.
 *
 * A checkout runs the TypeScript in `src/` directly, which Node does for files
 * it finds in a project but refuses for anything under `node_modules`: a package
 * has to ship JavaScript. So the CLI and everything it reaches are bundled into
 * `dist/`. Split rather than one file, because the subcommands are scripts that
 * do their work as they load, and only a separate chunk can be loaded on demand.
 *
 * Every chunk lands directly in `dist/`, one level below the package root, as
 * every file in `src/` and `scripts/` is below the checkout. That keeps each
 * module's `import.meta.dirname` pointing at the same `../prompts`,
 * `../schema` and `../public` either way.
 */

import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { build } from 'esbuild';

import { bundleOptions } from './bundle.ts';
import { licensesText, packageCredits } from './licenses.ts';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist');

await rm(outdir, { recursive: true, force: true });
const server = await build({
  entryPoints: { cli: resolve(root, 'src/cli.ts') },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  chunkNames: '[name]-[hash]',
  // The server has no runtime dependencies; the page's are in its own bundle.
  packages: 'bundle',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  // Google's client secret for the calendar sign-in, kept out of git as its
  // policy asks; see `src/oauthclients.ts`. Without it, Google isn't offered.
  define: { __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_CLIENT_SECRET ?? '') },
});

// What the page's bundle reads, asked again of esbuild without writing it: the
// build that writes it has run already, and its account is what is wanted here.
const client = await build({ ...bundleOptions, write: false, metafile: true, logLevel: 'warning' });
// The licences of every npm package either bundle read, and of the fonts. See `licenses.ts`.
await writeFile(resolve(outdir, 'third-party-licenses.txt'), licensesText(await packageCredits([server.metafile, client.metafile], root)));
console.log(`built ${outdir}`);
