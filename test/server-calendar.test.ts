import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { startServer } from '../src/server.ts';
import type { DashboardState } from '../src/types.ts';
import { CLIENTS, fakeProviders, fakeVault } from './fakecalendar.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function state(base: string): Promise<DashboardState> {
  return (await (await fetch(`${base}/api/state`)).json()) as DashboardState;
}

test('a Google calendar connects through its page and the callback, and the agenda reads it live, off a Mac', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daily-focus-server-calendar-'));
  dirs.push(root);
  const store = join(root, 'work');
  await mkdir(store);
  await writeFile(
    join(store, 'settings.json'),
    JSON.stringify({ DAILY_FOCUS_PROFILE: 'work', DAILY_FOCUS_AGENT: 'off', DAILY_FOCUS_GITHUB: 'off', DAILY_FOCUS_JIRA: 'off', DAILY_FOCUS_CALENDARS: 'Family' }),
  );
  const providers = fakeProviders({ day: today() });
  const server = await startServer(
    { PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' },
    { integrations: { calendarAccounts: { clients: CLIENTS, fetch: providers.fetch, vault: () => fakeVault(), platform: 'linux' } } },
  );
  try {
    const before = await state(server.url);
    assert.deepEqual(before.calendarAccounts, { offered: true, providers: ['google', 'microsoft'], unavailable: null, accounts: [] });
    assert.equal(before.setup.calendar.source, 'accounts');
    assert.match(before.agendaSource.problem ?? '', /No Google or Microsoft calendar is connected/);

    const started = await post(`${server.url}/api/calendar/accounts/connect`, { provider: 'google', returnTo: '/#settings-calendar' });
    assert.equal(started.status, 200);
    const { url } = (await started.json()) as { url: string };
    const port = new URL(server.url).port;
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth/callback`);
    const answer = providers.approve(url, 'code-1');

    // Where Google sends the browser: a page that does nothing by being loaded.
    const page = await fetch(`${server.url}/oauth/callback?state=${answer.state}&code=${answer.code}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /\/api\/calendar\/accounts\/finish/);
    assert.deepEqual((await state(server.url)).calendarAccounts?.accounts, [], 'loading the callback page connected nothing');

    const finished = (await (await post(`${server.url}/api/calendar/accounts/finish`, answer)).json()) as { connected?: string; returnTo: string };
    assert.deepEqual(finished, { returnTo: '/#settings-calendar', connected: 'robin@personal.example' });

    let after = await state(server.url);
    for (let i = 0; i < 200 && !after.agendaSource.live; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      after = await state(server.url);
    }
    assert.equal(after.agendaSource.live, true);
    assert.deepEqual(after.calendarAccounts?.accounts.map((account) => account.email), ['robin@personal.example']);
    assert.equal(after.setup.calendar.built, true);
    assert.ok(JSON.stringify(after.agenda).includes('Swimming'), 'today’s event is on the agenda');
    assert.doesNotMatch(JSON.stringify(after), /google-refresh|google-access/, 'no token reaches the page');
    await assert.rejects(readFile(join(store, 'calendar.json')), 'what was read is never written into the store');

    const listed = (await (await post(`${server.url}/api/calendars/list`, {})).json()) as { calendars: { title: string; source: string }[] };
    assert.deepEqual(listed.calendars, [
      { title: 'Family', source: 'robin@personal.example' },
      { title: 'Noisy', source: 'robin@personal.example' },
    ]);

    const gone = (await (await post(`${server.url}/api/calendar/accounts/disconnect`, { id: 'google:g-123' })).json()) as DashboardState;
    assert.deepEqual(gone.calendarAccounts?.accounts, []);
    assert.ok(providers.calls.some((call) => call.url.href === 'https://oauth2.googleapis.com/revoke'));
  } finally {
    await server.close();
  }
});
