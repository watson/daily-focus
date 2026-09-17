import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CalendarBoard, readCalendarFile, type CalendarDeps } from '../src/calendarboard.ts';
import { CalendarHelperError, type CalendarFacts } from '../src/calendar.ts';
import { loadConfig, type Config } from '../src/config.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-cal-'));
  dirs.push(dataDir);
  return loadConfig({
    DAILY_FOCUS_DATA: dataDir,
    DAILY_FOCUS_CALENDARS: 'Work',
    DAILY_FOCUS_CALENDAR_ADDRESSES: 'me@example.com',
    ...env,
  });
}

function facts(events: CalendarFacts['events'] = [], title = 'Work'): CalendarFacts {
  return {
    generatedAt: '2026-09-17T08:00:00+02:00',
    calendars: [{ id: 'cal-1', title, source: 'Work' }],
    events,
  };
}

const event = { externalId: 'a', calendarId: 'cal-1', title: 'standup', start: '2026-09-17T09:00:00+02:00' };

function deps(impl: CalendarDeps['run']): CalendarDeps {
  return { run: impl };
}

test('does nothing at all until a calendar is named', async () => {
  const board = new CalendarBoard(await config({ DAILY_FOCUS_CALENDARS: '' }), () => {}, deps(async () => facts()));

  assert.equal(board.enabled, false);
  await board.start();
  const state = board.state();
  assert.equal(state.live, false);
  assert.equal(state.problem, null, 'an unconfigured feature is not a broken one');
});

test('a successful read is live, and is written to the cache for next time', async () => {
  const cfg = await config();
  const board = new CalendarBoard(cfg, () => {}, deps(async () => facts([event])));
  await board.start();

  const state = board.state();
  assert.equal(state.live, true);
  assert.deepEqual(state.events.map((e) => e.title), ['standup']);
  assert.equal(state.problem, null);

  const cached = await readCalendarFile(cfg.calendarFile);
  assert.deepEqual(cached?.events.length, 1);
});

test('a day with no meetings is live and empty, not a failure', async () => {
  const board = new CalendarBoard(await config(), () => {}, deps(async () => facts([])));
  await board.start();

  const state = board.state();
  assert.equal(state.live, true, 'an empty day must not fall back to the brief');
  assert.deepEqual(state.events, []);
  assert.equal(state.problem, null);
});

test('every configured name missing is a broken setup, not a free day', async () => {
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => facts([event], 'Some Other Calendar')),
  );
  await board.start();

  const state = board.state();
  assert.equal(state.live, false, 'falls back rather than showing a blank agenda');
  assert.match(state.problem ?? '', /None of the configured calendars/);
  assert.ok(
    state.warnings.some((w) => /No calendar named "work"/.test(w)),
    `expected a name warning, got ${JSON.stringify(state.warnings)}`,
  );
});

test('a failed read keeps the previous answer and says so', async () => {
  let attempt = 0;
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => {
      attempt++;
      if (attempt === 1) return facts([event]);
      throw new CalendarHelperError('the helper wrote nothing');
    }),
  );

  await board.start();
  assert.equal(board.state().live, true);

  await board.refresh();
  const state = board.state();
  assert.equal(state.live, true, 'the last good read still stands');
  assert.deepEqual(state.events.map((e) => e.title), ['standup']);
  assert.match(state.problem ?? '', /Showing the last good read/);
});

test('a first read that fails falls back to the brief and explains', async () => {
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => {
      throw new CalendarHelperError('is the helper built?');
    }),
  );
  await board.start();

  const state = board.state();
  assert.equal(state.live, false);
  assert.match(state.problem ?? '', /events from this morning's brief/);
});

test('warns when no addresses are configured, since declines then still block', async () => {
  const board = new CalendarBoard(
    await config({ DAILY_FOCUS_CALENDAR_ADDRESSES: '' }),
    () => {},
    deps(async () => facts([event])),
  );
  await board.start();

  assert.ok(
    board.state().warnings.some((w) => /declined/.test(w)),
    'a silently-ignored decline is the whole bug this feature exists for',
  );
});

test('notifies on every read so open tabs see the change', async () => {
  let changes = 0;
  const board = new CalendarBoard(await config(), () => { changes++; }, deps(async () => facts([event])));

  await board.start();
  await board.refresh();
  assert.equal(changes, 2);
});
