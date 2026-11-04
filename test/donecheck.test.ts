/**
 * The done check: what a verdict is about, when one starts on its own, and how
 * its answer is read.
 *
 * The rules worth holding: only a new pull request, a push or a reworded
 * description asks again; nothing starts until the key has been still for the
 * settle wait; each key once, one at a time, only while watched and within the
 * day's count, the most useful first; and nothing but `complete` itself is ever
 * read as complete. The CLI is a stand-in here, and so is the clock.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { Assistant, RESTARTED, type CheckOutcome, type CheckSpec } from '../src/assistant.ts';
import { AutoCheck, CHECK_SETTLE_MS } from '../src/autoask.ts';
import { CONNECTOR_POLICY, GMAIL_DRAFTS } from '../src/codex.ts';
import { loadConfig, type Config } from '../src/config.ts';
import {
  CHECK_EFFORT,
  checkKey,
  checkRank,
  DONE_CHECK_SCHEMA,
  DONE_CHECK_TOOLS,
  DoneCheck,
  DoneCheckRefusal,
  parseVerdict,
} from '../src/donecheck.ts';
import { descriptionHash } from '../src/jira.ts';
import { CODEX_FALLBACK_MODEL } from '../src/onboarding.ts';
import type { ExecFile } from '../src/shellpath.ts';
import type { BoardRow, DoneCheckState, LinkedPull, Ticket } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Local time, as the day's count is: the server's calendar. */
const T0 = new Date('2026-11-03T09:00:00');
const MINUTE = 60_000;

function pull(number: number, overrides: Partial<LinkedPull> = {}): LinkedPull {
  return {
    repo: 'acme/ledger',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/ledger/pull/${number}`,
    state: 'open',
    closedAt: null,
    headSha: `a1b2c3d${number}`,
    ...overrides,
  };
}

function ticket(key: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `jira:${key}`,
    key,
    summary: `Work for ${key}`,
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: `https://acme.atlassian.net/browse/${key}`,
    hasAnyPr: true,
    hasOpenPr: true,
    allPrsClosed: false,
    descriptionHash: '0123456789abcdef',
    pulls: [pull(1)],
    ...overrides,
  };
}

function boardRow(url: string, court: BoardRow['court']): BoardRow {
  return { url, court } as BoardRow;
}

/* ---------- the key ---------- */

test('a ticket is checked as its description and its pull requests at their head commits', () => {
  const base = ticket('PAY-1', { pulls: [pull(1), pull(2, { repo: 'acme/web', url: 'https://github.com/acme/web/pull/2' })] });
  const key = checkKey(base);
  assert.equal(key, 'PAY-1 0123456789abcdef acme/ledger#1@a1b2c3d1,acme/web#2@a1b2c3d2');
  assert.equal(checkKey({ ...base, pulls: [...base.pulls!].reverse() }), key, 'the order GitHub lists them in is not a change');

  // What asks again.
  assert.notEqual(checkKey({ ...base, pulls: [pull(1, { headSha: 'ffffff1' }), base.pulls![1]!] }), key, 'a push');
  assert.notEqual(checkKey({ ...base, pulls: [...base.pulls!, pull(3)] }), key, 'a new pull request');
  assert.notEqual(checkKey({ ...base, descriptionHash: 'fedcba9876543210' }), key, 'a reworded description');

  // What doesn't.
  const merged = base.pulls!.map((each) => ({ ...each, state: 'merged' as const, closedAt: '2026-11-02T10:00:00Z' }));
  assert.equal(checkKey({ ...base, pulls: merged }), key, 'a merge keeps the head it merged');
  assert.equal(checkKey({ ...base, pulls: [{ ...base.pulls![0]!, title: 'Renamed' }, base.pulls![1]!] }), key, 'a new title');
  assert.equal(checkKey({ ...base, workflowStatus: 'In Review', summary: 'Reworded summary' }), key, 'a status change');
  assert.equal(
    checkKey({ ...base, pulls: [...base.pulls!, pull(4, { state: 'closed', closedAt: '2026-11-01T10:00:00Z' })] }),
    key,
    'a pull request closed without merging finishes nothing',
  );
});

