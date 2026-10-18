import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { NEEDS_SYMLINKS } from './symlinks.ts';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/init.ts');
const personalPrompt = resolve(import.meta.dirname, '../prompts/morning-brief-personal.md');
const workPrompt = resolve(import.meta.dirname, '../prompts/morning-brief-work.md');
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-init-'));
  dirs.push(dir);
  return dir;
}

function init(dataDir: string, ...args: string[]) {
  return run(process.execPath, [script, '--profile', 'personal', ...args], { env: { ...process.env, DAILY_FOCUS_DATA: dataDir } });
}


/** Linked to `source`, or on Windows, where the store gets copies, a copy of it. */
async function assertLinked(path: string, source: string, message?: string): Promise<void> {
  if (process.platform === 'win32') assert.equal(await readFile(path, 'utf8'), await readFile(source, 'utf8'), message);
  else assert.equal(await readlink(path), source, message);
}

test('a first run never suggests seeding the store it just set up', async () => {
  const dir = await tempStore();

  const { stdout } = await init(dir);

  // The agent's first brief would carry the sample tasks forward as real work.
  assert.doesNotMatch(stdout, /npm run seed/);
  assert.match(stdout, /npm run demo/);
});

test('a second run reports that nothing changed', async () => {
  const dir = await tempStore();
  await init(dir);

  const { stdout } = await init(dir);

  assert.match(stdout, /The store was already set up\. Nothing was changed\./);
});

test('says so when it repoints a link at this checkout', { skip: NEEDS_SYMLINKS }, async () => {
  const dir = await tempStore();
  await init(dir);
  const store = join(dir, 'personal');
  // A link left pointing at another checkout, as a run from a since-abandoned worktree leaves it.
  const elsewhere = join(store, 'other-checkout-prompt.md');
  await writeFile(elsewhere, '# an older prompt\n');
  await unlink(join(store, 'prompt.md'));
  await symlink(elsewhere, join(store, 'prompt.md'));

  const { stdout } = await init(dir);

  assert.match(stdout, /Linked 1 file to this checkout; nothing else changed\./);
  assert.doesNotMatch(stdout, /Nothing was changed/);
  await assertLinked(join(store, 'prompt.md'), personalPrompt);
});

test("--profile sets up that profile's store, in its folder, which says the profile", async () => {
  const dir = await tempStore();
  const { stdout } = await init(dir);

  const store = join(dir, 'personal');
  assert.match(stdout, /personal \(personal profile\)/);
  assert.equal(existsSync(join(store, 'settings.json')), false, 'the folder is the record; nothing needs saving');
  assert.match(await readFile(join(store, 'sources.md'), 'utf8'), /e-Boks/i, 'the personal template');
  await assertLinked(join(store, 'prompt.md'), personalPrompt);
});

test('without --profile, a new data folder gets the work store', async () => {
  const dir = await tempStore();
  await run(process.execPath, [script], { env: { ...process.env, DAILY_FOCUS_DATA: dir } });

  assert.deepEqual(await readdir(dir), ['work']);
  await assertLinked(join(dir, 'work', 'prompt.md'), workPrompt);
});

test('a store from before the folders is set up where it lies, for the dashboard to move', async () => {
  const dir = await tempStore();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ DAILY_FOCUS_PROFILE: 'personal', DAILY_FOCUS_AGENT: 'codex' }));

  await run(process.execPath, [script], { env: { ...process.env, DAILY_FOCUS_DATA: dir } });

  await assertLinked(join(dir, 'prompt.md'), personalPrompt, "linked for the store's own profile");
  assert.equal(existsSync(join(dir, 'personal')), false, 'moving it is the dashboard\'s job, as it starts');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')), { DAILY_FOCUS_PROFILE: 'personal', DAILY_FOCUS_AGENT: 'codex' });
});
