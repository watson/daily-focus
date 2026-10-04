/**
 * What a failing read renders: one line, folded, with the rest behind a click.
 *
 * The rules worth holding are the ones the page exists for — closed it costs
 * no more than the old banner did, open it says how long and why, and Retry
 * asks once — and they live only in `client/failure.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { byClass, byTag, handlersWith, mount, mountOne, uiWith } from './dom.ts';
import { h } from 'preact';
import { renderAgenda } from '../client/agenda.ts';
import { renderBoard } from '../client/board.ts';
import { failureFacts, failureNotice } from '../client/failure.ts';
import { formatTime } from '../client/format.ts';
import type { BoardState, DashboardState, ReadFailure } from '../src/types.ts';

const NOW = new Date('2026-10-04T10:00:00');
const at = (hh: number, mm: number) => new Date(2026, 9, 4, hh, mm).toISOString();

function failure(overrides: Partial<ReadFailure> = {}): ReadFailure {
  return {
    message: "alice and alice_corp: couldn't reach api.github.com (the DNS lookup failed — is this machine online?)",
    detail: 'caused by TypeError: fetch failed\ncaused by Error: getaddrinfo ENOTFOUND api.github.com (code ENOTFOUND)',
    since: at(9, 14),
    attempts: 4,
    retryAt: at(10, 30),
    retrying: false,
    ...overrides,
  };
}

function notice(f: ReadFailure, opts: { open?: boolean; onRetry?: () => void; toggled?: (key: string, open: boolean) => void } = {}) {
  return mountOne(
    failureNotice(
      f,
      { fold: 'failure:board:0', className: 'banner banner--warning', icon: '!', lastGood: at(9, 12), now: NOW, onRetry: opts.onRetry ?? (() => {}) },
      uiWith({ openDrawers: new Set(opts.open ? ['failure:board:0'] : []) }),
      handlersWith({ toggleDrawer: opts.toggled ?? (() => {}) }),
    ),
  );
}

test('folded, it is the one line the banner always was', () => {
  const node = notice(failure()) as HTMLDetailsElement;
  assert.equal(node.tagName, 'DETAILS');
  assert.equal(node.open, false);
  const summary = byTag(node, 'summary')[0];
  assert.equal(summary?.textContent, `!${failure().message}`);
});

test('open, it says how long, how old, when next, and what the error said', () => {
  const node = notice(failure(), { open: true }) as HTMLDetailsElement;
  assert.equal(node.open, true, 'kept open with the drawers, so a retry cannot fold it shut');
  assert.equal(
    byClass(node, 'failure__facts')[0]?.firstElementChild?.textContent,
    `Failing since ${formatTime(at(9, 14))} · 4 attempts · last good read ${formatTime(at(9, 12))} · next try ${formatTime(at(10, 30))}`,
  );
  assert.equal(byTag(node, 'pre')[0]?.textContent, failure().detail);
});

test('a first failure is a moment, not a run, and one with nothing more to say has no block for it', () => {
  const node = notice(failure({ attempts: 1, detail: '' }));
  assert.match(byClass(node, 'failure__facts')[0]?.textContent ?? '', /^Failed at /);
  assert.equal(byTag(node, 'pre').length, 0);
});

test('an outage that crossed midnight says which day it started', () => {
  const facts = failureFacts(failure({ since: new Date(2026, 9, 3, 22, 5).toISOString() }), null, NOW);
  assert.match(facts, /^Failing since yesterday /);
  assert.match(facts, /nothing read yet/);
});

test('Retry asks once, and not again while it is trying', () => {
  let asked = 0;
  const idle = notice(failure(), { onRetry: () => asked++ });
  const button = byClass(idle, 'failure__retry')[0]!;
  assert.equal(button.textContent, 'Retry now');
  button.click();
  assert.equal(asked, 1);

  const busy = notice(failure({ retrying: true, retryAt: null }), { onRetry: () => asked++ });
  const again = byClass(busy, 'failure__retry')[0]!;
  assert.equal(again.textContent, 'Retrying…');
  again.click();
  assert.equal(asked, 1);
  assert.match(byClass(busy, 'failure__facts')[0]?.textContent ?? '', /trying again now/);
});

test('the error is shown as text, never as Markdown: it quotes what upstream said', () => {
  const node = notice(failure({ message: 'GitHub answered 502: [click](https://evil.example) `x`' }));
  assert.equal(byTag(node, 'a').length, 0);
  assert.equal(byTag(node, 'code').length, 0);
});

test('the board shows its failures as folds and its warnings as plain strips', () => {
  const board = {
    enabled: true,
    reason: null,
    failures: [failure()],
    fetchedAt: at(9, 12),
    fetching: false,
    accounts: [],
    scope: [],
    warnings: ['alice: some results were withheld by single sign-on.'],
    pollMinutes: 5,
    rows: [],
    counts: {},
  } as unknown as BoardState;
  const state = { now: NOW.toISOString(), board } as unknown as DashboardState;
  const root = mount(h('div', null, renderBoard(state, uiWith(), handlersWith())));
  assert.equal(byTag(root, 'details').length, 1);
  assert.equal(byClass(root, 'banner').length, 2);
});

test('the agenda folds a failed calendar read into its note, with a Retry that asks the calendar', () => {
  let asked = 0;
  const state = {
    now: NOW.toISOString(),
    agenda: { events: [], conflictIds: [], freeWindows: [] },
    agendaSource: { live: false, fetchedAt: null, problem: null, warnings: [], failure: failure({ message: 'the helper wrote nothing' }) },
  } as unknown as DashboardState;
  const root = mountOne(renderAgenda(state, uiWith(), handlersWith({ refreshCalendar: () => asked++ })));
  const note = byClass(root, 'failure')[0];
  assert.ok(note?.classList.contains('agenda__note--stale'), 'falling back to the brief is the louder note');
  byClass(note!, 'failure__retry')[0]!.click();
  assert.equal(asked, 1);
});