test('a ticket without a pull request, or with one whose head commit is unknown, is not checked', () => {
  assert.equal(checkKey(ticket('PAY-1', { pulls: undefined })), null);
  assert.equal(checkKey(ticket('PAY-1', { pulls: [pull(1, { state: 'closed', closedAt: '2026-11-01T10:00:00Z' })] })), null, 'only abandoned');
  assert.equal(checkKey(ticket('PAY-1', { pulls: [pull(1), pull(2, { headSha: undefined })] })), null, 'a cache from before heads were read');
  assert.equal(checkKey(ticket('PAY-1', { descriptionHash: undefined })), 'PAY-1 - acme/ledger#1@a1b2c3d1', 'a description not read yet is still a key');
});

test('the description is hashed by its words, so layout alone is no change', () => {
  const paragraph = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cap retries at five.' }, { type: 'text', text: ' Reset the backoff.' }] }] };
  const listed = {
    type: 'doc',
    version: 1,
    content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cap retries at five.', marks: [{ type: 'strong' }] }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reset the backoff.' }] }] }] }],
  };
  assert.equal(descriptionHash(paragraph), descriptionHash(listed));
  assert.equal(descriptionHash(paragraph), descriptionHash('Cap retries at five.\n\nReset   the backoff.'), 'an older site sends text');
  const reworded = structuredClone(paragraph);
  reworded.content[0]!.content[1]!.text = ' Keep the backoff.';
  assert.notEqual(descriptionHash(reworded), descriptionHash(paragraph));
  const linked = (href: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the spec', marks: [{ type: 'link', attrs: { href } }] }] }] });
  assert.notEqual(descriptionHash(linked('https://example.com/a')), descriptionHash(linked('https://example.com/b')), 'a link pointed elsewhere');
  assert.equal(descriptionHash(null), descriptionHash(''), 'no description');
  assert.match(descriptionHash(paragraph), /^[0-9a-f]{16}$/);
});

/* ---------- the answer ---------- */

test('a verdict is read from the JSON, fenced, wrapped in a sentence, or in other words for not finished', () => {
  assert.deepEqual(parseVerdict('{"verdict":"complete","line":""}'), { verdict: 'complete', line: '' });
  assert.deepEqual(parseVerdict('```json\n{"verdict":"work-left","line":"The backfill script is missing."}\n```'), {
    verdict: 'work-left',
    line: 'The backfill script is missing.',
  });
  assert.deepEqual(parseVerdict('Here it is: {"verdict": "unclear", "line": "The description is empty."} Hope that helps.'), {
    verdict: 'unclear',
    line: 'The description is empty.',
  });
  assert.deepEqual(parseVerdict('{"verdict":"Work Left","reason":"- Docs are not updated\\nand more"}'), { verdict: 'work-left', line: 'Docs are not updated' });
  assert.deepEqual(parseVerdict('{"verdict":"incomplete","line":"x"}')?.verdict, 'work-left');
  assert.deepEqual(parseVerdict('{"verdict":"cant_tell","line":"x"}')?.verdict, 'unclear');
  assert.equal(parseVerdict(`{"verdict":"work-left","line":"${'word '.repeat(80)}"}`)!.line.length, 200, 'one line is kept to one line');
});

test('nothing reads as complete unless it says complete', () => {
  for (const reply of [
    '{"verdict":"done","line":""}',
    '{"verdict":"completed","line":""}',
    '{"verdict":"yes"}',
    '{"verdict":true}',
    '{"complete":true}',
    '{"line":"All good"}',
    'Looks complete to me!',
    '',
    '[{"verdict":"complete"}]',
    '{"verdict": "complete"',
  ]) {
    assert.equal(parseVerdict(reply), null, reply);
  }
});

