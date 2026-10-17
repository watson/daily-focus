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
  connectorLabel,
  foldAssistantLog,
  QUICK_ACTIONS,
  unwrapShell,
} from '../src/assistant.ts';
import { CONNECTOR_POLICY, GMAIL_DRAFTS } from '../src/codex.ts';
import { briefWritingTools, DEFAULT_AGENT_TOOLS, DEFAULT_ASSISTANT_TOOLS, loadConfig, type Config } from '../src/config.ts';
import type { ExecFile } from '../src/shellpath.ts';

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

/** A tool call, as Claude Code prints one. */
const CALLED = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }] } });
/** A tool's answer, which Claude Code prints as a user message. */
const ANSWERED = (id: string, isError = false) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: isError ? 'denied' : 'ok', is_error: isError }] } });

/**
 * Wait until every turn on the item is over, and logged as over: a turn is
 * marked done in memory a moment before its closing line reaches the log, and
 * a test that reads the log must not land in between.
 */
async function settle(assistant: Assistant, itemId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const entry = assistant.view().items[itemId];
    if (entry && !entry.running && entry.turns.every((turn) => turn.status !== 'running') && (await logged(assistant, entry.turns))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the turn never finished');
}

async function logged(assistant: Assistant, turns: readonly { id: string }[]): Promise<boolean> {
  const file = (assistant as unknown as { config: Config }).config.assistantLogFile;
  const text = await readFile(file, 'utf8').catch(() => '');
  const closed = new Set(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; turn: string })
      .filter((record) => record.event !== 'started')
      .map((record) => record.turn),
  );
  return turns.every((turn) => closed.has(turn.id));
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

test('what it did on the way is kept as steps, and the reply is only the answer', async () => {
  const config = await makeConfig([
    INIT,
    SAID('Reading the review first.'),
    CALLED('toolu_1', 'Bash', { command: 'gh pr view 1 --comments', description: 'View the pull request' }),
    ANSWERED('toolu_1'),
    CALLED('toolu_2', 'Bash', { command: 'gh api repos/acme/private/pulls/1' }),
    ANSWERED('toolu_2', true),
    SAID('The review is right.'),
    RESULT('The review is right.'),
  ]);
  const changes: number[] = [];
  const assistant = new Assistant(config, { onChange: () => changes.push(Date.now()) });
  await assistant.ask({ itemId: 'gh:1', action: 'assess-review' }, {});
  await settle(assistant, 'gh:1');

  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.reply, 'The review is right.', 'the narration is not part of the answer');
  assert.deepEqual(turn.steps, [
    { kind: 'message', text: 'Reading the review first.', detail: null, state: 'done' },
    { kind: 'tool', text: 'View the pull request', detail: 'gh pr view 1 --comments', state: 'done' },
    { kind: 'tool', text: 'Run a command', detail: 'gh api repos/acme/private/pulls/1', state: 'failed' },
  ]);
  assert.ok(changes.length >= 6, 'each step reaches the tabs as it happens');

  // And the log keeps them, so a reload shows the same trail.
  const log = (await readFile(config.assistantLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log[1].steps, turn.steps);
  assert.deepEqual(foldAssistantLog(await readFile(config.assistantLogFile, 'utf8')).get(turn.id)!.steps, turn.steps);
});

test('a turn that fails keeps everything it said as steps, and a call left hanging failed with it', async () => {
  const config = await makeConfig([INIT, SAID('Checking the CI log.'), CALLED('toolu_1', 'Bash', { command: 'gh run view 7 --log-failed' })]);
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', action: 'explain-ci' }, {});
  await settle(assistant, 'gh:1');

  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'failed');
  assert.equal(turn.reply, '', 'nothing it said on the way was an answer');
  assert.deepEqual(
    turn.steps.map((step) => [step.kind, step.state]),
    [
      ['message', 'done'],
      ['tool', 'failed'],
    ],
  );
});

test('under Codex, the last message is the answer and the earlier ones are steps', async () => {
  const config = await makeConfig(
    [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll read the thread first.\\n"}}',
      `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'gh pr view 1'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'gh pr view 1'","aggregated_output":"ok","exit_code":0,"status":"completed"}}`,
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Drafted."}}',
      '{"type":"turn.completed","usage":{}}',
    ],
    { DAILY_FOCUS_ASSISTANT: 'codex', DAILY_FOCUS_ASSISTANT_COMPUTER_USE: 'on' },
  );
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, listing([]));
  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');

  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.reply, 'Drafted.');
  assert.deepEqual(turn.steps, [
    { kind: 'message', text: 'I’ll read the thread first.\n', detail: null, state: 'done' },
    { kind: 'tool', text: 'Run a command', detail: 'gh pr view 1', state: 'done' },
  ]);
});

