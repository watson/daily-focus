/**
 * The setup screen through the server: a new store's state carries it, the
 * routes answer with fresh state, and the finish saves and restarts into a
 * dashboard that is set up. No CLI is chosen, so nothing is run; gh and the
 * calendar helper point at nothing, so no live account is asked.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';
import type { DashboardState } from '../src/types.ts';

let dataDir: string;
let server: StartedServer | null = null;
let url = '';
let restarts = 0;
let env: NodeJS.ProcessEnv;

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

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-server-onboarding-'));
  env = {
    DAILY_FOCUS_DATA: dataDir,
    DAILY_FOCUS_PORT: '0',
    DAILY_FOCUS_HOST: '127.0.0.1',
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_GH: join(dataDir, 'no-gh'),
    DAILY_FOCUS_CALENDAR_APP: join(dataDir, 'no-helper.app'),
  };
  await start();
});

after(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async (): Promise<DashboardState> => (await fetch(`${url}/api/state`)).json() as Promise<DashboardState>;

test('a new store carries the setup screen in its state, on its first question', async () => {
  const current = await state();
  assert.equal(current.onboarding?.current, 'cli');
  assert.ok(current.onboarding!.steps.some((step) => step.id === 'calendars'));
});

test('an answer comes back as fresh state, and one to no question is refused', async () => {
  const res = await post('/api/onboarding/answer', { step: 'cli', answer: { later: true } });
  assert.equal(res.status, 200);
  const next = (await res.json()) as DashboardState;
  assert.equal(next.onboarding!.steps.find((step) => step.id === 'cli')!.status, 'later');
  assert.equal(next.onboarding!.current, 'profile');

  const refused = await post('/api/onboarding/answer', { step: 'nope', answer: { later: true } });
  assert.equal(refused.status, 409);
  assert.equal((await post('/api/onboarding/frobnicate', {})).status, 404);
  assert.equal((await post('/api/onboarding/revise', { step: 'identity' })).status, 409, 'nothing to say');
});

test('the finish saves the answers, restarts, and the screen is gone', async () => {
  for (const step of (await state()).onboarding!.steps) {
    if (step.status !== 'open') continue;
    // Work or personal, and the calendars, are answered; the rest can be put off.
    const answers: Record<string, unknown> = {
      profile: { choices: { profile: ['personal'] }, fields: {} },
      calendars: { choices: { calendars: [] }, fields: {} },
    };
    const answer = answers[step.id] ?? { later: true };
    assert.equal((await post('/api/onboarding/answer', { step: step.id, answer })).status, 200, step.id);
  }
  assert.equal((await state()).onboarding!.current, null);
  const preview = (await (await fetch(`${url}/api/onboarding/sources`)).json()) as { text: string | null; kept: boolean };
  assert.deepEqual(preview, { text: null, kept: false }, 'nothing chosen that the source list holds');

  const res = await post('/api/onboarding/finish', {});
  assert.equal(res.status, 200);
  for (let i = 0; i < 200 && (restarts < 1 || server === null); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(server, 'the dashboard came back');
  // The boards are set in this test's environment, which wins, so they aren't saved.
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')), { DAILY_FOCUS_PROFILE: 'personal' });
  const after = await state();
  assert.equal(after.onboarding, null);
  assert.equal(after.setup.needed, true, 'no brief yet, and no agent to write one');
  assert.equal(after.agentRun.last, null, 'nothing was started');
});
