/**
 * Loaded before every test file (`npm test` passes it with `--import`): a home
 * folder of the run's own (HOME, and USERPROFILE for Windows), and none of the
 * shell's `DAILY_FOCUS_*` variables, so
 * nothing a test starts can fall back to the real `~/.daily-focus` when it isn't
 * handed a store of its own. A dashboard, the CLI or a script started without
 * one would otherwise open the store a real dashboard is running on, link it to
 * this checkout and, since the profile folders, move it.
 *
 * A child process inherits both. Run one file on its own the same way:
 *
 *   node --test --import ./test/sandbox.ts test/cli.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'daily-focus-test-home-'));
process.env.HOME = home;
// Where Windows takes the home folder from: `os.homedir()` there ignores HOME.
process.env.USERPROFILE = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DAILY_FOCUS_')) delete process.env[key];
}
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
