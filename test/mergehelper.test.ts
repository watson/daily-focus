/**
 * The merge helper: how it is started, how its answers are read, and what the
 * dashboard keeps of them. The helpers here are stand-ins written with
 * `fakeCli`, started the way the dashboard starts the real one, recording what
 * they were given; nothing reaches GitHub or any queue.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, test } from 'node:test';

import {
  CHECK_FRESH_MS,
  DEFAULT_LABEL,
  HelperError,
  HelperRefusal,
  MergeHelper,
  STATUS_AFTER_MS,
  firstLine,
  readCheck,
  readMerge,
  readStatus,
  runMergeHelper,
  type HelperRun,
  type RunHelper,
} from '../src/mergehelper.ts';
import type { PullRequest } from '../src/types.ts';
import { fakeCli } from './fakecli.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `daily-focus-${name}-`));
  dirs.push(dir);
  return dir;
}

/** What a recording helper saw, as it wrote it down. */
interface Seen {
  args: string[];
  cwd: string;
  entries: string[];
  stdinTTY: boolean;
  stdin: string;
  tty: boolean;
  ceiling: string | null;
  gitPrompt: string | null;
  inherited: string | null;
}

/** A helper that writes down what it was given to `RECORD`, then answers `answer`. */
const RECORDING = `
let stdin;
try { stdin = fs.readFileSync(0, 'utf8'); } catch (err) { stdin = 'unreadable: ' + err.code; }
let tty = false;
try { fs.closeSync(fs.openSync('/dev/tty', 'r')); tty = true; } catch {}
fs.writeFileSync(process.env.RECORD, JSON.stringify({
  args,
  cwd: process.cwd(),
  entries: fs.readdirSync(process.cwd()),
  stdinTTY: Boolean(process.stdin.isTTY),
  stdin,
  tty,
  ceiling: process.env.GIT_CEILING_DIRECTORIES ?? null,
  gitPrompt: process.env.GIT_TERMINAL_PROMPT ?? null,
  inherited: process.env.FROM_THE_DASHBOARD ?? null,
}));
say('{"queue": true}');
`;

test('the helper gets its arguments as they are, no terminal, no input, and an empty folder of its own outside any checkout', async () => {
  const dir = await scratch('helper-launch');
  const helper = await fakeCli(join(dir, 'merge-helper'), RECORDING);
  const record = join(dir, 'seen.json');
  const tmpRoot = await scratch('helper-tmp');

  // What a shell would read as two commands and a variable, if one were in between.
  const url = 'https://github.com/acme/payments-api/pull/412; echo $HOME "quoted"';
  const run = await runMergeHelper(helper, ['check', url, 'main'], {
    timeoutMs: 20_000,
    env: { ...process.env, RECORD: record, FROM_THE_DASHBOARD: 'yes' },
    tmpRoot,
  });
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), '{"queue": true}');

  const seen = JSON.parse(await readFile(record, 'utf8')) as Seen;
  assert.deepEqual(seen.args, ['check', url, 'main'], 'no shell took the arguments apart');
  assert.equal(seen.stdinTTY, false);
  assert.equal(seen.stdin, '', 'standard input is closed: nothing to read, nothing to wait on');
  assert.equal(seen.tty, false, 'no terminal to open and ask on');
  assert.equal(seen.inherited, 'yes', 'the environment it was given');
  assert.equal(seen.gitPrompt, '0');

  const root = await realpath(tmpRoot);
  assert.ok(seen.cwd.startsWith(`${root}${sep}daily-focus-helper-`), `${seen.cwd} is a folder of its own in the temporary folder`);
  assert.deepEqual(seen.entries, [], 'and it is empty');
  assert.equal(seen.ceiling, dirname(seen.cwd), 'git is told not to look above it');
  assert.equal(existsSync(seen.cwd), false, 'removed afterwards');
});

test('a tool looking for the git checkout it runs in finds none, even inside one', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  // As when the home folder is a git repository, and the temporary folder is in it.
  const repo = await scratch('helper-repo');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const tmpRoot = join(repo, 'tmp');
  await mkdir(tmpRoot);

  const dir = await scratch('helper-git');
  const helper = await fakeCli(
    join(dir, 'merge-helper'),
    `
const { spawnSync } = require('node:child_process');
const top = (env) => spawnSync('git', ['rev-parse', '--show-toplevel'], { env, encoding: 'utf8' });
const { GIT_CEILING_DIRECTORIES, ...unbounded } = process.env;
const bounded = top(process.env);
const control = top(unbounded);
say(JSON.stringify({ bounded: bounded.status, control: control.status, found: control.stdout.trim() }));
`,
  );
  const run = await runMergeHelper(helper, ['check', 'https://github.com/acme/payments-api/pull/412', 'main'], {
    timeoutMs: 20_000,
    env: process.env,
    tmpRoot,
  });
  const answer = JSON.parse(run.stdout) as { bounded: number; control: number; found: string };
  assert.notEqual(answer.bounded, 0, 'git finds no checkout from the helper’s folder');
  assert.equal(answer.control, 0, 'without the ceiling it would have found the one around it');
  assert.equal(await realpath(answer.found), await realpath(repo));
});

