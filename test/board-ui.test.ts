/**
 * What one board row actually renders.
 *
 * What is worth asking of a board row is whether the reason appears, the
 * check's link is clickable, and the *Nudged* button is offered — rules that live
 * only in `client/board.ts` and would otherwise never be held to anything.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported ahead of the client, for the document it installs.
import { h } from 'preact';

import { buttonLabels, byClass, byTag, handlersWith, mount, mountOne, uiWith } from './dom.ts';
import { renderBoard, renderPullRow } from '../client/board.ts';
import { formatTime } from '../client/format.ts';
import { resolveBoard } from '../src/prs.ts';
import type { Action, BoardRow, BoardState, DashboardState, PullRequest } from '../src/types.ts';

/* ---------- the fixtures ---------- */

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const GATES = ['policy/merge-gate'];

const STATE = { now: NOW.toISOString() } as unknown as DashboardState;
const UI = uiWith();
const HANDLERS = handlersWith();

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'github:pr:acme/webapp#3421',
    account: 'alice',
    repo: 'acme/webapp',
    number: 3421,
    title: 'Fix rounding in gift card balances',
    url: 'https://github.com/acme/webapp/pull/3421',
    isDraft: false,
    createdAt: hoursAgo(72),
    readyAt: hoursAgo(72),
    updatedAt: hoursAgo(24),
    headRef: 'alice/fix-leak',
    baseRef: 'main',
    reviewDecision: 'APPROVED',
    checks: 'success',
    failingChecks: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    pendingChecks: [],
    cancelledChecks: [],
    autoMerge: false,
    requestedReviewers: [],
    reviews: [{ login: 'bob', state: 'APPROVED', at: hoursAgo(6) }],
    lastActivityByYou: hoursAgo(48),
    lastActivityByOthers: { at: hoursAgo(6), login: 'bob', kind: 'review' },
    ...overrides,
  };
}

/** One rendered row, judged the way the server would judge it. */
function render(overrides: Partial<PullRequest>, actions: Action[] = []): { row: BoardRow; node: HTMLElement } {
  const [row] = resolveBoard([pr(overrides)], actions, NOW, GATES);
  assert.ok(row);
  return { row, node: mountOne(renderPullRow(row, STATE, UI, HANDLERS)) };
}

test("a gate row names the check, links GitHub's details page, and offers no nudge", () => {
  const { row, node } = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [
      { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/4821', checkRunId: 4821 },
    ],
  });
  assert.equal(row.court, 'gate');
  assert.equal(node.dataset.court, 'gate');

  const reason = byClass(node, 'item__reason')[0];
  assert.ok(reason, 'a gate row explains itself');
  assert.equal(reason.textContent, 'merge policy pending: policy/merge-gate');
  // Not red: nothing has gone wrong, it just isn't finished.
  assert.ok(reason.className.includes('item__reason--waiting'));

  const link = byTag(reason, 'a')[0] as HTMLAnchorElement | undefined;
  assert.equal(link?.href, 'https://github.com/acme/webapp/runs/4821');
  assert.equal(link?.textContent, 'policy/merge-gate');

  // How long the merge has been refused, as a span rather than a point in time:
  // the row's last push was 48 hours ago, which is where the wait starts.
  assert.ok(
    byClass(node, 'pill').some((pill) => pill.textContent === 'waiting 2 days'),
    byClass(node, 'pill')
      .map((pill) => pill.textContent)
      .join(' | '),
  );

  // The board has no idea whose action the gate needs, so it suggests nobody.
  assert.deepEqual(buttonLabels(node), ['Park']);
});

test('a cancelled check is shown on the row in every court, and moves none of them', () => {
  // The merge-queue shape: the gate decides the court, and the cancellation it
  // caused is stated underneath rather than counted as red.
  const gated = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [{ name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null }],
    cancelledChecks: [{ name: 'policy/merge', kind: 'check-run', detailsUrl: 'https://github.com/acme/webapp/runs/77' }],
  });
  assert.equal(gated.row.court, 'gate');
  const lines = byClass(gated.node, 'item__reason').map((line) => line.textContent);
  assert.deepEqual(lines, ['merge policy pending: policy/merge-gate', 'cancelled, no verdict: policy/merge']);

  // And on a row where nothing is outstanding at all: still ready, and the
  // cancellation is still said out loud, which is the point of saying it.
  const ready = render({ cancelledChecks: [{ name: 'policy/merge', kind: 'check-run', detailsUrl: null }] });
  assert.equal(ready.row.court, 'ready');
  assert.deepEqual(
    byClass(ready.node, 'item__reason').map((line) => line.textContent),
    ['cancelled, no verdict: policy/merge'],
  );
  assert.equal(
    byClass(ready.node, 'pill').some((pill) => pill.textContent === 'CI failing'),
    false,
    'a cancellation is not a red pill either',
  );
});