test('a turn asked ahead carries its key into the log, and back out of it', async () => {
  const config = await makeConfig([INIT, RESULT('Dana is right.')]);
  const assistant = new Assistant(config, { onChange: () => {} });
  await assistant.ask({ itemId: 'gh:1', action: 'assess-review' }, {}, { auto: 'assess-review@2026-10-16T09:00:00Z' });
  await assistant.ask({ itemId: 'gh:2', text: 'mine' }, {});
  await settle(assistant, 'gh:1');
  await settle(assistant, 'gh:2');

  const log = (await readFile(config.assistantLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const started = log.filter((record) => record.event === 'started');
  assert.equal(started.find((record) => record.item === 'gh:1').auto, 'assess-review@2026-10-16T09:00:00Z');
  assert.ok(!('auto' in started.find((record) => record.item === 'gh:2')), "a turn the user asked carries none");

  const reread = new Assistant(config, { onChange: () => {} });
  await reread.start();
  assert.deepEqual(
    reread.autoTurns().map((turn) => [turn.itemId, turn.auto, turn.status]),
    [['gh:1', 'assess-review@2026-10-16T09:00:00Z', 'done']],
  );
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

/* ---------- under Codex ---------- */

const CODEX_LINES = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Drafted."}}',
  '{"type":"turn.completed","usage":{}}',
];

/**
 * A Codex that says it is 0.162.1 and lists these servers, less any switched off
 * by a `-c` override. Every `mcp list` is recorded in `calls`.
 */
function listing(servers: { name: string; enabled: boolean }[], calls: string[][] = []): ExecFile {
  return async (_file, args) => {
    if (args[0] === '--version') return 'codex-cli 0.162.1\n';
    calls.push([...args]);
    const off = args.filter((arg) => arg.startsWith('mcp_servers.')).map((arg) => arg.split('.')[1]);
    return JSON.stringify(servers.map((server) => (off.includes(server.name) ? { ...server, enabled: false } : server)));
  };
}

test('under Codex, connector writes are refused but drafts, and computer use is switched off by default', async () => {
  const config = await makeConfig(CODEX_LINES, { DAILY_FOCUS_ASSISTANT: 'codex' });
  assert.equal(config.assistant.computerUse, false, 'computer use is off unless turned on');
  const calls: string[][] = [];
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, listing([{ name: 'node_repl', enabled: true }], calls));

  await assistant.ask({ itemId: 'email:thread:1', action: 'draft-reply' }, {});
  await settle(assistant, 'email:thread:1');
  assert.equal(assistant.view().items['email:thread:1']!.turns[0]!.status, 'done');

  const argv = (await readFile(join(config.dataDir, 'argv'), 'utf8')).split('\n');
  for (const override of [...CONNECTOR_POLICY, ...GMAIL_DRAFTS]) assert.ok(argv.includes(override), `missing ${override}`);
  assert.ok(argv.includes('plugins.unified-computer-use@openai-bundled.enabled=false'));
  assert.ok(argv.includes('mcp_servers.node_repl.enabled=false'), 'a server from your own config goes too');

  // Codex is asked once per process, not once per turn.
  await assistant.ask({ itemId: 'email:thread:1', text: 'shorter' }, {});
  await settle(assistant, 'email:thread:1');
  assert.equal(calls.length, 2, 'two looks for the first turn, none for the next');
  const resumed = (await readFile(join(config.dataDir, 'argv'), 'utf8')).split('\n');
  assert.ok(resumed.includes('resume') && resumed.includes('mcp_servers.node_repl.enabled=false'), 'a resumed turn is held the same way');
});

test('under Codex with computer use turned on, Codex is not asked and nothing is switched off', async () => {
  const config = await makeConfig(CODEX_LINES, { DAILY_FOCUS_ASSISTANT: 'codex', DAILY_FOCUS_ASSISTANT_COMPUTER_USE: 'on' });
  const calls: string[][] = [];
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, listing([{ name: 'node_repl', enabled: true }], calls));
  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');
  const argv = await readFile(join(config.dataDir, 'argv'), 'utf8');
  assert.equal(calls.length, 0);
  assert.ok(!argv.includes('plugins.') && !argv.includes('mcp_servers.'));
  assert.ok(argv.includes(CONNECTOR_POLICY[0]!), 'connector writes are refused either way');
});

test("under Codex, a turn whose computer use can't be confirmed off fails and starts nothing", async () => {
  const config = await makeConfig(CODEX_LINES, { DAILY_FOCUS_ASSISTANT: 'codex' });
  let refusals = 0;
  const refuses: ExecFile = async (_file, args) => {
    if (args[0] === '--version') return 'codex-cli 0.162.1\n';
    refusals += 1;
    throw new Error('Error: invalid transport');
  };
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, refuses);
  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');
  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'failed');
  assert.match(turn.error!, /computer use is off in the settings, and Codex could not confirm it: Error: invalid transport/);
  await assert.rejects(readFile(join(config.dataDir, 'argv'), 'utf8'), 'the CLI never ran');

  // Not remembered: the next turn asks again.
  await assistant.ask({ itemId: 'gh:1', text: 'again' }, {});
  await settle(assistant, 'gh:1');
  assert.equal(refusals, 2);
});

