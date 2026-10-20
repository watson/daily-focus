import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CalendarBoard, type CalendarDeps } from '../src/calendarboard.ts';
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

function deps(impl: CalendarDeps['read'], ready: string | null = null): CalendarDeps {
  return { read: impl, ready: () => ready, where: 'Calendar.app' };
}

test('does nothing at all until a calendar is named', async () => {
  const board = new CalendarBoard(await config({ DAILY_FOCUS_CALENDARS: '' }), () => {}, deps(async () => facts()));

  assert.equal(board.enabled, false);
  await board.start();
  const state = board.state();
  assert.equal(state.live, false);
  assert.equal(state.problem, null, 'an unconfigured feature is not a broken one');
});

test('a successful read is live, and is kept in memory only', async () => {
  const cfg = await config();
  // What an older Daily Focus left in the store, which is the morning agent's folder.
  await writeFile(cfg.calendarFile, JSON.stringify(facts([event])));
  const board = new CalendarBoard(cfg, () => {}, deps(async () => facts([event])));
  await board.start();

  const state = board.state();
  assert.equal(state.live, true);
  assert.deepEqual(state.events.map((e) => e.title), ['standup']);
  assert.equal(state.problem, null);
  await assert.rejects(stat(cfg.calendarFile), 'nothing read from a calendar is left where Claude Code or Codex could read it');
});

test('with nothing to read from yet, it says why, and neither reads nor fails', async () => {
  let reads = 0;
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => {
      reads++;
      return facts([event]);
    }, 'No Google or Microsoft calendar is connected.'),
  );
  await board.start();

  const state = board.state();
  assert.equal(reads, 0);
  assert.equal(state.live, false);
  assert.equal(state.failure, null);
  assert.equal(state.problem, 'No Google or Microsoft calendar is connected.');
});

test('an account that failed while others read stays live, and says which', async () => {
  const board = new CalendarBoard(
    await config({ DAILY_FOCUS_CALENDAR_ADDRESSES: '' }),
    () => {},
    deps(async () => ({ ...facts([event]), selfKnown: true, problems: ['Google (alex@example.com) needs connecting again.'] })),
  );
  await board.start();

  const state = board.state();
  assert.equal(state.live, true);
  assert.deepEqual(state.events.map((e) => e.title), ['standup']);
  assert.match(state.failure?.message ?? '', /alex@example\.com/);
  assert.ok(
    !state.warnings.some((w) => /declined/.test(w)),
    'connected accounts say which reply is the user’s, so no addresses are needed',
  );
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
  assert.match(state.failure?.message ?? '', /Showing the last good read/);
  assert.equal(state.problem, null, 'the failure says it; nothing else needs to');
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
  assert.match(state.failure?.message ?? '', /events from this morning's brief/);
  assert.equal(state.problem, null, 'not "has not been read yet": it has, and it failed');
});

test('a helper that would not launch keeps what macOS said behind the line', async () => {
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => {
      throw new CalendarHelperError("macOS couldn't launch the calendar helper at /x/dfcal.app", 'Command failed: /usr/bin/open -n -a /x/dfcal.app\nLSOpenURLsWithRole() failed with error -10810');
    }),
  );
  await board.start();

  const failure = board.state().failure;
  assert.equal(failure?.message, "macOS couldn't launch the calendar helper at /x/dfcal.app. Showing the events from this morning's brief instead.");
  assert.match(failure?.detail ?? '', /error -10810/);
  assert.equal(failure?.attempts, 1);
});

test('a read in flight says the failure is being retried', async () => {
  let release: (() => void) | null = null;
  let attempt = 0;
  const board = new CalendarBoard(
    await config(),
    () => {},
    deps(async () => {
      if (++attempt > 1) await new Promise<void>((resolve) => (release = resolve));
      throw new CalendarHelperError('the helper wrote nothing');
    }),
  );
  await board.start();
  assert.equal(board.state().failure?.retrying, false);

  const read = board.refresh();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(board.state().failure?.retrying, true);
  (release as () => void)();
  await read;
  assert.equal(board.state().failure?.attempts, 2);
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
  assert.equal(changes, 4, 'as each read starts, so a retry shows, and as it lands');
});