test('a check row lists what is still running, without inventing a link', () => {
  const { row, node } = render({
    mergeStateStatus: 'UNSTABLE',
    checks: 'pending',
    pendingChecks: [
      { name: 'integration-tests', kind: 'check-run', detailsUrl: null },
      { name: 'ci/deploy', kind: 'status-context', detailsUrl: null },
    ],
  });
  assert.equal(row.court, 'checks');

  const reason = byClass(node, 'item__reason')[0];
  assert.match(reason?.textContent ?? '', /still running: integration-tests, ci\/deploy/);
  assert.equal(byTag(reason!, 'a').length, 0, 'GitHub gave nowhere to look, so nothing is linked');
  assert.deepEqual(buttonLabels(node), ['Park']);
});

test('a blocked merge with nothing pending is not presented as a check wait', () => {
  const { row, node } = render({ mergeStateStatus: 'BLOCKED' });
  assert.equal(row.court, 'blocked');
  assert.equal(byClass(node, 'item__reason').length, 0, 'the section heading already says why the row is here');
  assert.ok(byClass(node, 'pill').some((pill) => pill.textContent === 'blocked 2 days'));
});

test('an undecided merge state is reported as undecided, not as fine', () => {
  const { node } = render({ mergeStateStatus: 'UNKNOWN' });
  assert.match(byClass(node, 'item__reason')[0]?.textContent ?? '', /still determining mergeability/);
});

test('a branch behind its base is your move, in red', () => {
  const { row, node } = render({ mergeStateStatus: 'BEHIND' });
  assert.equal(row.court, 'you');
  const reason = byClass(node, 'item__reason')[0];
  assert.match(reason?.textContent ?? '', /behind its base/);
  assert.ok(!reason?.className.includes('item__reason--waiting'), 'something is wrong here, and it looks it');
});

test('only a row waiting on reviewers is offered the nudge', () => {
  const { row, node } = render({
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [],
    lastActivityByOthers: null,
    requestedReviewers: ['carol'],
  });
  assert.equal(row.court, 'reviewers');
  assert.deepEqual(buttonLabels(node), ['Nudged', 'Park']);
  assert.equal(byClass(node, 'item__reason').length, 0, 'waiting on a review needs no explaining');
});

/** Waiting on reviewers for three days, with nobody having said a word. */
const UNREVIEWED: Partial<PullRequest> = {
  reviewDecision: 'REVIEW_REQUIRED',
  reviews: [],
  lastActivityByOthers: null,
  requestedReviewers: ['carol'],
};

test('a nudged row says when it was nudged and when it comes back, and offers no second nudge', () => {
  const { row, node } = render(UNREVIEWED, [{ id: 'github:pr:acme/webapp#3421', action: 'nudge', at: hoursAgo(3) }]);
  assert.equal(row.court, 'reviewers');
  assert.equal(node.dataset.nudged, 'true');
  const pills = byClass(node, 'pill').map((pill) => pill.textContent ?? '');
  // A day after the nudge: tomorrow, at the clock time it was pressed.
  assert.ok(pills.includes(`nudged 3 h ago, back tomorrow ${formatTime(hoursAgo(3))}`), pills.join(' | '));
  assert.ok(!pills.includes('time to ask'));
  assert.deepEqual(buttonLabels(node), ['Park']);
});

