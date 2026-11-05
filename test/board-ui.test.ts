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
import { connectionView } from '../client/connect.ts';
import { formatTime } from '../client/format.ts';
import { DEFAULT_MERGE_GATE_REVIEWS, mergeGateReviewPattern } from '../src/config.ts';
import { resolveBoard } from '../src/prs.ts';
import type { Action, BoardRow, BoardState, DashboardState, PullRequest } from '../src/types.ts';

/* ---------- the fixtures ---------- */

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const GATES = ['policy/merge-gate'];
const REVIEWS = mergeGateReviewPattern(DEFAULT_MERGE_GATE_REVIEWS);

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
  const [row] = resolveBoard([pr(overrides)], actions, NOW, GATES, REVIEWS);
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
  // The gate is the only thing unfinished, and the reason already names it.
  assert.ok(!byClass(node, 'pill').some((pill) => pill.textContent === 'checks running'));

  // The board has no idea whose action the gate needs, so it suggests nobody.
  assert.deepEqual(buttonLabels(node), ['Snooze']);
});

test('a gate wanting only approvals waits on reviewers, saying so in its own words', () => {
  const { row, node } = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [
      {
        name: 'policy/merge-gate',
        kind: 'check-run',
        detailsUrl: 'https://github.com/acme/webapp/runs/4821',
        description: '1 pending: 1 approval missing',
      },
    ],
  });
  assert.equal(row.court, 'reviewers');

  const reason = byClass(node, 'item__reason')[0];
  assert.equal(reason?.textContent, 'merge policy pending: policy/merge-gate — 1 pending: 1 approval missing');
  assert.equal((byTag(reason!, 'a')[0] as HTMLAnchorElement | undefined)?.href, 'https://github.com/acme/webapp/runs/4821');

  // The gate is the only thing unfinished, and the reason already says so.
  const pills = byClass(node, 'pill').map((pill) => pill.textContent);
  assert.ok(!pills.includes('checks running'), pills.join(' | '));
  assert.ok(pills.includes('approved'), "GitHub's own decision still shows");
  assert.ok(pills.includes('time to ask'), pills.join(' | '));

  // Unlike a gate row, there is somebody to ask.
  assert.ok(buttonLabels(node).includes('Nudged'), buttonLabels(node).join(' | '));

  // Anything else still running keeps its pill.
  const running = render({
    mergeStateStatus: 'BLOCKED',
    checks: 'pending',
    pendingChecks: [
      { name: 'integration-tests', kind: 'check-run', detailsUrl: null },
      { name: 'policy/merge-gate', kind: 'check-run', detailsUrl: null, description: '1 pending: 1 approval missing' },
    ],
  });
  assert.equal(running.row.court, 'reviewers');
  assert.ok(byClass(running.node, 'pill').some((pill) => pill.textContent === 'checks running'));
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
  assert.deepEqual(buttonLabels(node), ['Snooze']);
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

test('a comment after the approval says that is all that keeps the row from Ready to merge', () => {
  const reasonOf = (overrides: Partial<PullRequest>) => {
    const { row, node } = render(overrides);
    assert.equal(row.court, 'you');
    return byClass(node, 'item__reason')[0]?.textContent;
  };
  const after = { at: hoursAgo(2), login: 'bob', kind: 'review' as const };
  assert.equal(
    reasonOf({ lastActivityByOthers: after }),
    '@bob commented 2 h ago, after approving — reply to move it to Ready to merge',
  );
  assert.equal(
    reasonOf({ lastActivityByOthers: { ...after, login: 'carol', kind: 'comment' } }),
    '@carol commented 2 h ago, after @bob approved — reply to move it to Ready to merge',
  );
  // A reply would leave it behind its base, so the row doesn't promise one is enough.
  assert.equal(
    reasonOf({ lastActivityByOthers: after, mergeStateStatus: 'BEHIND' }),
    'the branch is behind its base — update it to merge · @bob commented 2 h ago, after approving',
  );
  // Nobody approved: the comment is just the last word, as before.
  assert.equal(reasonOf({ reviewDecision: null, reviews: [], lastActivityByOthers: after }), '@bob reviewed 2 h ago');
});

