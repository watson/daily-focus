/**
 * The poller, driven without an `acli` or a Jira. `board.test.ts` for tickets,
 * and the questions worth asking are the same ones: does a failed read keep the
 * rows it had, does it say so, and does the file survive a round trip.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  AcliAuthError,
  AcliMissingError,
  JiraSearchError,
  JiraTransitionError,
  type JiraIdentity,
  type TicketFetch,
} from '../src/jira.ts';
import { TicketBoard, normalizeStoredTicket, readTicketsFile, type TicketBoardDeps } from '../src/ticketboard.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Ticket } from '../src/types.ts';

const NOW = new Date('2026-09-22T09:00:00Z');

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-jira-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, ...env });
}

function ticket(key: string, overrides: Partial<Ticket> = {}): Ticket {
  const base: Ticket = {
    id: `jira:${key}`,
    key,
    summary: `Something about ${key}`,
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: `https://acme.atlassian.net/browse/${key}`,
    hasAnyPr: true,
    hasOpenPr: false,
    allPrsClosed: true,
    ...overrides,
  };
  // Coherent with the two counts unless a test says otherwise, which is what a
  // confirmed development panel read produces.
  return { ...base, allPrsClosed: overrides.allPrsClosed ?? (base.hasAnyPr && !base.hasOpenPr) };
}

const IDENTITY: JiraIdentity = { site: 'acme.atlassian.net', account: 'alice@example.com' };

function fakeDeps(opts: {
  identity?: () => Promise<JiraIdentity>;
  fetches?: (() => Promise<TicketFetch>)[];
  transition?: (key: string, status: string) => Promise<void>;
}): TicketBoardDeps & { calls: string[] } {
  const calls: string[] = [];
  let round = 0;
  return {
    calls,
    async identity() {
      calls.push('identity');
      return opts.identity ? opts.identity() : IDENTITY;
    },
    async fetch(_acli, { site }) {
      calls.push(`fetch:${site}`);
      const fetcher = opts.fetches?.[Math.min(round++, (opts.fetches?.length ?? 1) - 1)];
      if (!fetcher) throw new Error('nothing to fetch');
      return fetcher();
    },
    async transition(_acli, key, status) {
      calls.push(`transition:${key}:${status}`);
      if (opts.transition) await opts.transition(key, status);
    },
  };
}

const ok =
  (tickets: Ticket[], warnings: string[] = [], statuses: Record<string, string[]> = {}) =>
  async (): Promise<TicketFetch> => ({ tickets, statuses, warnings });

const fails = (message: string) => async (): Promise<TicketFetch> => {
  throw new JiraSearchError(message);
};

/* ---------- reading ---------- */