test('when more are owed than the day allows, merged tickets go first, then ones whose last pull request is ready', () => {
  const merged = ticket('PAY-1', { pulls: [pull(1, { state: 'merged', closedAt: '2026-11-02T10:00:00Z' })] });
  const ready = ticket('PAY-2', { pulls: [pull(2, { state: 'merged', closedAt: '2026-11-02T10:00:00Z' }), pull(3)] });
  const reviewing = ticket('PAY-3', { pulls: [pull(4)] });
  const twoOpen = ticket('PAY-4', { pulls: [pull(5), pull(6)] });
  const rows = [boardRow(pull(3).url, 'ready'), boardRow(pull(4).url, 'reviewers'), boardRow(pull(5).url, 'ready'), boardRow(pull(6).url, 'ready')];
  assert.equal(checkRank(merged, rows), 0);
  assert.equal(checkRank(ready, rows), 1);
  assert.equal(checkRank(reviewing, rows), 2);
  assert.equal(checkRank(twoOpen, rows), 2, 'two still open is not the last one');
  assert.equal(checkRank(ready, []), 2, 'a pull request the board has no row for is not known to be ready');
});

/* ---------- starting checks ---------- */

/** The assistant, standing in: every check it is asked waits until the test answers it. */
function fakeRunner(enabled = true) {
  const asked: { spec: CheckSpec; answer: (outcome: CheckOutcome) => void }[] = [];
  return {
    asked,
    enabled,
    check(spec: CheckSpec): Promise<CheckOutcome> {
      return new Promise((resolve) => asked.push({ spec, answer: resolve }));
    },
  };
}

const said = (reply: string): CheckOutcome => ({ ok: true, reply, error: null, cause: null });
const failed = (error: string, cause: CheckOutcome['cause'] = null): CheckOutcome => ({ ok: false, reply: '', error, cause });

/**
 * Let file writes and promise chains land. `setTimeout` is mocked, so this
 * yields with `setImmediate`, and gives up after real seconds rather than a
 * count of turns: on a slow Windows runner a write can outlast thousands of
 * them, and the test failed with nothing wrong.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`never: ${what}`);
}

async function store(env: Record<string, string> = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-donecheck-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_ASSISTANT: 'claude', DAILY_FOCUS_ASSISTANT_AUTO: 'on', ...env });
}

interface Rig {
  config: Config;
  runner: ReturnType<typeof fakeRunner>;
  checks: DoneCheck;
  auto: AutoCheck;
  /** The done check as the page would get it. */
  view(): DoneCheckState;
  clock: { now: Date };
  tickets: Ticket[];
  rows: BoardRow[];
  gate: { open: boolean };
  /** Move the clock on by minutes. */
  at(minutes: number): void;
  /** Answer the newest check, and wait for the dashboard to have written it down. */
  answer(outcome: CheckOutcome): Promise<void>;
}

/** Tests whose timers are already mocked: a second rig in one test shares them. */
const mocked = new WeakSet<TestContext>();

