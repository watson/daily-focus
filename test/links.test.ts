import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, type Config } from '../src/config.ts';
import { linkState, storeLinkWarning } from '../src/links.ts';

const repo = resolve(import.meta.dirname, '..');
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A store under a temporary home, with the agent and the assistant on unless `env` says otherwise. */
async function setup(env: Record<string, string> = {}): Promise<{ home: string; config: Config }> {
  const home = await mkdtemp(join(tmpdir(), 'daily-focus-links-'));
  dirs.push(home);
  const dataDir = join(home, 'store');
  await mkdir(dataDir);
  const config = loadConfig({
    DAILY_FOCUS_DATA: dataDir,
    DAILY_FOCUS_PROFILE: 'personal',
    DAILY_FOCUS_AGENT: 'codex',
    DAILY_FOCUS_ASSISTANT: 'codex',
    ...env,
  });
  return { home, config };
}

async function linkAll(config: Config): Promise<void> {
  await symlink(config.promptSource, config.promptFile);
  await symlink(config.schemaSource, config.schemaFile);
  await symlink(config.assistantPromptSource, config.assistantPromptFile);
}

/** The same three files in a checkout that isn't this one, as a worktree left behind would have them. */
async function otherCheckout(home: string): Promise<{ root: string; prompt: string; schema: string; assistant: string }> {
  const root = join(home, 'old-worktree');
  await mkdir(join(root, 'prompts'), { recursive: true });
  await mkdir(join(root, 'schema'));
  const files = {
    root,
    prompt: join(root, 'prompts', 'morning-brief-personal.md'),
    schema: join(root, 'schema', 'items.schema.json'),
    assistant: join(root, 'prompts', 'assistant.md'),
  };
  for (const file of [files.prompt, files.schema, files.assistant]) await writeFile(file, 'an older copy\n');
  return files;
}

test('quiet when every link in use points at this checkout', async () => {
  const { home, config } = await setup();
  await linkAll(config);

  assert.equal(await storeLinkWarning(config, home), null);
  assert.deepEqual(await linkState(config.promptFile, config.promptSource), { state: 'linked' });
});

test("a real file where a link should be is someone's own prompt, left alone", async () => {
  const { home, config } = await setup();
  await linkAll(config);
  await rm(config.promptFile);
  await writeFile(config.promptFile, '# my own prompt\n');

  assert.deepEqual(await linkState(config.promptFile, config.promptSource), { state: 'own' });
  assert.equal(await storeLinkWarning(config, home), null);
});

test('names every link into another checkout, who follows it, and the one command that fixes them', async () => {
  const { home, config } = await setup();
  const old = await otherCheckout(home);
  await symlink(old.prompt, config.promptFile);
  await symlink(old.schema, config.schemaFile);
  await symlink(old.assistant, config.assistantPromptFile);

  assert.deepEqual(await linkState(config.promptFile, config.promptSource), { state: 'elsewhere', target: old.prompt });
  assert.equal(
    await storeLinkWarning(config, home),
    '`prompt.md`, `items.schema.json` and `assistant.md` in the store link to another checkout (`~/old-worktree`), ' +
      'so the morning agent and the assistant follow that copy, not this one. ' +
      `Run \`npm run init\` in \`${repo}\` to relink them.`,
  );
});

test("a link to a file that's gone, or no link at all, means the agent can't read it", async () => {
  const { home, config } = await setup();
  await linkAll(config);
  await rm(config.promptFile);
  await symlink(join(home, 'old-worktree', 'prompts', 'renamed.md'), config.promptFile);
  await rm(config.schemaFile);

  assert.equal(
    await storeLinkWarning(config, home),
    "`prompt.md` in the store links to a file that no longer exists (`~/old-worktree/prompts/renamed.md`), so the morning agent can't read it. " +
      "`items.schema.json` is missing from the store, so the morning agent can't read it. " +
      `Run \`npm run init\` in \`${repo}\` to relink them.`,
  );
});

test('only the links something here reads are checked', async () => {
  // Nothing runs the agent or the assistant: nothing reads any of the three.
  const off = await setup({ DAILY_FOCUS_AGENT: 'off', DAILY_FOCUS_ASSISTANT: 'off' });
  assert.equal(await storeLinkWarning(off.config, off.home), null);

  // The assistant falls back to the repo's copy, so only a link to another copy matters.
  const { home, config } = await setup({ DAILY_FOCUS_AGENT: 'off' });
  assert.equal(await storeLinkWarning(config, home), null, 'missing');
  await symlink(join(home, 'gone.md'), config.assistantPromptFile);
  assert.equal(await storeLinkWarning(config, home), null, 'dangling');
  await rm(config.assistantPromptFile);
  const old = await otherCheckout(home);
  await symlink(old.assistant, config.assistantPromptFile);
  assert.match((await storeLinkWarning(config, home)) ?? '', /^`assistant\.md` in the store links to another checkout .*, so the assistant follows that copy/);
});