test('under Codex older than 0.144.0, a turn is refused and nothing is started', async () => {
  const config = await makeConfig(CODEX_LINES, { DAILY_FOCUS_ASSISTANT: 'codex', DAILY_FOCUS_ASSISTANT_COMPUTER_USE: 'on' });
  let version = 'codex-cli 0.143.0\n';
  const old: ExecFile = async (_file, args) => (args[0] === '--version' ? version : '[]');
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, old);

  await assistant.ask({ itemId: 'gh:1', text: 'hi' }, {});
  await settle(assistant, 'gh:1');
  const turn = assistant.view().items['gh:1']!.turns[0]!;
  assert.equal(turn.status, 'failed');
  assert.match(turn.error!, /Codex 0\.143\.0 is older than 0\.144\.0/);
  await assert.rejects(readFile(join(config.dataDir, 'argv'), 'utf8'), 'the CLI never ran');

  // Updated without a restart: the next turn asks again, and runs.
  version = 'codex-cli 0.144.0\n';
  await assistant.ask({ itemId: 'gh:1', text: 'again' }, {});
  await settle(assistant, 'gh:1');
  assert.equal(assistant.view().items['gh:1']!.turns.at(-1)!.status, 'done');
});

/* ---------- the pieces ---------- */

test('the log folds forgivingly', () => {
  const text = [
    JSON.stringify({ event: 'started', turn: 'a', item: 'i', agent: 'claude', request: 'q', action: null, at: '1' }),
    '{broken',
    JSON.stringify({
      event: 'finished',
      turn: 'a',
      sessionId: 's',
      reply: 'r',
      steps: [{ kind: 'tool', text: 'Run a command', detail: 'gh pr view 1', state: 'failed' }, { text: 7 }, null, { text: 'said', kind: 'message' }],
      at: '2',
    }),
    JSON.stringify({ event: 'finished', turn: 'never-started', sessionId: 's', reply: 'r', at: '2' }),
    JSON.stringify({ event: 'started', turn: 'b', item: 'i', agent: 'claude', request: 'q2', action: 'x', at: '3' }),
  ].join('\n');
  const turns = foldAssistantLog(text);
  assert.equal(turns.size, 2);
  assert.equal(turns.get('a')!.status, 'done');
  assert.equal(turns.get('a')!.reply, 'r');
  assert.equal(turns.get('a')!.sessionId, 's');
  assert.deepEqual(turns.get('a')!.steps, [
    { kind: 'tool', text: 'Run a command', detail: 'gh pr view 1', state: 'failed' },
    { kind: 'message', text: 'said', detail: null, state: 'done' },
  ]);
  assert.equal(turns.get('b')!.status, 'running');
  assert.deepEqual(turns.get('b')!.steps, [], 'a line from before steps were kept has none');
});

/** The options every adapter test starts from. */
const BASE = { prompt: 'p', sessionId: null, model: null, effort: null, tools: [], denyEdits: true, drafts: false, codexConfig: [] };

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

  const args = claudeAdapter.args({ ...BASE, model: 'opus', effort: 'high', tools: ['Bash(gh *)'], codexConfig: ['x=1'] });
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'opus');
  assert.ok(args.includes('--effort') && args[args.indexOf('--effort') + 1] === 'high');
  assert.ok(args.includes('--allowedTools') && args[args.indexOf('--allowedTools') + 1] === 'Bash(gh *)');
  assert.equal(args.at(-1), 'p');
  assert.ok(!args.includes('-c') && !args.includes('x=1'), "Codex's config is Codex's alone");

  const bare = claudeAdapter.args({ ...BASE, sessionId: 'abc' });
  assert.ok(!bare.includes('--model') && !bare.includes('--effort') && !bare.includes('--allowedTools'));
  assert.ok(bare.includes('--resume') && bare[bare.indexOf('--resume') + 1] === 'abc');
});

