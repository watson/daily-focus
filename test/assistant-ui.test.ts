/**
 * The assistant's half of the item panel.
 *
 * Two rules worth holding here: the section exists only when there is an
 * assistant to ask, and it offers a row only the quick actions that fit its
 * source — a "draft a reply" on a pull request is the kind of wrong that looks
 * like a feature until it is pressed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mountOne, uiWith } from './dom.ts';
import { Flyout } from '../client/flyout.ts';
import { renderItem } from '../client/items.ts';
import { renderMarkdownBlocks } from '../client/markdown.ts';
import { QUICK_ACTIONS } from '../src/assistant.ts';
import { resolveTickets } from '../src/tickets.ts';
import type { AssistantTurn, DashboardState, ResolvedItem } from '../src/types.ts';

const NOW = '2026-09-24T12:00:00Z';
const HANDLERS = handlersWith();

function item(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id: 'email:thread:1',
    source: 'email',
    kind: 'task',
    title: 'Reply to the vendor',
    status: 'open',
    notes: [],
    ageDays: 0,
    ...overrides,
  };
}

function state(assistant: unknown): DashboardState {
  return { now: NOW, agenda: { conflictIds: [] }, assistant } as unknown as DashboardState;
}

/** The panel, open on `row`. */
function panel(row: ResolvedItem, assistant: unknown): HTMLElement {
  return mountOne(h(Flyout, { row, run: null, state: state(assistant), ui: uiWith({ detailFor: row.id }), handlers: HANDLERS }));
}

/** Markdown blocks, as the elements they become. */
const blocksOf = (text: string): HTMLElement[] => [...mountOne(h('div', null, renderMarkdownBlocks(text))).children] as HTMLElement[];

const ENABLED = { enabled: true, agent: 'claude', quickActions: QUICK_ACTIONS, items: {} };

test('the assistant is in the panel only when it is on, and never on the row', () => {
  const off = { enabled: false, quickActions: [], items: {} };
  assert.equal(byClass(panel(item(), off), 'assistant').length, 0, 'no assistant section to speak to');
  assert.equal(byClass(panel(item(), off), 'assistant__input').length, 0);

  const on = mountOne(renderItem(item(), state(ENABLED), uiWith(), HANDLERS));
  assert.ok(!buttonLabels(on).includes('Ask'), 'the card itself opens the panel; no button for it');
  assert.equal(byClass(on, 'assistant').length, 0, 'the conversation lives in the panel, not on the row');
  assert.equal(byClass(panel(item(), ENABLED), 'assistant__input').length, 1);
});

test('with the assistant off, what it said while on is still in the panel, read-only', () => {
  const said: AssistantTurn = {
    id: 't0',
    itemId: 'email:thread:1',
    agent: 'claude',
    sessionId: 's',
    request: QUICK_ACTIONS.find((a) => a.id === 'draft-reply')!.request,
    action: 'draft-reply',
    auto: null,
    startedAt: NOW,
    endedAt: NOW,
    status: 'done',
    reply: 'Drafted, not sent.',
    steps: [],
    error: null,
  };
  const off = { enabled: false, agent: null, quickActions: QUICK_ACTIONS, items: { 'email:thread:1': { running: false, sessionId: null, turns: [said] } } };
  const node = panel(item(), off);

  const turns = byClass(node, 'assistant__turn');
  assert.equal(turns.length, 1, 'the conversation belongs to the row, not to the setting');
  assert.equal(byClass(turns[0]!, 'assistant__request')[0]!.textContent, 'Draft a reply');
  assert.match(turns[0]!.textContent!, /Drafted, not sent/);
  assert.equal(byClass(node, 'assistant__input').length, 0, 'but there is nothing to ask');
  assert.equal(byClass(node, 'assistant__quick').length, 0);
  assert.match(node.textContent!, /switched off \(DAILY_FOCUS_ASSISTANT\)/);
});

test("the panel offers the quick actions for the row's source and the ones for every row", () => {
  const node = panel(item(), ENABLED);
  const chips = byClass(node, 'assistant__quick')[0]!;
  const offered = buttonLabels(chips);
  const expected = QUICK_ACTIONS.filter((a) => a.sources === null || a.sources.includes('email')).map((a) => a.label);
  assert.deepEqual(offered, expected);
  assert.ok(!offered.includes('Assess the review'));
  assert.ok(offered.includes('Break it into next steps'));
});

