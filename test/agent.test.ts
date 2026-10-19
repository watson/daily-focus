/**
 * Running the morning agent, against a script standing in for the CLI.
 *
 * The rules worth holding: the run starts in the store on the wrapper prompt,
 * the brief is the agent's to write and never the runner's, the report is the
 * agent's last word, a run is recorded, closed on restart, and one at a time;
 * a follow-up resumes the run's own session and is given nothing to write; and
 * the clock starts one run a day, never a second.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AgentRunner, agentPrompt, displayPath, foldAgentLog, followUpPrompt } from '../src/agent.ts';
import { CONNECTOR_POLICY, GMAIL_DRAFTS } from '../src/codex.ts';
import type { ExecFile } from '../src/shellpath.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// A Codex run's subagents are read from Codex's session files; never the real ones.
const CODEX_HOME = await mkdtemp(join(tmpdir(), 'daily-focus-codex-home-'));
dirs.push(CODEX_HOME);
process.env.CODEX_HOME = CODEX_HOME;

/**
 * A store with a fake CLI that records its argv and working directory, runs
 * `body` as JavaScript (see `fakeCli`), then prints the given JSON lines.
 */
async function makeConfig(lines: string[], env: Record<string, string> = {}, body = ''): Promise<Config> {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'daily-focus-agent-')));
  dirs.push(dataDir);
  const stem = join(tmpdir(), `daily-focus-fake-agent-${dirs.length}-${process.pid}`);
  dirs.push(stem, `${stem}.cjs`, `${stem}.cmd`);
  const bin = await fakeCli(
    stem,
    [
      // Asked before every run; answered the way Codex does, and not recorded as a run.
      "if (args[0] === '--version') { say('codex-cli 0.162.1'); process.exit(0); }",
      `fs.writeFileSync(${quoted(join(dataDir, '.argv'))}, args.map((arg) => arg + '\\n').join(''));`,
      `fs.writeFileSync(${quoted(join(dataDir, '.cwd'))}, process.cwd() + '\\n');`,
      body,
      ...lines.map((line) => `say(${quoted(line)});`),
    ].join('\n'),
  );
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_BIN: bin, ...env });
}

const THREAD = '{"type":"thread.started","thread_id":"thread-1"}';
const SAID = (text: string) => `{"type":"item.completed","item":{"id":"i","type":"agent_message","text":${JSON.stringify(text)}}}`;
const DONE = '{"type":"turn.completed","usage":{}}';

async function settle(runner: AgentRunner): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const last = runner.view().last;
    if (last?.status !== 'running' && !last?.turns.some((turn) => turn.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run never finished');
}

test('a run starts in the store on the wrapper prompt, and keeps the last word as the report', async () => {
  const config = await makeConfig(
    [THREAD, SAID('Reading the prompt.'), SAID('Wrote 7 items; Calendar was unreachable.'), DONE],
    { DAILY_FOCUS_AGENT_MODEL: 'some-model', DAILY_FOCUS_AGENT_EFFORT: 'xhigh' },
    // The agent writes the brief, the way the prompt tells it to.
    `fs.writeFileSync('items.json.tmp', '{"version":1,"items":[]}'); fs.renameSync('items.json.tmp', 'items.json');`,
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await settle(runner);

  const run = runner.view().last!;
  assert.equal(run.status, 'done');
  assert.equal(run.trigger, 'hand');
  assert.equal(run.report, 'Wrote 7 items; Calendar was unreachable.');
  assert.deepEqual(run.messages, ['Reading the prompt.', 'Wrote 7 items; Calendar was unreachable.']);
  assert.equal(run.sessionId, 'thread-1');
  assert.equal(run.resumable, true);

  assert.equal((await readFile(join(config.dataDir, '.cwd'), 'utf8')).trim(), config.dataDir);
  const argv = (await readFile(join(config.dataDir, '.argv'), 'utf8')).trimEnd().split('\n');
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('model="some-model"') && argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(argv.includes('sandbox_mode="workspace-write"'), 'writes are confined to the store');
  assert.ok(CONNECTOR_POLICY.every((override) => argv.includes(override)), 'connectors are read, never written');
  assert.ok(!GMAIL_DRAFTS.some((override) => argv.includes(override)), 'the agent drafts nothing');
  assert.ok(!argv.some((arg) => arg.startsWith('plugins.') || arg.startsWith('mcp_servers.')), 'its plugins are left as they are');
  assert.ok(!argv.includes('resume'), 'every run is a fresh session');
  // The wrapper is the prompt's last argument, over several lines.
  const prompt = argv.slice(argv.indexOf('Run my morning brief for today.')).join('\n');
  assert.equal(prompt, agentPrompt(displayPath(config.promptFile)));

  assert.equal(await readFile(config.itemsFile, 'utf8'), '{"version":1,"items":[]}');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'finished']);
  assert.equal(log[0].trigger, 'hand');
  assert.equal(log[1].report, run.report);
  assert.deepEqual(log[1].messages, run.messages);

  // Reloaded from the log, the way there is still there.
  const again = new AgentRunner(config, { onChange: () => {} });
  await again.start();
  assert.deepEqual(again.view().last!.messages, run.messages);
});