async function rig(t: TestContext, tickets: Ticket[], opts: { env?: Record<string, string>; config?: Config; execFn?: ExecFile; runner?: ReturnType<typeof fakeRunner> } = {}): Promise<Rig> {
  // Pokes and the settle wake-up are timers; the tests start checks themselves.
  if (!mocked.has(t)) t.mock.timers.enable({ apis: ['setTimeout'] });
  mocked.add(t);
  const config = opts.config ?? (await store(opts.env));
  const runner = opts.runner ?? fakeRunner();
  const clock = { now: T0 };
  const state = { tickets, rows: [] as BoardRow[], gate: { open: true } };
  let auto: AutoCheck | null = null;
  const checks = new DoneCheck({
    config,
    assistant: runner,
    tickets: () => state.tickets,
    onChange: () => auto?.poke(),
    now: () => clock.now,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
  });
  auto = new AutoCheck({
    config,
    checks,
    tickets: () => state.tickets,
    rows: () => state.rows,
    canStart: () => state.gate.open,
    now: () => clock.now,
  });
  const ahead = auto;
  t.after(() => {
    ahead.close();
    checks.close();
  });
  await checks.start();
  ahead.setAudience(1);
  // First seen now: where every settle wait below counts from.
  ahead.view();
  const r: Rig = {
    config,
    runner,
    checks,
    auto: ahead,
    view: () => checks.view(ahead.view()),
    clock,
    get tickets() {
      return state.tickets;
    },
    set tickets(next: Ticket[]) {
      state.tickets = next;
    },
    get rows() {
      return state.rows;
    },
    set rows(next: BoardRow[]) {
      state.rows = next;
    },
    gate: state.gate,
    at(minutes) {
      clock.now = new Date(T0.getTime() + minutes * MINUTE);
    },
    async answer(outcome) {
      const asked = runner.asked.at(-1);
      assert.ok(asked, 'nothing was asked');
      asked.answer(outcome);
      await until(() => !checks.busy, 'the check to be written down');
    },
  };
  return r;
}

test('a check waits until its pull requests and description have been still for the settle wait', async (t) => {
  const r = await rig(t, [ticket('PAY-1')], { env: { DAILY_FOCUS_ASSISTANT_MODEL: 'sonnet', DAILY_FOCUS_ASSISTANT_EFFORT: 'low' } });
  assert.equal(r.view().tickets['PAY-1']!.dueAt, new Date(T0.getTime() + CHECK_SETTLE_MS).toISOString());
  assert.equal(CHECK_SETTLE_MS, 20 * MINUTE);

  r.at(19);
  assert.equal(await r.auto.consider(), null, 'not yet');
  assert.equal(r.runner.asked.length, 0);

  r.at(20);
  assert.equal(await r.auto.consider(), 'PAY-1');
  await until(() => r.runner.asked.length === 1, 'the CLI to be asked');
  const { spec } = r.runner.asked[0]!;
  assert.equal(spec.model, 'opus', "the newest flagship, whatever the assistant's own model is");
  assert.equal(spec.effort, CHECK_EFFORT);
  assert.equal(CHECK_EFFORT, 'high');
  assert.deepEqual(spec.tools, DONE_CHECK_TOOLS);
  assert.ok(spec.tools.every((tool) => /^Bash\((gh pr|gh repo|gh search|acli jira workitem (view|search|comment list))/.test(tool)), 'reads alone');
  assert.equal(spec.schema, DONE_CHECK_SCHEMA);
  assert.match(spec.prompt, /Never post/, 'its own instructions');
  assert.match(spec.prompt, /"key": "PAY-1"/);
  assert.match(spec.prompt, /"headSha": "a1b2c3d1"/);
  assert.equal(r.view().tickets['PAY-1']!.running?.by, 'auto');

  await r.answer(said('{"verdict":"work-left","line":"The backfill is not in it."}'));
  const entry = r.view().tickets['PAY-1']!;
  assert.deepEqual(entry.verdict, { verdict: 'work-left', line: 'The backfill is not in it.', at: r.clock.now.toISOString(), current: true });
  assert.equal(entry.dueAt, null, 'nothing more is owed');
});

test('a push during the wait starts it again, so push, fix, push costs one check', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  r.at(15);
  r.tickets = [ticket('PAY-1', { pulls: [pull(1, { headSha: 'b0b0b01' })] })];
  assert.equal(await r.auto.consider(), null, 'seen at 15 minutes');
  r.at(21);
  assert.equal(await r.auto.consider(), null, 'twenty minutes from the push, not from the first sight');
  r.at(35);
  assert.equal(await r.auto.consider(), 'PAY-1');
  await until(() => r.runner.asked.length === 1, 'the CLI to be asked');
  assert.match(r.runner.asked[0]!.spec.prompt, /b0b0b01/, 'about the newest push');
});

