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
  return { now: NOW, session: { active: null }, agenda: { conflictIds: [] }, assistant } as unknown as DashboardState;
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
    startedAt: NOW,
    endedAt: NOW,
    status: 'done',
    reply: 'Drafted.\n\n- one\n- two',
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