test('only a row waiting on reviewers is offered the nudge', () => {
  const { row, node } = render({
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [],
    lastActivityByOthers: null,
    requestedReviewers: ['carol'],
  });
  assert.equal(row.court, 'reviewers');
  assert.deepEqual(buttonLabels(node), ['Nudged', 'Snooze']);
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
  assert.deepEqual(buttonLabels(node), ['Snooze']);
});

/** Two waiting on reviewers, one of them nudged, a draft, and one snoozed. */
function boardOfFour(ui = uiWith(), handlers = handlersWith()): HTMLElement {
  const pulls = [
    pr({ ...UNREVIEWED, id: 'github:pr:acme/webapp#1', number: 1 }),
    pr({ ...UNREVIEWED, id: 'github:pr:acme/webapp#2', number: 2 }),
    pr({ id: 'github:pr:acme/webapp#3', number: 3, isDraft: true }),
    pr({ id: 'github:pr:acme/webapp#4', number: 4 }),
  ];
  const actions: Action[] = [
    { id: 'github:pr:acme/webapp#2', action: 'nudge', at: hoursAgo(1) },
    { id: 'github:pr:acme/webapp#4', action: 'snooze', at: hoursAgo(1), until: '2026-09-20' },
  ];
  const rows = resolveBoard(pulls, actions, NOW, GATES);
  const board = { enabled: true, reason: null, failures: [], fetchedAt: NOW.toISOString(), warnings: [], scope: [], rows } as unknown as BoardState;
  return mount(h('div', null, renderBoard({ ...STATE, board }, ui, handlers)));
}

const drawersOf = (root: HTMLElement) => byClass(root, 'drawer') as HTMLDetailsElement[];

test('nudged rows sit in a drawer of their own, below the reviewers they wait on', () => {
  const drawers = drawersOf(boardOfFour()).map((drawer) => ({
    title: byClass(drawer, 'drawer__title')[0]?.textContent,
    ids: byTag(drawer, 'li').map((li) => li.dataset.id),
  }));
  assert.deepEqual(drawers, [
    { title: 'Waiting on reviewers', ids: ['github:pr:acme/webapp#1'] },
    { title: 'Nudged', ids: ['github:pr:acme/webapp#2'] },
    { title: 'Drafts', ids: ['github:pr:acme/webapp#3'] },
    { title: 'Snoozed', ids: ['github:pr:acme/webapp#4'] },
  ]);
});

/**
 * Every court folds. One starts open, since it holds what to look at; Nudged and
 * Snoozed start closed, since there is nothing to do about either until they
 * come back. The page keeps a fold by hand, so the next state push leaves it be.
 */
test('the courts start open and Nudged and Snoozed closed, and a fold by hand is kept', () => {
  const toggled: [string, boolean][] = [];
  const handlers = handlersWith({ toggleDrawer: (key, open) => void toggled.push([key, open]) });
  const drawers = drawersOf(boardOfFour(uiWith(), handlers));
  assert.deepEqual(
    drawers.map((drawer) => drawer.open),
    [true, false, true, false],
  );

  // Rendered open, a court says so with a toggle of its own, which changes nothing.
  drawers[0]!.dispatchEvent(new Event('toggle'));
  assert.deepEqual(toggled, []);

  // happy-dom fires a toggle of its own when `open` is set, and a browser
  // doesn't until later, so the page is asked to keep what both add up to.
  drawers[0]!.open = false;
  drawers[0]!.dispatchEvent(new Event('toggle'));
  drawers[1]!.open = true;
  drawers[1]!.dispatchEvent(new Event('toggle'));
  const folds = new Map<string, boolean>(toggled);
  assert.deepEqual(
    [...folds],
    [
      ['board:reviewers', false],
      ['board:nudged', true],
    ],
  );

  const kept = drawersOf(boardOfFour(uiWith({ drawers: folds })));
  assert.deepEqual(
    kept.map((drawer) => drawer.open),
    [false, true, true, false],
  );
});

test('a ready row is plain: no reason, no nudge', () => {
  const { row, node } = render({});
  assert.equal(row.court, 'ready');
  assert.equal(byClass(node, 'item__reason').length, 0);
  assert.deepEqual(buttonLabels(node), ['Snooze']);
});

/* ---------- changing the pull request on GitHub ---------- */