test("the Claude adapter turns tool calls into steps, and the tools' answers into how they went", () => {
  assert.deepEqual(claudeAdapter.parse(CALLED('toolu_1', 'Bash', { command: 'echo hello', description: 'Print hello' })), {
    steps: [{ id: 'toolu_1', text: 'Print hello', detail: 'echo hello', state: 'running' }],
  });
  assert.deepEqual(claudeAdapter.parse(ANSWERED('toolu_1')), { steps: [{ id: 'toolu_1', state: 'done' }] });
  assert.deepEqual(claudeAdapter.parse(ANSWERED('toolu_2', true)), { steps: [{ id: 'toolu_2', state: 'failed' }] });

  // A message can say something and call a tool at once; the text came first.
  const both = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't', name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } }] },
  });
  assert.deepEqual(claudeAdapter.parse(both), {
    text: 'Looking.',
    steps: [{ id: 't', text: 'Fetch a page', detail: 'https://example.com/a', state: 'running' }],
  });

  const gmail = claudeAdapter.parse(CALLED('t', 'mcp__claude_ai_Gmail__get_thread', { threadId: '18f2' }));
  assert.deepEqual(gmail?.steps, [{ id: 't', text: 'Gmail: get thread', detail: '{"threadId":"18f2"}', state: 'running' }]);
  assert.equal(claudeAdapter.parse(CALLED('t', 'ToolSearch', { query: 'select:x' })), null, "Claude Code's housekeeping is not a step");
  assert.equal(claudeAdapter.parse(CALLED('t', 'Bash', { command: 'a'.repeat(500) }))!.steps![0]!.detail!.length, 200);
  assert.equal(claudeAdapter.parse(CALLED('t', 'Bash', { command: 'cat <<EOF\nsecret\nEOF' }))!.steps![0]!.detail, 'cat <<EOF …');
});

