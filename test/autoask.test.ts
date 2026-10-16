/**
 * Asking ahead: which rows call for which question, and when one may start.
 *
 * The rules worth holding: only rows waiting on the user, only the two quick
 * actions that read, each state once, one turn at a time, never on a row the
 * user is asking about, and never past the day's limit.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { RESTARTED } from '../src/assistant.ts';
import { actionOf, AutoAsk, autoKeys, type AutoAssistant } from '../src/autoask.ts';
import { loadConfig } from '../src/config.ts';
import { demoIntegrations } from '../src/demo.ts';
import { startServer } from '../src/server.ts';
import type { AssistantTurn, BoardRow, CourtReason } from '../src/types.ts';

const NOW = new Date('2026-10-16T12:00:00Z');

function row(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'github:pr:acme/webapp#1',
    account: 'me',
    repo: 'acme/webapp',
    number: 1,
    title: 'A change',
    url: 'https://github.com/acme/webapp/pull/1',
    isDraft: false,
    createdAt: '2026-10-14T09:00:00Z',
    readyAt: '2026-10-14T09:00:00Z',
    updatedAt: '2026-10-16T09:00:00Z',
    headRef: 'me/change',
    baseRef: 'main',
    reviewDecision: null,
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [],
    headSha: 'abc123',
    lastActivityByYou: '2026-10-15T09:00:00Z',
    lastActivityByOthers: null,
    court: 'you',
    decision: null,
    reasons: [],
    stale: false,
    nudge: false,
    since: '2026-10-16T09:00:00Z',
    status: 'open',
    notes: [],
    ...overrides,
  };
}

const commented: CourtReason = { kind: 'activity', login: 'dana', at: '2026-10-16T09:00:00Z', activity: 'comment' };
const failing: CourtReason = { kind: 'ci-failing' };

test('a row waiting on you after a review or a comment calls for an assessment, keyed by the newest', () => {
  assert.deepEqual(autoKeys(row({ reasons: [commented] })), ['assess-review@2026-10-16T09:00:00Z']);
  const both = row({
    reasons: [{ kind: 'changes-requested', login: 'eli', at: '2026-10-16T10:30:00Z' }, commented],
  });
  assert.deepEqual(autoKeys(both), ['assess-review@2026-10-16T10:30:00Z'], 'one question about the review, at its newest');
});

test('a red row calls for an explanation, keyed by its head commit and the checks that failed', () => {
  const red = row({ reasons: [failing], failingChecks: ['unit', 'lint'] });
  assert.deepEqual(autoKeys(red), ['explain-ci@abc123:lint,unit']);
  assert.deepEqual(autoKeys({ ...red, failingChecks: ['lint', 'unit'] }), autoKeys(red), 'the order GitHub lists them in is not a new question');
  assert.notDeepEqual(autoKeys({ ...red, headSha: 'def456' }), autoKeys(red), 'a new commit failing is');
  assert.deepEqual(autoKeys({ ...red, headSha: undefined }), ['explain-ci@2026-10-15T09:00:00Z:lint,unit'], 'a cache from before the head was kept');
});

test('review first, then CI; nothing for a conflict, another court, or a parked row', () => {
  assert.deepEqual(
    autoKeys(row({ reasons: [failing, commented], failingChecks: ['unit'] })).map(actionOf),
    ['assess-review', 'explain-ci'],
  );
  assert.deepEqual(autoKeys(row({ reasons: [{ kind: 'conflicts' }, { kind: 'behind' }] })), []);
  assert.deepEqual(autoKeys(row({ court: 'reviewers', reasons: [commented] })), []);
  assert.deepEqual(autoKeys(row({ status: 'snoozed', reasons: [commented] })), []);
  assert.equal(actionOf('draft-reply@x'), null, 'only the two that read');
});

/* ---------- when it asks ---------- */

