/**
 * Where each ticket in a project stands, and what to do next about it: the
 * join of Jira, the ticket board and the pull request board in
 * `client/stages.ts`. The fixtures are invented; see `projectfixtures.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assignLanes,
  blocksOf,
  loopPath,
  nameTicket,
  nextSteps,
  projectWork,
  pullSources,
  pullWording,
  stageCounts,
  stageLabel,
  ticketWork,
  type PullSources,
  type Stage,
} from '../client/stages.ts';
import { resolveBoard } from '../src/prs.ts';
import type { ProjectTicket } from '../src/types.ts';
import { NOW, PULLS, boardRows, epicRead, hoursAgo, linked, planned, pull, stateWith, ticket } from './projectfixtures.ts';

const SOURCES = pullSources(stateWith(undefined));

function sourcesFor(byKey: Record<string, ReturnType<typeof linked>[]>, pulls = [PULLS.ready]): PullSources {
  const rows = resolveBoard(pulls, [], NOW);
  return {
    linked: new Map(Object.entries(byKey)),
    rows: new Map(rows.map((row) => [row.url, row])),
    heads: new Map(rows.map((row) => [`${row.repo}\n${row.headRef}`, row])),
  };
}

const stageOf = (t: ProjectTicket, sources: PullSources = SOURCES): Stage => ticketWork(t, sources).stage;

/* ---------- one ticket's stage ---------- */

test('done in Jira is done, whatever its pull requests say', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)] });
  assert.equal(stageOf(ticket('PAY-1', { statusCategory: 'done' }), sources), 'done');
});

test('no pull requests: not started when the status says so, in progress when it says otherwise', () => {
  const none = sourcesFor({});
  assert.equal(stageOf(ticket('PAY-1', { statusCategory: 'new' }), none), 'not-started');
  assert.equal(stageOf(ticket('PAY-1', { statusCategory: 'indeterminate' }), none), 'progress');
  assert.equal(stageLabel(ticketWork(ticket('PAY-1'), none)).text, 'In progress, no pull request');
});

test('the least advanced open pull request decides, so ready means every open one is', () => {
  const both = sourcesFor({ 'PAY-1': [linked(PULLS.ready), linked(PULLS.draft)] }, [PULLS.ready, PULLS.draft]);
  assert.equal(stageOf(ticket('PAY-1'), both), 'draft');
  const one = sourcesFor({ 'PAY-1': [linked(PULLS.ready)] }, [PULLS.ready]);
  assert.equal(stageOf(ticket('PAY-1'), one), 'ready');
  assert.deepEqual(stageLabel(ticketWork(ticket('PAY-1'), one)), { text: 'Ready to merge', tone: 'good' });
});

test('an open pull request in review, with one merged beside it, is in review', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.merged, 'merged', hoursAgo(3)), linked(PULLS.waiting)] }, [PULLS.waiting]);
  assert.equal(stageOf(ticket('PAY-1'), sources), 'review');
});

test('merged once every pull request is merged or closed and one merged; closed alone is as good as none', () => {
  const merged = sourcesFor({ 'PAY-1': [linked(PULLS.merged, 'merged', hoursAgo(3)), linked(PULLS.draft, 'closed', hoursAgo(2))] }, []);
  assert.equal(stageOf(ticket('PAY-1'), merged), 'merged');
  const declined = sourcesFor({ 'PAY-1': [linked(PULLS.draft, 'closed', hoursAgo(2))] }, []);
  assert.equal(stageOf(ticket('PAY-1', { statusCategory: 'new' }), declined), 'not-started');
});

test('a pull request waiting on the user, or with changes asked for, says so in the critical tone', () => {
  const work = ticketWork(ticket('PAY-210'), SOURCES);
  assert.equal(work.stage, 'review');
  assert.equal(work.needsYou, true);
  assert.deepEqual(stageLabel(work), { text: 'Changes requested', tone: 'critical' });
});

test('the board knows a draft was marked ready, and the ticket board may not yet', () => {
  // The ticket board still says draft; the board row says it is ready.
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready, 'draft')] }, [PULLS.ready]);
  assert.equal(stageOf(ticket('PAY-1'), sources), 'ready');
});

test('without a board row an open pull request is in review, and a draft a draft', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready, 'open')], 'PAY-2': [linked(PULLS.draft, 'draft')] }, []);
  assert.equal(stageOf(ticket('PAY-1'), sources), 'review');
  assert.equal(stageOf(ticket('PAY-2'), sources), 'draft');
});

