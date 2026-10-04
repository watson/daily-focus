import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/init.ts');
const personalPrompt = resolve(import.meta.dirname, '../prompts/morning-brief-personal.md');
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-init-'));
  dirs.push(dir);
  return dir;
}

// The agent is set so an already set-up store has nothing left to ask for.
function init(dataDir: string) {
  return run(process.execPath, [script], {
    env: { ...process.env, DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_PROFILE: 'personal', DAILY_FOCUS_AGENT: 'codex' },
  });
}

test('a first run never suggests seeding the store it just set up', async () => {
  const dir = await tempStore();

  const { stdout } = await init(dir);

  // The agent's first brief would carry the sample tasks forward as real work.
  assert.doesNotMatch(stdout, /npm run seed/);
  assert.match(stdout, /demo in the README/);
});

test('a second run reports that nothing changed', async () => {
  const dir = await tempStore();
  await init(dir);

  const { stdout } = await init(dir);

  assert.match(stdout, /The store was already set up\. Nothing was changed\./);
});

test('says so when it repoints a link at this checkout', async () => {
  const dir = await tempStore();
  await init(dir);
  // A link left pointing at another checkout, as a run from a since-abandoned worktree leaves it.
  const elsewhere = join(dir, 'other-checkout-prompt.md');
  await writeFile(elsewhere, '# an older prompt\n');
  await unlink(join(dir, 'prompt.md'));
  await symlink(elsewhere, join(dir, 'prompt.md'));

  const { stdout } = await init(dir);

  assert.match(stdout, /Linked 1 file to this checkout; nothing else changed\./);
  assert.doesNotMatch(stdout, /Nothing was changed/);
  assert.equal(await readlink(join(dir, 'prompt.md')), personalPrompt);
});
