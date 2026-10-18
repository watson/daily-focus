import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { findStore, settled, settleStore, STORE_ENTRIES } from '../src/stores.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-stores-'));
  dirs.push(dir);
  return dir;
}

/** A store as it was before the folders, in `dir` itself, with what an agent may leave beside it. */
async function olderStore(dir: string, settings: Record<string, string>): Promise<void> {
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(dir, 'items.json'), '{"version":1,"items":[]}\n');
  await writeFile(join(dir, 'actions.jsonl'), '{"id":"a","action":"done","at":"2026-10-01T09:00:00Z"}\n');
  await mkdir(join(dir, 'archive'));
  await writeFile(join(dir, 'archive', 'items-2026-10-01.json'), '{}\n');
  await symlink('/nowhere/prompt.md', join(dir, 'prompt.md'));
  await writeFile(join(dir, 'scratch-from-the-agent.txt'), 'notes\n');
  await writeFile(join(dir, '.hidden'), 'x\n');
}

const OLDER = ['.hidden', 'actions.jsonl', 'archive', 'items.json', 'prompt.md', 'scratch-from-the-agent.txt', 'settings.json'];

test("a new data folder opens the work store, or the profile asked for, and there's nothing to move", async () => {
  const root = await dataFolder();
  assert.deepEqual(findStore(root), { root, profile: 'work', dir: join(root, 'work'), given: false, move: null, problem: null });
  assert.deepEqual(findStore(root, { asked: 'personal' }), {
    root,
    profile: 'personal',
    dir: join(root, 'personal'),
    given: true,
    move: null,
    problem: null,
  });
});

test('without a profile, the one store there is is the one it opens; with both, work, unless a restart keeps the other', async () => {
  const root = await dataFolder();
  await mkdir(join(root, 'personal'));
  assert.equal(findStore(root).profile, 'personal');
  await mkdir(join(root, 'work'));
  assert.equal(findStore(root).profile, 'work');
  assert.equal(findStore(root, { last: 'personal' }).profile, 'personal');
  assert.equal(findStore(root, { asked: 'work', last: 'personal' }).profile, 'work', 'what was given at launch wins');
});

test('a store from before the folders moves, all of it, into the folder for its profile', async () => {
  const root = await dataFolder();
  await olderStore(root, { DAILY_FOCUS_PROFILE: 'personal', DAILY_FOCUS_AGENT: 'codex' });

  const found = findStore(root);
  assert.deepEqual([found.profile, found.dir, found.move], ['personal', root, { kind: 'into-folder' }], 'read where it lies until it moves');
  assert.deepEqual(settled(found), { dir: join(root, 'personal'), profile: 'personal' });

  const { location, moved } = await settleStore(found);
  assert.deepEqual(await readdir(root), ['personal']);
  assert.deepEqual((await readdir(join(root, 'personal'))).sort(), OLDER);
  assert.equal(await readFile(join(root, 'personal', 'archive', 'items-2026-10-01.json'), 'utf8'), '{}\n');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'personal', 'settings.json'), 'utf8')), {
    DAILY_FOCUS_PROFILE: 'personal',
    DAILY_FOCUS_AGENT: 'codex',
  });
  assert.deepEqual([location.dir, location.move, location.given], [join(root, 'personal'), null, false]);
  assert.match(moved ?? '', /moved the personal store/);
  assert.deepEqual(findStore(root), location, 'and the next start finds it there');
});

test('a store that never saved a profile is a work store', async () => {
  const root = await dataFolder();
  await olderStore(root, { DAILY_FOCUS_AGENT: 'claude' });
  await settleStore(findStore(root));
  assert.deepEqual(await readdir(root), ['work']);
});

test("a dashboard for the other profile leaves an older store for its own dashboard to move", async () => {
  const root = await dataFolder();
  await olderStore(root, { DAILY_FOCUS_PROFILE: 'work' });
  const found = findStore(root, { asked: 'personal' });
  assert.deepEqual([found.dir, found.move, found.problem], [join(root, 'personal'), null, null]);
  await settleStore(found);
  assert.deepEqual((await readdir(root)).sort(), OLDER, 'nothing moved');
});

test('a move is never made over a folder that is already there, and says so', async () => {
  const root = await dataFolder();
  await olderStore(root, {});
  await mkdir(join(root, 'work'));
  await writeFile(join(root, 'work', 'items.json'), '{"version":1,"items":[]}\n');

  const found = findStore(root);
  assert.deepEqual([found.dir, found.move], [join(root, 'work'), null]);
  assert.match(found.problem ?? '', /beside the `work` folder/);
  assert.match(found.problem ?? '', /`actions\.jsonl`, `archive`, `items\.json` and 2 more/);
  await settleStore(found);
  assert.ok(existsSync(join(root, 'settings.json')), 'left where it was');
});

