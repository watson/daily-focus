/**
 * The assistant runner, against a script standing in for the CLI.
 *
 * The rules worth holding: the log records every turn and closes orphans, the
 * session id is carried into the next turn as a resume, the reply stays in the
 * chat and touches nothing else, and each CLI's output is read the way it
 * is actually shaped — the fixtures here are lines the real CLIs printed.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  Assistant,
  claudeAdapter,
  codexAdapter,
  composePrompt,
  foldAssistantLog,
  QUICK_ACTIONS,
} from '../src/assistant.ts';
import { loadConfig, type Config } from '../src/config.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A store with a fake `claude` that prints the given stream-json lines and records its argv. */
async function makeConfig(lines: string[], env: Record<string, string> = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-assistant-'));
  dirs.push(dataDir);
  const bin = join(dataDir, 'fake-cli');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${join(dataDir, 'argv')}"`,
    ...lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`),
  ].join('\n');
  await writeFile(bin, `${script}\n`, 'utf8');
  await chmod(bin, 0o755);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_ASSISTANT: 'claude', DAILY_FOCUS_ASSISTANT_BIN: bin, ...env });
}

const INIT = '{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"sess-1","tools":["Bash"]}';
const SAID = (text: string) =>
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const RESULT = (text: string) =>
  `{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":${JSON.stringify(text)}}`;

async function settle(assistant: Assistant, itemId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const entry = assistant.view().items[itemId];
    if (entry && !entry.running && entry.turns.every((turn) => turn.status !== 'running')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the turn never finished');
}

test('a turn is logged as started then finished, with the reply and the session id', async () => {
  const config = await makeConfig([INIT, SAID('Looking…'), RESULT('The review is right.')]);
  const assistant = new Assistant(config, { onChange: () => {} });

  await assistant.ask({ itemId: 'gh:1', action: 'assess-review' }, { item: { id: 'gh:1', title: 'x' } as never });
  await settle(assistant, 'gh:1');

  const entry = assistant.view().items['gh:1']!;
  assert.equal(entry.turns.length, 1);
  assert.equal(entry.turns[0]!.status, 'done');
  assert.equal(entry.turns[0]!.reply, 'The review is right.');
  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.turns[0]!.action, 'assess-review');

  const log = (await readFile(config.assistantLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'finished']);
  assert.equal(log[1].sessionId, 'sess-1');

  // The first turn carries the instructions and the row; the request is last.
  const argv = await readFile(join(config.dataDir, 'argv'), 'utf8');
  assert.ok(argv.includes('--permission-prompts\nnone'));
  assert.ok(argv.includes('--disallowedTools\nEdit\nWrite\nNotebookEdit'));
  assert.ok(!argv.includes('--resume'));
  assert.ok(argv.includes('## Request'));
  assert.ok(argv.includes(QUICK_ACTIONS.find((a) => a.id === 'assess-review')!.request));
});

test('the next turn on the same item resumes the session and sends only the request', async () => {
  const config = await makeConfig([INIT, RESULT('First.')]);
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', text: 'first' }, {});
  await settle(assistant, 'gh:1');

  await assistant.ask({ itemId: 'gh:1', text: 'and then?' }, {});
  await settle(assistant, 'gh:1');

  const argv = (await readFile(join(config.dataDir, 'argv'), 'utf8')).split('\n');
  const resume = argv.indexOf('--resume');
  assert.ok(resume > 0, 'the second turn must resume');
  assert.equal(argv[resume + 1], 'sess-1');
  assert.equal(argv.at(-2), 'and then?', 'a resumed turn sends the request bare');
  assert.equal(assistant.view().items['gh:1']!.turns.length, 2);
});

test('switching CLIs starts a fresh session rather than resuming the other one', async () => {
  const config = await makeConfig([INIT, RESULT('First.')]);
  await writeFile(
    config.assistantLogFile,
    [
      JSON.stringify({ event: 'started', turn: 't1', item: 'gh:1', agent: 'codex', request: 'x', action: null, at: '2026-09-24T08:00:00Z' }),
      JSON.stringify({ event: 'finished', turn: 't1', sessionId: 'codex-thread', reply: 'ok', at: '2026-09-24T08:00:05Z' }),
    ].join('\n') + '\n',
  );
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.start();
  assert.equal(assistant.view().items['gh:1']!.sessionId, null, "a Codex id is not Claude's to resume");

  await assistant.ask({ itemId: 'gh:1', text: 'hello' }, {});
  await settle(assistant, 'gh:1');
  const argv = await readFile(join(config.dataDir, 'argv'), 'utf8');
  assert.ok(!argv.includes('--resume'));
  assert.equal(assistant.view().items['gh:1']!.sessionId, 'sess-1');
});

test('a reply is kept whole; nothing in it becomes a note on the item', async () => {
  const config = await makeConfig([INIT, RESULT('Drafted it.\n\nNote for the morning agent: a draft is waiting.')]);
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'email:thread:1', action: 'draft-reply' }, {});
  await settle(assistant, 'email:thread:1');
  assert.equal(assistant.view().items['email:thread:1']!.turns[0]!.reply, 'Drafted it.\n\nNote for the morning agent: a draft is waiting.');
  await assert.rejects(readFile(config.actionsFile, 'utf8'), 'the action log must not have been created');
});