test('a key is checked once however it went; a push asks again, and so does a check a restart cut short', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  r.at(20);
  await r.auto.consider();
  await until(() => r.runner.asked.length === 1, 'the first check');
  await r.answer(failed('Claude is busy right now', 'busy'));
  r.at(300);
  assert.equal(await r.auto.consider(), null, 'a failed check is not retried on its own');
  assert.equal(r.view().tickets['PAY-1']!.dueAt, null);

  r.tickets = [ticket('PAY-1', { pulls: [pull(1, { headSha: 'c0ffee1' })] })];
  r.view();
  r.at(320);
  assert.equal(await r.auto.consider(), 'PAY-1', 'a push is a new key');
  await until(() => r.runner.asked.length === 2, 'the second check');
  await r.answer(said('{"verdict":"complete","line":""}'));
  r.at(600);
  assert.equal(await r.auto.consider(), null, 'nor a finished one');

  // The log as a dashboard that died mid-check left it.
  const config = await store();
  await writeFile(
    config.doneCheckLogFile,
    `${JSON.stringify({ event: 'started', check: 'c1', ticket: 'PAY-2', key: checkKey(ticket('PAY-2')), by: 'auto', agent: 'claude', at: T0.toISOString() })}\n`,
  );
  const again = await rig(t, [ticket('PAY-2')], { config });
  assert.equal(again.view().tickets['PAY-2']!.failure?.error, RESTARTED, 'closed as cut short, and said so');
  assert.match(await readFile(config.doneCheckLogFile, 'utf8'), /"event":"failed","check":"c1"/, 'and written down');
  again.at(20);
  assert.equal(await again.auto.consider(), 'PAY-2', 'asked again');
});

test('no more start on their own than the day allows, failed ones included, and the most useful go first', async (t) => {
  const merged = ticket('PAY-1', { pulls: [pull(1, { state: 'merged', closedAt: '2026-11-02T10:00:00Z' })] });
  const ready = ticket('PAY-2', { pulls: [pull(2)] });
  const reviewing = ticket('PAY-3', { pulls: [pull(3)] });
  const r = await rig(t, [reviewing, ready, merged], { env: { DAILY_FOCUS_DONE_CHECK_LIMIT: '2' } });
  r.rows = [boardRow(pull(2).url, 'ready'), boardRow(pull(3).url, 'reviewers')];
  r.at(20);

  assert.equal(await r.auto.consider(), 'PAY-1', 'every pull request merged');
  await until(() => r.runner.asked.length === 1, 'the first check');
  assert.equal(await r.auto.consider(), null, 'one at a time');
  await r.answer(said('{"verdict":"complete","line":""}'));

  assert.equal(await r.auto.consider(), 'PAY-2', 'its last pull request ready to merge');
  await until(() => r.runner.asked.length === 2, 'the second check');
  await r.answer(said('not JSON at all'));

  assert.equal(await r.auto.consider(), null, "today's two are used, the failed one with them");
  assert.equal(r.view().usedToday, 2);
  assert.equal(r.view().limit, 2);

  // A click is outside the count.
  await r.checks.checkNow('pay-3');
  await until(() => r.runner.asked.length === 3, 'the click');
  assert.equal(r.view().tickets['PAY-3']!.running?.by, 'click');
  await r.answer(said('{"verdict":"unclear","line":"The description is empty."}'));
  assert.equal(r.view().usedToday, 2);

  // The next day counts afresh.
  r.tickets = [reviewing, ready, merged, ticket('PAY-4', { pulls: [pull(4)] })];
  r.at(24 * 60);
  r.view();
  r.at(24 * 60 + 20);
  assert.equal(r.view().usedToday, 0);
  assert.equal(await r.auto.consider(), 'PAY-4');
});

