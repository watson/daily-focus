import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CalendarAccounts, dayBounds, isLoopback } from '../src/calendaraccounts.ts';
import { googleEvent, microsoftEvent } from '../src/calendarproviders.ts';
import { dpapiVault, keyringVault, type Vault } from '../src/calendarvault.ts';
import { selectEvents } from '../src/calendar.ts';
import { CLIENTS, fakeProviders, fakeVault } from './fakecalendar.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function accountsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-accounts-'));
  dirs.push(dir);
  return join(dir, 'calendar-accounts.json');
}

function accountsWith(file: string, providers: ReturnType<typeof fakeProviders>, vault: Vault = fakeVault(), now = () => new Date('2026-10-20T08:00:00')) {
  return new CalendarAccounts(file, '/stores/work', CLIENTS, () => {}, { fetch: providers.fetch, vault: () => vault, platform: 'linux', now });
}

test('signing in to Google goes through its page and back to this computer, with PKCE, and keeps only a sealed token', async () => {
  const file = await accountsFile();
  const providers = fakeProviders();
  const accounts = accountsWith(file, providers);

  const url = new URL(accounts.begin('google', '127.0.0.1:4321', '/#settings-calendar'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4321/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope') ?? '', /calendar\.events\.readonly/);
  assert.doesNotMatch(url.searchParams.get('scope') ?? '', /auth\/calendar(\s|$)/, 'never the scope that can change a calendar');

  const answer = providers.approve(url.toString(), 'code-1');
  const result = await accounts.finish(answer);
  assert.deepEqual(result, { returnTo: '/#settings-calendar', connected: 'robin@personal.example' });
  assert.deepEqual(
    accounts.view().accounts.map(({ provider, email, problem }) => ({ provider, email, problem })),
    [{ provider: 'google', email: 'robin@personal.example', problem: null }],
  );

  const saved = await readFile(file, 'utf8');
  assert.doesNotMatch(saved, /google-refresh-1/, 'the refresh token is in the file only as the vault sealed it');
  assert.match(saved, /robin@personal\.example/);

  const again = await accounts.finish(answer);
  assert.match(again.error ?? '', /expired, or was finished already/, 'each start is good for one finish');
  assert.equal(accounts.view().accounts.length, 1);
});

test('a sign-in nobody started here is refused, which keeps another page from finishing one into this dashboard', async () => {
  const accounts = accountsWith(await accountsFile(), fakeProviders());
  const result = await accounts.finish({ state: 'made-up', code: 'stolen' });
  assert.match(result.error ?? '', /expired, or was finished already/);
  assert.equal(result.returnTo, '/');
  assert.equal(accounts.view().accounts.length, 0);
});

test('only from this computer, and only where a sign-in can be kept safely', async () => {
  const accounts = accountsWith(await accountsFile(), fakeProviders());
  assert.throws(() => accounts.begin('google', 'mini.tailnet.ts.net', '/'), /connect from a browser there/);

  const microsoft = new URL(accounts.begin('microsoft', '127.0.0.1:4322', '/'));
  assert.equal(microsoft.searchParams.get('redirect_uri'), 'http://localhost:4322/oauth/callback', 'the address registered with Microsoft, whatever the port');

  const noKeyring = new CalendarAccounts(await accountsFile(), '/stores/work', CLIENTS, () => {}, {
    fetch: fakeProviders().fetch,
    vault: () => ({ unavailable: 'no keyring' }),
    platform: 'linux',
  });
  assert.throws(() => noKeyring.begin('google', 'localhost:4321', '/'), /no keyring/);
  assert.equal(noKeyring.view().unavailable, 'no keyring');

  const unregistered = new CalendarAccounts(await accountsFile(), '/stores/work', { google: { id: '', secret: '' }, microsoft: { id: 'm' } }, () => {}, {
    vault: () => fakeVault(),
    platform: 'win32',
  });
  assert.deepEqual(unregistered.view().providers, ['microsoft']);
  assert.throws(() => unregistered.begin('google', 'localhost:4321', '/'), /can’t sign in to Google/);

  const mac = new CalendarAccounts(await accountsFile(), '/stores/work', CLIENTS, () => {}, { platform: 'darwin' });
  assert.equal(mac.view().offered, false, 'a Mac reads Calendar.app instead');
});

test('a return address is a path on this dashboard, never another site', async () => {
  const providers = fakeProviders();
  const accounts = accountsWith(await accountsFile(), providers);
  for (const returnTo of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
    const result = await accounts.finish(providers.approve(accounts.begin('google', 'localhost:4321', returnTo), `code-${returnTo}`));
    assert.equal(result.returnTo, '/');
  }
});

test('a Google grant without both calendar permissions is refused and revoked', async () => {
  const providers = fakeProviders({ googleScopes: 'openid https://www.googleapis.com/auth/calendar.calendarlist.readonly' });
  const accounts = accountsWith(await accountsFile(), providers);
  const result = await accounts.finish(providers.approve(accounts.begin('google', 'localhost:4321', '/'), 'code-2'));
  assert.match(result.error ?? '', /both calendar permissions/);
  assert.ok(providers.calls.some((call) => call.url.href === 'https://oauth2.googleapis.com/revoke'));
  assert.equal(accounts.view().accounts.length, 0);
});

test('a work account its organisation must approve first gets the page to send an IT admin', async () => {
  const accounts = accountsWith(await accountsFile(), fakeProviders());
  const state = new URL(accounts.begin('microsoft', 'localhost:4321', '/')).searchParams.get('state')!;
  const result = await accounts.finish({ state, error: 'access_denied', errorDescription: 'AADSTS90094: Admin consent is required.' });
  assert.match(result.error ?? '', /IT admin/);
  const admin = new URL(result.adminUrl ?? '');
  assert.equal(admin.searchParams.get('client_id'), 'microsoft-client');
  assert.match(admin.searchParams.get('scope') ?? '', /Calendars\.ReadBasic/);
});

test('reads today’s events from the named calendars of every account, and asks Google for no one else’s address', async () => {
  const providers = fakeProviders();
  const accounts = accountsWith(await accountsFile(), providers);
  await accounts.finish(providers.approve(accounts.begin('google', 'localhost:4321', '/'), 'g'));
  await accounts.finish(providers.approve(accounts.begin('microsoft', 'localhost:4321', '/'), 'm'));

  const facts = await accounts.read(['Family', 'Calendar']);
  assert.equal(facts.selfKnown, true);
  assert.equal(facts.problems, undefined);
  assert.deepEqual(
    facts.calendars.map((calendar) => [calendar.title, calendar.source]),
    [['Family', 'robin@personal.example'], ['Noisy', 'robin@personal.example'], ['Calendar', 'robin@northwind.example']],
  );
  const selected = selectEvents(facts, ['Family', 'Calendar']).events;
  assert.deepEqual(selected.map((event) => event.title).sort(), ['Design review', 'Swimming']);
  // Dismissing one writes its ID to the action log, which the morning agent reads.
  assert.ok(selected.every((event) => !/uid-|google\.com/.test(event.id)), `an event ID carries nothing from the calendar: ${selected.map((event) => event.id)}`);

  const eventReads = providers.calls.filter((call) => call.url.pathname.startsWith('/calendar/v3/calendars/'));
  assert.equal(eventReads.length, 1, 'only the calendar named: not Noisy');
  const fields = eventReads[0]!.url.searchParams.get('fields') ?? '';
  assert.match(fields, /attendees\(self,responseStatus\)/);
  assert.doesNotMatch(fields, /email/);
  const { start, end } = dayBounds(new Date('2026-10-20T08:00:00'));
  assert.equal(eventReads[0]!.url.searchParams.get('timeMin'), start.toISOString());
  assert.equal(eventReads[0]!.url.searchParams.get('timeMax'), end.toISOString());
  assert.ok(eventReads.every((call) => call.auth === 'Bearer google-access-1'), 'the access token from signing in, while it lasts');
});

test('an expired access token is renewed from the vault, and a token Microsoft rotates is sealed again', async () => {
  const file = await accountsFile();
  const providers = fakeProviders({ rotate: true });
  const vault = fakeVault();
  let now = new Date('2026-10-20T08:00:00');
  const accounts = accountsWith(file, providers, vault, () => now);
  await accounts.finish(providers.approve(accounts.begin('microsoft', 'localhost:4321', '/'), 'm'));
  const before = await readFile(file, 'utf8');

  now = new Date('2026-10-20T10:00:00');
  await accounts.read(['Calendar']);
  const refreshed = providers.calls.find((call) => call.form?.get('grant_type') === 'refresh_token');
  assert.equal(refreshed?.form?.get('refresh_token'), 'microsoft-refresh-1');
  const after = await readFile(file, 'utf8');
  assert.notEqual(after, before);
  assert.doesNotMatch(after, /microsoft-refresh-/);
});

test('a sign-in that stopped working says to connect again, and its last good read stands in meanwhile', async () => {
  const file = await accountsFile();
  const providers = fakeProviders();
  let now = new Date('2026-10-20T08:00:00');
  const accounts = accountsWith(file, providers, fakeVault(), () => now);
  await accounts.finish(providers.approve(accounts.begin('google', 'localhost:4321', '/'), 'g'));
  assert.equal((await accounts.read(['Family'])).events.length, 1);

  // Revoked at Google, and the access token from signing in has run out.
  providers.revoke();
  now = new Date('2026-10-20T10:00:00');
  const facts = await accounts.read(['Family']);
  assert.equal(facts.events.length, 1, 'the last good read stands in');
  assert.match(facts.problems?.[0] ?? '', /robin@personal\.example\) needs connecting again/);
  assert.match(accounts.view().accounts[0]!.problem ?? '', /Reconnect under Calendar/);

  // After a restart nothing has been read yet, so nothing stands in, and the read fails as a whole.
  const restarted = accountsWith(file, providers, fakeVault(), () => now);
  await restarted.load();
  await assert.rejects(restarted.read(['Family']), /needs connecting again/);
});

test('disconnecting forgets the sign-in, asks Google to revoke it, and keeps the other accounts', async () => {
  const file = await accountsFile();
  const providers = fakeProviders();
  const vault = fakeVault();
  const accounts = accountsWith(file, providers, vault);
  await accounts.finish(providers.approve(accounts.begin('google', 'localhost:4321', '/'), 'g'));
  await accounts.finish(providers.approve(accounts.begin('microsoft', 'localhost:4321', '/'), 'm'));

  await accounts.disconnect('google:g-123');
  const revoke = providers.calls.find((call) => call.url.href === 'https://oauth2.googleapis.com/revoke');
  assert.equal(revoke?.form?.get('token'), 'google-refresh-1');
  assert.deepEqual(vault.forgotten, ['google:g-123']);
  assert.deepEqual(accounts.view().accounts.map((account) => account.email), ['robin@northwind.example']);
  assert.doesNotMatch(await readFile(file, 'utf8'), /personal\.example/);
});

test('Google events: times as given, all-day on the dashboard’s own day, free when marked free, the user’s own answer', () => {
  assert.equal(googleEvent({ status: 'cancelled', start: { dateTime: '2026-10-20T09:00:00Z' } }), null);
  assert.deepEqual(
    googleEvent({
      id: 'e',
      iCalUID: 'uid',
      summary: 'Lunch & learn',
      start: { dateTime: '2026-10-20T12:00:00+02:00' },
      end: { dateTime: '2026-10-20T13:00:00+02:00' },
      transparency: 'transparent',
      attendees: [{ responseStatus: 'accepted' }, { self: true, responseStatus: 'declined' }],
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    }),
    {
      externalId: 'uid',
      title: 'Lunch & learn',
      start: '2026-10-20T12:00:00+02:00',
      end: '2026-10-20T13:00:00+02:00',
      allDay: false,
      availability: 1,
      selfStatus: 3,
      url: 'https://meet.google.com/abc-defg-hij',
    },
  );
  const allDay = googleEvent({ id: 'h', summary: 'Autumn break', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } })!;
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.start, '2026-10-20T00:00:00', 'local midnight, which the agenda reads as the dashboard’s day');
});

