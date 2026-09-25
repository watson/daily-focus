import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { Store } from '../src/store.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Brief } from '../src/types.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(overrides: Partial<Config> = {}): Promise<Store> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-'));
  dirs.push(dataDir);
  const config: Config = { ...loadConfig({ DAILY_FOCUS_DATA: dataDir }), port: 0, ...overrides };
  return new Store(config);
}

function brief(items: Brief['items'], generatedAt = new Date().toISOString()): Brief {
  return { version: 1, generatedAt, items };
}

test('reports a missing brief instead of throwing', async () => {
  const store = await makeStore();
  const state = await store.getState();

  assert.match(state.problem ?? '', /No brief yet/);
  assert.deepEqual(state.items, []);
  assert.equal(state.brief.generatedAt, null);
  assert.equal(state.stats.open, 0);
});

test('round-trips a brief through the store', async () => {
  const store = await makeStore();
  await writeFile(
    store.config.itemsFile,
    JSON.stringify(brief([{ id: 'a', source: 'github', kind: 'task', title: 'Review' }])),
  );

  const state = await store.getState();
  assert.equal(state.problem, null);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]?.status, 'open');
  assert.equal(state.stats.open, 1);
});

test('an appended action changes what the dashboard reports', async () => {
  const store = await makeStore();
  await writeFile(
    store.config.itemsFile,
    JSON.stringify(
      brief([
        { id: 'a', source: 'github', kind: 'task', title: 'Review' },
        { id: 'b', source: 'email', kind: 'task', title: 'Reply' },
      ]),
    ),
  );

  await store.appendAction({ id: 'a', action: 'done', at: new Date().toISOString() });
  const state = await store.getState();

  assert.equal(state.stats.open, 1);
  assert.equal(state.stats.completedToday, 1);
  assert.equal(state.items.find((i) => i.id === 'a')?.status, 'done');
});

test('concurrent appends all survive', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));

  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      store.appendAction({ id: `item-${i}`, action: 'done', at: new Date().toISOString() }),
    ),
  );

  const actions = await store.readActions();
  assert.equal(actions.length, 25);
  assert.equal(new Set(actions.map((a) => a.id)).size, 25);
});

test('a corrupt line in the log does not lose the others', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));
  await writeFile(
    store.config.actionsFile,
    ['{"id":"a","action":"done","at":"2026-09-10T08:00:00Z"}', 'garbage {{{', '', '{"id":"b","action":"dismiss","at":"2026-09-10T08:01:00Z"}'].join('\n'),
  );

  const actions = await store.readActions();
  assert.deepEqual(
    actions.map((a) => a.id),
    ['a', 'b'],
  );
});

// Dates are pinned to a known week so the weekend rules are testable at all:
// Thu 10 -> Fri 11 -> Sat 12 -> Sun 13 -> Mon 14 September 2026.
const thursdayRun = new Date(2026, 8, 10, 6, 30).toISOString();
const fridayRun = new Date(2026, 8, 11, 6, 30).toISOString();

test('a stale brief is flagged', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], thursdayRun)));

  // Friday lunchtime: the morning run was due hours ago and didn't happen.
  const state = await store.getState(new Date(2026, 8, 11, 12, 30));
  assert.equal(state.brief.stale, true);
  assert.equal(state.brief.ageHours, 30);
});

test('a fresh brief is not flagged', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));

  const state = await store.getState();
  assert.equal(state.brief.stale, false);
});

test("Friday's brief is not stale at the weekend, when no run was due", async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], fridayRun)));

  const saturday = await store.getState(new Date(2026, 8, 12, 9, 0));
  assert.equal(saturday.brief.stale, false);
  assert.equal(saturday.schedule.runsToday, false);
  // The age itself is still reported honestly — it's only the verdict that changes.
  assert.equal(saturday.brief.ageHours, 26);

  const sunday = await store.getState(new Date(2026, 8, 13, 22, 0));
  assert.equal(sunday.brief.stale, false);
  assert.equal(sunday.brief.ageHours, 63);
});