test('nothing starts on its own with no page open, while settings wait on a restart, or with the switch off', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  r.at(20);
  r.auto.setAudience(0);
  assert.equal(await r.auto.consider(), null, 'no page open');
  r.auto.setAudience(1);
  r.gate.open = false;
  assert.equal(await r.auto.consider(), null, 'a restart waiting');
  r.gate.open = true;
  assert.equal(await r.auto.consider(), 'PAY-1');

  const off = await rig(t, [ticket('PAY-1')], { env: { DAILY_FOCUS_ASSISTANT_AUTO: 'off' } });
  off.at(60);
  assert.equal(await off.auto.consider(), null);
  const view = off.view();
  assert.equal(view.auto, false);
  assert.equal(view.enabled, true);
  assert.equal(view.tickets['PAY-1']!.dueAt, null, 'nothing owed on its own');
  assert.equal(view.tickets['PAY-1']!.checkable, true);
  await off.checks.checkNow('PAY-1');
  await until(() => off.runner.asked.length === 1, 'Check now, with the switch off');
});

test('the settle wait wakes the queue on its own while a page is open', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  assert.equal(await r.auto.consider(), null, 'seen now, owed in twenty minutes');
  r.at(20);
  t.mock.timers.tick(CHECK_SETTLE_MS + 1000);
  t.mock.timers.tick(1000);
  await until(() => r.runner.asked.length === 1, 'the wake-up to start it');
});