test('the settings the agent reads are in the store before it starts, the wrapper unchanged', async () => {
  // The fake CLI keeps what it found, as the agent would read it.
  const seen = "fs.copyFileSync('agent-settings.json', '.seen-settings');";
  const plain = await makeConfig([THREAD, SAID('Done.'), DONE], {}, seen);
  const runner = new AgentRunner(plain, { onChange: () => {} });
  await runner.run();
  await settle(runner);
  assert.deepEqual(JSON.parse(await readFile(join(plain.dataDir, '.seen-settings'), 'utf8')), { searchTrash: false, github: true, jira: true });

  const trash = await makeConfig([THREAD, SAID('Done.'), DONE], { DAILY_FOCUS_AGENT_SEARCH_TRASH: 'on' }, seen);
  const other = new AgentRunner(trash, { onChange: () => {} });
  await other.run();
  await settle(other);
  assert.deepEqual(JSON.parse(await readFile(join(trash.dataDir, '.seen-settings'), 'utf8')), { searchTrash: true, github: true, jira: true });
  const argv = (await readFile(join(trash.dataDir, '.argv'), 'utf8')).trimEnd().split('\n');
  assert.equal(argv.slice(argv.indexOf('Run my morning brief for today.')).join('\n'), agentPrompt(displayPath(trash.promptFile)));
});

test('a run whose settings cannot be written fails in the log, and the CLI never starts', async () => {
  const config = await makeConfig([THREAD, SAID('Done.'), DONE]);
  // A directory where the file goes: the rename onto it fails.
  await mkdir(join(config.agentSettingsFile, 'in-the-way'), { recursive: true });
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();

  const run = runner.view().last!;
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /could not write .*agent-settings\.json/);
  await assert.rejects(readFile(join(config.dataDir, '.argv'), 'utf8'), 'the CLI never ran');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'failed']);
});

test('a Codex older than 0.144.0 is refused: the run is logged as failed and the CLI never starts', async () => {
  const config = await makeConfig([THREAD, SAID('Wrote it.'), DONE]);
  const old: ExecFile = async () => 'codex-cli 0.143.0\n';
  const runner = new AgentRunner(config, { onChange: () => {} }, undefined, old);
  await runner.run();
  await settle(runner);

  const run = runner.view().last!;
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /Codex 0\.143\.0 is older than 0\.144\.0/);
  await assert.rejects(readFile(join(config.dataDir, '.argv'), 'utf8'), 'the CLI never ran');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'failed'], "logged, so the clock doesn't try again");
});
test('a follow-up resumes the run in its session, in the store, with nothing to write', async () => {
  const config = await makeConfig(
    ['{"type":"system","subtype":"init","session_id":"s-1"}', '{"type":"result","subtype":"success","is_error":false,"result":"Done."}'],
    { DAILY_FOCUS_AGENT: 'claude' },
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  const run = await runner.run();
  await settle(runner);
  assert.equal(runner.view().last!.resumable, true);

  await runner.ask(run.id, 'Why did you drop the vendor thread?');
  assert.equal(runner.view().last!.turns[0]!.status, 'running');
  await settle(runner);

  const argv = (await readFile(join(config.dataDir, '.argv'), 'utf8')).trimEnd().split('\n');
  assert.equal(argv[argv.indexOf('--resume') + 1], 's-1', 'the run\'s own session');
  assert.ok(argv.includes('--disallowedTools'), 'editing is denied');
  assert.ok(!argv.some((arg) => arg.startsWith('Write(') || arg.startsWith('Edit(') || arg.startsWith('Bash(mv')), 'and the brief-writing rules are withheld');
  assert.ok(argv.includes('Bash(gh *)'), 'the sources stay reachable');
  // The framed question is the prompt's last argument, over several lines.
  const question = argv.slice(argv.findIndex((arg) => arg.startsWith('A follow-up question'))).join('\n');
  assert.equal(question, followUpPrompt('Why did you drop the vendor thread?'));
  assert.equal((await readFile(join(config.dataDir, '.cwd'), 'utf8')).trim(), config.dataDir, 'where the session was filed');

  const turn = runner.view().last!.turns[0]!;
  assert.equal(turn.status, 'done');
  assert.equal(turn.question, 'Why did you drop the vendor thread?');
  assert.equal(turn.reply, 'Done.');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.event), ['started', 'finished', 'asked', 'replied']);

  // Reloaded from the log, the conversation is still there.
  const again = new AgentRunner(config, { onChange: () => {} });
  await again.start();
  assert.equal(again.view().last!.turns[0]!.reply, 'Done.');
});