/** What marking ready or merging needs, as a fresh poll reads it. */
const WRITABLE: Partial<PullRequest> = {
  nodeId: 'PR_kwDOAcme3421',
  headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
  defaultBranch: 'main',
  mergeMethod: 'SQUASH',
};

/** One row as the server judges it, rendered with the view state and handlers given. */
function renderWith(overrides: Partial<PullRequest>, ui = UI, handlers = HANDLERS, actions: Action[] = []): { row: BoardRow; node: HTMLElement } {
  const [row] = resolveBoard([pr({ ...WRITABLE, ...overrides })], actions, NOW, GATES, REVIEWS);
  assert.ok(row);
  return { row, node: mountOne(renderPullRow(row, STATE, ui, handlers)) };
}

const button = (node: HTMLElement, label: string): HTMLButtonElement | undefined =>
  byTag(node, 'button').find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;

test('a draft offers Ready for review, and a ready row Merge, or Add to merge queue where its branch has one', () => {
  const clicked: string[] = [];
  const handlers = handlersWith({ markReady: (id) => clicked.push(`ready ${id}`), mergePull: (id, route) => clicked.push(`${route} ${id}`) });

  const draft = renderWith({ isDraft: true }, UI, handlers).node;
  assert.deepEqual(buttonLabels(draft), ['Ready for review', 'Snooze']);
  button(draft, 'Ready for review')!.click();

  // Named for the method GitHub's own button would use.
  const ready = renderWith({}, UI, handlers).node;
  assert.deepEqual(buttonLabels(ready), ['Squash and merge', 'Snooze']);
  assert.match(button(ready, 'Squash and merge')!.title, /into main/);
  button(ready, 'Squash and merge')!.click();
  assert.deepEqual(buttonLabels(renderWith({ mergeMethod: 'MERGE' }).node), ['Merge', 'Snooze']);
  assert.deepEqual(buttonLabels(renderWith({ mergeMethod: 'REBASE' }).node), ['Rebase and merge', 'Snooze']);

  const queued = renderWith({ mergeQueue: true }, UI, handlers).node;
  assert.deepEqual(buttonLabels(queued), ['Add to merge queue', 'Snooze']);
  button(queued, 'Add to merge queue')!.click();

  // The page sends the row's id and which button: which pull request is the
  // server's to look up, and it refuses a way the row doesn't offer.
  assert.deepEqual(clicked, ['ready github:pr:acme/webapp#3421', 'merge github:pr:acme/webapp#3421', 'queue github:pr:acme/webapp#3421']);
});

test('Merge is not offered where the server would refuse it', () => {
  const cases: [string, Partial<PullRequest>][] = [
    ['stacked on another branch', { baseRef: 'alice/refactor-ledger' }],
    ['a member of a GitHub stack', { stacked: true }],
    ['already in the merge queue', { mergeQueue: true, inMergeQueue: true }],
    ['red', { checks: 'failure', failingChecks: ['unit-tests'], mergeStateStatus: 'UNSTABLE' }],
    ['waiting on reviewers', { reviewDecision: 'REVIEW_REQUIRED', reviews: [], mergeStateStatus: 'BLOCKED' }],
    ['read from an older cache', { nodeId: undefined, defaultBranch: undefined, mergeMethod: undefined }],
  ];
  for (const [what, overrides] of cases) {
    const labels = buttonLabels(renderWith(overrides).node);
    assert.ok(!labels.some((label) => /merge/i.test(label)), `${what}: ${labels.join(' | ')}`);
  }
  // A draft from an older cache can't be named to GitHub yet either.
  assert.ok(!buttonLabels(renderWith({ isDraft: true, nodeId: undefined }).node).includes('Ready for review'));
  // A snoozed row offers Unsnooze and nothing that reaches GitHub.
  const snoozed = renderWith({}, UI, HANDLERS, [
    { id: 'github:pr:acme/webapp#3421', action: 'snooze', at: hoursAgo(1), until: '2026-09-20' },
  ]).node;
  assert.deepEqual(buttonLabels(snoozed), ['Unsnooze']);
});

