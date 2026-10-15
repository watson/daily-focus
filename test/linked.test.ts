/**
 * GitHub's second opinion on a ticket's pull requests, without a GitHub.
 *
 * What is worth pinning is the asymmetry in `reconcile`: GitHub saying a pull
 * request is open is believed outright, and GitHub saying they are all closed
 * is believed only when nothing Jira knows could be one GitHub didn't see. A
 * false "finished" is the expensive mistake on this board, so most of these are
 * about the ways that one could slip through. The fixtures are invented.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { buildTicketSearchQueries, normalizeTicketPull, type TicketPullsFetch } from '../src/github.ts';
import { issueKeysIn, needsJiraCount, readLinkedPulls, reconcile, type LinkedDeps, type LinkedRead } from '../src/linked.ts';
import { judge } from '../src/tickets.ts';
import type { LinkedPull, Ticket } from '../src/types.ts';

const NOW = new Date('2026-09-22T09:00:00Z');

/* ---------- finding keys ---------- */

test('a key is found in a title, a branch, a link or a sentence', () => {
  assert.deepEqual([...issueKeysIn('PROJ-8842: drop the retry loop')], ['PROJ-8842']);
  assert.deepEqual([...issueKeysIn('mara/proj-8842-drop-retry')], ['PROJ-8842']);
  assert.deepEqual([...issueKeysIn('See https://acme.atlassian.net/browse/PLAT-311.')], ['PLAT-311']);
  assert.deepEqual([...issueKeysIn('Fixes PROJ-1 and (PLAT-2)')].sort(), ['PLAT-2', 'PROJ-1']);
});

test('a key is never found inside a longer one', () => {
  assert.deepEqual([...issueKeysIn('PROJ-123')], ['PROJ-123']);
  assert.deepEqual([...issueKeysIn('XPROJ-1 and 9PROJ-2')], ['XPROJ-1']);
});

/** Project keys can hold underscores, and so can a branch prefix; only keys on the board are ever looked up. */
test('an underscore offers every reading of the key', () => {
  assert.deepEqual([...issueKeysIn('mara_proj-8842')].sort(), ['MARA_PROJ-8842', 'PROJ-8842']);
  assert.deepEqual([...issueKeysIn('MY_PROJ-7')].sort(), ['MY_PROJ-7', 'PROJ-7']);
});

test('text with no key names nothing', () => {
  assert.deepEqual([...issueKeysIn('')], []);
  assert.deepEqual([...issueKeysIn('bump lodash to 4.17.21')], []);
});

/* ---------- the GitHub search ---------- */

test('open pull requests are searched however old, closed ones only since the date', () => {
  assert.deepEqual(buildTicketSearchQueries(['org:acme'], '2026-07-24'), [
    'is:pr author:@me is:open org:acme',
    'is:pr author:@me is:closed closed:>=2026-07-24 org:acme',
  ]);
});

test('a search node keeps its state, its closing time and every piece of its text', () => {
  const found = normalizeTicketPull({
    number: 3402,
    title: 'Drop the retry loop',
    url: 'https://github.com/acme/webapp/pull/3402',
    state: 'MERGED',
    isDraft: false,
    closedAt: '2026-09-21T15:00:05Z',
    mergedAt: '2026-09-21T15:00:00Z',
    headRefName: 'mara/proj-8842',
    body: 'Part of the ingest cleanup.',
    repository: { nameWithOwner: 'acme/webapp' },
    commits: { nodes: [{ commit: { message: 'PROJ-8842 drop it' } }, null] },
  });
  assert.deepEqual(found, {
    pull: {
      repo: 'acme/webapp',
      number: 3402,
      title: 'Drop the retry loop',
      url: 'https://github.com/acme/webapp/pull/3402',
      state: 'merged',
      closedAt: '2026-09-21T15:00:00Z',
    },
    text: ['Drop the retry loop', 'mara/proj-8842', 'Part of the ingest cleanup.', 'PROJ-8842 drop it'],
  });
});

test('a draft is told apart from open, and neither has closed', () => {
  const base = { number: 1, title: 't', url: 'https://github.com/a/b/pull/1', repository: { nameWithOwner: 'a/b' } };
  assert.equal(normalizeTicketPull({ ...base, state: 'OPEN', isDraft: true })?.pull.state, 'draft');
  assert.equal(normalizeTicketPull({ ...base, state: 'OPEN', closedAt: 'x' })?.pull.closedAt, null);
  assert.equal(normalizeTicketPull({ ...base, state: 'CLOSED', closedAt: '2026-09-20T00:00:00Z' })?.pull.state, 'closed');
});

/** A state GitHub adds later could be one that means open, so it is not guessed at. */
test('a node in an unknown state, or with an unsafe link, is not a pull request', () => {
  const base = { number: 1, title: 't', url: 'https://github.com/a/b/pull/1', repository: { nameWithOwner: 'a/b' } };
  assert.equal(normalizeTicketPull({ ...base, state: 'QUEUED' }), null);
  assert.equal(normalizeTicketPull({ ...base, state: 'OPEN', url: 'javascript:alert(1)' }), null);
  assert.equal(normalizeTicketPull({ state: 'OPEN' }), null);
});