test('a CLI that exits without a result is a failed turn, in its words', async () => {
  const config = await makeConfig([INIT, 'not json', 'echo "boom" >&2; exit 3']);
  // The last "line" is shell, deliberately: the script prints it as text, so the
  // fake exits 0 with junk. Make a real failure instead.
  await writeFile(config.assistant.binPath, '#!/bin/sh\necho "no such tool" >&2\nexit 3\n', 'utf8');
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');

  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'failed');
  assert.match(turn.error!, /code 3/);
  assert.match(turn.error!, /no such tool/);
});

test('a missing CLI fails the turn with a hint, not a crash', async () => {
  const config = await makeConfig([]);
  const missing = { ...config, assistant: { ...config.assistant, binPath: join(config.dataDir, 'nope') } };
  const assistant = new Assistant(missing, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');
  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'failed');
  assert.match(turn.error!, /DAILY_FOCUS_ASSISTANT_BIN/);
});

test('a turn left running by a dead process is closed as aborted on start', async () => {
  const config = await makeConfig([]);
  await writeFile(
    config.assistantLogFile,
    `${JSON.stringify({ event: 'started', turn: 't1', item: 'gh:1', agent: 'claude', request: 'x', action: null, at: '2026-09-24T08:00:00Z' })}\n`,
  );
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.start();
  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'aborted');
  assert.match(turn.error!, /restarted/);
  const log = (await readFile(config.assistantLogFile, 'utf8')).trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(log[1]!).event, 'aborted');
});

test('one turn per item at a time, and nothing to ask is refused', async () => {
  const config = await makeConfig([INIT, RESULT('ok')]);
  await writeFile(config.assistant.binPath, '#!/bin/sh\nsleep 5\n', 'utf8');
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', text: 'slow' }, {});
  await assert.rejects(assistant.ask({ itemId: 'gh:1', text: 'again' }, {}), /already working/);
  await assert.rejects(assistant.ask({ itemId: 'gh:2', text: '   ' }, {}), /nothing to ask/);
  await assert.rejects(assistant.ask({ itemId: 'gh:2', action: 'no-such-action' }, {}), /nothing to ask/);
  assert.equal(await assistant.stop('gh:1'), true);
  await settle(assistant, 'gh:1');
  assert.equal(assistant.view().items['gh:1']!.turns[0]!.status, 'aborted');
  assert.equal(await assistant.stop('gh:1'), false);
});

test('off means no turns and no log', async () => {
  const config = await makeConfig([], { DAILY_FOCUS_ASSISTANT: 'off' });
  const assistant = new Assistant(config, { onChange: () => {} });
  assert.equal(assistant.enabled, false);
  await assert.rejects(assistant.ask({ itemId: 'gh:1', text: 'hi' }, {}), /off/);
  assert.equal(assistant.view().enabled, false);
});

/* ---------- the pieces ---------- */

test('the log folds forgivingly', () => {
  const text = [
    JSON.stringify({ event: 'started', turn: 'a', item: 'i', agent: 'claude', request: 'q', action: null, at: '1' }),
    '{broken',
    JSON.stringify({ event: 'finished', turn: 'a', sessionId: 's', reply: 'r', at: '2' }),
    JSON.stringify({ event: 'finished', turn: 'never-started', sessionId: 's', reply: 'r', at: '2' }),
    JSON.stringify({ event: 'started', turn: 'b', item: 'i', agent: 'claude', request: 'q2', action: 'x', at: '3' }),
  ].join('\n');
  const turns = foldAssistantLog(text);
  assert.equal(turns.size, 2);
  assert.equal(turns.get('a')!.status, 'done');
  assert.equal(turns.get('a')!.reply, 'r');
  assert.equal(turns.get('a')!.sessionId, 's');
  assert.equal(turns.get('b')!.status, 'running');
});

