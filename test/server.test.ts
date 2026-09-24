import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';

let server: StartedServer;
let dataDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-server-'));
  process.env.DAILY_FOCUS_DATA = dataDir;
  process.env.DAILY_FOCUS_PORT = '0'; // any free port
  process.env.DAILY_FOCUS_HOST = '127.0.0.1';
  // Never let a test reach for gh or the network.
  process.env.DAILY_FOCUS_GITHUB = 'off';
  // ...nor for the real calendar, which would mean a TCC prompt in CI.
  process.env.DAILY_FOCUS_CALENDAR = 'off';
  // ...nor for acli, which would spawn a CLI and hit a real Jira.
  process.env.DAILY_FOCUS_JIRA = 'off';

  await writeFile(
    join(dataDir, 'items.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      items: [{ id: 'gh:1', source: 'github', kind: 'task', title: 'Review something' }],
    }),
  );

  // The process environment only, never the developer's private .env.
  server = await startServer(process.env);
});

after(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${server.url}/api/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** These tests poke at arbitrary response fields; `Response.json()` is typed `unknown`. */
const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;

test('GET /api/state returns the folded state', async () => {
  const res = await fetch(`${server.url}/api/state`);
  assert.equal(res.status, 200);

  const state = await json(res);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, 'open');
  assert.equal(state.problem, null);
});

test('POST /api/actions records an action and returns fresh state', async () => {
  const res = await post({ id: 'gh:1', action: 'done' });
  assert.equal(res.status, 200);

  const state = await json(res);
  assert.equal(state.items[0].status, 'done');
  assert.equal(state.stats.completedToday, 1);
  // The client replaces its whole state with this reply, so it has to be the
  // complete one. A reply without the board once made every save look failed.
  assert.ok(state.board, 'the action reply carries the board');
  assert.equal(state.board.enabled, false);
  assert.ok(state.assetVersion, 'and the asset fingerprint');
});

test('POST /api/actions rejects a bad payload', async () => {
  for (const body of [
    {},
    { id: 'gh:1' },
    { id: 'gh:1', action: 'explode' },
    { id: '', action: 'done' },
    { id: 'gh:1', action: 'snooze', until: 'next tuesday' },
    { id: 'gh:1', action: 'note' },
    { id: 'gh:1', action: 'note', text: '   ' },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok((await json(res)).error);
  }
});

test('a snooze without a date is allowed', async () => {
  const res = await post({ id: 'gh:1', action: 'snooze' });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).items[0].status, 'snoozed');
});

test('static assets are served and traversal is refused', async () => {
  const page = await fetch(`${server.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /Daily Focus/);

  for (const path of ['/../package.json', '/%2e%2e/package.json', '/../../etc/passwd']) {
    const res = await fetch(`${server.url}${path}`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `${path} returned ${res.status}`);
  }
});

test('SSE pushes the current state on connect', async () => {
  const controller = new AbortController();
  const res = await fetch(`${server.url}/api/events`, { signal: controller.signal });
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);

  assert.match(frame, /^event: state/);
  assert.ok(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).items);

  controller.abort();
});

test('unknown methods are refused', async () => {
  const res = await fetch(`${server.url}/api/state`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});

test('GET /favicon.svg serves the profile icon', async () => {
  const res = await fetch(`${server.url}/favicon.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /fill="#2a78d6"/);
});

test('rerunning the morning agent is off by default, and refuses a request that is not JSON', async () => {
  const state = await json(await fetch(`${server.url}/api/state`));
  assert.equal(state.agentRun.enabled, false);
  assert.equal(state.agentRun.last, null);

  // What a form on another site can send without a preflight.
  const form = await fetch(`${server.url}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(form.status, 415);

  const res = await fetch(`${server.url}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 409);
  assert.match((await json(res)).error, /DAILY_FOCUS_AGENT/);
});

test('the assistant is off by default, says so in state, and refuses to be asked', async () => {
  const state = await json(await fetch(`${server.url}/api/state`));
  assert.equal(state.assistant.enabled, false);
  assert.equal(state.assistant.agent, null);
  assert.ok(Array.isArray(state.assistant.quickActions) && state.assistant.quickActions.length > 0);

  const res = await fetch(`${server.url}/api/assistant/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'gh:1', text: 'hello' }),
  });
  assert.equal(res.status, 409);
  assert.match((await json(res)).error, /DAILY_FOCUS_ASSISTANT/);

  const bad = await fetch(`${server.url}/api/assistant/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'no id' }),
  });
  assert.equal(bad.status, 400);
});