test('nudged rows sit in a section of their own, below the reviewers they wait on', () => {
  const pulls = [
    pr({ ...UNREVIEWED, id: 'github:pr:acme/webapp#1', number: 1 }),
    pr({ ...UNREVIEWED, id: 'github:pr:acme/webapp#2', number: 2 }),
    pr({ id: 'github:pr:acme/webapp#3', number: 3, isDraft: true }),
  ];
  const rows = resolveBoard(pulls, [{ id: 'github:pr:acme/webapp#2', action: 'nudge', at: hoursAgo(1) }], NOW, GATES);
  const board = { enabled: true, reason: null, failures: [], fetchedAt: NOW.toISOString(), warnings: [], scope: [], rows } as unknown as BoardState;
  const root = mount(h('div', null, renderBoard({ ...STATE, board }, uiWith(), handlersWith())));

  const sections = byClass(root, 'section').map((section) => ({
    title: byClass(section, 'section__title')[0]?.textContent,
    ids: byTag(section, 'li').map((li) => li.dataset.id),
  }));
  assert.deepEqual(sections, [
    { title: 'Waiting on reviewers', ids: ['github:pr:acme/webapp#1'] },
    { title: 'Nudged', ids: ['github:pr:acme/webapp#2'] },
    { title: 'Drafts', ids: ['github:pr:acme/webapp#3'] },
  ]);
});

test('a ready row is plain: no reason, no nudge', () => {
  const { row, node } = render({});
  assert.equal(row.court, 'ready');
  assert.equal(byClass(node, 'item__reason').length, 0);
  assert.deepEqual(buttonLabels(node), ['Park']);
});

test('a reason kind this client has never heard of is skipped, not printed half', () => {
  const [row] = resolveBoard(
    [
      pr({
        mergeStateStatus: 'UNSTABLE',
        checks: 'pending',
        pendingChecks: [{ name: 'integration-tests', kind: 'check-run', detailsUrl: null }],
      }),
    ],
    [],
    NOW,
    GATES,
  );
  assert.ok(row);
  // A server one version ahead: the row renders, minus the part nothing can word.
  const ahead = { ...row, reasons: [{ kind: 'merge-queue-position' }, ...row.reasons] } as unknown as BoardRow;
  const reason = byClass(mountOne(renderPullRow(ahead, STATE, UI, HANDLERS)), 'item__reason')[0];
  assert.equal(reason?.textContent, 'still running: integration-tests', 'no stray separator where the unknown reason was');
});

test('more than three pending checks are summarised rather than listed', () => {
  const { node } = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, kind: 'check-run' as const, detailsUrl: null })),
  });
  assert.match(byClass(node, 'item__reason')[0]?.textContent ?? '', /still running: a, b, c and 2 more/);
});

/* ---------- answered ahead ---------- */

/** A red row waiting on you, and the state around it with the assistant's turns on it. */
function ahead(turns: Partial<import('../src/types.ts').AssistantTurn>[], auto: Partial<import('../src/types.ts').AssistantAuto> = {}) {
  const [row] = resolveBoard([pr({ checks: 'failure', failingChecks: ['unit'], headSha: 'abc', reviewDecision: 'REVIEW_REQUIRED', reviews: [], lastActivityByOthers: null })], [], NOW, GATES);
  assert.ok(row && row.court === 'you');
  const key = 'explain-ci@abc:unit';
  const state = {
    now: NOW.toISOString(),
    assistant: {
      enabled: true,
      agent: 'claude',
      quickActions: [],
      items: {
        [row.id]: {
          running: turns.some((turn) => turn.status === 'running'),
          sessionId: null,
          turns: turns.map((turn, i) => ({
            id: `t${i}`,
            itemId: row.id,
            agent: 'claude',
            sessionId: null,
            request: 'x',
            action: 'explain-ci',
            auto: key,
            startedAt: hoursAgo(1),
            endedAt: hoursAgo(0.9),
            status: 'done',
            reply: '',
            steps: [],
            error: null,
            ...turn,
          })),
        },
      },
      auto: { enabled: true, limit: 10, usedToday: 1, rows: { [row.id]: [key] }, ...auto },
    },
  } as unknown as DashboardState;
  return { row, key, node: mountOne(renderPullRow(row, state, UI, HANDLERS)) };
}

