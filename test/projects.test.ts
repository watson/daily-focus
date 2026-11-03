/**
 * The order a project's tickets can land in, worked out from blocks links
 * alone. The fixtures are invented, as everywhere else.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planProject } from '../src/projects.ts';
import type { OutsideTicket, ProjectTicket, TicketStatusCategory } from '../src/types.ts';

function ticket(key: string, links: { blockedBy?: string[]; blocks?: string[] } = {}, category: TicketStatusCategory = 'indeterminate'): ProjectTicket {
  return {
    key,
    summary: `Work for ${key}`,
    issueType: 'Task',
    workflowStatus: category === 'done' ? 'Done' : category === 'new' ? 'To Do' : 'In Progress',
    statusCategory: category,
    url: null,
    parent: 'PROJ-1',
    assignee: null,
    mine: true,
    blockedBy: links.blockedBy ?? [],
    blocks: links.blocks ?? [],
    pulls: null,
    linksRead: true,
  };
}

function outside(key: string, category: TicketStatusCategory): OutsideTicket {
  return { key, summary: `Elsewhere ${key}`, workflowStatus: category, statusCategory: category, url: null };
}

test('with no links the order is Jira\'s, and nothing waits', () => {
  const plan = planProject([ticket('PROJ-3'), ticket('PROJ-2'), ticket('PROJ-4')]);
  assert.deepEqual(plan.order, ['PROJ-3', 'PROJ-2', 'PROJ-4']);
  assert.deepEqual(plan.loops, []);
  assert.deepEqual(plan.waitsFor, { 'PROJ-3': [], 'PROJ-2': [], 'PROJ-4': [] });
});

test('a blocker goes ahead of what it blocks, wherever Jira lists it', () => {
  const plan = planProject([ticket('PROJ-2', { blockedBy: ['PROJ-3'] }), ticket('PROJ-3'), ticket('PROJ-4', { blockedBy: ['PROJ-2'] })]);
  assert.deepEqual(plan.order, ['PROJ-3', 'PROJ-2', 'PROJ-4']);
  assert.deepEqual(plan.waitsFor['PROJ-4'], ['PROJ-2']);
});

test('a link read from either end counts, so a ticket whose own links failed still orders', () => {
  // PROJ-3's links could not be read, but PROJ-2 names it as blocking.
  const unread = { ...ticket('PROJ-3'), linksRead: false };
  const plan = planProject([unread, ticket('PROJ-2', { blocks: ['PROJ-3'] })]);
  assert.deepEqual(plan.order, ['PROJ-2', 'PROJ-3']);
  assert.deepEqual(plan.waitsFor['PROJ-3'], ['PROJ-2']);
});

test('a finished blocker no longer holds anything up, and finished work comes first', () => {
  const plan = planProject([
    ticket('PROJ-2'),
    ticket('PROJ-3', { blockedBy: ['PROJ-4'] }),
    ticket('PROJ-4', {}, 'done'),
  ]);
  assert.deepEqual(plan.waitsFor['PROJ-3'], []);
  assert.deepEqual(plan.order, ['PROJ-4', 'PROJ-2', 'PROJ-3']);
});

test('a blocker outside the project is waited for until it is done', () => {
  const tickets = [ticket('PROJ-2', { blockedBy: ['OPS-7', 'OPS-8', 'OPS-9'] })];
  const plan = planProject(tickets, [outside('OPS-7', 'indeterminate'), outside('OPS-8', 'done')]);
  // OPS-9 is known only by its key, so it is assumed unfinished rather than finished.
  assert.deepEqual(plan.waitsFor['PROJ-2'], ['OPS-7', 'OPS-9']);
  assert.deepEqual(plan.order, ['PROJ-2']);
});

test('a ticket waiting on several is placed after all of them, branches and all', () => {
  const plan = planProject([
    ticket('PROJ-2'),
    ticket('PROJ-3', { blockedBy: ['PROJ-2'] }),
    ticket('PROJ-4', { blockedBy: ['PROJ-2'] }),
    ticket('PROJ-5'),
    ticket('PROJ-6', { blockedBy: ['PROJ-4', 'PROJ-5'] }),
  ]);
  const at = (key: string) => plan.order.indexOf(key);
  assert.ok(at('PROJ-2') < at('PROJ-3') && at('PROJ-2') < at('PROJ-4'));
  assert.ok(at('PROJ-4') < at('PROJ-6') && at('PROJ-5') < at('PROJ-6'));
  assert.equal(plan.order.length, 5);
});

test('a loop is reported, kept together in Jira\'s order, and the rest still orders around it', () => {
  const plan = planProject([
    ticket('PROJ-2'),
    ticket('PROJ-3', { blockedBy: ['PROJ-5'] }),
    ticket('PROJ-4', { blockedBy: ['PROJ-3'] }),
    ticket('PROJ-5', { blockedBy: ['PROJ-4', 'PROJ-2'] }),
    ticket('PROJ-6', { blockedBy: ['PROJ-4'] }),
  ]);
  assert.deepEqual(plan.loops, [['PROJ-3', 'PROJ-4', 'PROJ-5']]);
  // PROJ-2 feeds the loop, and PROJ-6 waits on it.
  assert.deepEqual(plan.order, ['PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6']);
});

test('a ticket that blocks itself is a loop of one', () => {
  const plan = planProject([ticket('PROJ-2', { blockedBy: ['PROJ-2'] }), ticket('PROJ-3')]);
  assert.deepEqual(plan.loops, [['PROJ-2']]);
  // Waiting on itself is not waiting on anything it could act on.
  assert.deepEqual(plan.waitsFor['PROJ-2'], []);
  assert.deepEqual(plan.order, ['PROJ-2', 'PROJ-3']);
});

test('two separate loops are both found, in the order Jira lists them', () => {
  const plan = planProject([
    ticket('PROJ-5', { blockedBy: ['PROJ-6'] }),
    ticket('PROJ-6', { blockedBy: ['PROJ-5'] }),
    ticket('PROJ-2', { blockedBy: ['PROJ-3'] }),
    ticket('PROJ-3', { blockedBy: ['PROJ-2'] }),
  ]);
  assert.deepEqual(plan.loops, [['PROJ-5', 'PROJ-6'], ['PROJ-2', 'PROJ-3']]);
  assert.equal(plan.order.length, 4);
});

test('the same links give the same order, read after read', () => {
  const tickets = [ticket('PROJ-4', { blockedBy: ['PROJ-2'] }), ticket('PROJ-2'), ticket('PROJ-3', { blockedBy: ['PROJ-2'] })];
  const first = planProject(tickets).order;
  for (let i = 0; i < 5; i++) assert.deepEqual(planProject(tickets).order, first);
  assert.deepEqual(first, ['PROJ-2', 'PROJ-4', 'PROJ-3']);
});

test('a long chain neither overflows nor slows to a crawl', () => {
  const tickets = Array.from({ length: 5000 }, (_, i) => ticket(`PROJ-${i + 1}`, i === 0 ? {} : { blockedBy: [`PROJ-${i}`] }));
  const plan = planProject([...tickets].reverse());
  assert.equal(plan.order[0], 'PROJ-1');
  assert.equal(plan.order.at(-1), 'PROJ-5000');
  assert.deepEqual(plan.loops, []);
});
