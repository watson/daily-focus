/**
 * The development loop: rebuild the client as it is edited, and restart the
 * server as it is.
 *
 * One process rather than two `&`-joined commands, because a background job in
 * a non-interactive shell ignores Ctrl-C: the watcher would outlive the terminal
 * and a second `npm run dev` would start a second one. Here the server is a child
 * of this process and the watcher lives in it, so they stop together.
 *
 * An edit to the client lands in `public/app.js`, which the server watches; it
 * bumps the asset version and every open tab reloads itself. An edit to the
 * server restarts it under `node --watch`, and the tab's EventSource reconnects.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { context } from 'esbuild';

import { bundleOptions } from './bundle.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

const watcher = await context(bundleOptions);
await watcher.watch();

const server = spawn(process.execPath, ['--watch', 'src/server.ts'], { cwd: root, stdio: 'inherit' });

server.on('exit', (code, signal) => {
  void watcher.dispose().then(() => process.exit(code ?? (signal ? 1 : 0)));
});

// The terminal sends Ctrl-C to the server too; this only covers a kill aimed at
// this process alone, so the server doesn't get left behind.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
