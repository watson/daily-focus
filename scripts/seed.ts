/**
 * Write a realistic sample items.json so the dashboard has something to show.
 *
 *   npm run seed
 *
 * Everything is dated relative to now, so the agenda and the "now" marker always
 * look sensible whenever you run it. This is also the best worked example of the
 * payload shape. See schema/items.schema.json and prompts/morning-brief-work.md for the rules.
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
import { Store } from '../src/store.ts';
import type { Brief } from '../src/types.ts';
import { localDateKey } from '../src/time.ts';

const now = new Date();

/** Today at a given local time, as an ISO string. */
function at(hour: number, minute = 0): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
}

function daysFromNow(days: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return localDateKey(d);
}

const brief: Brief = {
  version: 1,
  generatedAt: at(6, 30),
  generatedBy: 'morning-brief-agent (sample)',
  date: localDateKey(now),
  headline:
    'Two things are genuinely time-boxed today: the **Workday compliance training** deadline and the review `webapp#3421` is blocked on. The 13:00–15:00 gap is your only real focus block.',
  items: [
    {
      id: 'workday:task:compliance-training-2026',
      source: 'workday',
      kind: 'task',
      title: 'Complete annual security & compliance training',
      detail:
        'Workday has sent three reminders. Due end of day — after that it escalates to your manager.',
      url: 'https://wd5.myworkday.com/acme/d/task/compliance-2026',
      priority: 1,
      due: daysFromNow(0),
      firstSeen: daysFromNow(-6),
      tags: ['deadline'],
    },
    {
      id: 'github:pr:acme/webapp#3421',
      source: 'github',
      kind: 'task',
      title: 'Review requested: Fix session replay memory leak on long-lived tabs',
      detail: 'Requested you directly 2 days ago. 4 files, +180/−62. No other reviewer has looked yet.',
      url: 'https://github.com/acme/webapp/pull/3421',
      priority: 2,
      firstSeen: daysFromNow(-2),
      people: ['@alice'],
      tags: ['review-requested'],
    },
    {
      id: 'gtasks:task:MTU3NDkyODkwMjE2NDcx',
      source: 'tasks',
      kind: 'task',
      title: 'Write up the staging repro steps for the checkout breakage',
      detail: 'Your own note, and the only item here nobody else will ever chase.',
      due: daysFromNow(1),
      firstSeen: daysFromNow(-4),
      advancesObjective: true,
    },
    {
      id: 'email:thread:18f2a9c4b7',
      source: 'email',
      kind: 'task',
      title: 'Re: Q4 headcount plan — Bob is waiting on your input',
      detail:
        'They asked for the team split on Monday and followed up yesterday. Nothing sent back yet.',
      url: 'https://mail.google.com/mail/u/0/#inbox/18f2a9c4b7',
      priority: 3,
      firstSeen: daysFromNow(-3),
      people: ['bob@example.com'],
    },
    {
      id: 'github:pr:acme/webapp#3402',
      source: 'github',
      kind: 'task',
      title: 'CI failing on your PR: Add trace context to fetch instrumentation',
      detail:
        '`unit-tests (node-20)` is red. The failure is in `tracing/fetch.spec.ts`, which your diff touches — likely yours, not flaky infra.',
      url: 'https://github.com/acme/webapp/pull/3402',
      firstSeen: daysFromNow(-1),
      tags: ['ci-failing'],
    },
    {
      id: 'github:pr:acme/webapp#3395',
      source: 'github',
      kind: 'task',
      title: 'Open 3 days with no review: Bump chrome-launcher to 1.2.0',
      url: 'https://github.com/acme/webapp/pull/3395',
      firstSeen: daysFromNow(-3),
      tags: ['awaiting-review'],
    },
    {
      id: 'github:pr:acme/webapp#3430',
      source: 'github',
      kind: 'task',
      title: 'Draft PR is green — ready to mark for review?',
      detail: 'You opened this last night as a draft. All checks passed 40 minutes ago.',
      url: 'https://github.com/acme/webapp/pull/3430',
      firstSeen: daysFromNow(0),
      tags: ['draft', 'ci-green'],
    },
    {
      id: 'jira:PROJ-8842',
      source: 'jira',
      kind: 'task',
      title: 'PROJ-8842 still open — all 2 linked PRs are merged',
      detail: 'Assigned to you. Both PRs merged last week; the ticket never moved to Done.',
      url: 'https://acme.atlassian.net/browse/PROJ-8842',
      firstSeen: daysFromNow(-5),
    },
    {
      id: 'slack:msg:C04ABCDE/1757480412.118',
      source: 'slack',
      kind: 'task',
      title: '#webapp-dev: Chris asked whether v6 can drop IE11 shims',
      detail: 'Direct question to you, 19 hours ago, still unanswered in-thread.',
      url: 'https://acme.slack.com/archives/C04ABCDE/p1757480412118',
      firstSeen: daysFromNow(-1),
      people: ['@chris'],
    },
    {
      id: 'email:thread:18f30bb211',
      source: 'email',
      kind: 'task',
      title: 'Travel: approve your Dublin flight option before 17:00',
      detail: 'The held fare expires this evening. Two options attached.',
      url: 'https://mail.google.com/mail/u/0/#inbox/18f30bb211',
      due: daysFromNow(0),
      firstSeen: daysFromNow(0),
      tags: ['travel'],
    },
    {
      id: 'calendar:event:standup',
      source: 'calendar',
      kind: 'event',
      title: 'Webapp standup',
      start: at(9, 30),
      end: at(9, 45),
      url: 'https://meet.google.com/abc-defg-hij',
    },
    {
      id: 'calendar:event:1on1',
      source: 'calendar',
      kind: 'event',
      title: '1:1 with Alice',
      start: at(11, 0),
      end: at(11, 30),
    },
    {
      id: 'calendar:event:design-review',
      source: 'calendar',
      kind: 'event',
      title: 'Design review: search indexing v3',
      start: at(11, 15),
      end: at(12, 0),
    },
    {
      id: 'calendar:event:sync',
      source: 'calendar',
      kind: 'event',
      title: 'Platform ↔ Infra sync',
      start: at(15, 0),
      end: at(16, 0),
    },
    {
      id: 'calendar:holiday:us-labor-day',
      source: 'calendar',
      kind: 'info',
      title: 'US public holiday today — most American colleagues are off',
      detail: 'Expect slow replies from colleagues there.',
      firstSeen: daysFromNow(0),
    },
    {
      id: 'calendar:holiday:local-national-day',
      source: 'calendar',
      kind: 'info',
      title: `Local public holiday in 9 days (${daysFromNow(9)}) — office closed`,
      firstSeen: daysFromNow(0),
    },
  ],
};

const config = loadConfig();
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
      '    DAILY_FOCUS_DATA=$(mktemp -d) npm run seed',
      '',
      'To overwrite this file on purpose: npm run seed -- --force',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`${force ? 'Overwrote' : 'Wrote'} ${brief.items.length} sample items to ${config.itemsFile}`);
console.log('Run `npm start` and open the dashboard.');
