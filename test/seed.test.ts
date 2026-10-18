import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/seed.ts');
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-seed-'));
  dirs.push(dir);
  return dir;
}

function seed(dataDir: string, ...args: string[]) {
  return run(process.execPath, [script, ...args], {
    env: { ...process.env, DAILY_FOCUS_DATA: dataDir },
  });
}

test("seeds an empty data folder's work store and names it", async () => {
  const dir = await tempStore();
  const { stdout } = await seed(dir);

  assert.ok(stdout.includes(`Seeding store: ${join(dir, 'work')}`), stdout);
  const brief = JSON.parse(await readFile(join(dir, 'work', 'items.json'), 'utf8'));
  assert.ok(brief.items.length > 0);
});

test('--profile picks the store, and the brief follows it', async () => {
  const dir = await tempStore();
  await seed(dir, '--profile', 'personal');

  const brief = JSON.parse(await readFile(join(dir, 'personal', 'items.json'), 'utf8')) as { items: { source: string }[] };
  assert.ok(brief.items.some((item) => item.source === 'eboks'), 'the personal brief');
});

test('creates a missing store directory without warning', async () => {
  const dir = join(await tempStore(), 'not-yet-created');
  const { stdout, stderr } = await seed(dir);

  assert.equal(stderr, '');
  assert.match(stdout, /Wrote \d+ sample items/);
  await readFile(join(dir, 'work', 'items.json'), 'utf8');
});

test('refuses to overwrite an existing brief and names its path', async () => {
  const dir = await tempStore();
  const itemsFile = join(dir, 'items.json');
  await writeFile(itemsFile, '{"version":1,"items":[]}\n');

  await assert.rejects(seed(dir), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Refusing to overwrite/);
    assert.ok(error.stderr.includes(itemsFile));
    return true;
  });
  assert.equal(await readFile(itemsFile, 'utf8'), '{"version":1,"items":[]}\n');
});

test("a personal store gets the personal brief, following the store's profile", async () => {
  const dir = await tempStore();
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ DAILY_FOCUS_PROFILE: 'personal' }));
  await seed(dir);

  const brief = JSON.parse(await readFile(join(dir, 'items.json'), 'utf8')) as { items: { source: string }[] };
  assert.ok(brief.items.some((item) => item.source === 'eboks'), 'letters, not tickets');
  assert.ok(!brief.items.some((item) => item.source === 'jira' || item.source === 'workday'));
});

test('overwrites an existing brief with --force', async () => {
  const dir = await tempStore();
  const itemsFile = join(dir, 'items.json');
  await writeFile(itemsFile, '{"version":1,"items":[]}\n');

  const { stdout } = await seed(dir, '--force');

  assert.match(stdout, /Overwrote/);
  const brief = JSON.parse(await readFile(itemsFile, 'utf8'));
  assert.ok(brief.items.length > 0);
});
