import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  readSessionState,
  readSessions,
  reconcileSession,
  startSession,
  stopSession,
} from '../src/sessions.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Agenda } from '../src/types.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeConfig(): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-sessions-'));
  dirs.push(dataDir);
  return { ...loadConfig({ DAILY_FOCUS_DATA: dataDir }), port: 0 };
}

const NOW = new Date(2026, 8, 10, 10, 0, 0);
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const emptyAgenda: Agenda = {
  events: [],
  conflictIds: [],
  tracksFreeTime: true,
  freeWindows: [],
  remainingFocusMinutes: 0,
  dayStart: '09:00',
  dayEnd: '17:00',
};

function agendaWithEventAt(minutesFromNow: number): Agenda {
  const start = later(minutesFromNow).toISOString();
  return {
    ...emptyAgenda,
    events: [
      {
        id: 'calendar:next',
        source: 'calendar',
        kind: 'event',
        title: 'Standup',
        start,
        status: 'open',
        notes: [],
        ageDays: 0,
      },
    ],
  };
}

const start = (config: Config, id = 'jira:PROJ-1', minutes = 25, now = NOW) =>
  startSession(config, { id, title: `title for ${id}`, minutes, advancesObjective: true, now });

/* ---------- running ---------- */

test('nothing is running to begin with', async () => {
  const state = await readSessionState(await makeConfig(), emptyAgenda, NOW);
  assert.equal(state.active, null);
  assert.equal(state.completedToday, 0);
});

test('a started session counts down', async () => {
  const config = await makeConfig();
  await start(config);

  const state = await readSessionState(config, emptyAgenda, later(10));
  assert.equal(state.active?.id, 'jira:PROJ-1');
  assert.equal(state.active?.remainingSeconds, 900);
  assert.equal(state.active?.overrun, false);
});

test('past its target it keeps counting rather than stopping', async () => {
  const config = await makeConfig();
  await start(config);

  const state = await readSessionState(config, emptyAgenda, later(30));
  assert.equal(state.active?.overrun, true);
  assert.equal(state.active?.remainingSeconds, -300);
});

test('only one session runs at a time; starting another logs the first', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1');
  await startSession(config, {
    id: 'jira:PROJ-2',
    title: 'second',
    minutes: 25,
    advancesObjective: false,
    now: later(10),
  });

  const state = await readSessionState(config, emptyAgenda, later(11));
  assert.equal(state.active?.id, 'jira:PROJ-2');

  const logged = await readSessions(config);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.id, 'jira:PROJ-1');
  assert.equal(logged[0]?.actualMinutes, 10);
});

/* ---------- logging ---------- */

test('stopping records actual time, not planned time', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);
  await stopSession(config, later(18));

  const [entry] = await readSessions(config);
  assert.equal(entry?.plannedMinutes, 25);
  assert.equal(entry?.actualMinutes, 18);
  assert.equal(entry?.reachedTarget, false);
  assert.equal(entry?.advancesObjective, true);
});

test('running past the target still counts as reaching it', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);
  await stopSession(config, later(31));

  const [entry] = await readSessions(config);
  assert.equal(entry?.reachedTarget, true);
  assert.equal(entry?.actualMinutes, 31);
});

test('a misclick is not worth a line in the record', async () => {
  const config = await makeConfig();
  await start(config);
  await stopSession(config, later(0.2));

  assert.deepEqual(await readSessions(config), []);
});

test('stopping nothing is harmless', async () => {
  assert.equal(await stopSession(await makeConfig(), NOW), null);
});

test("today's tally counts sessions and minutes", async () => {
  const config = await makeConfig();
  await start(config, 'a', 25);
  await stopSession(config, later(25));
  await startSession(config, { id: 'b', title: 'b', minutes: 25, advancesObjective: false, now: later(30) });
  await stopSession(config, later(50));

  const state = await readSessionState(config, emptyAgenda, later(51));
  assert.equal(state.completedToday, 2);
  assert.equal(state.minutesToday, 45);
});