test('a reply renders as blocks, and a running turn says so with a Stop button', () => {
  const done: AssistantTurn = {
    id: 't1',
    itemId: 'email:thread:1',
    agent: 'claude',
    sessionId: 's',
    request: QUICK_ACTIONS.find((a) => a.id === 'draft-reply')!.request,
    action: 'draft-reply',
    auto: null,
    startedAt: NOW,
    endedAt: NOW,
    status: 'done',
    reply: 'Drafted.\n\n- one\n- two',
    steps: [],
    error: null,
  };
  const running: AssistantTurn = { ...done, id: 't2', action: null, request: 'and shorter?', status: 'running', reply: '', endedAt: null };
  const assistant = { ...ENABLED, items: { 'email:thread:1': { running: true, sessionId: 's', turns: [done, running] } } };
  const node = panel(item(), assistant);

  const turns = byClass(node, 'assistant__turn');
  assert.equal(turns.length, 2);
  assert.equal(byClass(turns[0]!, 'assistant__request')[0]!.textContent, 'Draft a reply');
  assert.equal(byTag(turns[0]!, 'li').length, 2);
  assert.match(byClass(turns[1]!, 'assistant__status')[0]!.textContent!, /Working/);
  assert.ok(buttonLabels(node).includes('Stop'));
  assert.ok(!buttonLabels(node).includes('Send'));
  assert.equal(byClass(node, 'assistant__quick').length, 0, 'no quick actions while working');
  const row = mountOne(renderItem(item(), state(assistant), uiWith(), HANDLERS));
  assert.ok(byClass(row, 'pill--assistant').length === 1, 'the row says the assistant is working');
});

test('markdown blocks: a quote is a quote, not a literal angle bracket', () => {
  const blocks = blocksOf('Updated the draft to say:\n\n> The journalist reached out.\n> Second line.\n\nDone.');
  assert.deepEqual(
    blocks.map((b) => b.tagName),
    ['P', 'BLOCKQUOTE', 'P'],
  );
  assert.equal(blocks[1]!.textContent, 'The journalist reached out. Second line.');
  assert.ok(!blocks[1]!.textContent!.includes('>'));
});

test('markdown blocks: paragraphs, lists, fences and a heading as a lead line', () => {
  const blocks = blocksOf('# Verdict\n\nIt is **right**.\n\n1. first\n2. second\n\n```\ncode here\n```');
  assert.deepEqual(
    blocks.map((b) => b.tagName.toLowerCase()),
    ['p', 'p', 'ol', 'pre'],
  );
  assert.equal(byTag(blocks[0]!, 'strong')[0]!.textContent, 'Verdict');
  assert.equal(blocks[3]!.textContent, 'code here');
});

/* ---------- the work, and what to do with the answer ---------- */

/** A turn on the email row, finished unless a test says otherwise. */
function turn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    id: 't1',
    itemId: 'email:thread:1',
    agent: 'claude',
    sessionId: 's',
    request: 'What do they want?',
    action: null,
    auto: null,
    startedAt: '2026-09-24T11:59:00Z',
    endedAt: '2026-09-24T11:59:52Z',
    status: 'done',
    reply: 'They want a date.',
    steps: [],
    error: null,
    ...overrides,
  };
}

const panelWith = (turns: AssistantTurn[], handlers = HANDLERS): HTMLElement =>
  mountOne(
    h(Flyout, {
      row: item(),
      run: null,
      state: state({ ...ENABLED, items: { 'email:thread:1': { running: turns.some((t) => t.status === 'running'), sessionId: 's', turns } } }),
      ui: uiWith({ detailFor: 'email:thread:1' }),
      handlers,
    }),
  );

const STEPS: AssistantTurn['steps'] = [
  { kind: 'message', text: 'Reading the thread first.', detail: null, state: 'done' },
  { kind: 'tool', text: 'Gmail: get thread', detail: '{"threadId":"1"}', state: 'done' },
  { kind: 'tool', text: 'Read the shared doc', detail: 'https://docs.example.com/d/1', state: 'failed' },
];

test('running, the turn shows a clock and each step as it comes, with no answer yet', () => {
  const running = turn({ status: 'running', endedAt: null, reply: '', startedAt: new Date().toISOString(), steps: [...STEPS, { kind: 'tool', text: 'Gmail: search threads', detail: '{"query":"x"}', state: 'running' }] });
  const node = panelWith([running]);

  assert.match(byClass(node, 'assistant__status')[0]!.textContent!, /^Working · 0:0\d$/);
  const steps = byClass(node, 'assistant__step');
  assert.deepEqual(
    steps.map((step) => step.dataset.state ?? 'message'),
    ['message', 'done', 'failed', 'running'],
  );
  assert.equal(steps[0]!.textContent, 'Reading the thread first.');
  assert.equal(byClass(steps[1]!, 'assistant__step-text')[0]!.textContent, 'Gmail: get thread');
  assert.equal(byClass(steps[1]!, 'assistant__step-detail')[0]!.textContent, '{"threadId":"1"}');
  assert.equal(byClass(node, 'assistant__reply').length, 0);
  assert.equal(byTag(node, 'details').length, 0, 'nothing is folded away while it works');
});

