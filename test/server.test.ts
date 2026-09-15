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

  await writeFile(
    join(dataDir, 'items.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      items: [{ id: 'gh:1', source: 'github', kind: 'task', title: 'Review something' }],
    }),
  );

  server = await startServer();
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
