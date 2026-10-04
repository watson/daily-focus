import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { fillIdentity, findExecutable, firstBriefPending, placeholdersIn, setupState } from '../src/setup.ts';
import { sourcesTemplate } from '../src/templates.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-setup-'));
  dirs.push(dir);
  return dir;
}

test('both templates are full of placeholders, and a filled-in list has none', () => {
  assert.ok(placeholdersIn(sourcesTemplate('work')) >= 5);
  assert.ok(placeholdersIn(sourcesTemplate('personal')) >= 3);
  assert.equal(placeholdersIn('## Identity\n\n- Name: `Alex Example`\n'), 0);
});

test('what gh and git know replaces the identity placeholders, and nothing else', () => {
  const filled = fillIdentity(sourcesTemplate('work'), { name: 'Alex Example', login: 'alex-example', email: 'alex@example.org' });
  assert.match(filled, /`Alex Example`/);
  assert.match(filled, /`alex@example.org`/);
  assert.match(filled, /`alex-example`/);
  assert.match(filled, /Some Shared Calendar/, 'the calendars are still for the user to name');
  assert.equal(fillIdentity('`Your Name`', { name: null, login: null, email: null }), '`Your Name`', 'an unknown stays a placeholder');
});

test('a program is found where a shell would find it, and only if it can run', async () => {
  const dir = await temp();
  await writeFile(join(dir, 'claude'), '#!/bin/sh\n');
  await chmod(join(dir, 'claude'), 0o755);
  await writeFile(join(dir, 'codex'), 'not executable\n');
  assert.equal(await findExecutable('claude', `/nowhere:${dir}`), join(dir, 'claude'));
  assert.equal(await findExecutable('codex', dir), null);
  assert.equal(await findExecutable(join(dir, 'claude'), ''), join(dir, 'claude'), 'a path is checked as it is');
});

test("a store is new until something has written a brief, and an archived one counts", async () => {
  const dir = await temp();
  const config = loadConfig({ DAILY_FOCUS_DATA: dir, DAILY_FOCUS_CALENDAR: 'off' });
  assert.equal(await firstBriefPending(config), true);
  await mkdir(config.archiveDir);
  await writeFile(join(config.archiveDir, '2026-10-01.json'), '{}');
  assert.equal(await firstBriefPending(config), false);

  const fresh = await temp();
  const other = loadConfig({ DAILY_FOCUS_DATA: fresh });
  await writeFile(other.itemsFile, '{}');
  assert.equal(await firstBriefPending(other), false);
});

test('the setup state counts placeholders without carrying the text', async () => {
  const dir = await temp();
  const config = loadConfig({ DAILY_FOCUS_DATA: dir });
  await writeFile(config.sourcesFile, sourcesTemplate('work'));
  const setup = await setupState(config, { briefExists: false, profileChosen: true });
  assert.equal(setup.needed, true);
  assert.equal(setup.profile, 'work');
  assert.equal(setup.sources.exists, true);
  assert.ok(setup.sources.placeholders > 0);
  assert.ok(!JSON.stringify(setup).includes('Identity'), 'never the text itself');
});