/* ---------- reading as each account ---------- */

function pull(key: string, number: number, state: LinkedPull['state'] = 'merged'): TicketPullsFetch['pulls'][number] {
  return {
    pull: {
      repo: 'acme/webapp',
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/acme/webapp/pull/${number}`,
      state,
      closedAt: state === 'merged' || state === 'closed' ? '2026-09-21T15:00:00Z' : null,
    },
    text: [`Pull request ${number}`, `mara/${key.toLowerCase()}-thing`, '', `${key} do the thing`],
  };
}

function deps(answers: Record<string, () => Promise<TicketPullsFetch>>): LinkedDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async token(_gh, login) {
      return login ?? 'active';
    },
    async search(token, scope, closedSince) {
      asked.push(`${token} ${scope.join(',')} ${closedSince}`);
      const answer = answers[token];
      if (!answer) throw new Error(`no answer for ${token}`);
      return answer();
    },
  };
}

test("each configured account is asked, back two months, and the pull requests are indexed by key", async () => {
  const { github } = loadConfig({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'mara-l,mara-acme', DAILY_FOCUS_GITHUB_SCOPE: 'acme' });
  const fake = deps({
    'mara-l': async () => ({ pulls: [pull('PROJ-1', 1)], complete: true }),
    'mara-acme': async () => ({ pulls: [pull('PROJ-1', 2, 'open'), pull('PLAT-9', 3)], complete: true }),
  });
  const read = await readLinkedPulls(github, NOW, undefined, fake);
  assert.deepEqual(fake.asked.sort(), ['mara-acme org:acme 2026-07-24', 'mara-l org:acme 2026-07-24']);
  assert.equal(read.complete, true);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.byKey.get('PROJ-1')?.map((p) => p.number), [1, 2]);
  assert.deepEqual(read.byKey.get('PLAT-9')?.map((p) => p.number), [3]);
});

test('with no accounts configured, gh is asked as whichever account is active', async () => {
  const { github } = loadConfig({});
  const fake = deps({ active: async () => ({ pulls: [], complete: true }) });
  await readLinkedPulls(github, NOW, undefined, fake);
  assert.equal(fake.asked.length, 1);
});

test('one pull request reached twice is listed once', async () => {
  const { github } = loadConfig({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'a,b' });
  const same = async (): Promise<TicketPullsFetch> => ({ pulls: [pull('PROJ-1', 1)], complete: true });
  const read = await readLinkedPulls(github, NOW, undefined, deps({ a: same, b: same }));
  assert.equal(read.byKey.get('PROJ-1')?.length, 1);
});

/** One account's outage leaves the other's answer, and takes away only what it could not vouch for. */
test('an account that fails makes the reading incomplete, and says so', async () => {
  const { github } = loadConfig({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'a,b' });
  const read = await readLinkedPulls(
    github,
    NOW,
    undefined,
    deps({ a: async () => ({ pulls: [pull('PROJ-1', 1)], complete: true }), b: () => Promise.reject(new Error('GitHub answered 502')) }),
  );
  assert.equal(read.complete, false);
  assert.equal(read.byKey.get('PROJ-1')?.length, 1);
  assert.match(read.warnings.join('\n'), /as b .*GitHub answered 502.*only once Jira has it/);
});

test('a search that could not read everything makes the reading incomplete', async () => {
  const { github } = loadConfig({});
  const read = await readLinkedPulls(github, NOW, undefined, deps({ active: async () => ({ pulls: [], complete: false }) }));
  assert.equal(read.complete, false);
  assert.match(read.warnings[0] ?? '', /did not list every pull request/);
});

test('when no account can be asked, the reading fails rather than coming back empty', async () => {
  const { github } = loadConfig({ DAILY_FOCUS_GITHUB_ACCOUNTS: 'a' });
  await assert.rejects(readLinkedPulls(github, NOW, undefined, deps({})), /no answer for a/);
});

/* ---------- reconciling ---------- */

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'jira:PROJ-1',
    key: 'PROJ-1',
    summary: 'Drop the retry loop',
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: null,
    hasAnyPr: true,
    hasOpenPr: true,
    allPrsClosed: false,
    ...overrides,
  };
}

function linkedPull(number: number, state: LinkedPull['state'] = 'merged', closedAt = '2026-09-21T15:00:00Z'): LinkedPull {
  return {
    repo: 'acme/webapp',
    number,
    title: 't',
    url: `https://github.com/acme/webapp/pull/${number}`,
    state,
    closedAt: state === 'open' || state === 'draft' ? null : closedAt,
  };
}

function read(pulls: LinkedPull[], complete = true): LinkedRead {
  return { byKey: new Map([['PROJ-1', pulls]]), complete, warnings: [] };
}

/** The user's case: merged on GitHub, still open in Jira. */
test('a pull request Jira still has open, merged on GitHub, settles the ticket', () => {
  const reconciled = reconcile(ticket(), read([linkedPull(1)]), 1);
  assert.equal(reconciled.hasOpenPr, false);
  assert.equal(reconciled.allPrsClosed, true);
  assert.equal(reconciled.fromGitHub, true);
  assert.equal(judge(reconciled), 'settled');
});

test('a pull request merged before Jira heard of it settles the ticket too', () => {
  const reconciled = reconcile(ticket({ hasAnyPr: false, hasOpenPr: false }), read([linkedPull(1)]), null);
  assert.equal(judge(reconciled), 'settled');
  assert.equal(reconciled.fromGitHub, true);
});

/** Jira only gets this wrong by being behind, and being behind is the one thing GitHub never is. */
test('an open pull request on GitHub is open, whatever Jira says and however incomplete the reading', () => {
  for (const jira of [ticket({ hasAnyPr: false, hasOpenPr: false }), ticket({ hasOpenPr: false, allPrsClosed: true })]) {
    for (const state of ['open', 'draft'] as const) {
      const reconciled = reconcile(jira, read([linkedPull(1), linkedPull(2, state)], false), null);
      assert.equal(reconciled.hasOpenPr, true, state);
      assert.equal(reconciled.allPrsClosed, false, state);
      assert.equal(reconciled.fromGitHub, true, state);
    }
  }
});

test('when GitHub agrees with Jira it brings its evidence, and claims nothing', () => {
  const open = reconcile(ticket(), read([linkedPull(1, 'open')]), null);
  assert.equal(open.fromGitHub, undefined);
  assert.equal(open.pulls?.length, 1);

  const closed = reconcile(ticket({ hasOpenPr: false, allPrsClosed: true }), read([linkedPull(1)]), 1);
  assert.equal(closed.fromGitHub, undefined);
});

/** It could be another author's, or another organisation's, and open. */
test('when Jira knows more pull requests than GitHub found, Jira stands', () => {
  const reconciled = reconcile(ticket(), read([linkedPull(1)]), 2);
  assert.equal(reconciled.hasOpenPr, true);
  assert.equal(reconciled.fromGitHub, undefined);
  assert.deepEqual(reconciled.pulls, [linkedPull(1)]);
});

test('when Jira could not say how many it knows, Jira stands', () => {
  assert.equal(reconcile(ticket(), read([linkedPull(1)]), null).hasOpenPr, true);
  assert.equal(reconcile(ticket({ hasOpenPr: false }), read([linkedPull(1)]), null).allPrsClosed, false);
});

/** A pull request the reading missed could be the one still open. */
test('an incomplete reading cannot close anything', () => {
  const reconciled = reconcile(ticket(), read([linkedPull(1)], false), 1);
  assert.equal(reconciled.hasOpenPr, true);
  assert.equal(reconciled.fromGitHub, undefined);
});

test('a ticket GitHub has nothing for is returned untouched', () => {
  const jira = ticket();
  assert.equal(reconcile(jira, read([]), 1), jira);
  assert.equal(reconcile(jira, null, 1), jira);
  assert.equal(reconcile(ticket({ key: 'PLAT-2' }), read([linkedPull(1)]), 0).pulls, undefined);
});

test('the evidence leads with what is open, then what closed most recently', () => {
  const pulls = [linkedPull(1, 'merged', '2026-09-01T00:00:00Z'), linkedPull(2, 'merged', '2026-09-20T00:00:00Z'), linkedPull(3, 'draft')];
  assert.deepEqual(reconcile(ticket(), read(pulls), null).pulls?.map((p) => p.number), [3, 2, 1]);
});

test('a lower-case key on the board still finds its pull requests', () => {
  const reconciled = reconcile(ticket({ key: 'proj-1' }), read([linkedPull(1)]), 1);
  assert.equal(reconciled.allPrsClosed, true);
});

/* ---------- which panels are worth reading ---------- */

test("Jira's count is needed only where GitHub, in full, has only closed pull requests and Jira disagrees", () => {
  assert.equal(needsJiraCount(ticket(), read([linkedPull(1)])), true);
  assert.equal(needsJiraCount(ticket(), read([linkedPull(1), linkedPull(2, 'draft')])), false, 'GitHub has one open');
  assert.equal(needsJiraCount(ticket(), read([linkedPull(1)], false)), false, 'could not close anything anyway');
  assert.equal(needsJiraCount(ticket(), read([])), false, 'nothing to weigh');
  assert.equal(needsJiraCount(ticket(), null), false);
  assert.equal(needsJiraCount(ticket({ hasAnyPr: false, hasOpenPr: false }), read([linkedPull(1)])), false, 'Jira counts none');
  assert.equal(needsJiraCount(ticket({ hasOpenPr: false, allPrsClosed: true }), read([linkedPull(1)])), false, 'Jira agrees');
});