test('a run made by the other CLI, or one that left no session, cannot be asked', async () => {
  const config = await makeConfig([DONE]);
  await writeFile(
    config.agentLogFile,
    [
      JSON.stringify({ event: 'started', run: 'claude-run', cli: 'claude', trigger: 'hand', at: '2026-09-24T08:00:00Z' }),
      JSON.stringify({ event: 'finished', run: 'claude-run', sessionId: 's-1', report: 'ok', at: '2026-09-24T08:10:00Z' }),
      JSON.stringify({ event: 'started', run: 'no-session', cli: 'codex', trigger: 'hand', at: '2026-09-24T09:00:00Z' }),
      JSON.stringify({ event: 'failed', run: 'no-session', sessionId: null, error: 'x', report: '', at: '2026-09-24T09:01:00Z' }),
      '',
    ].join('\n'),
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.start();
  assert.deepEqual(runner.view().runs.map((run) => [run.id, run.resumable]), [['no-session', false], ['claude-run', false]]);
  await assert.rejects(runner.ask('claude-run', 'why?'), /made by claude/);
  await assert.rejects(runner.ask('no-session', 'why?'), /no session/);
  await assert.rejects(runner.ask('nobody', 'why?'), /no such run/);
  await assert.rejects(runner.ask('claude-run', '   '), /made by claude|nothing to ask/);
});

test('a stopped follow-up is recorded as aborted, and nothing runs alongside it', async () => {
  const config = await makeConfig([THREAD, DONE], {}, "if (args[0] === 'exec' && args[1] === 'resume') sleep(5000);");
  const runner = new AgentRunner(config, { onChange: () => {} });
  const run = await runner.run();
  await settle(runner);
  await runner.ask(run.id, 'again?');
  await assert.rejects(runner.run(), /answering a question/);
  await assert.rejects(runner.ask(run.id, 'and?'), /answering a question/);
  assert.equal(await runner.stop(), true);
  await settle(runner);
  const turn = runner.view().last!.turns[0]!;
  assert.equal(turn.status, 'aborted');
  assert.equal(runner.view().last!.status, 'done', 'the run itself is untouched');
});

/* ---------- the clock ---------- */

/** Local 06:30 or so on the given local date, so the tests don't depend on the zone. */
function local(date: string, hour: number, minute = 0): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour, minute);
}

test('the clock starts a run once the time has passed on a scheduled day, and only once', async () => {
  const config = await makeConfig([THREAD, SAID('ok'), DONE], { DAILY_FOCUS_AGENT_AT: '06:30', DAILY_FOCUS_AGENT_DAYS: '1-5' });
  let changes = 0;
  const runner = new AgentRunner(config, { onChange: () => changes++ });
  const wednesday = '2026-09-23';

  await runner.tick(local(wednesday, 6, 0));
  assert.equal(runner.view().last, null, 'too early');
  assert.equal(runner.view(local(wednesday, 6, 0)).schedule?.nextRunAt, local(wednesday, 6, 30).toISOString());

  await runner.tick(local(wednesday, 9, 15));
  assert.equal(runner.view().last?.trigger, 'schedule', 'late is still today');
  await settle(runner);
  assert.equal(runner.view().last?.status, 'done');

  await runner.tick(local(wednesday, 11, 0));
  assert.equal(runner.view().runs.length, 1, 'once a day');
  assert.equal(runner.view().schedule?.nextRunAt, local('2026-09-24', 6, 30).toISOString());

  await runner.tick(local('2026-09-26', 9, 0));
  assert.equal(runner.view().runs.length, 1, 'not on a Saturday');
});