test("a teammate's ticket ignores the user's pull requests and goes by Jira's roll-up", () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)] });
  const theirs = (pulls: ProjectTicket['pulls'], category: ProjectTicket['statusCategory'] = 'indeterminate') =>
    ticketWork(ticket('PAY-1', { mine: false, pulls, statusCategory: category }), sources);
  assert.deepEqual(theirs(null).pulls, []);
  assert.equal(theirs(null).stage, 'progress');
  assert.equal(stageLabel(theirs(null)).text, 'In progress', 'no claim about pull requests this page cannot see');
  assert.equal(theirs({ count: 2, state: 'OPEN', stateCount: 1 }).stage, 'review');
  assert.equal(theirs({ count: 1, state: 'DRAFT', stateCount: 1 }).stage, 'draft');
  assert.equal(theirs({ count: 2, state: 'MERGED', stateCount: 2 }).stage, 'merged');
  assert.equal(theirs({ count: 2, state: 'MERGED', stateCount: 1 }).stage, 'review', 'one it did not name may still be open');
  assert.equal(theirs({ count: 1, state: 'DECLINED', stateCount: 1 }, 'new').stage, 'not-started');
  assert.equal(theirs({ count: 1, state: 'OPEN', stateCount: 1 }).basis, 'jira');
});

test("the user's own ticket falls back on Jira's roll-up only when GitHub named nothing", () => {
  const rollUp = { count: 1, state: 'OPEN', stateCount: 1 };
  assert.equal(ticketWork(ticket('PAY-1', { pulls: rollUp }), sourcesFor({})).stage, 'review');
  // GitHub says merged; a roll-up still saying open is Jira running behind.
  const merged = sourcesFor({ 'PAY-1': [linked(PULLS.merged, 'merged', hoursAgo(3))] }, []);
  assert.equal(ticketWork(ticket('PAY-1', { pulls: rollUp }), merged).stage, 'merged');
});

test('a pull request whose base is another open one’s branch is stacked on it', () => {
  const work = ticketWork(ticket('PAY-202'), SOURCES);
  assert.equal(work.pulls[0]?.stackedOn?.number, 412);
  assert.equal(ticketWork(ticket('PAY-201'), SOURCES).pulls[0]?.stackedOn, null);
});

test('the ticket board lists a ticket in both views; its pull requests are kept once', () => {
  const rows = [{ key: 'pay-1', pulls: [linked(PULLS.ready)] }, { key: 'PAY-1', pulls: [linked(PULLS.ready), linked(PULLS.draft)] }];
  const sources = pullSources({ tickets: { rows, inProgress: [] }, board: { enabled: false, rows: [] } } as never);
  assert.deepEqual(
    sources.linked.get('PAY-1')?.map((each) => each.number),
    [412, 420],
  );
  assert.equal(sources.rows.size, 0, 'a board that is off has no rows to join');
});

/* ---------- wording ---------- */

test("a pull request is described in the board's words", () => {
  const rows = boardRows();
  const work = (key: string) => ticketWork(ticket(key), SOURCES).pulls[0]!;
  assert.equal(pullWording(work('PAY-201'), NOW), 'Ready to merge');
  assert.equal(pullWording(work('PAY-203'), NOW), 'Draft, checks passed');
  assert.equal(pullWording(work('PAY-209'), NOW), 'Waiting on reviewers for 3 days');
  assert.equal(pullWording(work('PAY-210'), NOW), 'Waiting on you: changes requested by @sam');
  assert.equal(pullWording(work('PAY-207'), NOW), 'Merged 30 h ago');
  assert.ok(rows.length > 0);
});

test('the stage counts tally every ticket by how far it has got', () => {
  const counts = stageCounts(projectWork(epicRead(), SOURCES).works.values());
  assert.deepEqual(counts, { 'not-started': 2, progress: 0, draft: 1, review: 3, ready: 2, merged: 1, done: 1 });
  assert.equal(Object.values(stageCounts([])).reduce((a, b) => a + b, 0), 0);
});

test('a ticket outside the project is named with where it stands', () => {
  const project = projectWork(epicRead(), SOURCES);
  assert.equal(nameTicket('OPS-7', project), 'OPS-7 (another epic, In Review)');
  assert.equal(nameTicket('PAY-201', project), 'PAY-201');
  assert.equal(nameTicket('OPS-9', project), 'OPS-9', 'one known only by its key is named by it');
});