/** An assistant that records what it was asked, with the turns a test gives it. */
function fakeAssistant(turns: Partial<AssistantTurn>[] = [], running: string[] = []) {
  const asked: { itemId: string; action?: string; auto?: string; context: unknown }[] = [];
  const all: AssistantTurn[] = turns.map((turn, i) => ({
    id: `t${i}`,
    itemId: 'github:pr:acme/webapp#1',
    agent: 'claude',
    sessionId: null,
    request: 'x',
    action: null,
    auto: null,
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    status: 'done',
    reply: '',
    steps: [],
    error: null,
    ...turn,
  }));
  const assistant: AutoAssistant & { asked: typeof asked } = {
    asked,
    enabled: true,
    start: async () => {},
    autoTurns: () => all.filter((turn) => turn.auto !== null),
    view: () => ({
      enabled: true,
      agent: 'claude',
      quickActions: [],
      items: Object.fromEntries(running.map((id) => [id, { running: true, sessionId: null, turns: [] }])),
    }),
    ask: async (request, context, options) => {
      asked.push({ itemId: request.itemId, action: request.action, auto: options?.auto, context });
      all.push({ ...all[0]!, id: `t${all.length}`, itemId: request.itemId, auto: options?.auto ?? null, status: 'running', startedAt: NOW.toISOString() });
      return all.at(-1)!;
    },
  };
  return assistant;
}

function autoAsk(rows: BoardRow[], assistant: AutoAssistant, env: Record<string, string> = {}, canStart = true): AutoAsk {
  const config = loadConfig({ DAILY_FOCUS_DATA: '/tmp/unused', DAILY_FOCUS_ASSISTANT: 'claude', DAILY_FOCUS_ASSISTANT_AUTO: 'on', ...env });
  return new AutoAsk({
    config,
    assistant,
    rows: async () => rows,
    context: async (id) => ({ pull: rows.find((candidate) => candidate.id === id) }),
    canStart: () => canStart,
    now: () => NOW,
  });
}

const second = row({ id: 'github:pr:acme/webapp#2', number: 2, reasons: [failing], failingChecks: ['unit'] });

test('it asks the first question the board calls for, as the quick action, with the row', async () => {
  const assistant = fakeAssistant();
  const key = await autoAsk([row({ reasons: [commented] }), second], assistant).consider();
  assert.equal(key, 'assess-review@2026-10-16T09:00:00Z');
  assert.equal(assistant.asked.length, 1);
  assert.equal(assistant.asked[0]!.action, 'assess-review');
  assert.equal(assistant.asked[0]!.auto, key);
  assert.equal((assistant.asked[0]!.context as { pull: BoardRow }).pull.number, 1);
});

test('one at a time: nothing starts while one it started is running, and two looks start one', async () => {
  const assistant = fakeAssistant();
  const ahead = autoAsk([row({ reasons: [commented] }), second], assistant);
  const [a, b] = await Promise.all([ahead.consider(), ahead.consider()]);
  assert.deepEqual([a, b].filter(Boolean).length, 1);
  assert.equal(await ahead.consider(), null, 'the first is still running');
  assert.equal(assistant.asked.length, 1);
  ahead.close();
});

test('each state once: a key asked before is skipped, unless a restart cut it short', async () => {
  const key = 'assess-review@2026-10-16T09:00:00Z';
  const answered = fakeAssistant([{ auto: key, status: 'failed' }]);
  assert.equal(await autoAsk([row({ reasons: [commented] }), second], answered).consider(), `explain-ci@abc123:unit`, 'on to the next');

  const stopped = fakeAssistant([{ auto: key, status: 'aborted', error: 'stopped' }]);
  assert.equal(await autoAsk([row({ reasons: [commented] })], stopped).consider(), null, 'stopped by the user is an answer too');

  const cut = fakeAssistant([{ auto: key, status: 'aborted', error: RESTARTED }]);
  assert.equal(await autoAsk([row({ reasons: [commented] })], cut).consider(), key);
});

test("it waits on a row you're asking about, and goes on to the next", async () => {
  const assistant = fakeAssistant([], ['github:pr:acme/webapp#1']);
  assert.equal(await autoAsk([row({ reasons: [commented] }), second], assistant).consider(), 'explain-ci@abc123:unit');
});

test("no more than the day's limit, counted on today's turns only", async () => {
  const yesterday = new Date(NOW.getTime() - 24 * 3600_000).toISOString();
  const spent = fakeAssistant([
    { auto: 'explain-ci@old:a', startedAt: NOW.toISOString(), itemId: 'x' },
    { auto: 'explain-ci@old:b', startedAt: NOW.toISOString(), itemId: 'y' },
  ]);
  const limited = autoAsk([row({ reasons: [commented] })], spent, { DAILY_FOCUS_ASSISTANT_AUTO_LIMIT: '2' });
  assert.equal(await limited.consider(), null);
  assert.deepEqual(limited.view([row({ reasons: [commented] })]).usedToday, 2);

  const old = fakeAssistant([
    { auto: 'explain-ci@old:a', startedAt: yesterday, itemId: 'x' },
    { auto: 'explain-ci@old:b', startedAt: yesterday, itemId: 'y' },
  ]);
  assert.ok(await autoAsk([row({ reasons: [commented] })], old, { DAILY_FOCUS_ASSISTANT_AUTO_LIMIT: '2' }).consider());
});

