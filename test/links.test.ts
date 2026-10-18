import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, type Config } from '../src/config.ts';
import { linkState, linkStore, storeLinkWarning } from '../src/links.ts';

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

test('names every link into another checkout, who follows it, and how to link them back', async () => {
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
      `Restart the dashboard to link them back to \`${repo}\`.`,
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
      `Restart the dashboard to link them back to \`${repo}\`.`,
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

test('linking the store makes what is missing, repoints what points elsewhere, and leaves a real file alone', async () => {
  const { home, config } = await setup();
  const old = await otherCheckout(home);
  await symlink(old.schema, config.schemaFile);
  await writeFile(config.assistantPromptFile, 'my own instructions\n');

  const outcomes = await linkStore(config);

  assert.deepEqual(
    outcomes.map(({ name, result }) => [name, result]),
    [
      ['prompt.md', 'linked'],
      ['items.schema.json', 'linked'],
      ['assistant.md', 'own'],
    ],
  );
  assert.equal(outcomes[1]!.detail, old.schema, 'says where it pointed before');
  assert.equal(await readlink(config.promptFile), config.promptSource);
  assert.equal(await readlink(config.schemaFile), config.schemaSource);
  assert.deepEqual(await linkState(config.assistantPromptFile, config.assistantPromptSource), { state: 'own' });

  assert.deepEqual((await readdir(config.dataDir)).filter((name) => name.endsWith('.link')), [], 'nothing staged is left behind');

  // A second pass has nothing to do.
  assert.deepEqual(
    (await linkStore(config)).map(({ result }) => result),
    ['kept', 'kept', 'own'],
  );
});

/** `symlink` as Windows answers it without Developer Mode. */
const refused = (async () => {
  throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
}) as unknown as typeof symlink;

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('on Windows without Developer Mode, the files are copied, recorded, and read as linked', async () => {
  const { home, config } = await setup();

  assert.deepEqual((await linkStore(config, 'win32', refused)).map(({ result }) => result), ['copied', 'copied', 'copied']);
  assert.equal((await lstat(config.promptFile)).isSymbolicLink(), false);
  const prompt = await readFile(config.promptSource);
  assert.deepEqual(await readFile(config.promptFile), prompt);
  const copies = JSON.parse(await readFile(config.copiesFile, 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(copies).sort(), ['assistant.md', 'items.schema.json', 'prompt.md']);
  assert.equal(copies['prompt.md'], sha256(prompt));
  assert.deepEqual(await linkState(config.promptFile, config.promptSource, copies['prompt.md']), { state: 'linked' });
  assert.equal(await storeLinkWarning(config, home), null);
  assert.deepEqual((await readdir(config.dataDir)).filter((name) => name.endsWith('.link')), [], 'nothing staged is left behind');

  assert.deepEqual((await linkStore(config, 'win32', refused)).map(({ result }) => result), ['kept', 'kept', 'kept'], 'a second start has nothing to do');
});

test("on Windows, a copy someone edited is their own, and a file that was never the dashboard's copy too", async () => {
  const { home, config } = await setup();
  await linkStore(config, 'win32', refused);
  await writeFile(config.promptFile, '# my own prompt, started from the copy\n');
  await rm(config.schemaFile);
  await writeFile(config.schemaFile, '{}\n');
  const copies = JSON.parse(await readFile(config.copiesFile, 'utf8')) as Record<string, string>;
  delete copies['items.schema.json'];
  await writeFile(config.copiesFile, JSON.stringify(copies));

  assert.deepEqual(await linkState(config.promptFile, config.promptSource, copies['prompt.md']), { state: 'own' });
  assert.equal(await storeLinkWarning(config, home), null);
  assert.deepEqual((await linkStore(config, 'win32', refused)).map(({ result }) => result), ['own', 'own', 'kept']);
  assert.equal(await readFile(config.promptFile, 'utf8'), '# my own prompt, started from the copy\n');
});

test("on Windows, another version's copy is warned about, then refreshed at the next start", async () => {
  const { home, config } = await setup();
  await writeFile(config.promptFile, 'an older prompt\n');
  await writeFile(config.copiesFile, JSON.stringify({ 'prompt.md': sha256('an older prompt\n') }));

  assert.match(
    (await storeLinkWarning(config, home)) ?? '',
    /^`prompt\.md` in the store is a copy of another version's, so the morning agent follows that, not this one's\. /,
  );
  const [prompt] = await linkStore(config, 'win32', refused);
  assert.equal(prompt!.result, 'copied');
  assert.deepEqual(await readFile(config.promptFile), await readFile(config.promptSource));
  assert.equal(await storeLinkWarning(config, home), null);
});

test('on Windows with Developer Mode, a link replaces a copy once the file changes', async () => {
  const { home, config } = await setup();
  const old = await otherCheckout(home);
  const older = { ...config, promptSource: old.prompt };
  assert.equal((await linkStore(older, 'win32', refused))[0]!.result, 'copied');

  // This checkout's prompt differs from the copy, and links can be made now.
  const [prompt] = await linkStore(config, 'win32');
  assert.equal(prompt!.result, 'linked');
  assert.equal(await readlink(config.promptFile), config.promptSource);
  const copies = JSON.parse(await readFile(config.copiesFile, 'utf8')) as Record<string, string>;
  assert.equal(copies['prompt.md'], undefined, 'no longer a copy');
});

test("anywhere but Windows a link that can't be made fails, and nothing is copied", async () => {
  const { config } = await setup();
  const outcomes = await linkStore(config, 'darwin', refused);
  assert.deepEqual(outcomes.map(({ result }) => result), ['failed', 'failed', 'failed']);
  assert.match(outcomes[0]!.detail ?? '', /EPERM/);
  await assert.rejects(lstat(config.promptFile), /ENOENT/);
  await assert.rejects(lstat(config.copiesFile), /ENOENT/, 'and copies.json is never written');
});