test("Friday's brief goes stale on Monday after the refresh grace period", async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], fridayRun)));

  const beforeTheRun = await store.getState(new Date(2026, 8, 14, 5, 0));
  assert.equal(beforeTheRun.brief.stale, false);
  assert.equal(beforeTheRun.schedule.runsToday, true);

  const afterIt = await store.getState(new Date(2026, 8, 14, 7, 15));
  assert.equal(afterIt.brief.stale, true);
  assert.equal(afterIt.brief.ageHours, 72);
});

test('on a Sun–Thu week the weekend moves with the schedule', async () => {
  // The Israeli working week: Sun–Thu.
  const store = await makeStore({ agentDays: [0, 1, 2, 3, 4] });
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], thursdayRun)));

  const friday = await store.getState(new Date(2026, 8, 11, 9, 0));
  assert.equal(friday.brief.stale, false, 'Friday is the weekend here, so nothing is late');
  assert.equal(friday.schedule.runsToday, false);
  assert.equal(friday.schedule.source, 'config');
  assert.equal(friday.schedule.description, 'Sun–Thu');
  assert.equal(friday.schedule.nextRunDate, '2026-09-13');

  const saturday = await store.getState(new Date(2026, 8, 12, 20, 0));
  assert.equal(saturday.brief.stale, false);

  // Sunday is a working morning: by 07:15 the grace period has ended.
  const sunday = await store.getState(new Date(2026, 8, 13, 7, 15));
  assert.equal(sunday.brief.stale, true);
  assert.equal(sunday.schedule.runsToday, true);
});

test('a brief written at the weekend is still fresh at the weekend', async () => {
  const store = await makeStore();
  const saturdayRun = new Date(2026, 8, 12, 8, 0).toISOString();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], saturdayRun)));

  const state = await store.getState(new Date(2026, 8, 12, 18, 0));
  assert.equal(state.brief.stale, false);
  assert.equal(state.brief.ageHours, 10);
});

test('a broken items.json surfaces as a problem, keeping the server up', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, '{ this is not json');

  const state = await store.getState();
  assert.match(state.problem ?? '', /not valid JSON/);
  assert.deepEqual(state.items, []);
});

test('focus is null when focus.md has not been written', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));

  assert.equal((await store.getState()).focus, null);
});

test('the agent-only section of focus.md never reaches the state payload', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));
  await writeFile(
    store.config.focusFile,
    [
      '---',
      'objective: Ship the thing',
      'blocker: It is broken',
      '---',
      '',
      'Public prose.',
      '',
      '<!-- agent-only -->',
      'UNRENDERABLE-SENTINEL',
    ].join('\n'),
  );

  const state = await store.getState();
  assert.equal(state.focus?.objective, 'Ship the thing');
  assert.equal(state.focus?.blocker, 'It is broken');
  assert.equal(state.focus?.note, 'Public prose.');

  // The whole point of the marker: it must not survive serialisation.
  assert.equal(JSON.stringify(state).includes('UNRENDERABLE-SENTINEL'), false);
});

test('objectiveProgress is null without an objective to measure against', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));

  assert.equal((await store.getState()).objectiveProgress, null);
});

test('completing an objective-aligned item resets the progress clock', async () => {
  const store = await makeStore();
  await writeFile(store.config.focusFile, '---\nobjective: Ship it\n---\n');
  await writeFile(
    store.config.itemsFile,
    JSON.stringify(
      brief([
        { id: 'moves-it', source: 'github', kind: 'task', title: 'Restore the build', advancesObjective: true },
        { id: 'noise', source: 'email', kind: 'task', title: 'Unrelated' },
      ]),
    ),
  );
  await store.archiveCurrentBrief();

  const before = await store.getState();
  assert.equal(before.objectiveProgress?.workingDaysSince, null);

  // Completing the unrelated item is not progress.
  await store.appendAction({ id: 'noise', action: 'done', at: new Date().toISOString() });
  assert.equal((await store.getState()).objectiveProgress?.workingDaysSince, null);

  await store.appendAction({ id: 'moves-it', action: 'done', at: new Date().toISOString() });
  const after = await store.getState();
  assert.equal(after.objectiveProgress?.workingDaysSince, 0);
  assert.equal(after.objectiveProgress?.lastTitle, 'Restore the build');
  assert.equal(after.objectiveProgress?.recentCount, 1);
});