test('a successful read becomes rows, a file, and a timestamp', async () => {
  const cfg = await config();
  const deps = fakeDeps({ fetches: [ok([ticket('PROJ-1'), ticket('PROJ-2', { hasAnyPr: false })])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();

  const state = board.view([], NOW);
  assert.equal(state.enabled, true);
  assert.equal(state.reason, null);
  assert.equal(state.account, 'alice@example.com');
  assert.equal(state.checked, 2);
  assert.deepEqual(
    state.rows.map((row) => [row.key, row.court]),
    [
      ['PROJ-1', 'settled'],
      ['PROJ-2', 'idle'],
    ],
  );
  assert.ok(state.fetchedAt);

  const onDisk = JSON.parse(await readFile(cfg.ticketsFile, 'utf8')) as { tickets: unknown[]; account: string };
  assert.equal(onDisk.tickets.length, 2);
  assert.equal(onDisk.account, 'alice@example.com');
  board.stop();
});

/** The hold list is the user's private configuration, so it is applied on read. */
test('nothing computed reaches the file', async () => {
  const cfg = await config({ DAILY_FOCUS_JIRA_HOLD_STATUSES: 'Blocked' });
  const deps = fakeDeps({ fetches: [ok([ticket('PROJ-1', { workflowStatus: 'Blocked', hasAnyPr: false })])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();

  assert.deepEqual(board.view([], NOW).rows, []);
  const onDisk = await readFile(cfg.ticketsFile, 'utf8');
  assert.ok(onDisk.includes('PROJ-1'), 'the ticket is still a fact worth keeping');
  // The verdict, and the configuration it was reached through, stay out of a
  // cache of Jira facts — so changing the hold list needs no re-read.
  for (const word of ['court', 'settled', 'started', 'idle', 'holdStatuses']) {
    assert.ok(!onDisk.includes(word), `${word} reached tickets.json`);
  }
  board.stop();
});

test('a failed read keeps the rows it had, and says it is showing them', async () => {
  const cfg = await config();
  const deps = fakeDeps({ fetches: [ok([ticket('PROJ-1')]), fails('Jira said no')] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();
  await board.refresh();

  const state = board.view([], NOW);
  assert.equal(state.rows.length, 1);
  assert.match(state.reason ?? '', /Jira said no/);
  assert.match(state.reason ?? '', /last good read/);
  board.stop();
});

test('a first read that fails leaves no rows and the plain reason', async () => {
  const cfg = await config();
  const board = new TicketBoard(cfg, () => {}, fakeDeps({ fetches: [fails('Jira said no')] }));
  await board.start();

  const state = board.view([], NOW);
  assert.deepEqual(state.rows, []);
  assert.match(state.reason ?? '', /Jira said no/);
  assert.ok(!(state.reason ?? '').includes('last good read'));
  board.stop();
});

test('no acli and no session both say what to do, and offer the off switch', async () => {
  for (const [error, expected] of [
    [new AcliMissingError('acli'), /install the Atlassian CLI/],
    [new AcliAuthError('acli has no Jira session (expired) — run `acli jira auth login`'), /acli jira auth login/],
  ] as const) {
    const cfg = await config();
    const board = new TicketBoard(
      cfg,
      () => {},
      fakeDeps({
        identity: () => Promise.reject(error),
      }),
    );
    await board.start();

    const state = board.view([], NOW);
    assert.match(state.reason ?? '', expected);
    assert.match(state.reason ?? '', /DAILY_FOCUS_JIRA=off/);
    // The account line would contradict the banner sitting next to it.
    assert.equal(state.account, null);
    board.stop();
  }
});

test('the configured site wins over the one acli authenticated to', async () => {
  const cfg = await config({ DAILY_FOCUS_JIRA_SITE: 'https://other.atlassian.net/jira/software' });
  const deps = fakeDeps({ fetches: [ok([])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();
  assert.ok(deps.calls.includes('fetch:other.atlassian.net'), deps.calls.join(','));
  board.stop();
});

test('the fetch warnings reach the state', async () => {
  const cfg = await config();
  const board = new TicketBoard(cfg, () => {}, fakeDeps({ fetches: [ok([], ['acli did not say which site'])] }));
  await board.start();
  assert.deepEqual(board.view([], NOW).warnings, ['acli did not say which site']);
  board.stop();
});

test('switched off, nothing is read and the state says so rather than complaining', async () => {
  const cfg = await config({ DAILY_FOCUS_JIRA: 'off' });
  const deps = fakeDeps({ fetches: [ok([ticket('PROJ-1')])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();

  const state = board.view([], NOW);
  assert.equal(state.enabled, false);
  assert.equal(state.reason, null);
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(deps.calls, [], 'a disabled board must not reach for acli at all');
  board.stop();
});

test('the action log is joined on read, without a re-read', async () => {
  const cfg = await config();
  const board = new TicketBoard(cfg, () => {}, fakeDeps({ fetches: [ok([ticket('PROJ-1')])] }));
  await board.start();

  const parked = board.view([{ id: 'jira:PROJ-1', action: 'snooze', at: '2026-09-22T08:00:00Z', until: '2026-09-30' }], NOW);
  assert.equal(parked.rows[0]?.status, 'snoozed');
  assert.equal(parked.counts.parked, 1);
  assert.equal(board.view([], NOW).rows[0]?.status, 'open');
  board.stop();
});

/* ---------- the file ---------- */

test('a stored ticket survives the round trip', async () => {
  const cfg = await config();
  const board = new TicketBoard(cfg, () => {}, fakeDeps({ fetches: [ok([ticket('PROJ-1', { hasOpenPr: true })])] }));
  await board.start();
  board.stop();

  const file = await readTicketsFile(cfg.ticketsFile);
  assert.deepEqual(file?.tickets, [ticket('PROJ-1', { hasOpenPr: true })]);
});

test('an unreadable or foreign file reads as no file at all', async () => {
  const cfg = await config();
  assert.equal(await readTicketsFile(join(cfg.dataDir, 'nope.json')), null);

  await writeFile(cfg.ticketsFile, 'not json');
  assert.equal(await readTicketsFile(cfg.ticketsFile), null);

  await writeFile(cfg.ticketsFile, JSON.stringify({ version: 2, fetchedAt: 'x', tickets: [] }));
  assert.equal(await readTicketsFile(cfg.ticketsFile), null);
});

test('one bad entry costs that entry rather than the file', async () => {
  const cfg = await config();
  await writeFile(
    cfg.ticketsFile,
    JSON.stringify({
      version: 1,
      fetchedAt: NOW.toISOString(),
      account: 'alice@example.com',
      projects: [],
      warnings: [],
      tickets: [ticket('PROJ-1'), { summary: 'no key' }, 'nonsense', null],
    }),
  );
  const file = await readTicketsFile(cfg.ticketsFile);
  assert.equal(file?.tickets.length, 1);
  assert.equal(file?.tickets[0]?.key, 'PROJ-1');
});

/**
 * Read back through the same reducer a fresh read uses, so the file and acli
 * can't come to different conclusions about what a category means.
 */
test('a stored category the enum does not have reads as uncategorised', () => {
  const stored = { ...ticket('PROJ-1'), statusCategory: 'brand-new' };
  assert.equal(normalizeStoredTicket(stored)?.statusCategory, 'undefined');
});

test('a stored ticket with no key is dropped', () => {
  assert.equal(normalizeStoredTicket({ ...ticket('PROJ-1'), key: '' }), null);
  assert.equal(normalizeStoredTicket({}), null);
});

test('a stored url with no site leaves the row unlinked rather than half-linked', () => {
  assert.equal(normalizeStoredTicket({ ...ticket('PROJ-1'), url: null })?.url, null);
  assert.equal(normalizeStoredTicket({ ...ticket('PROJ-1'), url: 'notaurl' })?.url, null);
});

/* ---------- the one write ---------- */

/**
 * A transition is the only thing this board does that changes anything outside
 * the process, so what matters is that the row on screen comes from Jira having
 * accepted it — never from the click. These pin that the read happens after, and
 * that a refusal reaches the caller rather than being swallowed.
 */
test('a transition moves the ticket and then reads the board back', async () => {
  const cfg = await config();
  const deps = fakeDeps({ fetches: [ok([ticket('PROJ-1')])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();
  deps.calls.length = 0;

  await board.transition('PROJ-1', 'Done');
  assert.deepEqual(deps.calls, ['transition:PROJ-1:Done', 'identity', 'fetch:acme.atlassian.net']);
  board.stop();
});

test('a refused transition rejects, and does not read the board back', async () => {
  const cfg = await config();
  const deps = fakeDeps({
    fetches: [ok([ticket('PROJ-1')])],
    transition: () => Promise.reject(new JiraTransitionError('Transition is not valid for this work item')),
  });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();
  deps.calls.length = 0;

  await assert.rejects(board.transition('PROJ-1', 'Done'), /not valid/);
  // The board is unchanged and no read was spent on a move that never happened.
  assert.deepEqual(deps.calls, ['transition:PROJ-1:Done']);
  assert.equal(board.view([], NOW).rows.length, 1);
  board.stop();
});

/** Nothing may reach acli from a board the user switched off. */
test('a switched-off board refuses to transition anything', async () => {
  const cfg = await config({ DAILY_FOCUS_JIRA: 'off' });
  const deps = fakeDeps({ fetches: [ok([])] });
  const board = new TicketBoard(cfg, () => {}, deps);
  await board.start();

  await assert.rejects(board.transition('PROJ-1', 'Done'), /DAILY_FOCUS_JIRA=off/);
  assert.deepEqual(deps.calls, []);
  board.stop();
});

test('the status vocabulary is carried through, and survives the file', async () => {
  const cfg = await config();
  const vocab = { PROJ: ['Committed', 'Done', 'In Review'], OTHER: ['To Do'] };
  const board = new TicketBoard(cfg, () => {}, fakeDeps({ fetches: [ok([ticket('PROJ-1')], [], vocab)] }));
  await board.start();
  assert.deepEqual(board.view([], NOW).statuses, vocab);
  board.stop();

  assert.deepEqual((await readTicketsFile(cfg.ticketsFile))?.statuses, vocab);
});

/** An older cache has no vocabulary; the menu is then simply not offered. */
test('a file written before the vocabulary existed reads as none', async () => {
  const cfg = await config();
  await writeFile(
    cfg.ticketsFile,
    JSON.stringify({ version: 1, fetchedAt: NOW.toISOString(), tickets: [ticket('PROJ-1')] }),
  );
  assert.deepEqual((await readTicketsFile(cfg.ticketsFile))?.statuses, {});
});