test('a helper that takes too long is stopped, and its folder still removed', async () => {
  const dir = await scratch('helper-slow');
  const record = join(dir, 'cwd.txt');
  const helper = await fakeCli(join(dir, 'merge-helper'), `fs.writeFileSync(process.env.RECORD, process.cwd()); sleep(20000); say('{"queue": true}');`);
  const started = Date.now();
  await assert.rejects(runMergeHelper(helper, ['check', 'https://github.com/acme/payments-api/pull/412', 'main'], { timeoutMs: 1_000, env: { ...process.env, RECORD: record } }), {
    name: 'HelperError',
    message: 'took longer than 1 s and was stopped',
  });
  assert.ok(Date.now() - started < 10_000, 'it did not wait the helper out');
  const cwd = await readFile(record, 'utf8');
  assert.equal(existsSync(cwd), false);
});

test("a helper that can't be started is an error naming it", async () => {
  const dir = await scratch('helper-missing');
  await assert.rejects(runMergeHelper(join(dir, 'no-such-helper'), ['check'], { timeoutMs: 5_000, env: process.env }), (err: unknown) => {
    assert.ok(err instanceof HelperError);
    assert.match(err.message, /^could not run .*no-such-helper/);
    return true;
  });
});

/* ---------- reading what it says ---------- */

const ran = (stdout: string, code: number | null = 0, stderr = '', signal: NodeJS.Signals | null = null): HelperRun => ({ code, signal, stdout, stderr });

test('check: one line of JSON, with the label and stacks optional', () => {
  assert.deepEqual(readCheck(ran('{"queue": false}\n')), { queue: false, label: DEFAULT_LABEL, stacks: false });
  assert.deepEqual(readCheck(ran('{"queue": true}')), { queue: true, label: 'Add to merge queue', stacks: false });
  assert.deepEqual(readCheck(ran('{"queue": true, "label": "  Ship   it ", "stacks": true}')), { queue: true, label: 'Ship it', stacks: true });
  // Only true is true, and a label is a button.
  assert.equal(readCheck(ran('{"queue": true, "stacks": "yes"}')).stacks, false);
  assert.equal(readCheck(ran(`{"queue": true, "label": "${'x'.repeat(80)}"}`)).label.length, 60);
  // A word of its own before the answer is let through; the answer is the last line.
  assert.equal(readCheck(ran('checking acme/payments-api…\n{"queue": true}\n\n')).queue, true);
});

test("check: a failed run or an answer that can't be read is an error, never GitHub's merge", () => {
  const error = (run: HelperRun) => assert.throws(() => readCheck(run), HelperError);
  error(ran('{"queue": false}', 1));
  error(ran('', 0));
  error(ran('queue: yes'));
  error(ran('[true]'));
  error(ran('{"queue": "true"}'));
  assert.throws(() => readCheck(ran('', 2, 'not logged in to the queue\nmore detail')), { message: 'exited with code 2: not logged in to the queue' });
  assert.throws(() => readCheck(ran('', null, '', 'SIGTERM')), { message: 'was stopped by SIGTERM' });
  assert.throws(() => readCheck(ran('maybe')), { message: 'printed "maybe", not {"queue": true} or {"queue": false}' });
});

test('status: queued or not, and anything else an error', () => {
  assert.equal(readStatus(ran('{"queued": true}')), true);
  assert.equal(readStatus(ran('{"queued": false}')), false);
  assert.throws(() => readStatus(ran('{"queue": true}')), HelperError);
  assert.throws(() => readStatus(ran('{"queued": true}', 1, 'rate limited')), { message: 'exited with code 1: rate limited' });
});