test('the Codex adapter turns commands, connector calls and searches into steps', () => {
  const item = (event: string, fields: Record<string, unknown>) => JSON.stringify({ type: event, item: fields });
  const command = { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls /nope'", aggregated_output: '' };
  assert.deepEqual(codexAdapter.parse(item('item.started', { ...command, exit_code: null, status: 'in_progress' })), {
    steps: [{ id: 'item_1', text: 'Run a command', detail: 'ls /nope', state: 'running' }],
  });
  assert.equal(codexAdapter.parse(item('item.completed', { ...command, exit_code: 1, status: 'failed' }))!.steps![0]!.state, 'failed');
  assert.equal(codexAdapter.parse(item('item.completed', { ...command, exit_code: 0, status: 'completed' }))!.steps![0]!.state, 'done');

  // A search doesn't know its query until it is done.
  assert.deepEqual(codexAdapter.parse(item('item.started', { id: 'ws', type: 'web_search', query: '', action: { type: 'other' } }))!.steps, [
    { id: 'ws', text: 'Search the web', detail: null, state: 'running' },
  ]);
  const searched = item('item.completed', { id: 'ws', type: 'web_search', query: 'node lts', action: { type: 'search', query: 'node lts' } });
  assert.deepEqual(codexAdapter.parse(searched)!.steps, [{ id: 'ws', text: 'Search the web', detail: 'node lts', state: 'done' }]);
  const opened = item('item.completed', { id: 'ws', type: 'web_search', query: 'https://x.dev', action: { type: 'open_page', url: 'https://x.dev' } });
  assert.deepEqual(codexAdapter.parse(opened)!.steps, [{ id: 'ws', text: 'Open a page', detail: 'https://x.dev', state: 'done' }]);

  const mcp = { id: 'm', type: 'mcp_tool_call', server: 'codex_apps', tool: 'gmail_create_draft', arguments: { thread_id: '18f2' } };
  assert.deepEqual(codexAdapter.parse(item('item.completed', { ...mcp, status: 'completed' }))!.steps, [
    { id: 'm', text: 'Gmail create draft', detail: '{"thread_id":"18f2"}', state: 'done' },
  ]);
  assert.equal(codexAdapter.parse(item('item.completed', { ...mcp, status: 'failed', error: { message: 'refused' } }))!.steps![0]!.state, 'failed');
  assert.equal(codexAdapter.parse(item('item.completed', { id: 'r', type: 'reasoning', text: '…' })), null);
  assert.equal(codexAdapter.parse(item('item.started', { id: 'f', type: 'file_change', changes: [] })), null);
});

test('a busy service, a model the account lacks and a plan without the CLI each fail in a sentence that says so', () => {
  const claudeFailed = (result: string) =>
    claudeAdapter.parse(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result }))!.done;
  assert.deepEqual(claudeFailed('API Error: Repeated 529 Overloaded errors'), { ok: false, error: 'Claude is busy right now', cause: 'busy' });
  assert.deepEqual(claudeFailed('Opus is experiencing high load, please use /model to switch to Sonnet'), {
    ok: false,
    error: 'Claude is busy right now',
    cause: 'busy',
  });
  assert.deepEqual(claudeFailed("There's an issue with the selected model (claude-opus-0). It may not exist or you may not have access to it."), {
    ok: false,
    error: "your Claude account can't use the model “claude-opus-0”",
    cause: 'model',
  });

  // Codex puts the server's JSON error object in the event's message, on both the error and the failed turn.
  const server = (message: string) => JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message } });
  const notSupported = server("The 'gpt-0' model is not supported when using Codex with a ChatGPT account.");
  const expected = { ok: false, error: "your ChatGPT plan or workspace doesn't include the model “gpt-0”", cause: 'model' };
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'error', message: notSupported }))!.done, expected);
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'turn.failed', error: { message: notSupported } }))!.done, expected);
  assert.deepEqual(
    codexAdapter.parse(JSON.stringify({ type: 'error', message: 'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.' }))!.done,
    { ok: false, error: "your ChatGPT plan doesn't include the Codex CLI, which needs Plus or higher", cause: 'plan' },
  );
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'error', message: 'Selected model is at capacity. Please try a different model.' }))!.done, {
    ok: false,
    error: 'Codex is busy right now',
    cause: 'busy',
  });

  // Anything else is as the CLI said it, out of its wrapping.
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'error', message: server('Your input exceeds the context window.') }))!.done, {
    ok: false,
    error: 'Your input exceeds the context window.',
  });
  assert.deepEqual(codexAdapter.parse(JSON.stringify({ type: 'error', message: 'stream disconnected' }))!.done, { ok: false, error: 'stream disconnected' });
  assert.deepEqual(claudeFailed('Rate limited'), { ok: false, error: 'Rate limited' });
});

test("the Claude adapter tells a subagent's lines from the agent's, and a handoff waits for word of how it ended", () => {
  // The call that hands the work over, then the subagent's own lines, under the call's id.
  assert.deepEqual(claudeAdapter.parse(CALLED('toolu_a', 'Agent', { description: 'Read the inbox', prompt: '…', subagent_type: 'general-purpose' })), {
    steps: [{ id: 'toolu_a', text: 'Hand part of it to a subagent', detail: 'Read the inbox', state: 'running', handoff: true }],
  });
  const sub = (content: unknown[]) => JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_a', message: { content } });
  assert.deepEqual(claudeAdapter.parse(sub([{ type: 'text', text: 'Three threads.' }])), { text: 'Three threads.', by: 'toolu_a' });
  assert.deepEqual(claudeAdapter.parse(sub([{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/x' } }])), {
    steps: [{ id: 'toolu_b', text: 'Read a file', detail: '/x', state: 'running' }],
    by: 'toolu_a',
  });
  // The agent's own lines name nobody.
  assert.equal(claudeAdapter.parse(SAID('hello'))!.by, undefined);

  const notified = (status: string) =>
    JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_a', status, session_id: 'sess-1' });
  assert.deepEqual(claudeAdapter.parse(notified('completed')), { steps: [{ id: 'toolu_a', state: 'done', final: true }] });
  assert.deepEqual(claudeAdapter.parse(notified('failed')), { steps: [{ id: 'toolu_a', state: 'failed', final: true }] });
  // Its other system lines still only say whose session it is.
  assert.deepEqual(claudeAdapter.parse('{"type":"system","subtype":"task_started","tool_use_id":"toolu_a","session_id":"sess-1"}'), {
    sessionId: 'sess-1',
  });
});

test('the Codex adapter shows its wait for its subagents, the one part of them it prints', () => {
  const wait = (event: string, status: string) =>
    JSON.stringify({
      type: event,
      item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'th', receiver_thread_ids: [], prompt: null, agents_states: {}, status },
    });
  assert.deepEqual(codexAdapter.parse(wait('item.started', 'in_progress'))!.steps, [
    { id: 'item_1', text: 'Wait for its subagents', detail: null, state: 'running' },
  ]);
  assert.equal(codexAdapter.parse(wait('item.completed', 'completed'))!.steps![0]!.state, 'done');
  const other = JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'collab_tool_call', tool: 'send_input', status: 'completed' } });
  assert.equal(codexAdapter.parse(other), null);
});

