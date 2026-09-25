import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import {
  MONDAY_TO_FRIDAY,
  describeSchedule,
  describeTime,
  nextRunDate,
  nextScheduledRun,
  parseWeekdays,
  resolveSchedule,
  runsOn,
  scheduledRunDue,
  type Schedule,
} from '../src/schedule.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-schedule-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, ...env });
}

/* ---------- the spec ---------- */

test('reads a cron-style day-of-week spec', () => {
  assert.deepEqual(parseWeekdays('1-5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdays('0-4'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseWeekdays('0,6'), [0, 6]);
  assert.deepEqual(parseWeekdays(' 1 , 3 '), [1, 3]);
  assert.deepEqual(parseWeekdays('2,1-2,1'), [1, 2], 'dedupes and sorts');
});

test('rejects a spec rather than guessing at it', () => {
  assert.throws(() => parseWeekdays('7'), /0–6/);
  assert.throws(() => parseWeekdays('mon-fri'), /not a weekday/);
  assert.throws(() => parseWeekdays('6-0'), /backwards/);
  assert.throws(() => parseWeekdays(''), /no weekdays/);
});

test('the config knob names the variable when the spec is bad', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-schedule-'));
  dirs.push(dataDir);
  assert.throws(() => loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_AGENT_DAYS: 'weekdays' }), {
    message: /DAILY_FOCUS_AGENT_DAYS/,
  });
});

test('an unset knob is not the same as every day', async () => {
  const config = await makeConfig();
  assert.equal(config.agentDays, null);
});

/* ---------- describing and projecting ---------- */

test('describes a run of days as a range and a scatter as a list', () => {
  assert.equal(describeSchedule({ days: [1, 2, 3, 4, 5], source: 'config' }), 'Mon–Fri');
  assert.equal(describeSchedule({ days: [0, 1, 2, 3, 4], source: 'config' }), 'Sun–Thu');
  assert.equal(describeSchedule({ days: [0, 6], source: 'config' }), 'Sun, Sat');
});

test('the next run skips the days off', () => {
  const monFri: Schedule = { days: [1, 2, 3, 4, 5], source: 'config' };
  const sunThu: Schedule = { days: [0, 1, 2, 3, 4], source: 'config' };

  // Friday 11 Sep -> Monday 14th for a Mon–Fri week …
  assert.equal(nextRunDate(monFri, new Date(2026, 8, 11, 9, 0)), '2026-09-14');
  // … but Friday is itself a day off on a Sun–Thu week, so the next is Sunday 13th.
  assert.equal(nextRunDate(sunThu, new Date(2026, 8, 11, 9, 0)), '2026-09-13');
  assert.equal(runsOn(sunThu, new Date(2026, 8, 13, 9, 0)), true);
  assert.equal(runsOn(sunThu, new Date(2026, 8, 12, 9, 0)), false, 'Saturday is off either way');
});

/* ---------- resolving ---------- */

test('the schedule is the configured days, else Mon–Fri', async () => {
  const told = await makeConfig({ DAILY_FOCUS_AGENT_DAYS: '0-4' });
  assert.deepEqual(resolveSchedule(told), { days: [0, 1, 2, 3, 4], source: 'config' });

  const unset = await makeConfig();
  assert.deepEqual(resolveSchedule(unset), { days: MONDAY_TO_FRIDAY, source: 'default' });
  assert.deepEqual(resolveSchedule(await makeConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: 'off' })), {
    days: MONDAY_TO_FRIDAY,
    source: 'default',
  });
});

test('the days briefs have landed on are not a schedule', async () => {
  // Nothing but this dashboard writes the brief, so the archive can only show
  // its own runs — and a month of Saturday runs by hand must not make Saturdays
  // scheduled.
  const config = await makeConfig();
  await mkdir(config.archiveDir, { recursive: true });
  for (const date of ['2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12']) {
    await writeFile(resolve(config.archiveDir, `items-${date}.json`), '{"version":1,"items":[]}');
  }
  assert.deepEqual(resolveSchedule(config), { days: MONDAY_TO_FRIDAY, source: 'default' });
});

/* ---------- the dashboard's own clock ---------- */

function local(date: string, hour: number, minute = 0): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour, minute);
}

const WEEKDAYS: Schedule = { days: MONDAY_TO_FRIDAY, source: 'config' };
const AT = { hour: 6, minute: 30 };
const wednesday = '2026-09-23';

test('a run is due from the time on a scheduled day until one has started that day', () => {
  const base = { at: AT, schedule: WEEKDAYS, lastRunStartedAt: null };
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 6, 29) }), false);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 6, 30) }), true);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 23, 59) }), true, 'late is still due');
  assert.equal(scheduledRunDue({ ...base, now: local('2026-09-26', 9, 0) }), false, 'not on a Saturday');
  // A run started today, by clock or by hand, is today's run.
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), lastRunStartedAt: local(wednesday, 5, 0).toISOString() }), false);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), lastRunStartedAt: local('2026-09-22', 9, 0).toISOString() }), true);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), lastRunStartedAt: 'garbage' }), true);
});

test('the next run is today\'s if it has not come yet, else the next scheduled morning', () => {
  const base = { at: AT, schedule: WEEKDAYS, lastRunStartedAt: null };
  assert.deepEqual(nextScheduledRun({ ...base, now: local(wednesday, 6, 0) }), local(wednesday, 6, 30));
  assert.deepEqual(nextScheduledRun({ ...base, now: local(wednesday, 7, 0) }), local('2026-09-24', 6, 30));
  // A hand run before the hour stands in for today's.
  assert.deepEqual(
    nextScheduledRun({ ...base, now: local(wednesday, 6, 0), lastRunStartedAt: local(wednesday, 5, 0).toISOString() }),
    local('2026-09-24', 6, 30),
  );
  assert.deepEqual(nextScheduledRun({ ...base, now: local('2026-09-25', 7, 0) }), local('2026-09-28', 6, 30), 'over the weekend');
  assert.equal(nextScheduledRun({ ...base, schedule: { days: [], source: 'config' }, now: local(wednesday, 7, 0) }), null);
  assert.equal(describeTime(AT), '06:30');
});
