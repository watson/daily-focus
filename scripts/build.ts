/** Build the client once. `npm start` runs this first; `npm run dev` watches instead. */

import { build } from 'esbuild';

import { bundleOptions } from './bundle.ts';

await build(bundleOptions);