test('done, the work folds under what it took, and a failed turn keeps it open', () => {
  const done = panelWith([turn({ steps: STEPS })]);
  const work = byTag(done, 'details')[0]!;
  assert.equal(work.querySelector('summary')!.textContent, 'Worked for 52 s · 3 steps · 1 failed');
  assert.equal((work as HTMLDetailsElement).open, false);
  assert.equal(byClass(done, 'assistant__reply')[0]!.textContent, 'They want a date.');

  const failed = panelWith([turn({ status: 'failed', reply: '', error: 'claude exited with code 1', steps: STEPS })]);
  assert.equal((byTag(failed, 'details')[0] as HTMLDetailsElement).open, true);
  assert.match(byTag(failed, 'summary')[0]!.textContent!, /^Ran for 52 s/);

  const before = panelWith([turn()]);
  assert.equal(byTag(before, 'details').length, 0, 'a turn logged before steps were kept has no trail');
  assert.equal(byClass(before, 'assistant__took')[0]!.textContent, 'Answered in 52 s');
});

test('what the assistant created is a button, and the answer and its blocks can be copied', () => {
  const copied: string[] = [];
  const reply = 'Drafted a reply.\n\n```\nThanks, Friday works.\n```\n\nCreated: [Gmail draft](https://mail.google.com/mail/u/0/#drafts?compose=1)';
  const node = panelWith([turn({ reply })], handlersWith({ copy: (text) => copied.push(text) }));

  const answer = byClass(node, 'assistant__reply')[0]!;
  assert.ok(!answer.textContent!.includes('Created:'), 'the line becomes the button, not prose');
  const open = byClass(node, 'assistant__after')[0]!.querySelector('a')!;
  assert.equal(open.textContent, 'Gmail draft ↗');
  assert.equal(open.getAttribute('href'), 'https://mail.google.com/mail/u/0/#drafts?compose=1');
  assert.equal(open.getAttribute('target'), '_blank');

  byClass(answer, 'code-block__copy')[0]!.click();
  byTag(node, 'button').find((button) => button.textContent === 'Copy reply')!.click();
  assert.deepEqual(copied, ['Thanks, Friday works.', 'Drafted a reply.\n\n```\nThanks, Friday works.\n```']);
});

test('an answer that names its draft in prose keeps the link where it put it', () => {
  const node = panelWith([turn({ reply: 'Created a draft: https://mail.google.com/x' })]);
  assert.equal(byClass(node, 'assistant__reply')[0]!.querySelector('a')!.getAttribute('href'), 'https://mail.google.com/x');
  assert.equal(byClass(node, 'assistant__after')[0]!.querySelectorAll('a').length, 0);
});

test("the field is pinned in the panel's foot, outside the part that scrolls", () => {
  const node = panelWith([turn()]);
  const footer = byClass(node, 'flyout__footer')[0]!;
  assert.equal(byClass(footer, 'assistant__input').length, 1);
  assert.equal(byClass(footer, 'assistant__quick').length, 1);
  assert.equal(byClass(byClass(node, 'flyout__body')[0]!, 'assistant__input').length, 0);
});

test("a ticket's panel offers the ticket's quick actions, not a pull request's", () => {
  const [row] = resolveTickets(
    [
      {
        id: 'jira:PROJ-1',
        key: 'PROJ-1',
        summary: 'Ship it',
        workflowStatus: 'In Progress',
        statusCategory: 'indeterminate',
        issueType: 'Task',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        hasAnyPr: false,
        hasOpenPr: false,
        allPrsClosed: false,
      },
    ],
    [],
    new Date(NOW),
  );
  const node = mountOne(h(Flyout, { row: row!, run: null, state: state(ENABLED), ui: uiWith({ detailFor: 'jira:PROJ-1' }), handlers: HANDLERS }));
  const offered = buttonLabels(byClass(node, 'assistant__quick')[0]!);
  assert.ok(offered.includes('Summarise the ticket'));
  assert.ok(!offered.includes('Assess the review'));
});

test('a turn the dashboard asked on its own says so in the panel', () => {
  const node = panelWith([turn({ action: 'assess-review', request: QUICK_ACTIONS.find((a) => a.id === 'assess-review')!.request, auto: 'assess-review@x' })]);
  assert.equal(byClass(node, 'assistant__request')[0]!.textContent, 'Assess the review · asked ahead');
  const brief = mountOne(
    renderItem(
      item(),
      state({ ...ENABLED, items: { 'email:thread:1': { running: false, sessionId: 's', turns: [turn({ auto: 'k', reply: 'Yes, Friday.' })] } }, auto: { enabled: true, limit: 10, usedToday: 1, rows: { 'email:thread:1': ['k'] } } }),
      uiWith(),
      HANDLERS,
    ),
  );
  assert.equal(byClass(brief, 'item__ahead')[0]!.textContent, '✦Yes, Friday.', 'a brief item with the same id shows it too');
});