test('a failed or malformed check never reads as complete, and never takes the last verdict with it', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  r.at(20);
  await r.auto.consider();
  await until(() => r.runner.asked.length === 1, 'the first check');
  await r.answer(said('{"verdict":"complete","line":""}'));
  assert.equal(r.view().tickets['PAY-1']!.verdict?.verdict, 'complete');

  // A push: the verdict is now from before it.
  r.tickets = [ticket('PAY-1', { pulls: [pull(1, { headSha: 'd00d001' })] })];
  let entry = r.view().tickets['PAY-1']!;
  assert.equal(entry.verdict?.current, false);

  r.at(45);
  await r.auto.consider();
  await until(() => r.runner.asked.length === 2, 'the second check');
  await r.answer(said('{"verdict":"done","line":"Looks complete to me!"}'));
  entry = r.view().tickets['PAY-1']!;
  assert.equal(entry.verdict?.verdict, 'complete', 'the last verdict stands');
  assert.equal(entry.verdict?.current, false, 'as about the work before the push');
  assert.equal(entry.failure?.current, true);
  assert.match(entry.failure!.error, /not in the shape asked for: “\{"verdict":"done"/);

  // A failure from the CLI itself, after another push.
  r.tickets = [ticket('PAY-1', { pulls: [pull(1, { headSha: 'e00e001' })] })];
  r.view();
  r.at(70);
  await r.auto.consider();
  await until(() => r.runner.asked.length === 3, 'the third check');
  await r.answer(failed('gave up after 15 minutes'));
  entry = r.view().tickets['PAY-1']!;
  assert.equal(entry.failure?.error, 'gave up after 15 minutes');
  assert.equal(entry.verdict?.verdict, 'complete');

  const log = (await readFile(r.config.doneCheckLogFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    log.map((line) => line.event),
    ['started', 'finished', 'started', 'failed', 'started', 'failed'],
  );
  assert.ok(log.filter((line) => line.event !== 'started').every((line) => typeof line.ms === 'number'), 'each says how long it took');
});

test('the verdicts and the day’s count come back after a restart', async (t) => {
  const r = await rig(t, [ticket('PAY-1')]);
  r.at(20);
  await r.auto.consider();
  await until(() => r.runner.asked.length === 1, 'the check');
  await r.answer(said('{"verdict":"work-left","line":"Docs are missing."}'));

  const next = await rig(t, [ticket('PAY-1')], { config: r.config });
  next.at(25);
  const view = next.view();
  assert.equal(view.usedToday, 1);
  assert.equal(view.tickets['PAY-1']!.verdict?.line, 'Docs are missing.');
  assert.equal(view.tickets['PAY-1']!.verdict?.current, true);
  next.at(60);
  assert.equal(await next.auto.consider(), null, 'not asked again');
});

test('Check now refuses what it cannot check, and a ticket already being checked', async (t) => {
  const r = await rig(t, [ticket('PAY-1'), ticket('PAY-2', { pulls: undefined })]);
  const refusal = async (key: string): Promise<DoneCheckRefusal> => {
    try {
      await r.checks.checkNow(key);
    } catch (err) {
      assert.ok(err instanceof DoneCheckRefusal);
      return err;
    }
    return assert.fail(`${key} was checked`);
  };
  assert.equal((await refusal('PAY-9')).status, 404, 'not one of the user’s tickets');
  assert.equal((await refusal('PAY-2')).status, 409, 'no pull requests');
  await r.checks.checkNow('PAY-1');
  assert.equal((await refusal('PAY-1')).status, 409, 'already going');

  const off = await rig(t, [ticket('PAY-1')], { runner: fakeRunner(false) });
  const err = await off.checks.checkNow('PAY-1').catch((caught: unknown) => caught);
  assert.ok(err instanceof DoneCheckRefusal && err.status === 409 && /assistant is off/.test(err.message));
});

test("under Codex, a check runs on the catalog's flagship, and on the fallback once the account can't use it", async (t) => {
  const catalog: ExecFile = async (_file, args) =>
    args[0] === 'debug'
      ? JSON.stringify({ models: [{ slug: 'gpt-7-luna', priority: 5, visibility: 'list' }, { slug: 'gpt-7-sol', priority: 1, visibility: 'list' }] })
      : '';
  const r = await rig(t, [ticket('PAY-1'), ticket('PAY-2', { pulls: [pull(2)] })], { env: { DAILY_FOCUS_ASSISTANT: 'codex' }, execFn: catalog });
  await r.checks.checkNow('PAY-1');
  await until(() => r.runner.asked.length === 1, 'the check');
  assert.equal(r.runner.asked[0]!.spec.model, 'gpt-7-sol');
  r.runner.asked[0]!.answer(failed("your ChatGPT plan or workspace doesn't include the model “gpt-7-sol”", 'model'));
  await until(() => r.runner.asked.length === 2, 'asked again');
  assert.equal(r.runner.asked[1]!.spec.model, CODEX_FALLBACK_MODEL);
  await r.answer(said('{"verdict":"complete","line":""}'));
  assert.equal(r.view().tickets['PAY-1']!.verdict?.verdict, 'complete');

  await r.checks.checkNow('PAY-2');
  await until(() => r.runner.asked.length === 3, 'the next check');
  assert.equal(r.runner.asked[2]!.spec.model, CODEX_FALLBACK_MODEL, 'kept to after');
});

/* ---------- the runner ---------- */

const STRUCTURED = '{"verdict":"work-left","line":"The migration is missing."}';

test("Claude Code runs a check in the assistant's empty folder, on the model given, with nothing to edit or draft with", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-donecheck-cli-'));
  dirs.push(dataDir);
  const bin = await fakeCli(
    join(dataDir, 'fake-claude'),
    [
      `fs.writeFileSync(${quoted(join(dataDir, 'argv'))}, args.map((arg) => arg + '\\n').join(''));`,
      `fs.writeFileSync(${quoted(join(dataDir, 'cwd'))}, process.cwd());`,
      `say(${quoted('{"type":"system","subtype":"init","session_id":"s-1"}')});`,
      `say(${quoted(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', result: STRUCTURED }))});`,
    ].join('\n'),
  );
  const config = loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_ASSISTANT: 'claude', DAILY_FOCUS_ASSISTANT_BIN: bin, DAILY_FOCUS_ASSISTANT_MODEL: 'sonnet' });
  const assistant = new Assistant(config, { onChange: () => {} });
  const outcome = await assistant.check({ prompt: 'Check PAY-1.', model: 'opus', effort: 'high', tools: DONE_CHECK_TOOLS, schema: DONE_CHECK_SCHEMA, timeoutMs: 60_000 });
  assert.deepEqual(outcome, { ok: true, reply: STRUCTURED, error: null, cause: null });
  assert.equal(assistant.busy, false);

  const argv = (await readFile(join(dataDir, 'argv'), 'utf8')).split('\n');
  const value = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(value('--model'), 'opus');
  assert.equal(value('--effort'), 'high');
  assert.equal(value('--json-schema'), JSON.stringify(DONE_CHECK_SCHEMA));
  assert.ok(argv.includes('--disallowedTools') && argv.includes('Edit') && argv.includes('Write'));
  for (const tool of DONE_CHECK_TOOLS) assert.ok(argv.includes(tool), tool);
  assert.ok(!argv.some((arg) => arg.includes('Gmail')), "not the assistant's list, which can draft");
  assert.ok(!argv.includes('--resume'));
  assert.equal(await realpath(await readFile(join(dataDir, 'cwd'), 'utf8')), await realpath(config.assistantDir));
  await assert.rejects(readFile(config.assistantLogFile, 'utf8'), "no turn in the assistant's log");
});