test('what a ticket blocks: the unfinished tickets waiting for it', () => {
  const project = projectWork(epicRead(), SOURCES);
  assert.deepEqual(blocksOf('PAY-201', project), ['PAY-202', 'PAY-203']);
  assert.deepEqual(blocksOf('PAY-204', project), []);
});

/* ---------- what to do next ---------- */

test('the fixture epic: merge first, then what only waits on merging, then close, ready, answer, nudge, start', () => {
  const steps = nextSteps(projectWork(epicRead(), SOURCES), NOW);
  assert.deepEqual(
    steps.map((step) => step.title),
    [
      'Merge acme/payments-api #412',
      'Then merge acme/payments-api #415 (after PAY-201)',
      'Move PAY-207 to Done',
      'Mark acme/payments-api #420 ready for review',
      'Answer the review on acme/payments-api #430',
      'Nudge reviewers on acme/web #88',
      'Start PAY-206',
    ],
  );
  assert.deepEqual(
    steps.map((step) => step.on),
    ['github', 'github', 'jira', 'github', 'github', 'github', 'jira'],
  );
  assert.deepEqual(
    steps.map((step) => step.pull?.number ?? null),
    [412, 415, null, 420, 430, 88, null],
    "a pull request's step carries its board row, for the board's own buttons; a ticket's carries none",
  );
  assert.equal(steps[0]!.reason, 'PAY-201 · unblocks PAY-202 and PAY-203');
  assert.equal(steps[0]!.url, PULLS.ready.url);
  assert.equal(steps[2]!.url, 'https://acme.atlassian.net/browse/PAY-207');
  assert.equal(steps[3]!.reason, 'PAY-203 · checks passed · PAY-201 is ready to merge');
  assert.equal(steps[4]!.reason, 'PAY-210 · changes requested by @sam', 'the review that asked is not counted again as activity');
  assert.equal(steps[5]!.reason, 'PAY-209 · waiting on reviewers for 3 days · asked @sam');
});

test("a teammate's tickets lead to nothing to do", () => {
  const steps = nextSteps(projectWork(epicRead(), SOURCES), NOW);
  assert.ok(!steps.some((step) => step.key === 'PAY-205'));
});

test('what frees the most goes first among merges', () => {
  const tickets = [
    ticket('PAY-1'),
    ticket('PAY-2'),
    ticket('PAY-3', { blockedBy: ['PAY-2'], statusCategory: 'new' }),
    ticket('PAY-4', { blockedBy: ['PAY-2'], statusCategory: 'new' }),
  ];
  const other = pull({ id: 'github:pr:acme/payments-api#500', number: 500, url: 'https://github.com/acme/payments-api/pull/500', headRef: 'pay-2' });
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)], 'PAY-2': [linked(other)] }, [PULLS.ready, other]);
  const steps = nextSteps(projectWork(planned(tickets), sources), NOW).filter((step) => step.kind === 'merge');
  assert.deepEqual(
    steps.map((step) => step.title),
    ['Merge acme/payments-api #500', 'Merge acme/payments-api #412'],
  );
});

test('a ready pull request behind a blocker still in review waits; behind a ready one, it follows it', () => {
  const tickets = [ticket('PAY-1'), ticket('PAY-2', { blockedBy: ['PAY-1'] })];
  const second = pull({ id: 'github:pr:acme/payments-api#501', number: 501, url: 'https://github.com/acme/payments-api/pull/501', headRef: 'pay-2' });
  const inReview = sourcesFor({ 'PAY-1': [linked(PULLS.waiting)], 'PAY-2': [linked(second)] }, [PULLS.waiting, second]);
  assert.deepEqual(
    nextSteps(projectWork(planned(tickets), inReview), NOW).filter((step) => step.kind.startsWith('merge')),
    [],
  );
  const ready = sourcesFor({ 'PAY-1': [linked(PULLS.ready)], 'PAY-2': [linked(second)] }, [PULLS.ready, second]);
  assert.deepEqual(
    nextSteps(projectWork(planned(tickets), ready), NOW).map((step) => step.title),
    ['Merge acme/payments-api #412', 'Then merge acme/payments-api #501 (after PAY-1)'],
  );
});

test('a stack inside one ticket merges its base first, and says after which', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready), linked(PULLS.stacked)] }, [PULLS.ready, PULLS.stacked]);
  assert.deepEqual(
    nextSteps(projectWork(planned([ticket('PAY-1')]), sources), NOW).map((step) => step.title),
    ['Merge acme/payments-api #412', 'Then merge acme/payments-api #415 (after #412)'],
  );
});

