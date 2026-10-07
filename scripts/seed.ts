/**
 * Write a realistic sample items.json so the dashboard has something to show.
 *
 *   npm run seed
 *
 * The brief itself is `src/sample.ts`, which the CLI's demo shows too, and it
 * follows the store's profile: a personal store gets the personal brief.
 *
 * **It refuses to replace an existing `items.json`.** Against a live store that
 * would destroy a real brief, and since the agent recovers each item's `firstSeen`
 * from the previous file, the ageing on every item would then restart from these
 * sample dates. Point `DAILY_FOCUS_DATA` at a throwaway directory instead:
 *
 *   DAILY_FOCUS_DATA=$(mktemp -d) npm run seed
 *
 * The refusal names the full path so a real store can't be mistaken for a temporary
 * one. There is no prompt, because agents and CI would hang on it; to overwrite on
 * purpose, pass `--force`:
 *
 *   npm run seed -- --force
 */

import { writeFile } from 'node:fs/promises';

import { loadConfig } from '../src/config.ts';
import { command } from '../src/install.ts';
import { sampleBrief } from '../src/sample.ts';
import { Store } from '../src/store.ts';

const config = loadConfig();
const brief = sampleBrief(new Date(), config.profile);
const force = process.argv.slice(2).includes('--force');
const store = new Store(config);
await store.ensureDataDir();

const isDefaultStore = !process.env.DAILY_FOCUS_DATA?.trim();
console.log(`Seeding store: ${config.dataDir}${isDefaultStore ? ' (the default store — DAILY_FOCUS_DATA is not set)' : ''}`);

// `wx` makes the existence check and the write one operation, like init.ts, so
// there's no window in which a brief written by the agent could be clobbered.
try {
  await writeFile(config.itemsFile, `${JSON.stringify(brief, null, 2)}\n`, {
    encoding: 'utf8',
    flag: force ? 'w' : 'wx',
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  console.error(
    [
      '',
      `\x1b[31m✗ Refusing to overwrite an existing brief:\x1b[0m`,
      '',
      `    ${config.itemsFile}`,
      '',
      'If this is your real store, replacing it destroys the brief and restarts the',
      'ageing on every item. For sample data, use a throwaway store:',
      '',
      `    DAILY_FOCUS_DATA=$(mktemp -d) ${command('seed')}`,
      '',
      `To overwrite this file on purpose: ${command('seed', '--force')}`,
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`${force ? 'Overwrote' : 'Wrote'} ${brief.items.length} sample items to ${config.itemsFile}`);
console.log('Start the dashboard and open it.');