test('Outlook events: UTC times with Graph’s seven decimals, all-day on the right date, and the user’s own answer', () => {
  assert.equal(microsoftEvent({ isCancelled: true, start: { dateTime: '2026-10-20T09:00:00.0000000' } }), null);
  assert.deepEqual(
    microsoftEvent({
      iCalUId: 'uid',
      subject: '1:1',
      start: { dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-20T09:30:00.0000000', timeZone: 'UTC' },
      showAs: 'tentative',
      responseStatus: { response: 'declined' },
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
    }),
    {
      externalId: 'uid',
      title: '1:1',
      start: '2026-10-20T09:00:00.000Z',
      end: '2026-10-20T09:30:00.000Z',
      allDay: false,
      availability: 2,
      selfStatus: 3,
      url: 'https://teams.microsoft.com/l/meetup-join/abc',
    },
  );
  // Midnight in Copenhagen, which Graph gives as 22:00 UTC the day before.
  const allDay = microsoftEvent({ subject: 'Offsite', isAllDay: true, start: { dateTime: '2026-10-19T22:00:00.0000000' }, end: { dateTime: '2026-10-20T22:00:00.0000000' } })!;
  assert.equal(allDay.start, '2026-10-20T00:00:00');
  assert.equal(microsoftEvent({ subject: 'WFH', start: { dateTime: '2026-10-20T00:00:00' }, showAs: 'workingElsewhere' })!.availability, 1);
});

test('the vaults take the token on stdin, never as an argument another process could read', async () => {
  const seen: { file: string; args: readonly string[]; input: string }[] = [];
  const run = async (file: string, args: readonly string[], input: string) => {
    seen.push({ file, args, input });
    return file === 'powershell.exe' ? (input === 'refresh-secret' ? 'U0VBTEVE' : 'refresh-secret') : 'refresh-secret';
  };

  const dpapi = dpapiVault(run);
  const sealed = await dpapi.seal('google:1', 'refresh-secret');
  assert.equal(sealed, 'dpapi:U0VBTEVE');
  assert.equal(await dpapi.open('google:1', sealed), 'refresh-secret');

  const keyring = keyringVault('/stores/work', 'secret-tool', run);
  assert.equal(await keyring.seal('google:1', 'refresh-secret'), 'secret-service');
  assert.equal(await keyring.open('google:1', 'secret-service'), 'refresh-secret');
  await keyring.forget('google:1', 'secret-service');
  const stores = seen.filter((call) => call.file === 'secret-tool').map((call) => call.args);
  assert.ok(stores.every((args) => args.includes('/stores/work')), 'one entry per store: the same account in work and personal is two');

  for (const call of seen) assert.ok(!call.args.some((arg) => arg.includes('refresh-secret')), `${call.file} was given the token as an argument`);
});

test('a provider can send the browser back only to this computer', () => {
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('mini.tailnet.ts.net'), false);
  assert.equal(isLoopback('192.168.1.20'), false);
});
