/**
 * Rerunning the morning agent, against a script standing in for the CLI.
 *
 * The rules worth holding: the run starts in the store on the scheduled
 * wrapper, the brief is the agent's to write and never the runner's, the report
 * is the agent's last word, and a run is recorded, closed on restart, and one at
 * a time.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AgentRunner, agentPrompt, displayPath, foldAgentLog } from '../src/agent.ts';
import { loadConfig, type Config } from '../src/config.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * A store with a fake CLI that records its argv and working directory, runs
 * `body` as shell, then prints the given JSON lines.
 */
async function makeConfig(lines: string[], env: Record<string, string> = {}, body = ''): Promise<Config> {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'daily-focus-agent-')));
  dirs.push(dataDir);
  const bin = join(tmpdir(), `daily-focus-fake-agent-${dirs.length}-${process.pid}`);
  dirs.push(bin);
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${join(dataDir, '.argv')}"`,
    `pwd > "${join(dataDir, '.cwd')}"`,
    body,
    ...lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`),
  ].join('\n');
  await writeFile(bin, `${script}\n`, 'utf8');
  await chmod(bin, 0o755);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_BIN: bin, ...env });
}

const THREAD = '{"type":"thread.started","thread_id":"thread-1"}';
const SAID = (text: string) => `{"type":"item.completed","item":{"id":"i","type":"agent_message","text":${JSON.stringify(text)}}}`;
const DONE = '{"type":"turn.completed","usage":{}}';

async function settle(runner: AgentRunner): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (runner.view().last?.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run never finished');
}

test('a run starts in the store on the scheduled wrapper, and keeps the last word as the report', async () => {
  const config = await makeConfig(
    [THREAD, SAID('Reading the prompt.'), SAID('Wrote 7 items; Calendar was unreachable.'), DONE],
    { DAILY_FOCUS_AGENT_MODEL: 'some-model', DAILY_FOCUS_AGENT_EFFORT: 'xhigh' },
    // The agent writes the brief, the way the prompt tells it to.
    `printf '{"version":1,"items":[]}' > items.json.tmp && mv items.json.tmp items.json`,
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await settle(runner);

  const run = runner.view().last!;
  assert.equal(run.status, 'done');
  assert.equal(run.report, 'Wrote 7 items; Calendar was unreachable.');
  assert.equal(run.sessionId, 'thread-1');

  assert.equal((await readFile(join(config.dataDir, '.cwd'), 'utf8')).trim(), config.dataDir);
  const argv = (await readFile(join(config.dataDir, '.argv'), 'utf8')).trimEnd().split('\n');
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('model="some-model"') && argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(argv.includes('sandbox_mode="workspace-write"'), 'writes are confined to the store');
  assert.ok(!argv.includes('resume'), 'every run is a fresh session');
  // The wrapper is the prompt's last argument, over several lines.
  const prompt = argv.slice(argv.indexOf('Run my morning brief for today.')).join('\n');
  assert.equal(prompt, agentPrompt(displayPath(config.promptFile)));

  assert.equal(await readFile(config.itemsFile, 'utf8'), '{"version":1,"items":[]}');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'finished']);
  assert.equal(log[1].report, run.report);
});

test('under Claude Code, editing is allowed but only for the brief', async () => {
  const config = await makeConfig(
    ['{"type":"system","subtype":"init","session_id":"s-1"}', '{"type":"result","subtype":"success","is_error":false,"result":"Done."}'],
    { DAILY_FOCUS_AGENT: 'claude', DAILY_FOCUS_AGENT_TOOLS: 'mcp__calendar' },
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await settle(runner);
  assert.equal(runner.view().last!.report, 'Done.');

  const argv = (await readFile(join(config.dataDir, '.argv'), 'utf8')).split('\n');
  assert.ok(!argv.includes('--disallowedTools'), 'the agent has to be able to write its brief');
  assert.ok(argv.includes('Write(./items.json.*)') && argv.includes('Bash(mv items.json.* items.json)'));
  assert.ok(argv.includes('mcp__calendar'), 'the configured source tools come along');
  assert.ok(!argv.includes('Bash(gh *)'), 'and replace the default ones');
  assert.ok(!argv.some((arg) => /^(Write|Edit)\(\.\/(actions|focus|sessions)/.test(arg)));
});

test('a CLI that exits without finishing is a failed run, in its words', async () => {
  const config = await makeConfig([], {}, 'echo "not logged in" >&2; exit 2');
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await settle(runner);
  const run = runner.view().last!;
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /code 2/);
  assert.match(run.error!, /not logged in/);
});

test('a missing CLI fails the run with a hint, not a crash', async () => {
  const config = await makeConfig([]);
  const missing = { ...config, agent: { ...config.agent, binPath: join(config.dataDir, 'nope') } };
  const runner = new AgentRunner(missing, { onChange: () => {} });
  await runner.run();
  await settle(runner);
  assert.equal(runner.view().last!.status, 'failed');
  assert.match(runner.view().last!.error!, /DAILY_FOCUS_AGENT_BIN/);
});

test('one run at a time, and a stopped run is recorded as aborted', async () => {
  const config = await makeConfig([], {}, 'sleep 5');
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await assert.rejects(runner.run(), /already running/);
  assert.equal(await runner.stop(), true);
  await settle(runner);
  assert.equal(runner.view().last!.status, 'aborted');
  assert.equal(await runner.stop(), false);
});

test('a run left going by a dead process is closed as aborted on start', async () => {
  const config = await makeConfig([]);
  await writeFile(config.agentLogFile, `${JSON.stringify({ event: 'started', run: 'r1', cli: 'codex', at: '2026-09-24T08:00:00Z' })}\n`);
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.start();
  assert.equal(runner.view().last!.status, 'aborted');
  assert.match(runner.view().last!.error!, /restarted/);
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(log[1]!).event, 'aborted');
});

test('off means no run and no log', async () => {
  const config = await makeConfig([], { DAILY_FOCUS_AGENT: 'off' });
  const runner = new AgentRunner(config, { onChange: () => {} });
  assert.equal(runner.enabled, false);
  await assert.rejects(runner.run(), /DAILY_FOCUS_AGENT/);
  await assert.rejects(readFile(config.agentLogFile, 'utf8'));
});

test('a mistyped CLI name is refused at startup rather than read as off', () => {
  assert.throws(() => loadConfig({ DAILY_FOCUS_AGENT: 'codx' }), /DAILY_FOCUS_AGENT must be off or one of/);
});

/* ---------- the pieces ---------- */

test('the log folds forgivingly, newest last', () => {
  const runs = foldAgentLog(
    [
      JSON.stringify({ event: 'started', run: 'b', cli: 'codex', at: '2026-09-24T10:00:00Z' }),
      'not json',
      JSON.stringify({ event: 'started', run: 'a', cli: 'codex', at: '2026-09-24T08:00:00Z' }),
      JSON.stringify({ event: 'finished', run: 'a', sessionId: 't', report: 'ok', at: '2026-09-24T08:10:00Z' }),
      JSON.stringify({ event: 'failed', run: 'nobody', sessionId: null, error: 'x', report: '', at: '2026-09-24T08:10:00Z' }),
    ].join('\n'),
  );
  assert.deepEqual(runs.map((run) => [run.id, run.status]), [
    ['a', 'done'],
    ['b', 'running'],
  ]);
});

test('the store path is shown as the README writes it', () => {
  assert.equal(displayPath('/home/alex/.daily-focus/prompt.md', '/home/alex'), '~/.daily-focus/prompt.md');
  assert.equal(displayPath('/tmp/store/prompt.md', '/home/alex'), '/tmp/store/prompt.md');
});
