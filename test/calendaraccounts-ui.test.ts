/**
 * Connecting a calendar account off a Mac, rendered: what Daily Focus will read
 * is said before the provider's page opens, and only a second click goes there;
 * an account that needs signing in again says so and offers it. All invented.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mount, settle } from './dom.ts';
import { calendarAccountsView } from '../client/calendaraccounts.ts';
import type { CalendarAccountsState, CalendarProvider } from '../src/types.ts';

function accounts(overrides: Partial<CalendarAccountsState> = {}): CalendarAccountsState {
  return { offered: true, providers: ['google', 'microsoft'], unavailable: null, accounts: [], ...overrides };
}

function click(root: HTMLElement, label: string): void {
  const button = byTag(root, 'button').find((each) => each.textContent === label);
  assert.ok(button, `no button "${label}" among ${JSON.stringify(buttonLabels(root))}`);
  button.click();
}

test('connecting says what Daily Focus will read, and goes to the provider only when asked to', async () => {
  const went: [CalendarProvider, string, string | null][] = [];
  const handlers = handlersWith({
    connectCalendar: async (provider, returnTo, reconnect) => {
      went.push([provider, returnTo, reconnect]);
    },
  });
  const root = mount(calendarAccountsView(accounts(), handlers, { returnTo: '/#settings-calendar', disconnect: true }));
  assert.deepEqual(buttonLabels(root), ['Connect Google Calendar', 'Connect Outlook']);

  click(root, 'Connect Google Calendar');
  await settle();
  assert.equal(went.length, 0, 'nothing leaves the page on the first click');
  const ask = byClass(root, 'calendar-accounts__ask')[0]!;
  assert.match(ask.textContent ?? '', /names of your calendars and today’s events, and nothing else/);
  assert.match(ask.textContent ?? '', /never go to Claude Code, Codex or any other AI/);
  assert.ok(byTag(ask, 'a').some((link) => link.getAttribute('href') === 'https://dailyfocus.dev/privacy/#calendars'));

  click(root, 'Continue to Google');
  await settle();
  assert.deepEqual(went, [['google', '/#settings-calendar', null]]);
});

test('a work account is warned it may need its IT admin, and a refusal stays on the page', async () => {
  const handlers = handlersWith({
    connectCalendar: async () => {
      throw new Error('connect from a browser there');
    },
  });
  const root = mount(calendarAccountsView(accounts(), handlers, { returnTo: '/', disconnect: false }));
  click(root, 'Connect Outlook');
  await settle();
  assert.match(root.textContent ?? '', /may need your IT admin to approve Daily Focus/);
  click(root, 'Continue to Microsoft');
  await settle();
  await settle();
  assert.match(byClass(root, 'connect__error')[0]?.textContent ?? '', /connect from a browser there/);
});

test('a connected account shows who, offers Reconnect only when it needs it, and Disconnect only in Settings', async () => {
  const gone: string[] = [];
  const handlers = handlersWith({ disconnectCalendar: (id) => void gone.push(id) });
  const state = accounts({
    accounts: [
      { id: 'google:1', provider: 'google', email: 'robin@personal.example', problem: null },
      { id: 'microsoft:2', provider: 'microsoft', email: 'robin@northwind.example', problem: 'Microsoft (robin@northwind.example) needs connecting again.' },
    ],
  });

  const settings = mount(calendarAccountsView(state, handlers, { returnTo: '/#settings-calendar', disconnect: true }));
  assert.deepEqual(buttonLabels(settings), ['Disconnect', 'Reconnect', 'Disconnect', 'Connect another Google Calendar account', 'Connect another Outlook account']);
  assert.match(settings.textContent ?? '', /needs connecting again/);
  byTag(settings, 'button')[0]!.click();
  assert.deepEqual(gone, ['google:1']);

  const setup = mount(calendarAccountsView(state, handlers, { returnTo: '/', disconnect: false }));
  assert.ok(!buttonLabels(setup).includes('Disconnect'), 'setup connects; Settings is where an account goes');
});

test('says why nothing can be connected, and shows nothing at all on a Mac', () => {
  const handlers = handlersWith();
  const noKeyring = mount(calendarAccountsView(accounts({ unavailable: 'Install secret-tool, then restart Daily Focus.' }), handlers, { returnTo: '/', disconnect: true }));
  assert.match(noKeyring.textContent ?? '', /Install secret-tool/);
  assert.deepEqual(buttonLabels(noKeyring), []);

  assert.equal(calendarAccountsView(accounts({ offered: false }), handlers, { returnTo: '/', disconnect: true }), null);
  assert.equal(calendarAccountsView(undefined, handlers, { returnTo: '/', disconnect: true }), null, 'an older server says nothing of accounts');
});