test('yesterday does not count towards today', async () => {
  const config = await makeConfig();
  const yesterday = new Date(NOW.getTime() - 86_400_000);
  await start(config, 'a', 25, yesterday);
  await stopSession(config, new Date(yesterday.getTime() + 25 * 60_000));

  const state = await readSessionState(config, emptyAgenda, NOW);
  assert.equal(state.completedToday, 0);
  assert.equal((await readSessions(config)).length, 1);
});

/* ---------- the things a kitchen timer can't do ---------- */

test('warns when the session would run into the next meeting', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);

  const colliding = await readSessionState(config, agendaWithEventAt(10), NOW);
  assert.equal(colliding.active?.collidesWithNextEvent, true);

  const clear = await readSessionState(config, agendaWithEventAt(90), NOW);
  assert.equal(clear.active?.collidesWithNextEvent, false);
});

test('a session left running is closed out rather than logging a fictional marathon', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);

  // Forgotten overnight.
  const state = await readSessionState(config, emptyAgenda, later(60 * 10));
  assert.equal(state.active, null);

  const [entry] = await readSessions(config);
  assert.equal(entry?.actualMinutes, 120, 'capped rather than ten hours');
});

/* ---------- walking away ---------- */

/**
 * Poll the way the server does, minute by minute, because a single call proves
 * nothing here: the checkpoint only means something if it has been kept up to date.
 * `idleAt` answers as the machine would at each minute — seconds since the last
 * keypress, or null for a machine that can't say.
 */
async function pollThrough(
  config: Config,
  throughMinutes: number,
  idleAt: (minute: number) => number | null,
) {
  let closed = null;
  for (let minute = 1; minute <= throughMinutes; minute++) {
    const probe = () => Promise.resolve(idleAt(minute));
    closed = (await reconcileSession(config, probe, later(minute))) ?? closed;
  }
  return closed;
}

/** Worked until `until`, then left the desk. */
const leftAfter = (until: number) => (minute: number) =>
  minute <= until ? 5 : (minute - until) * 60;

test('being at the machine keeps the session running', async () => {
  const config = await makeConfig();
  await start(config);

  assert.equal(await pollThrough(config, 45, () => 5), null);
  assert.equal((await readSessionState(config, emptyAgenda, later(45))).active?.id, 'jira:PROJ-1');
});

test('leaving ends the session where you stopped, not where it was noticed', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);

  // Worked for 40 minutes, then left for an hour with the timer running.
  const closed = await pollThrough(config, 100, leftAfter(40));

  assert.equal(closed?.endedBy, 'away');
  assert.equal(closed?.actualMinutes, 40, 'the hour away is not in the record');
  // Recorded to the minute they actually stopped: as the reported idle time grows,
  // the moment it points back to stays put.
  assert.equal(closed?.endedAt, later(40).toISOString());
  assert.equal((await readSessionState(config, emptyAgenda, later(100))).active, null);
});

test('a still ten minutes of reading is not a walk-out', async () => {
  const config = await makeConfig();
  await start(config);

  // Away from the keyboard between minute 30 and minute 38, then typing again.
  const closed = await pollThrough(config, 60, (minute) =>
    minute <= 30 || minute > 38 ? 5 : (minute - 30) * 60,
  );

  assert.equal(closed, null);
  assert.equal((await readSessionState(config, emptyAgenda, later(60))).active?.id, 'jira:PROJ-1');
});

test('waking the laptop cannot vouch for the hour it spent asleep', async () => {
  const config = await makeConfig();
  await start(config);

  // Twenty minutes of work, then the lid shut — so nothing polls at all.
  await pollThrough(config, 20, () => 5);
  // An hour later they open it and touch the trackpad: idle time reads as nothing.
  const closed = await reconcileSession(config, () => Promise.resolve(2), later(90));

  assert.equal(closed?.endedBy, 'away');
  assert.equal(closed?.actualMinutes, 20, 'ends at the checkpoint, not at the keypress');
});

test('starting something and walking straight out leaves no trace', async () => {
  const config = await makeConfig();
  await start(config);

  const closed = await reconcileSession(config, () => Promise.resolve(11 * 60), later(11));

  assert.equal(closed, null);
  assert.deepEqual(await readSessions(config), [], 'nothing worth recording happened');
  assert.equal((await readSessionState(config, emptyAgenda, later(11))).active, null);
});

