/**
 * The Ask button and the panel, rendered against the DOM stub.
 *
 * Two rules worth holding here: the button exists only when there is an
 * assistant to ask, and the panel offers a row only the quick actions that fit
 * its source — a "draft a reply" on a pull request is the kind of wrong that
 * looks like a feature until it is pressed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buttonLabels, byClass, byTag, type StubElement } from './dom-stub.ts';
import { QUICK_ACTIONS } from '../src/assistant.ts';
import type { AssistantTurn, ResolvedItem } from '../src/types.ts';

const { renderItem, renderMarkdownBlocks } = (await import('../public/render.js')) as {
  renderItem: (item: ResolvedItem, state: unknown, ui: unknown, handlers: unknown) => StubElement;
  renderMarkdownBlocks: (text: string) => StubElement[];
};

const NOW = '2026-09-24T12:00:00Z';
const HANDLERS = new Proxy({}, { get: () => () => {} });

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

function state(assistant: unknown) {
  return { now: NOW, session: { active: null }, agenda: { conflictIds: [] }, assistant };
}

const ui = (overrides: Record<string, unknown> = {}) => ({
  selectedId: null,
  pending: new Set<string>(),
  noteFor: null,
  menuFor: null,
  noteDraft: '',
  assistantFor: null,
  assistantDraft: '',
  ...overrides,
});

const ENABLED = { enabled: true, agent: 'claude', quickActions: QUICK_ACTIONS, items: {} };

test('the Ask button appears only when the assistant is on', () => {
  const off = renderItem(item(), state({ enabled: false, quickActions: [], items: {} }), ui(), HANDLERS);
  assert.ok(!buttonLabels(off).includes('Ask'));
  const on = renderItem(item(), state(ENABLED), ui(), HANDLERS);
  assert.ok(buttonLabels(on).includes('Ask'));
  assert.equal(byClass(on, 'assistant').length, 0, 'closed until asked for');
});

test('the panel offers the quick actions for the row\'s source and the ones for every row', () => {
  const node = renderItem(item(), state(ENABLED), ui({ assistantFor: 'email:thread:1' }), HANDLERS);
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
  const node = renderItem(item(), state(assistant), ui({ assistantFor: 'email:thread:1' }), HANDLERS);

  const turns = byClass(node, 'assistant__turn');
  assert.equal(turns.length, 2);
  assert.equal(byClass(turns[0]!, 'assistant__request')[0]!.textContent, 'Draft a reply');
  assert.equal(byTag(turns[0]!, 'LI').length, 2);
  assert.match(byClass(turns[1]!, 'assistant__status')[0]!.textContent, /Working/);
  assert.ok(buttonLabels(node).includes('Stop'));
  assert.ok(!buttonLabels(node).includes('Send'));
  assert.equal(byClass(node, 'assistant__quick').length, 0, 'no quick actions while working');
  assert.ok(byClass(node, 'pill--assistant').length === 1, 'the row says the assistant is working');
});

test('markdown blocks: a quote is a quote, not a literal angle bracket', () => {
  const blocks = renderMarkdownBlocks('Updated the draft to say:\n\n> The journalist reached out.\n> Second line.\n\nDone.');
  assert.deepEqual(
    blocks.map((b) => b.tagName),
    ['P', 'BLOCKQUOTE', 'P'],
  );
  assert.equal(blocks[1]!.textContent, 'The journalist reached out. Second line.');
  assert.ok(!blocks[1]!.textContent.includes('>'));
});

test('markdown blocks: paragraphs, lists, fences and a heading as a lead line', () => {
  const blocks = renderMarkdownBlocks('# Verdict\n\nIt is **right**.\n\n1. first\n2. second\n\n```\ncode here\n```');
  assert.deepEqual(
    blocks.map((b) => b.tagName.toLowerCase()),
    ['p', 'p', 'ol', 'pre'],
  );
  assert.equal(byTag(blocks[0]!, 'STRONG')[0]!.textContent, 'Verdict');
  assert.equal(blocks[3]!.textContent, 'code here');
});