test('the clock does not retry a run that failed', async () => {
  const config = await makeConfig([], { DAILY_FOCUS_AGENT_AT: '06:30', DAILY_FOCUS_AGENT_DAYS: '1-5' }, 'process.exit(2);');
  const today = '2026-09-23';
  const runner = new AgentRunner(config, { onChange: () => {} });

  await runner.tick(local(today, 7, 0));
  assert.equal(runner.view().last?.trigger, 'schedule');
  await settle(runner);
  assert.equal(runner.view().last?.status, 'failed');

  await runner.tick(local(today, 7, 1));
  assert.equal(runner.view().runs.length, 1, 'a failed run is not retried every half minute');
});

test('the clock is seven by default, off when told, and a time without a CLI is refused', async () => {
  const config = await makeConfig([DONE], { DAILY_FOCUS_AGENT_AT: 'off', DAILY_FOCUS_AGENT_DAYS: '1-5' });
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.tick(local('2026-09-23', 9, 0));
  assert.equal(runner.view().last, null);
  assert.equal(runner.view().schedule, null);

  assert.deepEqual(loadConfig({ DAILY_FOCUS_AGENT: 'codex' }).agent.at, { hour: 7, minute: 0 });
  assert.equal(loadConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: 'off' }).agent.at, null);
  assert.equal(loadConfig({}).agent.at, null, 'no agent, no clock');
  assert.throws(() => loadConfig({ DAILY_FOCUS_AGENT_AT: '06:30' }), /DAILY_FOCUS_AGENT_AT needs DAILY_FOCUS_AGENT/);
  assert.throws(() => loadConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: '6.30' }), /24-hour time/);
  assert.throws(() => loadConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: '24:00' }), /24-hour time/);
  assert.deepEqual(loadConfig({ DAILY_FOCUS_AGENT: 'codex', DAILY_FOCUS_AGENT_AT: '6:05' }).agent.at, { hour: 6, minute: 5 });
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
  // Edit rules, which Claude Code applies to the Write tool too; a path in a Write rule matches nothing.
  assert.ok(argv.includes('Edit(./items.json)') && argv.includes('Edit(./items.json.*)') && argv.includes('Bash(mv items.json.* items.json)'));
  assert.ok(!argv.some((arg) => arg.startsWith('Write(')));
  assert.ok(argv.includes('mcp__calendar'), 'the configured source tools come along');
  assert.ok(!argv.includes('Bash(gh *)'), 'and replace the default ones');
  assert.ok(!argv.some((arg) => /^(Write|Edit)\(\.\/(actions|focus|sessions)/.test(arg)));
});

test('a CLI that exits without finishing is a failed run, in its words', async () => {
  const config = await makeConfig([], {}, "fail('not logged in', 2);");
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
  const config = await makeConfig([], {}, 'sleep(5000);');
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.run();
  await assert.rejects(runner.run(), /already running/);
  assert.equal(await runner.stop(), true);
  await settle(runner);
  assert.equal(runner.view().last!.status, 'aborted');
  assert.equal(await runner.stop(), false);
});