test("merge: exit 0 is taken, with its first line for the page; anything else a refusal in its own words", () => {
  assert.equal(readMerge(ran('\nQueued at position 3\nsee https://queue.example\n')), 'Queued at position 3');
  assert.equal(readMerge(ran('')), '');
  assert.throws(() => readMerge(ran('', 1, 'the queue is closed for the release\nstack trace')), (err: unknown) => {
    assert.ok(err instanceof HelperRefusal);
    assert.equal(err.message, 'the queue is closed for the release');
    return true;
  });
  assert.throws(() => readMerge(ran('not mergeable: required check missing', 3)), { message: 'not mergeable: required check missing' });
  assert.throws(() => readMerge(ran('', 4)), { message: 'the merge helper exited with code 4' });
  assert.equal(firstLine(`${'y'.repeat(400)}\nnext`).length, 300);
});

/* ---------- what the dashboard keeps of it ---------- */

function pull(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `github:pr:acme/payments-api#${number}`,
    account: 'alice',
    repo: 'acme/payments-api',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/payments-api/pull/${number}`,
    isDraft: false,
    createdAt: '2026-10-28T09:00:00Z',
    readyAt: '2026-10-28T09:00:00Z',
    updatedAt: '2026-11-02T09:00:00Z',
    headRef: `alice/change-${number}`,
    baseRef: 'main',
    reviewDecision: 'APPROVED',
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    lastActivityByYou: '2026-11-02T09:00:00Z',
    lastActivityByOthers: null,
    defaultBranch: 'main',
    ...overrides,
  };
}

/** A stand-in run: answers by the command, and writes down each call. */
function fakeRun(answer: (args: readonly string[]) => HelperRun | Promise<HelperRun>): RunHelper & { calls: string[] } {
  const calls: string[] = [];
  const run: RunHelper = async (_helper, args) => {
    calls.push(args.join(' '));
    return answer(args);
  };
  return Object.assign(run, { calls });
}

function clock(start = Date.parse('2026-11-03T12:00:00Z')) {
  let now = start;
  return { now: () => now, pass: (ms: number) => (now += ms) };
}

test('check is asked once per repository and branch, after a poll, and its answer kept a day', async () => {
  const time = clock();
  const run = fakeRun(() => ran('{"queue": true, "label": "Queue it", "stacks": true}'));
  const helper = new MergeHelper('/opt/merge-helper', run, () => ({}), time.now);

  assert.deepEqual(helper.view('acme/payments-api', 'main'), { kind: 'asking' }, 'nothing offered before it has said');
  const pulls = [pull(410), pull(411), pull(412, { baseRef: 'alice/change-411' }), pull(7, { repo: 'acme/webapp', id: 'github:pr:acme/webapp#7', url: 'https://github.com/acme/webapp/pull/7' })];
  await helper.ask(pulls);
  // One per branch a pull request targets as its default; never for a branch stacked on another.
  assert.deepEqual(run.calls, ['check https://github.com/acme/payments-api/pull/410 main', 'check https://github.com/acme/webapp/pull/7 main']);
  assert.deepEqual(helper.view('acme/payments-api', 'main'), { kind: 'queue', label: 'Queue it', stacks: true });
  assert.deepEqual(helper.view('ACME/Payments-API', 'main'), { kind: 'queue', label: 'Queue it', stacks: true });

  run.calls.length = 0;
  time.pass(CHECK_FRESH_MS - 1);
  await helper.ask(pulls);
  assert.deepEqual(run.calls, [], 'still fresh');
  time.pass(1);
  await helper.ask(pulls);
  assert.equal(run.calls.length, 2, 'a day on, asked again');
  assert.deepEqual(helper.warnings(), []);
});

test("queue: false is GitHub's merge; a failed check is a warning, GitHub's merge meanwhile, and asked again next time", async () => {
  let answer = ran('', 1, 'queue-cli: not logged in');
  const run = fakeRun(() => answer);
  const helper = new MergeHelper('/opt/merge-helper', run, () => ({}));

  await helper.ask([pull(410)]);
  assert.equal(helper.view('acme/payments-api', 'main'), null);
  assert.deepEqual(helper.warnings(), [
    "The merge helper couldn't say how acme/payments-api merges into main: it exited with code 1: queue-cli: not logged in. Its pull requests offer GitHub's merge until it can.",
  ]);

  answer = ran('{"queue": false}');
  await helper.ask([pull(410)]);
  assert.equal(run.calls.length, 2, 'the failure was not kept as an answer');
  assert.equal(helper.view('acme/payments-api', 'main'), null);
  assert.deepEqual(helper.warnings(), []);

  await helper.ask([pull(410)]);
  assert.equal(run.calls.length, 2, 'the answer was');
});

test('a failure for a branch no pull request targets any more is no longer worth a warning', async () => {
  const helper = new MergeHelper('/opt/merge-helper', fakeRun(() => ran('', 1, 'down')), () => ({}));
  await helper.ask([pull(410)]);
  assert.equal(helper.warnings().length, 1);
  await helper.ask([]);
  assert.deepEqual(helper.warnings(), []);
});

test('a pull request handed to it is queued until status says otherwise or GitHub stops listing it', async () => {
  const time = clock();
  const queued = new Map<string, HelperRun>();
  const run = fakeRun((args) => (args[0] === 'check' ? ran('{"queue": true}') : (queued.get(args[1]!) ?? ran('{"queued": true}'))));
  const helper = new MergeHelper('/opt/merge-helper', run, () => ({}), time.now);
  const handed = (number: number) => ({ id: `github:pr:acme/payments-api#${number}`, url: `https://github.com/acme/payments-api/pull/${number}`, repo: 'acme/payments-api', number });

  helper.handed([handed(410), handed(411), handed(412)]);
  assert.ok(helper.queued('github:pr:acme/payments-api#410'));
  assert.ok(helper.queued('GITHUB:PR:acme/payments-api#411'), 'by canonical id');
  assert.equal(helper.queued('github:pr:acme/payments-api#413'), false);

  await helper.ask([pull(410), pull(411), pull(412)]);
  assert.deepEqual(run.calls, ['check https://github.com/acme/payments-api/pull/410 main'], 'a queue gets a moment to notice it first');

  run.calls.length = 0;
  time.pass(STATUS_AFTER_MS);
  queued.set('https://github.com/acme/payments-api/pull/411', ran('{"queued": false}'));
  queued.set('https://github.com/acme/payments-api/pull/412', ran('', 1, 'queue API timed out'));
  // 410 merged: GitHub no longer lists it.
  await helper.ask([pull(411), pull(412)]);
  assert.deepEqual(run.calls.sort(), ['status https://github.com/acme/payments-api/pull/411', 'status https://github.com/acme/payments-api/pull/412']);
  assert.equal(helper.queued('github:pr:acme/payments-api#410'), false, 'merged, forgotten without asking');
  assert.equal(helper.queued('github:pr:acme/payments-api#411'), false, 'out of the queue, and asked about no more');
  assert.equal(helper.queued('github:pr:acme/payments-api#412'), true, 'what it said last stands while it can’t say');
  assert.deepEqual(helper.warnings(), ["The merge helper couldn't say whether acme/payments-api#412 is still in its queue: it exited with code 1: queue API timed out."]);

  run.calls.length = 0;
  queued.delete('https://github.com/acme/payments-api/pull/412');
  await helper.ask([pull(411), pull(412)]);
  assert.deepEqual(run.calls, ['status https://github.com/acme/payments-api/pull/412'], '411 is not asked about again');
  assert.deepEqual(helper.warnings(), []);
});