test('a draft is offered for review only once what it waits for is at least ready to merge', () => {
  const tickets = [ticket('PAY-1'), ticket('PAY-2', { blockedBy: ['PAY-1'] })];
  const blocked = sourcesFor({ 'PAY-1': [linked(PULLS.waiting)], 'PAY-2': [linked(PULLS.draft)] }, [PULLS.waiting, PULLS.draft]);
  assert.ok(!nextSteps(projectWork(planned(tickets), blocked), NOW).some((step) => step.kind === 'ready'));
  const failing = pull({ ...PULLS.draft, checks: 'failure' });
  const red = sourcesFor({ 'PAY-2': [linked(failing)] }, [failing]);
  assert.ok(!nextSteps(projectWork(planned([ticket('PAY-2')]), red), NOW).some((step) => step.kind === 'ready'), 'not with CI red');
});

test('a ticket waiting on one outside the project is not started, merged or marked ready', () => {
  const tickets = [ticket('PAY-1', { blockedBy: ['OPS-7'], statusCategory: 'new' }), ticket('PAY-2', { blockedBy: ['OPS-7'] })];
  const sources = sourcesFor({ 'PAY-2': [linked(PULLS.ready)] }, [PULLS.ready]);
  const steps = nextSteps(projectWork(planned(tickets), sources), NOW);
  assert.deepEqual(steps, []);
});

test('a stack between two tickets orders them though Jira links neither', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)], 'PAY-2': [linked(PULLS.stacked)] }, [PULLS.ready, PULLS.stacked]);
  const project = projectWork(planned([ticket('PAY-2'), ticket('PAY-1')]), sources);
  assert.deepEqual(project.order, ['PAY-1', 'PAY-2']);
  assert.deepEqual(project.waitsFor['PAY-2'], ['PAY-1']);
  assert.deepEqual(project.stackedOn.get('PAY-2'), ['PAY-1']);
  assert.deepEqual(project.overruled, []);
});

test('a stack wins over a Jira link that says the opposite, and that is kept to say so', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)], 'PAY-2': [linked(PULLS.stacked)] }, [PULLS.ready, PULLS.stacked]);
  const tickets = [ticket('PAY-1', { blockedBy: ['PAY-2'] }), ticket('PAY-2', { blocks: ['PAY-1'] })];
  const project = projectWork(planned(tickets), sources);
  assert.deepEqual(project.order, ['PAY-1', 'PAY-2']);
  assert.deepEqual(project.plan.loops, [], 'one order, not a loop');
  assert.deepEqual(project.overruled, [{ ticket: 'PAY-2', over: 'PAY-1' }]);
});

test('without stacks between tickets the server plan stands as it is', () => {
  const read = planned([ticket('PAY-1', { blockedBy: ['PAY-2'] }), ticket('PAY-2')]);
  assert.equal(projectWork(read, SOURCES).plan, read.plan);
});

test('a ticket whose links could not be read is never offered to merge', () => {
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)] }, [PULLS.ready]);
  const steps = nextSteps(projectWork(planned([ticket('PAY-1', { linksRead: false })]), sources), NOW);
  assert.ok(!steps.some((step) => step.kind.startsWith('merge')));
  assert.ok(nextSteps(projectWork(planned([ticket('PAY-1')]), sources), NOW).some((step) => step.kind === 'merge'), 'it is, once they are read');
});

test('tickets in a loop are never offered to merge', () => {
  const tickets = [ticket('PAY-1', { blockedBy: ['PAY-2'] }), ticket('PAY-2', { blockedBy: ['PAY-1'] })];
  const other = pull({ id: 'github:pr:acme/payments-api#502', number: 502, url: 'https://github.com/acme/payments-api/pull/502', headRef: 'pay-2' });
  const sources = sourcesFor({ 'PAY-1': [linked(PULLS.ready)], 'PAY-2': [linked(other)] }, [PULLS.ready, other]);
  assert.deepEqual(nextSteps(projectWork(planned(tickets), sources), NOW), []);
});

test('fixing CI and answering a comment are worded as what to do', () => {
  const red = pull({ ...PULLS.ready, checks: 'failure', failingChecks: ['unit'], reviewDecision: 'REVIEW_REQUIRED', reviews: [], lastActivityByOthers: null });
  const steps = nextSteps(projectWork(planned([ticket('PAY-1')]), sourcesFor({ 'PAY-1': [linked(red)] }, [red])), NOW);
  assert.equal(steps[0]?.title, 'Fix CI on acme/payments-api #412');
  assert.equal(steps[0]?.reason, 'PAY-1 · CI failing: unit');
});

