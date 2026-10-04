import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';

let dataDir: string;
let env: NodeJS.ProcessEnv;
let server: StartedServer | null = null;
let url = '';
let restarts = 0;

/** What `runServer` does, minus the process: close this one, start the next on the same environment. */
async function start(): Promise<void> {
  server = await startServer(env, {
    onRestart: () => {
      restarts++;
      const previous = server;
      server = null;
      void previous!.close().then(start);
    },
  });
  url = server.url;
}

/** Wait for the restart a save asked for to finish. */
async function restarted(count: number): Promise<void> {
  for (let i = 0; i < 200 && (restarts < count || server === null); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(server, 'the dashboard came back');
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-server-settings-'));
  env = {
    DAILY_FOCUS_DATA: dataDir,
    DAILY_FOCUS_PORT: '0',
    DAILY_FOCUS_HOST: '127.0.0.1',
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_CALENDAR: 'off',
    DAILY_FOCUS_JIRA: 'off',
    // Locked: set for this launch, so the page can't change it.
    DAILY_FOCUS_SESSION_MINUTES: '30',
  };
  await start();
});

after(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;
const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the store is linked to this copy when the dashboard starts', async () => {
  for (const name of ['prompt.md', 'items.schema.json', 'assistant.md']) {
    assert.ok((await lstat(join(dataDir, name))).isSymbolicLink(), name);
  }
  assert.match(await readlink(join(dataDir, 'prompt.md')), /prompts\/morning-brief-work\.md$/);
});

test('the settings page sees every setting, where it came from, and what the default is', async () => {
  const settings = await json(await fetch(`${url}/api/settings`));
  const agent = settings.settings.find((s: { key: string }) => s.key === 'DAILY_FOCUS_AGENT');
  assert.deepEqual([agent.value, agent.source, agent.fallback], [null, 'default', 'Off']);
  const minutes = settings.settings.find((s: { key: string }) => s.key === 'DAILY_FOCUS_SESSION_MINUTES');
  assert.deepEqual([minutes.value, minutes.source], ['30', 'environment']);
  assert.ok(!settings.settings.some((s: { key: string }) => s.key === 'DAILY_FOCUS_DATA'), 'the store path is not on the page');
  assert.equal(settings.restart, null);
});

test('a bad value is refused and nothing is written', async () => {
  const res = await post('/api/settings', { values: { DAILY_FOCUS_ASSISTANT: 'gpt' } });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /DAILY_FOCUS_ASSISTANT/);
  await assert.rejects(readFile(join(dataDir, 'settings.json')), { code: 'ENOENT' });

  const locked = await post('/api/settings', { values: { DAILY_FOCUS_SESSION_MINUTES: '50' } });
  assert.equal(locked.status, 400);
  assert.match((await json(locked)).error, /environment/);
});

