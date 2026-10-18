/**
 * The setup screen through the server: a new store's state carries it, the
 * routes answer with fresh state, and the finish saves and restarts into a
 * dashboard that is set up. No CLI is chosen, so nothing is run; gh and the
 * calendar helper point at nothing, so no live account is asked.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';
import type { Profile } from '../src/stores.ts';
import type { DashboardState } from '../src/types.ts';

let root: string;
/** The work store, which a dashboard told no profile opens in a new data folder. */
let dataDir: string;
let server: StartedServer | null = null;
let url = '';
let restarts = 0;
let env: NodeJS.ProcessEnv;
/** What the store starts with: boards off, and gh and the calendar helper pointing at nothing. */
let SAVED: Record<string, string>;

/** What `runServer` does, minus the process: close this one, start the next on the same environment and profile. */
async function start(profile?: Profile): Promise<void> {
  server = await startServer(env, {
    onRestart: () => {
      restarts++;
      const previous = server;
      server = null;
      void previous!.close().then(() => start(previous!.profile));
    },
    profile,
  });
  url = server.url;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-focus-server-onboarding-'));
  dataDir = join(root, 'work');
  await mkdir(dataDir);
  SAVED = {
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_GH: join(dataDir, 'no-gh'),
    DAILY_FOCUS_CALENDAR_APP: join(dataDir, 'no-helper.app'),
  };
  env = {
    DAILY_FOCUS_DATA: root,
    DAILY_FOCUS_PORT: '0',
    DAILY_FOCUS_HOST: '127.0.0.1',
  };
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(SAVED));
  await start();
});

after(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
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
    // Work or personal, the boards, the calendars and the objective are answered; the rest can be left.
    const answers: Record<string, unknown> = {
      profile: { choices: { profile: ['personal'] }, fields: {} },
      services: { choices: { services: [] }, fields: {} },
      calendars: { choices: { calendars: [] }, fields: {} },
      objective: { choices: {}, fields: { objective: '', blocker: '' } },
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
  // What the store had stands beside the answers, which leave both boards off,
  // and the store, which began as work, is now in the personal folder.
  const personal = join(root, 'personal');
  assert.deepEqual(JSON.parse(await readFile(join(personal, 'settings.json'), 'utf8')), { ...SAVED, DAILY_FOCUS_PROFILE: 'personal' });
  assert.equal(existsSync(dataDir), false, 'the work folder was renamed, not copied');
  const status = (await (await fetch(`${url}/api/status`)).json()) as { dataDir: string; profile: string };
  assert.deepEqual([status.dataDir, status.profile], [personal, 'personal']);
  const after = await state();
  assert.deepEqual(after.setupNotices, [], 'a new store renamed after setup is no news');
  assert.equal(after.onboarding, null);
  assert.equal(after.setup.needed, true, 'no brief yet, and no agent to write one');
  assert.equal(after.agentRun.last, null, 'nothing was started');
});