test('progress survives the item dropping out of the current brief', async () => {
  const store = await makeStore();
  await writeFile(store.config.focusFile, '---\nobjective: Ship it\n---\n');

  // Yesterday's brief carried the objective item; it gets archived, then completed.
  await writeFile(
    store.config.itemsFile,
    JSON.stringify(
      brief(
        [{ id: 'shipped', source: 'github', kind: 'task', title: 'Shipped it', advancesObjective: true }],
        new Date(Date.now() - 86_400_000).toISOString(),
      ),
    ),
  );
  await store.archiveCurrentBrief();
  await store.appendAction({ id: 'shipped', action: 'done', at: new Date().toISOString() });

  // Today's brief no longer mentions it — the archive is the only record.
  await writeFile(store.config.itemsFile, JSON.stringify(brief([])));

  const state = await store.getState();
  assert.equal(state.objectiveProgress?.workingDaysSince, 0);
  assert.equal(state.objectiveProgress?.lastTitle, 'Shipped it');
});

test('archiving is idempotent across repeated observations', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], '2026-09-10T06:00:00Z')));

  assert.equal(await store.archiveCurrentBrief(), true);
  assert.equal(await store.archiveCurrentBrief(), false);
});

test('archiving a missing brief is a no-op, not an error', async () => {
  const store = await makeStore();
  assert.equal(await store.archiveCurrentBrief(), false);
});

test('counts overdue items against local today', async () => {
  const store = await makeStore();
  await writeFile(
    store.config.itemsFile,
    JSON.stringify(
      brief([
        { id: 'past', source: 'email', kind: 'task', title: 'Late', due: '2020-01-01' },
        { id: 'future', source: 'email', kind: 'task', title: 'Soon', due: '2099-01-01' },
      ]),
    ),
  );

  const state = await store.getState();
  assert.equal(state.stats.overdue, 1);
});


test('a refresh gets 45 minutes of grace at the configured threshold', async () => {
  for (const threshold of [24, 12]) {
    const store = await makeStore({ staleAfterHours: threshold });
    await writeFile(store.config.itemsFile, JSON.stringify(brief([], thursdayRun)));
    for (const [offset, pending, stale] of [
      [-1, false, false], [0, true, false], [44 * 60_000 + 59_999, true, false],
      [45 * 60_000, false, true],
    ] as const) {
      const now = new Date(new Date(thursdayRun).getTime() + threshold * 3_600_000 + offset);
      const state = await store.getState(now);
      assert.equal(state.brief.refreshPending, pending);
      assert.equal(state.brief.stale, stale);
    }
  }
});

test('refresh grace skips days off and resumes on the next run day', async () => {
  const store = await makeStore();
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], fridayRun)));
  const weekend = await store.getState(new Date(2026, 8, 13, 7, 0));
  assert.equal(weekend.brief.refreshPending, false);
  const monday = await store.getState(new Date(2026, 8, 14, 7, 0));
  assert.equal(monday.brief.refreshPending, true);
  assert.equal(monday.brief.stale, false);
  await writeFile(store.config.itemsFile, JSON.stringify(brief([], new Date(2026, 8, 14, 7, 0).toISOString())));
  const refreshed = await store.getState(new Date(2026, 8, 14, 7, 1));
  assert.equal(refreshed.brief.refreshPending, false);
  assert.equal(refreshed.brief.stale, false);
});