test('nothing to do on a project that is all done', () => {
  const tickets = [ticket('PAY-1', { statusCategory: 'done' })];
  assert.deepEqual(nextSteps(projectWork(planned(tickets), sourcesFor({})), NOW), []);
});

/* ---------- loops ---------- */

test('a loop is named as a path round it', () => {
  const tickets = [
    ticket('PAY-1', { blockedBy: ['PAY-3'] }),
    ticket('PAY-2', { blockedBy: ['PAY-1'] }),
    ticket('PAY-3', { blockedBy: ['PAY-2'] }),
  ];
  const read = planned(tickets);
  assert.deepEqual(read.plan.loops, [['PAY-1', 'PAY-2', 'PAY-3']]);
  assert.deepEqual(loopPath(read.plan.loops[0]!, tickets), { path: ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-1'], others: [] });
});

test('a member of the loop the shortest way round misses is named after it', () => {
  const tickets = [
    ticket('PAY-1', { blockedBy: ['PAY-2'] }),
    ticket('PAY-2', { blockedBy: ['PAY-1', 'PAY-3'] }),
    ticket('PAY-3', { blockedBy: ['PAY-2'] }),
  ];
  const read = planned(tickets);
  assert.deepEqual(loopPath(read.plan.loops[0]!, tickets), { path: ['PAY-1', 'PAY-2', 'PAY-1'], others: ['PAY-3'] });
});

/* ---------- the rail ---------- */

const blockers = (links: Record<string, string[]>) => (key: string) => links[key] ?? [];

test('a chain stays in one lane', () => {
  const rail = assignLanes(['A', 'B', 'C'], blockers({ B: ['A'], C: ['B'] }));
  assert.deepEqual(rail?.lanes, { A: 0, B: 0, C: 0 });
  assert.deepEqual(
    rail?.edges.map((edge) => [edge.from, edge.to, edge.viaLane]),
    [
      ['A', 'B', 0],
      ['B', 'C', 0],
    ],
  );
  assert.equal(rail?.width, 1);
});

test('a branch takes the next free lane, and joins back where both lead', () => {
  // The fixture's shape: PAY-201 holds up 202 and 203, which both hold up 204.
  const rail = assignLanes(['201', '202', '203', '204', '206'], blockers({ 202: ['201'], 203: ['201'], 204: ['202', '203'] }));
  assert.deepEqual(rail?.lanes, { 201: 0, 202: 0, 203: 1, 204: 0, 206: 0 });
  const via = Object.fromEntries(rail!.edges.map((edge) => [`${edge.from}>${edge.to}`, edge.viaLane]));
  assert.deepEqual(via, { '201>202': 0, '201>203': 1, '202>204': 0, '203>204': 0 });
  assert.equal(rail?.width, 2);
});

test('a lane is held while a line runs down it, so no node sits on a line', () => {
  // A holds up C two rows down; B, unrelated, must not take A's lane meanwhile.
  const rail = assignLanes(['A', 'B', 'C'], blockers({ C: ['A'] }));
  assert.equal(rail?.lanes.A, 0);
  assert.equal(rail?.lanes.B, 1);
  assert.equal(rail?.lanes.C, 0);
});

test('a line running up the list, as in a loop, is not drawn', () => {
  const rail = assignLanes(['A', 'B'], blockers({ A: ['B'], B: ['A'] }));
  assert.deepEqual(
    rail?.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['A>B'],
  );
});

test('a blocker whose work has landed draws a dotted line', () => {
  const rail = assignLanes(['A', 'B'], blockers({ B: ['A'] }), (key) => key === 'A');
  assert.equal(rail?.edges[0]?.dotted, true);
});

test('too many lanes means no rail at all', () => {
  // One ticket holding up five others spread down the list needs a lane for each.
  const keys = ['A', 'x1', 'x2', 'x3', 'x4', 'B', 'C', 'D', 'E', 'F'];
  const links = { B: ['A'], C: ['A'], D: ['A'], E: ['A'], F: ['A'] };
  assert.equal(assignLanes(keys, blockers(links), undefined, 4), null);
  assert.ok(assignLanes(keys, blockers(links), undefined, 8));
});

test('blockers outside the list draw nothing', () => {
  const rail = assignLanes(['A'], blockers({ A: ['OPS-7'] }));
  assert.deepEqual(rail, { lanes: { A: 0 }, edges: [], width: 1 });
});