test('the Claude adapter reads what Claude Code prints', () => {
  assert.deepEqual(claudeAdapter.parse(INIT), { sessionId: 'sess-1' });
  assert.deepEqual(claudeAdapter.parse(SAID('hello')), { text: 'hello' });
  assert.equal(claudeAdapter.parse('{"type":"rate_limit_event"}'), null);
  assert.equal(claudeAdapter.parse('plain text'), null);
  assert.deepEqual(claudeAdapter.parse(RESULT('done')), { sessionId: 'sess-1', done: { ok: true, reply: 'done' } });
  assert.deepEqual(
    claudeAdapter.parse('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Rate limited"}'),
    { done: { ok: false, error: 'Rate limited' } },
  );

  const args = claudeAdapter.args({ prompt: 'p', sessionId: null, model: 'opus', effort: 'high', tools: ['Bash(gh *)'] });
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'opus');
  assert.ok(args.includes('--effort') && args[args.indexOf('--effort') + 1] === 'high');
  assert.ok(args.includes('--allowedTools') && args[args.indexOf('--allowedTools') + 1] === 'Bash(gh *)');
  assert.equal(args.at(-1), 'p');

  const bare = claudeAdapter.args({ prompt: 'p', sessionId: 'abc', model: null, effort: null, tools: [] });
  assert.ok(!bare.includes('--model') && !bare.includes('--effort') && !bare.includes('--allowedTools'));
  assert.ok(bare.includes('--resume') && bare[bare.indexOf('--resume') + 1] === 'abc');
});

test('the Codex adapter reads what Codex prints', () => {
  assert.deepEqual(codexAdapter.parse('{"type":"thread.started","thread_id":"t-1"}'), { sessionId: 't-1' });
  assert.deepEqual(codexAdapter.parse('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}'), { text: 'OK' });
  assert.equal(codexAdapter.parse('{"type":"item.completed","item":{"type":"reasoning","text":"…"}}'), null);
  assert.deepEqual(codexAdapter.parse('{"type":"turn.completed","usage":{}}'), { done: { ok: true } });
  assert.deepEqual(codexAdapter.parse('{"type":"turn.failed","error":{"message":"nope"}}'), { done: { ok: false, error: 'nope' } });

  const first = codexAdapter.args({ prompt: 'p', sessionId: null, model: 'gpt-x', effort: 'low', tools: [] });
  assert.deepEqual(first.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.ok(first.includes('-c') && first.includes('model="gpt-x"') && first.includes('model_reasoning_effort="low"'));
  assert.ok(first.includes('sandbox_mode="workspace-write"') && first.includes('sandbox_workspace_write.network_access=true'));

  const again = codexAdapter.args({ prompt: 'p', sessionId: 't-1', model: null, effort: null, tools: [] });
  assert.deepEqual(again.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(again.slice(-2), ['t-1', 'p']);
  assert.ok(again.includes('sandbox_workspace_write.network_access=true'), 'the resumed turn is sandboxed the same way');
});

test('the first prompt carries the instructions, the row and the request, in that order', () => {
  const prompt = composePrompt('Be brief.', { item: { id: 'gh:1', title: 'T' } as never }, 'Why?', 'work');
  const at = (s: string) => prompt.indexOf(s);
  assert.ok(at('Be brief.') < at('## Context') && at('## Context') < at('"id": "gh:1"') && at('"id": "gh:1"') < at('## Request'));
  assert.ok(prompt.endsWith('Why?'));
  assert.ok(prompt.includes('- Profile: work'));
});

test('a quick action plus typed text sends both', () => {
  const action = QUICK_ACTIONS.find((a) => a.id === 'explain-ci')!;
  assert.deepEqual(Assistant.requestFor({ itemId: 'x', action: 'explain-ci', text: 'the lint job' }), {
    request: `${action.request}\n\nthe lint job`,
    action: 'explain-ci',
  });
  assert.deepEqual(Assistant.requestFor({ itemId: 'x', text: 'just this' }), { request: 'just this', action: null });
  assert.equal(Assistant.requestFor({ itemId: 'x' }), null);
});

test('every quick action names sources the schema knows, or none', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema/items.schema.json', import.meta.url), 'utf8')) as {
    $defs: { item: { properties: { source: { enum: string[] } } } };
  };
  const known = new Set(schema.$defs.item.properties.source.enum);
  const ids = new Set<string>();
  for (const action of QUICK_ACTIONS) {
    assert.ok(!ids.has(action.id), `duplicate quick action id ${action.id}`);
    ids.add(action.id);
    for (const source of action.sources ?? []) assert.ok(known.has(source), `${action.id} names unknown source ${source}`);
  }
});