test('a saved setting lands in the store and takes effect after the restart it asks for', async () => {
  const before = await json(await fetch(`${url}/api/state`));
  assert.equal(before.assistant.enabled, false);

  const res = await post('/api/settings', { values: { DAILY_FOCUS_ASSISTANT: 'claude' } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')), { DAILY_FOCUS_ASSISTANT: 'claude' });

  await restarted(1);
  const after = await json(await fetch(`${url}/api/state`));
  assert.equal(after.assistant.enabled, true);
  assert.equal(after.assistant.agent, 'claude');
  assert.equal(after.restart, null, 'and nothing is left waiting');

  const settings = await json(await fetch(`${url}/api/settings`));
  const assistant = settings.settings.find((s: { key: string }) => s.key === 'DAILY_FOCUS_ASSISTANT');
  assert.deepEqual([assistant.value, assistant.source], ['claude', 'settings']);

  // Saving what is already saved changes nothing, so restarts nothing.
  assert.equal((await post('/api/settings', { values: { DAILY_FOCUS_ASSISTANT: 'claude' } })).status, 200);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(restarts, 1);
});

test('two settings saved at once both land', async () => {
  const before = restarts;
  const [a, b] = await Promise.all([
    post('/api/settings', { values: { DAILY_FOCUS_WORK_START: '8' } }),
    post('/api/settings', { values: { DAILY_FOCUS_MIN_FREE_WINDOW: '30' } }),
  ]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const saved = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.DAILY_FOCUS_WORK_START, '8');
  assert.equal(saved.DAILY_FOCUS_MIN_FREE_WINDOW, '30');
  // One restart applies both: the second save finds one already on its way.
  await restarted(before + 1);
});

test('the editors read and save the whole file, and a stale save is refused', async () => {
  const opened = await json(await fetch(`${url}/api/text/focus`));
  assert.deepEqual([opened.text, opened.version], [null, 'absent']);
  assert.match(opened.template, /<!-- agent-only -->/);

  const text = '---\nobjective: Ship the reliability fix\n---\n\nShown.\n\n<!-- agent-only -->\nNot shown.\n';
  const saved = await post('/api/text/focus', { text, version: opened.version });
  assert.equal(saved.status, 200);
  const { version } = await json(saved);

  // The board gets the public half; the editor gets all of it.
  const state = await json(await fetch(`${url}/api/state`));
  assert.equal(state.focus.objective, 'Ship the reliability fix');
  assert.ok(!JSON.stringify(state).includes('Not shown.'), 'the private part never reaches the state');
  assert.equal((await json(await fetch(`${url}/api/text/focus`))).text, text);

  const stale = await post('/api/text/focus', { text: 'something else', version: opened.version });
  assert.equal(stale.status, 409);
  const conflict = await json(stale);
  assert.equal(conflict.text, text);
  assert.equal(conflict.version, version);

  const sources = await json(await fetch(`${url}/api/text/sources`));
  assert.equal(sources.text, null);
  assert.match(sources.template, /## Identity/);
});

test('the objective can be changed on its own, and the rest of the file is kept', async () => {
  const res = await post('/api/focus/objective', { objective: 'Get staging working again', blocker: 'No access to the logs' });
  assert.equal(res.status, 200);
  const state = await json(res);
  assert.equal(state.focus.objective, 'Get staging working again');
  assert.equal(state.focus.blocker, 'No access to the logs');
  const text = await readFile(join(dataDir, 'focus.md'), 'utf8');
  assert.match(text, /Not shown\./);

  assert.equal((await post('/api/focus/objective', { objective: 42 })).status, 400);
});

test('the status the menu bar app reads is small and says what it needs', async () => {
  const status = await json(await fetch(`${url}/api/status`));
  assert.equal(status.dataDir, dataDir);
  assert.equal(status.profile, 'work');
  assert.equal(status.setupNeeded, true);
  assert.equal(status.restartPending, false);
  assert.deepEqual(Object.keys(status.brief).sort(), ['ageHours', 'generatedAt', 'open', 'stale']);
  assert.equal(status.agent.enabled, false);
  assert.equal(status.agent.last, null);
  assert.equal(status.waitingOnYou, 0);
});

test("the morning agent's clock waits for the first brief, which comes from the setup steps", async () => {
  const store = await mkdtemp(join(tmpdir(), 'daily-focus-first-brief-'));
  // Due every minute of the day, so only the first-brief rule can be holding it back.
  const due = await startServer({
    ...env,
    DAILY_FOCUS_DATA: store,
    DAILY_FOCUS_AGENT: 'codex',
    DAILY_FOCUS_AGENT_AT: '00:00',
    DAILY_FOCUS_AGENT_DAYS: '0-6',
    DAILY_FOCUS_AGENT_BIN: '/usr/bin/false',
  });
  try {
    await new Promise((done) => setTimeout(done, 200));
    const state = await json(await fetch(`${due.url}/api/state`));
    assert.equal(state.setup.needed, true);
    assert.equal(state.agentRun.runs.length, 0, 'nothing started on its own');
  } finally {
    await due.close();
    await rm(store, { recursive: true, force: true });
  }
});