test('Codex runs a check with the connector rules, the schema as a file, and no draft', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-donecheck-codex-'));
  dirs.push(dataDir);
  const bin = await fakeCli(
    join(dataDir, 'fake-codex'),
    [
      `fs.writeFileSync(${quoted(join(dataDir, 'argv'))}, args.map((arg) => arg + '\\n').join(''));`,
      "const schema = args[args.indexOf('--output-schema') + 1];",
      `fs.writeFileSync(${quoted(join(dataDir, 'schema'))}, fs.readFileSync(schema, 'utf8'));`,
      `say(${quoted('{"type":"thread.started","thread_id":"t-1"}')});`,
      `say(${quoted(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: STRUCTURED } }))});`,
      `say(${quoted('{"type":"turn.completed","usage":{}}')});`,
    ].join('\n'),
  );
  const config = loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_ASSISTANT: 'codex', DAILY_FOCUS_ASSISTANT_BIN: bin, DAILY_FOCUS_ASSISTANT_COMPUTER_USE: 'on' });
  const version: ExecFile = async () => 'codex-cli 0.162.1\n';
  const assistant = new Assistant(config, { onChange: () => {} }, undefined, version);
  const outcome = await assistant.check({ prompt: 'Check PAY-1.', model: 'gpt-7-sol', effort: 'high', tools: DONE_CHECK_TOOLS, schema: DONE_CHECK_SCHEMA, timeoutMs: 60_000 });
  assert.equal(outcome.reply, STRUCTURED);
  const argv = (await readFile(join(dataDir, 'argv'), 'utf8')).split('\n');
  for (const rule of CONNECTOR_POLICY) assert.ok(argv.includes(rule), rule);
  for (const draft of GMAIL_DRAFTS) assert.ok(!argv.includes(draft), 'no draft');
  assert.ok(argv.includes('model="gpt-7-sol"') && argv.includes('model_reasoning_effort="high"'));
  assert.equal(await readFile(join(dataDir, 'schema'), 'utf8'), JSON.stringify(DONE_CHECK_SCHEMA));
});

test('a check that runs too long is stopped, and says so', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-donecheck-slow-'));
  dirs.push(dataDir);
  const bin = await fakeCli(join(dataDir, 'fake-claude'), 'sleep(10000);');
  const config = loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_ASSISTANT: 'claude', DAILY_FOCUS_ASSISTANT_BIN: bin });
  const assistant = new Assistant(config, { onChange: () => {} });
  const outcome = await assistant.check({ prompt: 'p', model: 'opus', effort: 'high', tools: [], schema: DONE_CHECK_SCHEMA, timeoutMs: 300 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /^gave up after/);
});
