import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { archiveBrief, briefDateKey, computeObjectiveProgress, readArchiveIndex } from '../src/archive.ts';
import type { ArchivedItem } from '../src/archive.ts';
import type { Config } from '../src/config.ts';
import type { Action, Brief } from '../src/types.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-archive-'));
  dirs.push(dataDir);
  return {
    dataDir,
    itemsFile: resolve(dataDir, 'items.json'),
    actionsFile: resolve(dataDir, 'actions.jsonl'),
    focusFile: resolve(dataDir, 'focus.md'),
    sourcesFile: resolve(dataDir, 'sources.md'),
    promptFile: resolve(dataDir, 'prompt.md'),
    schemaFile: resolve(dataDir, 'items.schema.json'),
    archiveDir: resolve(dataDir, 'archive'),
    sessionFile: resolve(dataDir, 'session.json'),
    sessionsLogFile: resolve(dataDir, 'sessions.jsonl'),
    sessionMinutes: 25,
    awayAfterMinutes: 10,
    port: 0,
    host: '127.0.0.1',
    workStartHour: 9,
    workEndHour: 17,
    minFreeWindowMinutes: 45,
    staleAfterHours: 24,
    agentDays: null,
  };
}

function brief(date: string, generatedAt: string, items: Brief['items'] = []): Brief {
  return { version: 1, generatedAt, date, items };
}

const item = (id: string, advancesObjective = false) => ({
  id,
  source: 'github' as const,
  kind: 'task' as const,
  title: `title for ${id}`,
  ...(advancesObjective ? { advancesObjective: true } : {}),
});

/* ---------- writing ---------- */

test('archives a brief under its own date', async () => {
  const config = await makeConfig();
  assert.equal(await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z')), true);

  assert.deepEqual(await readdir(config.archiveDir), ['items-2026-09-10.json']);
});

test('falls back to generatedAt when the brief has no date', async () => {
  const generatedAt = new Date(2026, 8, 10, 6, 0).toISOString();
  assert.equal(briefDateKey({ version: 1, generatedAt, items: [] }), '2026-09-10');
});

test('re-archiving the same generation is a no-op', async () => {
  const config = await makeConfig();
  const b = brief('2026-09-10', '2026-09-10T06:00:00Z');

  assert.equal(await archiveBrief(config, b), true);
  assert.equal(await archiveBrief(config, b), false);
});

test('a later run the same day replaces the snapshot', async () => {
  const config = await makeConfig();
  await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z', [item('morning')]));
  assert.equal(
    await archiveBrief(config, brief('2026-09-10', '2026-09-10T15:00:00Z', [item('afternoon')])),
    true,
  );

  const stored = JSON.parse(
    await readFile(resolve(config.archiveDir, 'items-2026-09-10.json'), 'utf8'),
  ) as Brief;
  assert.deepEqual(
    stored.items.map((i) => i.id),
    ['afternoon'],
  );
});

test('an older generation does not clobber a newer snapshot', async () => {
  const config = await makeConfig();
  await archiveBrief(config, brief('2026-09-10', '2026-09-10T15:00:00Z', [item('newer')]));
  assert.equal(
    await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z', [item('older')])),
    false,
  );
});

test('leaves no temp files behind', async () => {
  const config = await makeConfig();
  await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z'));
  assert.equal((await readdir(config.archiveDir)).some((n) => n.endsWith('.tmp')), false);
});

/* ---------- reading ---------- */

test('indexes items newest-first across archives', async () => {
  const config = await makeConfig();
  await archiveBrief(config, brief('2026-09-08', '2026-09-08T06:00:00Z', [item('a'), item('old-only')]));
  await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z', [item('a', true)]));

  const index = await readArchiveIndex(config);
  // The newer snapshot wins for ids present in both.
  assert.equal(index.get('a')?.advancesObjective, true);
  assert.equal(index.get('old-only')?.advancesObjective, false);
});

test('a missing archive directory yields an empty index', async () => {
  assert.equal((await readArchiveIndex(await makeConfig())).size, 0);
});

test('one corrupt snapshot does not blind the rest', async () => {
  const config = await makeConfig();
  await archiveBrief(config, brief('2026-09-10', '2026-09-10T06:00:00Z', [item('good', true)]));
  await writeFile(resolve(config.archiveDir, 'items-2026-09-09.json'), '{ broken');

  const index = await readArchiveIndex(config);
  assert.equal(index.get('good')?.advancesObjective, true);
});

/* ---------- the metric ---------- */

const NOW = new Date(2026, 8, 10, 12, 0, 0); // Thursday 10 Sep 2026
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10, 0, 0).toISOString();