test('off, or with a restart waiting, it asks nothing; the view still keys the rows', async () => {
  const off = fakeAssistant();
  const quiet = autoAsk([row({ reasons: [commented] })], off, { DAILY_FOCUS_ASSISTANT_AUTO: 'off' });
  assert.equal(await quiet.consider(), null);
  assert.equal(off.asked.length, 0);
  // The log outlives the setting: what was answered ahead still belongs on the row.
  assert.deepEqual(quiet.view([row({ reasons: [commented] })]), {
    enabled: false,
    limit: 10,
    usedToday: 0,
    rows: { 'github:pr:acme/webapp#1': ['assess-review@2026-10-16T09:00:00Z'] },
  });

  const waiting = fakeAssistant();
  assert.equal(await autoAsk([row({ reasons: [commented] })], waiting, {}, false).consider(), null);
  assert.equal(waiting.asked.length, 0);
});

test('the limit is a whole number from 1 to 100', () => {
  assert.throws(() => loadConfig({ DAILY_FOCUS_DATA: '/tmp/x', DAILY_FOCUS_ASSISTANT_AUTO_LIMIT: '0' }), /from 1 to 100/);
  assert.equal(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x' }).assistant.autoLimit, 10);
  assert.equal(loadConfig({ DAILY_FOCUS_DATA: '/tmp/x' }).assistant.auto, false, 'off unless asked for');
});

/* ---------- in the dashboard ---------- */

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('the dashboard asks ahead on its own once the board has read, each question once', async () => {
  const store = await mkdtemp(join(tmpdir(), 'daily-focus-autoask-'));
  dirs.push(store);
  const bin = join(store, 'fake-claude');
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      `echo '{"type":"system","subtype":"init","session_id":"s-1"}'`,
      `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":"Yours: the retry drops the headers."}'`,
    ].join('\n') + '\n',
    'utf8',
  );
  await chmod(bin, 0o755);
  const server = await startServer(
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DAILY_FOCUS_DATA: store,
      DAILY_FOCUS_PORT: '0',
      DAILY_FOCUS_HOST: '127.0.0.1',
      DAILY_FOCUS_PROFILE: 'work',
      DAILY_FOCUS_AGENT: 'off',
      DAILY_FOCUS_CALENDAR: 'off',
      DAILY_FOCUS_JIRA: 'off',
      DAILY_FOCUS_ASSISTANT: 'claude',
      DAILY_FOCUS_ASSISTANT_BIN: bin,
      DAILY_FOCUS_ASSISTANT_AUTO: 'on',
    },
    { integrations: demoIntegrations('work') },
  );
  try {
    // The demo's board has one pull request red and one with a comment since your push.
    const started = async () =>
      (await readFile(join(store, 'assistant.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; item: string; auto?: string; action: string })
        .filter((record) => record.event === 'started');
    let asked = await started();
    for (let i = 0; i < 400 && asked.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      asked = await started();
    }
    assert.deepEqual(
      asked.map((record) => [record.item, record.action]).sort(),
      [
        ['github:pr:acme/webapp#3398', 'assess-review'],
        ['github:pr:acme/webapp#3402', 'explain-ci'],
      ],
    );
    assert.ok(asked.every((record) => record.auto?.startsWith(`${record.action}@`)));

    const state = (await (await fetch(`${server.url}/api/state`)).json()) as import('../src/types.ts').DashboardState;
    assert.equal(state.assistant.auto.enabled, true);
    assert.equal(state.assistant.auto.usedToday, 2);
    assert.ok(state.assistant.auto.rows['github:pr:acme/webapp#3402']?.includes(asked.find((r) => r.action === 'explain-ci')!.auto!));

    // Nothing left to ask: a third look starts nothing.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await started()).length, 2);
  } finally {
    await server.close();
  }
});