test('a run or a question left going by a dead process is closed as aborted on start', async () => {
  const config = await makeConfig([]);
  await writeFile(
    config.agentLogFile,
    [
      JSON.stringify({ event: 'started', run: 'r0', cli: 'codex', trigger: 'schedule', at: '2026-09-23T08:00:00Z' }),
      JSON.stringify({ event: 'finished', run: 'r0', sessionId: 't0', report: 'ok', at: '2026-09-23T08:10:00Z' }),
      JSON.stringify({ event: 'asked', run: 'r0', turn: 'q1', question: 'why?', at: '2026-09-23T09:00:00Z' }),
      JSON.stringify({ event: 'started', run: 'r1', cli: 'codex', trigger: 'hand', at: '2026-09-24T08:00:00Z' }),
      '',
    ].join('\n'),
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  await runner.start();
  assert.equal(runner.view().last!.status, 'aborted');
  assert.match(runner.view().last!.error!, /restarted/);
  const earlier = runner.view().runs[1]!;
  assert.equal(earlier.status, 'done');
  assert.equal(earlier.turns[0]!.status, 'aborted');
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.slice(4).map((r) => [r.event, r.run]), [['turn-aborted', 'r0'], ['aborted', 'r1']]);
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

/* ---------- subagents ---------- */

test("under Claude Code, a subagent's work is kept under the call that handed it over, and is done when the subagent is", async () => {
  const sub = (content: unknown[]) => JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_a', message: { content } });
  const config = await makeConfig(
    [
      '{"type":"system","subtype":"init","session_id":"s-1"}',
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Read the inbox', prompt: '…' } }] },
      }),
      '{"type":"system","subtype":"task_started","tool_use_id":"toolu_a","is_backgrounded":true,"session_id":"s-1"}',
      sub([{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'gh search prs --review-requested @me', description: 'Find review requests' } }]),
      JSON.stringify({ type: 'user', parent_tool_use_id: 'toolu_a', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b' }] } }),
      sub([{ type: 'text', text: 'Two review requests.' }]),
      // Started in the background, its call returns at once; the subagent works on.
      JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] } }),
      '{"type":"system","subtype":"task_notification","tool_use_id":"toolu_a","status":"completed","session_id":"s-1"}',
      '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Wrote 5 items."}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Wrote 5 items.","session_id":"s-1"}',
    ],
    { DAILY_FOCUS_AGENT: 'claude' },
  );
  const handoff: string[] = [];
  const runner = new AgentRunner(config, {
    onChange: () => {
      const step = runner.view().last?.steps.find((candidate) => candidate.subagent);
      if (step) handoff.push(step.state);
    },
  });
  await runner.run();
  await settle(runner);

  // Running through the handoff, the subagent's call, its result, its words and
  // the handoff's own return; done on word from the subagent, and after.
  assert.deepEqual(handoff, ['running', 'running', 'running', 'running', 'running', 'done', 'done', 'done']);
  const run = runner.view().last!;
  assert.deepEqual(
    run.steps.map((step) => [step.by, step.kind, step.text, step.state, step.subagent ?? null]),
    [
      [null, 'tool', 'Hand part of it to a subagent', 'done', 'toolu_a'],
      ['toolu_a', 'tool', 'Find review requests', 'done', null],
      ['toolu_a', 'message', 'Two review requests.', 'done', null],
      [null, 'message', 'Wrote 5 items.', 'done', null],
    ],
  );
  assert.deepEqual(run.messages, ['Wrote 5 items.'], "the subagent's words are not the agent's");
  assert.equal(run.report, 'Wrote 5 items.');
});

test("under Codex, a run's subagents are read from Codex's session files, and kept in the log", async () => {
  const root = '0000bbbb-0000-7000-8000-000000000001';
  const child = '0000bbbb-0000-7000-8000-000000000002';
  const now = new Date();
  const day = join(
    CODEX_HOME,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  await mkdir(day, { recursive: true });
  const done = (item: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } });
  await writeFile(
    join(day, `rollout-2026-10-16T07-00-01-${root}.jsonl`),
    [
      done({ type: 'SubAgentActivity', id: 'a', kind: 'started', agent_thread_id: child, agent_path: '/root/github' }),
      done({ type: 'SubAgentActivity', id: 'b', kind: 'completed', agent_thread_id: child, agent_path: '/root/github' }),
      '',
    ].join('\n'),
  );
  await writeFile(
    join(day, `rollout-2026-10-16T07-00-02-${child}.jsonl`),
    [
      done({ type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'gh pr list'], status: 'completed', exit_code: 0 }),
      done({ type: 'AgentMessage', id: 'm', content: [{ type: 'Text', text: 'One pull request waits on you.' }] }),
      '',
    ].join('\n'),
  );
  const wait = (event: string, status: string) =>
    JSON.stringify({ type: event, item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: [], status } });
  const config = await makeConfig([
    `{"type":"thread.started","thread_id":"${root}"}`,
    SAID('Handing GitHub to a subagent.'),
    wait('item.started', 'in_progress'),
    wait('item.completed', 'completed'),
    SAID('Wrote 4 items.'),
    DONE,
  ]);
  const runner = new AgentRunner(config, { onChange: () => {} }, undefined, undefined, CODEX_HOME);
  await runner.run();
  await settle(runner);

  const expected = [
    [null, 'message', 'Handing GitHub to a subagent.', 'done', null],
    [null, 'tool', 'Wait for its subagents', 'done', null],
    [null, 'message', 'Wrote 4 items.', 'done', null],
    [null, 'tool', 'Hand part of it to a subagent', 'done', child],
    [child, 'tool', 'Run a command', 'done', null],
    [child, 'message', 'One pull request waits on you.', 'done', null],
  ];
  const steps = (run: { steps: { by: string | null; kind: string; text: string; state: string; subagent?: string }[] }) =>
    run.steps.map((step) => [step.by, step.kind, step.text, step.state, step.subagent ?? null]);
  const run = runner.view().last!;
  assert.deepEqual(steps(run), expected);
  assert.equal(run.steps.find((step) => step.by === child && step.kind === 'tool')!.detail, 'gh pr list');
  assert.deepEqual(run.messages, ['Handing GitHub to a subagent.', 'Wrote 4 items.']);

  // Kept in the log, and read back from it; sent for the newest run only.
  const log = (await readFile(config.agentLogFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log[1].steps.length, expected.length);
  const again = new AgentRunner(config, { onChange: () => {} }, undefined, undefined, CODEX_HOME);
  await again.start();
  assert.deepEqual(steps(again.view().last!), expected);
  await again.run();
  await settle(again);
  assert.equal(again.view().runs[1]!.id, run.id);
  assert.deepEqual(again.view().runs[1]!.steps, []);
});