function index(entries: Record<string, boolean>): Map<string, ArchivedItem> {
  return new Map(
    Object.entries(entries).map(([id, advancesObjective]) => [
      id,
      { title: `title for ${id}`, advancesObjective },
    ]),
  );
}

const done = (id: string, when: string): Action => ({ id, action: 'done', at: when });

test('no objective-aligned completion reads as unknown, not zero', () => {
  const progress = computeObjectiveProgress(index({ a: false }), [done('a', at(2026, 9, 9))], NOW);
  assert.equal(progress.workingDaysSince, null);
  assert.equal(progress.lastTitle, null);
  assert.equal(progress.recentCount, 0);
});

test('completing an objective item today reads as 0', () => {
  const progress = computeObjectiveProgress(index({ a: true }), [done('a', at(2026, 9, 10))], NOW);
  assert.equal(progress.workingDaysSince, 0);
  assert.equal(progress.lastTitle, 'title for a');
});

test('counts working days, skipping the weekend', () => {
  // Friday 4 Sep -> Thursday 10 Sep is Mon,Tue,Wed,Thu = 4 working days.
  const progress = computeObjectiveProgress(index({ a: true }), [done('a', at(2026, 9, 4))], NOW);
  assert.equal(progress.workingDaysSince, 4);
});

test('a Friday completion viewed on Monday is one working day', () => {
  const monday = new Date(2026, 8, 7, 12, 0, 0);
  const progress = computeObjectiveProgress(index({ a: true }), [done('a', at(2026, 9, 4))], monday);
  assert.equal(progress.workingDaysSince, 1);
});

test('the most recent objective completion wins', () => {
  const progress = computeObjectiveProgress(
    index({ old: true, recent: true }),
    [done('old', at(2026, 9, 2)), done('recent', at(2026, 9, 9))],
    NOW,
  );
  assert.equal(progress.workingDaysSince, 1);
  assert.equal(progress.lastTitle, 'title for recent');
});

test('a later reopen cancels the completion', () => {
  const progress = computeObjectiveProgress(
    index({ a: true }),
    [done('a', at(2026, 9, 9)), { id: 'a', action: 'reopen', at: at(2026, 9, 10) }],
    NOW,
  );
  assert.equal(progress.workingDaysSince, null);
});

test('a note after a completion does not cancel it', () => {
  const progress = computeObjectiveProgress(
    index({ a: true }),
    [done('a', at(2026, 9, 10)), { id: 'a', action: 'note', at: at(2026, 9, 10), text: 'shipped' }],
    NOW,
  );
  assert.equal(progress.workingDaysSince, 0);
});

test('dismissing an objective item is not progress', () => {
  const progress = computeObjectiveProgress(
    index({ a: true }),
    [{ id: 'a', action: 'dismiss', at: at(2026, 9, 10) }],
    NOW,
  );
  assert.equal(progress.workingDaysSince, null);
});

test('counts recent completions inside the window only', () => {
  const progress = computeObjectiveProgress(
    index({ a: true, b: true, ancient: true }),
    [done('a', at(2026, 9, 9)), done('b', at(2026, 9, 8)), done('ancient', at(2026, 6, 1))],
    NOW,
  );
  assert.equal(progress.recentCount, 2);
  assert.equal(progress.windowDays, 14);
});

test('a completed id absent from the archive is ignored', () => {
  const progress = computeObjectiveProgress(index({}), [done('ghost', at(2026, 9, 10))], NOW);
  assert.equal(progress.workingDaysSince, null);
});