test("a step names a connector's tool and the command that was asked for", () => {
  assert.equal(connectorLabel('claude_ai_Gmail', 'search_threads'), 'Gmail: search threads');
  assert.equal(connectorLabel('atlassian', 'getJiraIssue'), 'atlassian: getJiraIssue');
  assert.equal(connectorLabel('codex_apps', 'gmail_get_thread'), 'Gmail get thread');
  assert.equal(unwrapShell("/bin/zsh -lc 'gh pr view 1'"), 'gh pr view 1');
  assert.equal(unwrapShell(`bash -lc 'echo '\\''hi'\\'''`), "echo 'hi'");
  assert.equal(unwrapShell('/bin/sh -c "ls -la"'), 'ls -la');
  assert.equal(unwrapShell('gh pr view 1'), 'gh pr view 1');
});

test('Claude receives the first prompt separately from the default tool permissions', () => {
  for (const denyEdits of [false, true]) {
    const tools = denyEdits ? DEFAULT_ASSISTANT_TOOLS : [...briefWritingTools(), ...DEFAULT_AGENT_TOOLS];
    const prompt = 'Reply with just: ok';
    const args = claudeAdapter.args({ ...BASE, prompt, tools, denyEdits });
    const allowedTools = args.indexOf('--allowedTools');
    const separator = args.indexOf('--');

    // Claude's variadic --allowedTools otherwise consumes the prompt as a tool name.
    assert.ok(separator > allowedTools, 'the tool list must end before the prompt');
    assert.deepEqual(args.slice(allowedTools + 1, separator), tools);
    assert.deepEqual(args.slice(separator + 1), [prompt]);
  }
});

test('the Codex adapter reads what Codex prints', () => {
  assert.deepEqual(codexAdapter.parse('{"type":"thread.started","thread_id":"t-1"}'), { sessionId: 't-1' });
  assert.deepEqual(codexAdapter.parse('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}'), { text: 'OK' });
  assert.equal(codexAdapter.parse('{"type":"item.completed","item":{"type":"reasoning","text":"…"}}'), null);
  assert.deepEqual(codexAdapter.parse('{"type":"turn.completed","usage":{}}'), { done: { ok: true } });
  assert.deepEqual(codexAdapter.parse('{"type":"turn.failed","error":{"message":"nope"}}'), { done: { ok: false, error: 'nope' } });

  const first = codexAdapter.args({ ...BASE, model: 'gpt-x', effort: 'low', drafts: true, codexConfig: ['plugins.x.enabled=false'] });
  assert.deepEqual(first.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.ok(first.includes('-c') && first.includes('model="gpt-x"') && first.includes('model_reasoning_effort="low"'));
  assert.ok(first.includes('sandbox_mode="workspace-write"') && first.includes('sandbox_workspace_write.network_access=true'));
  for (const override of [...CONNECTOR_POLICY, ...GMAIL_DRAFTS, 'plugins.x.enabled=false']) {
    assert.equal(first[first.indexOf(override) - 1], '-c', `${override} is passed as config`);
  }
  // The shell is the user's own Codex config's: nothing here touches how it is approved.
  assert.ok(!first.some((arg) => arg.startsWith('approval_policy') || arg === 'approvals_reviewer="user"'));
  assert.ok(!first.includes('--ignore-rules') && !first.includes('--ignore-user-config'));

  const again = codexAdapter.args({ ...BASE, sessionId: 't-1' });
  assert.deepEqual(again.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(again.slice(-2), ['t-1', 'p']);
  assert.ok(again.includes('sandbox_workspace_write.network_access=true'), 'the resumed turn is sandboxed the same way');
  assert.ok(CONNECTOR_POLICY.every((override) => again.includes(override)), 'and held to reading connectors');
  assert.ok(!GMAIL_DRAFTS.some((override) => again.includes(override)), 'drafts only when asked for');
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
