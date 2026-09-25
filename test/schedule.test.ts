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
import { localDateKey } from '../src/time.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-schedule-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, ...env });
}

/**
 * Fake `days` worth of history: an archived brief on every one of `on` in the
 * `days` before `now`, skipping any date the caller wants missing.
 */
async function seedArchive(
  config: Config,
  now: Date,
  { on, days = 28, skip = [] }: { on: number[]; days?: number; skip?: string[] },
): Promise<void> {
  await mkdir(config.archiveDir, { recursive: true });
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < days; i++) {
    cursor.setDate(cursor.getDate() - 1);
    const date = localDateKey(cursor);
    if (!on.includes(cursor.getDay()) || skip.includes(date)) continue;
    await writeFile(resolve(config.archiveDir, `items-${date}.json`), '{"version":1,"items":[]}');
  }
}

// Monday 14 September 2026, 08:00 local.
const MONDAY = new Date(2026, 8, 14, 8, 0);

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

test('the configured schedule wins over anything observed', async () => {
  const config = await makeConfig({ DAILY_FOCUS_AGENT_DAYS: '0-4' });
  await seedArchive(config, MONDAY, { on: [1, 2, 3, 4, 5] });

  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'config');
  assert.deepEqual(schedule.days, [0, 1, 2, 3, 4]);
});

test('a Sun–Thu week is read off the archive without being told', async () => {
  const config = await makeConfig();
  await seedArchive(config, MONDAY, { on: [0, 1, 2, 3, 4] });

  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'observed');
  assert.deepEqual(schedule.days, [0, 1, 2, 3, 4]);
});

test('so is a Mon–Fri week', async () => {
  const config = await makeConfig();
  await seedArchive(config, MONDAY, { on: [1, 2, 3, 4, 5] });

  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'observed');
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
});

test('one brief run by hand on a Saturday does not become a schedule', async () => {
  const config = await makeConfig();
  await seedArchive(config, MONDAY, { on: [1, 2, 3, 4, 5] });
  await writeFile(resolve(config.archiveDir, 'items-2026-09-05.json'), '{"version":1,"items":[]}');

  const schedule = await resolveSchedule(config, MONDAY);
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
});

test('a week away does not make those weekdays look unscheduled', async () => {
  const config = await makeConfig();
  await seedArchive(config, MONDAY, {
    on: [1, 2, 3, 4, 5],
    skip: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  });

  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'observed');
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
});

test('too little history falls back to the default rather than inventing one', async () => {
  const config = await makeConfig();
  await seedArchive(config, MONDAY, { on: [0, 1, 2, 3, 4], days: 7 });

  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'default');
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
});

test('an empty store falls back too', async () => {
  const config = await makeConfig();
  const schedule = await resolveSchedule(config, MONDAY);
  assert.equal(schedule.source, 'default');
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
});

/* ---------- the dashboard's own clock ---------- */

function local(date: string, hour: number, minute = 0): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour, minute);
}

const WEEKDAYS: Schedule = { days: MONDAY_TO_FRIDAY, source: 'config' };
const AT = { hour: 6, minute: 30 };
const wednesday = '2026-09-23';

test('a run is due from the time on a scheduled day until something has produced the day\'s brief', () => {
  const base = { at: AT, schedule: WEEKDAYS, lastRunStartedAt: null, briefGeneratedAt: null };
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 6, 29) }), false);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 6, 30) }), true);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 23, 59) }), true, 'late is still due');
  assert.equal(scheduledRunDue({ ...base, now: local('2026-09-26', 9, 0) }), false, 'not on a Saturday');
  // Whatever made today's brief — this dashboard's run, by clock or by hand, or
  // something else writing the file — is today's run.
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), lastRunStartedAt: local(wednesday, 5, 0).toISOString() }), false);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), briefGeneratedAt: local(wednesday, 6, 45).toISOString() }), false);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), lastRunStartedAt: local('2026-09-22', 9, 0).toISOString() }), true);
  assert.equal(scheduledRunDue({ ...base, now: local(wednesday, 9, 0), briefGeneratedAt: 'garbage' }), true);
});

test('the next run is today\'s if it has not come yet, else the next scheduled morning', () => {
  const base = { at: AT, schedule: WEEKDAYS, lastRunStartedAt: null, briefGeneratedAt: null };
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

test('with a clock of its own the dashboard never infers the schedule from the archive', async () => {
  const now = local(wednesday, 9, 0);
  const config = await makeConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: '06:30' });
  await seedArchive(config, now, { on: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(await resolveSchedule(config, now), { days: MONDAY_TO_FRIDAY, source: 'default' });
  const told = await makeConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: '06:30', DAILY_FOCUS_AGENT_DAYS: '0-4' });
  assert.deepEqual((await resolveSchedule(told, now)).days, [0, 1, 2, 3, 4]);
});