test('a machine that cannot report idle time keeps the old backstop', async () => {
  const config = await makeConfig();
  await start(config);

  // Nothing can prove they left, so nothing closes it early...
  assert.equal(await pollThrough(config, 115, () => null), null);
  // ...and the two-hour ceiling is what catches it, saying so in the record.
  const state = await readSessionState(config, emptyAgenda, later(150));
  assert.equal(state.active, null);

  const [entry] = await readSessions(config);
  assert.equal(entry?.actualMinutes, 120);
  assert.equal(entry?.endedBy, 'limit');
});

test('the check can be turned off entirely', async () => {
  const config = { ...(await makeConfig()), awayAfterMinutes: 0 };
  await start(config);

  assert.equal(await pollThrough(config, 60, leftAfter(1)), null);
  assert.equal((await readSessionState(config, emptyAgenda, later(60))).active?.id, 'jira:PROJ-1');
});

/* ---------- owning up to it ---------- */

test('stopping by hand is recorded as such', async () => {
  const config = await makeConfig();
  await start(config);
  await stopSession(config, later(18));

  const [entry] = await readSessions(config);
  assert.equal(entry?.endedBy, 'user');
});

test('the dashboard reports the session it closed for you', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);
  await pollThrough(config, 60, leftAfter(40));

  const state = await readSessionState(config, emptyAgenda, later(60));
  assert.equal(state.unattendedClose?.id, 'jira:PROJ-1');
  assert.equal(state.unattendedClose?.reason, 'away');
  assert.equal(state.unattendedClose?.actualMinutes, 40);
  // And the time still counts as time worked — it happened, they just weren't asked.
  assert.equal(state.minutesToday, 40);
});

test('the report is dropped once something else has been worked on', async () => {
  const config = await makeConfig();
  await start(config, 'jira:PROJ-1', 25);
  await pollThrough(config, 60, leftAfter(40));

  await startSession(config, {
    id: 'jira:PROJ-2',
    title: 'something else',
    minutes: 25,
    advancesObjective: false,
    now: later(70),
  });

  // Nothing to own up to while it's running...
  assert.equal((await readSessionState(config, emptyAgenda, later(75))).unattendedClose, null);
  // ...nor once they have stopped it themselves.
  await stopSession(config, later(80));
  assert.equal((await readSessionState(config, emptyAgenda, later(85))).unattendedClose, null);
});

test('sessions logged before any of this existed are not announced', async () => {
  const config = await makeConfig();
  await start(config);
  await stopSession(config, later(20));

  // Rewrite the line as an older version of the dashboard would have left it.
  const [entry] = await readSessions(config);
  const { endedBy: _dropped, ...legacy } = entry!;
  await writeFile(config.sessionsLogFile, `${JSON.stringify(legacy)}\n`);

  const state = await readSessionState(config, emptyAgenda, later(25));
  assert.equal(state.unattendedClose, null);
  assert.equal(state.completedToday, 1, 'still counts as a session, just not as news');
});

/* ---------- durability ---------- */

test('a running session survives a restart', async () => {
  const config = await makeConfig();
  await start(config);

  // A fresh process reads the same files and finds the session still going.
  const state = await readSessionState(config, emptyAgenda, later(5));
  assert.equal(state.active?.id, 'jira:PROJ-1');
  assert.equal(state.active?.remainingSeconds, 1200);
});

test('a corrupt session file is ignored rather than fatal', async () => {
  const config = await makeConfig();
  await writeFile(config.sessionFile, '{ not json');
  assert.equal((await readSessionState(config, emptyAgenda, NOW)).active, null);
});

test('a corrupt line in the log does not hide the rest', async () => {
  const config = await makeConfig();
  await start(config);
  await stopSession(config, later(25));
  const good = await readFile(config.sessionsLogFile, 'utf8');
  await writeFile(config.sessionsLogFile, `garbage {{{\n${good}`);

  assert.equal((await readSessions(config)).length, 1);
});