test("a folder with nothing of a store's own in it is no store, whatever its folders are called", async () => {
  const root = await dataFolder();
  await mkdir(join(root, 'archive'));
  await writeFile(join(root, 'notes.txt'), 'mine\n');
  const found = findStore(root);
  assert.deepEqual([found.dir, found.move], [join(root, 'work'), null]);
});

test('nothing is moved out of the home folder', async () => {
  const root = await dataFolder();
  await olderStore(root, {});
  const found = findStore(root, { home: root });
  assert.equal(found.move, null);
  assert.match(found.problem ?? '', /home folder or the top of a disk/);
});

test('a move cut short carries on at the next start', async () => {
  const root = await dataFolder();
  await olderStore(root, { DAILY_FOCUS_PROFILE: 'personal' });
  // As if the last start stopped part way: some of it gathered, the rest still out.
  await mkdir(join(root, '.moving-personal'));
  for (const name of ['settings.json', 'archive']) {
    await import('node:fs/promises').then(({ rename }) => rename(join(root, name), join(root, '.moving-personal', name)));
  }

  const found = findStore(root);
  assert.deepEqual([found.profile, found.move], ['personal', { kind: 'into-folder' }], 'its profile is the staging folder it was going to');
  await settleStore(found);
  assert.deepEqual(await readdir(root), ['personal']);
  assert.deepEqual((await readdir(join(root, 'personal'))).sort(), OLDER);
});

test('a name both moved and still out stops the move rather than replace either', async () => {
  const root = await dataFolder();
  await olderStore(root, {});
  await mkdir(join(root, '.moving-work'));
  await writeFile(join(root, '.moving-work', 'items.json'), '{"version":1,"items":[],"note":"moved"}\n');

  await assert.rejects(settleStore(findStore(root)), /items\.json is already there/);
  assert.equal(await readFile(join(root, 'items.json'), 'utf8'), '{"version":1,"items":[]}\n');
  assert.match(await readFile(join(root, '.moving-work', 'items.json'), 'utf8'), /moved/);
});

test('a data folder that is a link moves inside the folder it links to', async () => {
  const real = await dataFolder();
  await olderStore(real, {});
  const link = join(await dataFolder(), 'linked');
  await symlink(real, link);
  await settleStore(findStore(link));
  assert.deepEqual(await readdir(real), ['work']);
});

test("a store whose settings name the other profile is renamed to match, unless that one is there or the profile was given", async () => {
  const root = await dataFolder();
  await mkdir(join(root, 'work'));
  await writeFile(join(root, 'work', 'settings.json'), JSON.stringify({ DAILY_FOCUS_PROFILE: 'personal' }));

  assert.equal(findStore(root, { asked: 'work' }).move, null, 'given at launch, nothing saved changes it');
  const found = findStore(root, { last: 'work' });
  assert.deepEqual(found.move, { kind: 'rename', to: 'personal' });
  const { location } = await settleStore(found);
  assert.deepEqual(await readdir(root), ['personal']);
  assert.deepEqual([location.profile, location.dir, location.given], ['personal', join(root, 'personal'), false]);

  await mkdir(join(root, 'work'));
  await writeFile(join(root, 'work', 'settings.json'), JSON.stringify({ DAILY_FOCUS_PROFILE: 'personal' }));
  const blocked = findStore(root, { last: 'work' });
  assert.equal(blocked.move, null);
  assert.match(blocked.problem ?? '', /saved as a personal store/);
});

test('every name a store keeps at its top level is known as one', () => {
  const config = loadConfig({ DAILY_FOCUS_DATA: '/store' });
  const inStore = Object.values(config).filter((value): value is string => typeof value === 'string' && dirname(value) === '/store');
  assert.ok(inStore.length > 10, 'the paths in Config moved');
  for (const path of inStore) assert.ok(STORE_ENTRIES.includes(basename(path)), `${basename(path)} is missing from STORE_ENTRIES`);
});

test('a dashboard started on a store from before the folders moves it, says so on the page, and runs on it', async () => {
  const root = await dataFolder();
  await olderStore(root, {
    DAILY_FOCUS_PROFILE: 'personal',
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_CALENDAR: 'off',
  });
  const server = await startServer({ PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' });
  try {
    const status = (await (await fetch(`${server.url}/api/status`)).json()) as { dataDir: string; profile: string };
    assert.deepEqual([status.dataDir, status.profile], [join(root, 'personal'), 'personal']);
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as { setupNotices: string[]; setupWarnings: string[] };
    assert.equal(state.setupNotices.length, 1);
    assert.match(state.setupNotices[0]!, /moved to `.*\/personal`/);
    assert.equal(server.profile, 'personal');
    assert.ok(existsSync(join(root, 'personal', 'actions.jsonl')));
  } finally {
    await server.close();
  }
});
