import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ABSENT, readEditable, saveEditable, setFocusFields, versionOf } from '../src/editable.ts';
import { parseFocus } from '../src/focus.ts';
import { FOCUS_TEMPLATE } from '../src/templates.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-editable-'));
  dirs.push(dir);
  return join(dir, 'focus.md');
}

test('a missing file reads as absent, and the first save says it expected none', async () => {
  const path = await file();
  assert.deepEqual(await readEditable(path), { text: null, version: ABSENT });

  const saved = await saveEditable(path, 'objective: one', ABSENT);
  assert.deepEqual(saved, { saved: true, version: versionOf('objective: one\n') });
  assert.equal(await readFile(path, 'utf8'), 'objective: one\n', 'and it ends with a newline');
});

test('a save from an older version is refused, and hands back what is there now', async () => {
  const path = await file();
  await writeFile(path, 'first\n');
  const opened = await readEditable(path);
  // Edited by hand in another window meanwhile.
  await writeFile(path, 'second\n');

  const saved = await saveEditable(path, 'third', opened.version);
  assert.deepEqual(saved, { saved: false, text: 'second\n', version: versionOf('second\n') });
  assert.equal(await readFile(path, 'utf8'), 'second\n', 'nothing typed elsewhere is lost');
});

test('setting the objective leaves every other line as it was', () => {
  const text = [
    '---',
    'objective: Old goal',
    'owner: someone',
    '---',
    '',
    'Some prose.',
    '',
    '<!-- agent-only -->',
    'Private context.',
    '',
  ].join('\n');
  const next = setFocusFields(text, { objective: 'Ship the  reliability fix\nthis week', blocker: 'Staging is down' }, FOCUS_TEMPLATE);
  assert.equal(
    next,
    [
      '---',
      'objective: Ship the  reliability fix this week',
      'owner: someone',
      'blocker: Staging is down',
      '---',
      '',
      'Some prose.',
      '',
      '<!-- agent-only -->',
      'Private context.',
      '',
    ].join('\n'),
  );
  const focus = parseFocus(next);
  assert.equal(focus.objective, 'Ship the  reliability fix this week');
  assert.equal(focus.agentOnly, 'Private context.');
});

test('a missing file starts from the template, and a blank field is cleared', () => {
  const fresh = setFocusFields(null, { objective: 'Get staging working again', blocker: null }, FOCUS_TEMPLATE);
  assert.equal(parseFocus(fresh).objective, 'Get staging working again');
  assert.equal(parseFocus(fresh).blocker, null);
  assert.ok(fresh.includes('<!-- agent-only -->'), "the template's private section comes along");

  const cleared = setFocusFields(fresh, { objective: '', blocker: null }, FOCUS_TEMPLATE);
  assert.equal(parseFocus(cleared).objective, null);
  assert.match(cleared, /^---\nobjective:\nblocker:\n---/);
});

test('a file with no frontmatter gets one at the top', () => {
  const next = setFocusFields('Just a sentence.\n', { objective: 'A goal', blocker: null }, FOCUS_TEMPLATE);
  assert.equal(next, '---\nobjective: A goal\nblocker:\n---\n\nJust a sentence.\n');
});

test('two saves from the same version at once: the first lands, the second is told it is stale', async () => {
  const path = await file();
  await writeFile(path, 'start\n');
  const { version } = await readEditable(path);
  const [first, second] = await Promise.all([saveEditable(path, 'one', version), saveEditable(path, 'two', version)]);
  assert.equal(first.saved, true);
  assert.equal(second.saved, false);
  assert.equal(await readFile(path, 'utf8'), 'one\n');
});