test('a pull request on another branch says where it lands, and under Ready to merge why it has no merge button', () => {
  // #3420 owns the branch #3421 is based on: the board names it, with its title on hover.
  const below = pr({ id: 'github:pr:acme/webapp#3420', number: 3420, title: 'Refactor the ledger', headRef: 'alice/refactor-ledger', ...WRITABLE });
  const rows = resolveBoard([pr({ ...WRITABLE, baseRef: 'alice/refactor-ledger' }), below], [], NOW, GATES, REVIEWS);
  const top = rows.find((each) => each.number === 3421)!;
  assert.equal(top.court, 'ready');
  const state = { now: NOW.toISOString(), board: { rows } } as unknown as DashboardState;
  const node = mountOne(renderPullRow(top, state, UI, HANDLERS));
  const pill = byClass(node, 'pill').find((each) => each.textContent === 'stacked on #3420');
  assert.ok(pill, byClass(node, 'pill').map((each) => each.textContent).join(' | '));
  assert.equal(pill.title, 'Its base is the branch of #3420, Refactor the ledger: merging it lands there, not in main');
  assert.deepEqual(
    byClass(node, 'item__reason').map((each) => each.textContent),
    ["no merge button: it would land in #3420's branch, not main"],
  );
  assert.ok(!buttonLabels(node).some((label) => /merge/i.test(label)));

  // A branch no pull request on the board owns is named as it is.
  const alone = renderWith({ baseRef: 'release/2026.09' }).node;
  assert.ok(byClass(alone, 'pill').some((each) => each.textContent === 'into release/2026.09'));
  assert.deepEqual(byClass(alone, 'item__reason').map((each) => each.textContent), ['no merge button: it would land in release/2026.09, not main']);

  // A member of a GitHub stack merges there.
  assert.deepEqual(
    byClass(renderWith({ stacked: true }).node, 'item__reason').map((each) => each.textContent),
    ['no merge button: it is part of a stack on GitHub, which merges it there'],
  );

  // On the default branch, or a cache that hasn't read which that is, neither; nor where a merge is offered.
  for (const overrides of [{}, { defaultBranch: undefined, baseRef: 'alice/refactor-ledger' }]) {
    const plain = renderWith(overrides).node;
    assert.ok(!byClass(plain, 'pill').some((each) => /stacked|into /.test(each.textContent ?? '')), JSON.stringify(overrides));
    assert.deepEqual(byClass(plain, 'item__reason').map((each) => each.textContent), [], JSON.stringify(overrides));
  }
});

test('while a click is on its way the row says so and its GitHub buttons are disabled', () => {
  const pending = uiWith({ pending: new Set(['github:pr:acme/webapp#3421']) });
  for (const [overrides, label] of [[{}, 'Squash and merge'], [{ isDraft: true }, 'Ready for review']] as const) {
    const { node } = renderWith(overrides, pending);
    assert.equal(node.dataset.pending, 'true');
    const write = button(node, label);
    assert.ok(write, buttonLabels(node).join(' | '));
    assert.equal(write.disabled, true, label);
    assert.equal(write.getAttribute('aria-busy'), 'true');
  }
  const idle = button(renderWith({}).node, 'Squash and merge');
  assert.equal(idle?.disabled, false);
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
  const idle = { cli: { found: true, fetched: true }, status: 'idle', choices: null, inWindow: false, code: null, url: null, login: null, error: null, command: null } as const;
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

test("acli's question of which site is asked as buttons, one per site it offers", () => {
  const chose: string[] = [];
  const handlers = handlersWith({ chooseConnect: (service, choice) => chose.push(`${service} ${choice}`) });
  const choosing = {
    cli: { found: true, fetched: true },
    status: 'choosing',
    choices: ['acme.atlassian.net', 'acme-sandbox.atlassian.net'],
    inWindow: false,
    code: null,
    url: null,
    login: null,
    error: null,
    command: null,
  } as const;
  const node = mountOne(connectionView('jira', { ...choosing, choices: [...choosing.choices] }, handlers));
  assert.match(node.textContent ?? '', /Which site did you choose on Atlassian’s page\?/);
  assert.deepEqual(buttonLabels(node), ['acme.atlassian.net', 'acme-sandbox.atlassian.net', 'Cancel']);
  byTag(node, 'button').find((b) => b.textContent === 'acme-sandbox.atlassian.net')!.click();
  assert.deepEqual(chose, ['jira acme-sandbox.atlassian.net']);
});