test("an answer given ahead puts its first line on the row while it is still about the row's state", () => {
  const { node } = ahead([{ reply: '**Flaky, not yours:** the Safari job timed out.\n\nThe log shows…' }]);
  const line = byClass(node, 'item__ahead')[0]!;
  assert.equal(line.textContent, '✦Flaky, not yours: the Safari job timed out.');
  assert.match(line.getAttribute('title')!, /Answered ahead .* Open the panel/);
  assert.equal(line.querySelector('strong')!.textContent, 'Flaky, not yours:', 'its Markdown is kept');
  const named = byClass(ahead([{ reply: '## Raise `MAX_BATCHES` to 400\n\nWhy…' }]).node, 'item__ahead')[0]!;
  assert.equal(named.textContent, '✦Raise MAX_BATCHES to 400');
  assert.equal(named.querySelector('code')!.textContent, 'MAX_BATCHES');

  const { node: stale } = ahead([{ reply: 'About an older commit.', auto: 'explain-ci@old:unit' }]);
  assert.equal(byClass(stale, 'item__ahead').length, 0, 'an answer about a state the row has left says nothing about it now');

  const { node: mine } = ahead([{ reply: 'You asked this yourself.', auto: null }]);
  assert.equal(byClass(mine, 'item__ahead').length, 0, "the user's own questions stay in the panel");
});

test('while it reads, when it failed, and when the day is spent, the row says so quietly', () => {
  assert.equal(byClass(ahead([{ status: 'running', endedAt: null }]).node, 'item__ahead')[0]!.textContent, '✦Reading the failing checks…');
  assert.match(byClass(ahead([{ status: 'failed', error: 'gh: not found' }]).node, 'item__ahead')[0]!.textContent!, /Could not answer ahead/);
  assert.match(byClass(ahead([], { usedToday: 10 }).node, 'item__ahead')[0]!.textContent!, /today's 10 are used/);
  assert.equal(byClass(ahead([]).node, 'item__ahead').length, 0, 'waiting its turn is not worth a line');
  assert.equal(byClass(ahead([], { enabled: false, usedToday: 10 }).node, 'item__ahead').length, 0);
});

test('a board connecting would fix offers it, and shows the code to enter once gh has one', () => {
  const reason = { message: 'Not signed in to GitHub', detail: '', since: NOW.toISOString(), attempts: 1, retryAt: null, retrying: false };
  const board = { enabled: true, reason, failures: [], fetchedAt: null, warnings: [], scope: [], rows: [], connect: true } as unknown as BoardState;
  const idle = { cli: { found: true, fetched: true }, status: 'idle', code: null, url: null, login: null, error: null, command: null } as const;
  const jira = { ...idle, cli: { found: false, fetched: false } };
  const started: string[] = [];
  const handlers = handlersWith({ connect: (service) => started.push(`connect ${service}`), copy: (text) => started.push(`copy ${text}`) });
  const with_ = (github: object, board_ = board) =>
    mount(h('div', null, renderBoard({ ...STATE, board: board_, connections: { github, jira } } as unknown as DashboardState, uiWith(), handlers)));

  const offered = with_(idle);
  const button = byTag(offered, 'button').find((b) => b.textContent === 'Connect GitHub');
  assert.ok(button, buttonLabels(offered).join(' | '));
  button.click();
  assert.deepEqual(started, ['connect github']);

  // An outage is not something connecting fixes.
  assert.ok(!buttonLabels(with_(idle, { ...board, connect: false } as BoardState)).includes('Connect GitHub'));

  // Getting gh first says so, and is shown even before the board has asked again.
  assert.match(with_({ ...idle, status: 'fetching' }, { ...board, connect: false } as BoardState).textContent ?? '', /Getting the GitHub CLI from GitHub/);

  const waiting = { ...idle, status: 'waiting', code: 'AB12-CD34', url: 'https://github.com/login/device' };
  const opened: string[] = [];
  const open = window.open;
  window.open = ((url: string) => (opened.push(url), null)) as typeof window.open;
  try {
    const shown = with_(waiting);
    assert.equal(byClass(shown, 'connect__code')[0]?.textContent, 'AB12-CD34');
    byTag(shown, 'button').find((b) => b.textContent === 'Copy the code and open GitHub')!.click();
    assert.deepEqual(started, ['connect github', 'copy AB12-CD34']);
    assert.deepEqual(opened, ['https://github.com/login/device']);
  } finally {
    window.open = open;
  }

  // A failure says why, and how to finish in a terminal when the page can't.
  const failed = with_({ ...idle, status: 'failed', error: 'expired_token', command: 'gh auth login --web' });
  assert.match(failed.textContent ?? '', /That didn’t work: expired_token/);
  assert.equal(failed.querySelector('.connect__command code')?.textContent, 'gh auth login --web');
  assert.ok(buttonLabels(failed).includes('Try again'));
});