test("a follow-up's answer is the agent's alone, never a subagent's words", async () => {
  const config = await makeConfig(
    [
      '{"type":"system","subtype":"init","session_id":"s-1"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_a","message":{"content":[{"type":"text","text":"Looked in the archive."}]}}',
      '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"It was handled on Monday."}]}}',
      '{"type":"result","subtype":"error_during_execution","is_error":true}',
    ],
    { DAILY_FOCUS_AGENT: 'claude' },
  );
  const runner = new AgentRunner(config, { onChange: () => {} });
  const run = await runner.run();
  await settle(runner);
  await runner.ask(run.id, 'Why did you drop it?');
  await settle(runner);
  assert.equal(runner.view().last!.turns[0]!.reply, 'It was handled on Monday.');
});

/* ---------- the pieces ---------- */

test('the log folds forgivingly, newest last, with the questions under their runs', () => {
  const runs = foldAgentLog(
    [
      JSON.stringify({ event: 'started', run: 'b', cli: 'codex', at: '2026-09-24T10:00:00Z' }),
      'not json',
      JSON.stringify({ event: 'started', run: 'a', cli: 'codex', trigger: 'schedule', at: '2026-09-24T08:00:00Z' }),
      JSON.stringify({ event: 'finished', run: 'a', sessionId: 't', report: 'ok', at: '2026-09-24T08:10:00Z' }),
      JSON.stringify({ event: 'failed', run: 'nobody', sessionId: null, error: 'x', report: '', at: '2026-09-24T08:10:00Z' }),
      JSON.stringify({ event: 'asked', run: 'a', turn: 'q1', question: 'why?', at: '2026-09-24T09:00:00Z' }),
      JSON.stringify({ event: 'replied', run: 'a', turn: 'q1', reply: 'because', at: '2026-09-24T09:01:00Z' }),
      JSON.stringify({ event: 'asked', run: 'a', turn: 'q2', question: 'and?', at: '2026-09-24T09:02:00Z' }),
      JSON.stringify({ event: 'turn-failed', run: 'a', turn: 'q2', error: 'no', reply: '', at: '2026-09-24T09:03:00Z' }),
      JSON.stringify({ event: 'replied', run: 'a', turn: 'nobody', reply: 'lost', at: '2026-09-24T09:04:00Z' }),
      JSON.stringify({ event: 'asked', run: 'nobody', turn: 'q3', question: 'lost', at: '2026-09-24T09:05:00Z' }),
    ].join('\n'),
  );
  assert.deepEqual(runs.map((run) => [run.id, run.status, run.trigger]), [
    ['a', 'done', 'schedule'],
    // A run logged before the dashboard had a clock was started by hand.
    ['b', 'running', 'hand'],
  ]);
  assert.deepEqual(runs[0]!.turns.map((turn) => [turn.id, turn.status, turn.reply, turn.error]), [
    ['q1', 'done', 'because', null],
    ['q2', 'failed', '', 'no'],
  ]);
  // A line written before the commentary was kept has only the report.
  assert.deepEqual(runs[0]!.messages, ['ok']);
});

test('the store path is shown as the README writes it', () => {
  assert.equal(displayPath('/home/alex/.daily-focus/prompt.md', '/home/alex'), '~/.daily-focus/prompt.md');
  assert.equal(displayPath('/tmp/store/prompt.md', '/home/alex'), '/tmp/store/prompt.md');
});