test('merge hands over one pull request, or a stack from its top, and says what the helper said', async () => {
  let answer = ran('Queued: position 2\n');
  const run = fakeRun(() => answer);
  const helper = new MergeHelper('/opt/merge-helper', run, () => ({}));
  const one = [{ url: 'https://github.com/acme/payments-api/pull/412', head: 'head-412' }];
  const stack = [{ url: 'https://github.com/acme/payments-api/pull/411', head: 'head-411' }, ...one];
  assert.equal(await helper.merge('https://github.com/acme/payments-api/pull/412', false, one), 'Queued: position 2');
  assert.equal(await helper.merge('https://github.com/acme/payments-api/pull/412', true, stack), 'Queued: position 2');
  // Every pull request comes with the commit the user said yes to, for the helper to hold the queue to.
  assert.deepEqual(run.calls, [
    'merge https://github.com/acme/payments-api/pull/412 --head https://github.com/acme/payments-api/pull/412=head-412',
    'merge --stack https://github.com/acme/payments-api/pull/412 --head https://github.com/acme/payments-api/pull/411=head-411 --head https://github.com/acme/payments-api/pull/412=head-412',
  ]);

  answer = ran('', 1, 'acme/payments-api is frozen until Monday');
  await assert.rejects(helper.merge('https://github.com/acme/payments-api/pull/412', false, one), { name: 'HelperRefusal', message: 'acme/payments-api is frozen until Monday' });
});

test('a merge that takes too long says it may have happened', async () => {
  const run: RunHelper = async () => {
    throw new HelperError('took longer than 2 min and was stopped');
  };
  const helper = new MergeHelper('/opt/merge-helper', run, () => ({}));
  await assert.rejects(helper.merge('https://github.com/acme/payments-api/pull/412', false, [{ url: 'https://github.com/acme/payments-api/pull/412', head: 'head-412' }]), {
    message: 'the merge helper took longer than 2 min and was stopped; look on GitHub to see whether it took it',
  });
});
