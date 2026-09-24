/**
 * The item panel, rendered against the DOM stub.
 *
 * The rules worth holding: it is empty and hidden when nothing is open; it names
 * every kind of row in that row's own terms; a row's notes are read here and
 * only counted on the row; and the note field is always there, since the panel
 * is the one place a note is written now. The panel's focus, caret and scroll
 * handling need a browser and are not tested here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buttonLabels, byClass, byTag, mount, type StubElement } from './dom-stub.ts';
import { resolveBoard } from '../src/prs.ts';
import type { PullRequest, ResolvedItem } from '../src/types.ts';

const { renderFlyout, renderItem, renderPullRow } = (await import('../public/render.js')) as {
  renderFlyout: (row: unknown, state: unknown, ui: unknown, handlers: unknown) => void;
  renderItem: (item: ResolvedItem, state: unknown, ui: unknown, handlers: unknown) => StubElement;
  renderPullRow: (row: unknown, state: unknown, ui: unknown, handlers: unknown) => StubElement;
};

const NOW = '2026-09-24T12:00:00Z';
const STATE = { now: NOW, session: { active: null }, agenda: { conflictIds: [] } };
const HANDLERS = new Proxy({}, { get: () => () => {} });

const ui = (overrides: Record<string, unknown> = {}) => ({
  selectedId: null,
  pending: new Set<string>(),
  menuFor: null,
  detailFor: null,
  noteDraft: '',
  assistantDraft: '',
  focusField: null,
  ...overrides,
});

function item(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return {
    id: 'email:thread:1',
    source: 'email',
    kind: 'task',
    title: 'Reply to the vendor',
    detail: 'They want the **signed** order form back by Friday.',
    people: ['Dana'],
    status: 'open',
    notes: [],
    ageDays: 0,
    ...overrides,
  };
}

function panel(row: unknown, overrides: Record<string, unknown> = {}): StubElement {
  renderFlyout(row, STATE, ui({ detailFor: (row as { id?: string } | null)?.id ?? null, ...overrides }), HANDLERS);
  return mount('flyout');
}

test('nothing open: the panel is hidden and empty', () => {
  panel(item());
  const node = panel(null);
  assert.equal(node.hidden, true);
  assert.equal(node.childNodes.length, 0);
});

test('a brief item: source, people, title, the agent\'s detail, and a place to write', () => {
  const node = panel(item());
  assert.equal(node.hidden, false);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent, /Email/);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent, /Dana/);
  assert.equal(byClass(node, 'flyout__title')[0]!.textContent, 'Reply to the vendor');
  assert.equal(byTag(byClass(node, 'flyout__detail')[0]!, 'STRONG')[0]?.textContent, 'signed');
  assert.match(byClass(node, 'flyout__empty')[0]!.textContent, /Nothing noted yet/);
  assert.equal(byClass(node, 'flyout__note-input').length, 1);
  assert.deepEqual(buttonLabels(node), ['×', 'Save']);
});

test('a pull request: repo#number ahead of the title, linked', () => {
  const pr: PullRequest = {
    id: 'github:pr:acme/webapp#3421',
    account: 'alice',
    repo: 'acme/webapp',
    number: 3421,
    title: 'Fix session replay memory leak',
    url: 'https://github.com/acme/webapp/pull/3421',
    isDraft: false,
    createdAt: NOW,
    readyAt: NOW,
    updatedAt: NOW,
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
    reviews: [],
    lastActivityByYou: null,
    lastActivityByOthers: null,
  };
  const [row] = resolveBoard([pr], [], new Date(NOW), []);
  const node = panel(row);
  const title = byClass(node, 'flyout__title')[0]!;
  assert.equal(byClass(title, 'item__ref')[0]?.textContent, 'acme/webapp#3421');
  assert.equal(byTag(title, 'A')[0]?.href, pr.url);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent, /GitHub/);
  assert.equal(byClass(node, 'flyout__detail').length, 0, 'a pull request has no agent detail to show');
});

test('notes are read in the panel and only counted on the row', () => {
  const noted = item({
    notes: [
      { text: 'Called them, no answer', at: '2026-09-24T09:00:00Z' },
      { text: 'Dana is out until Monday', at: '2026-09-24T11:00:00Z' },
    ],
  });
  const node = panel(noted);
  assert.deepEqual(
    byClass(node, 'flyout__note').map((note) => note.textContent),
    ['“Called them, no answer” 3 h ago', '“Dana is out until Monday” 1 h ago'],
  );
  assert.equal(byClass(node, 'flyout__empty').length, 0);

  const row = renderItem(noted, STATE, ui(), HANDLERS);
  assert.equal(byClass(row, 'pill--notes')[0]?.textContent, '2 notes');
  assert.doesNotMatch(row.textContent, /no answer/);
  assert.equal(byClass(row, 'flyout__note-input').length, 0, 'no form on the row');
});

test('the draft comes back into the field after a rebuild', () => {
  const node = panel(item(), { noteDraft: 'half a thou', assistantDraft: 'and why' });
  assert.equal(byClass(node, 'flyout__note-input')[0]?.value, 'half a thou');
  assert.equal(byClass(node, 'assistant__input').length, 0, 'no assistant configured, no assistant field');
});

test('the card opens the panel: no Note or Ask button on any row', () => {
  const labels = buttonLabels(renderItem(item(), STATE, ui(), HANDLERS));
  assert.ok(!labels.includes('Note') && !labels.includes('Ask'), labels.join(','));
  assert.equal(byClass(renderItem(item({ notes: [{ text: 'x', at: NOW }] }), STATE, ui(), HANDLERS), 'pill--notes')[0]?.tagName, 'SPAN');
});

test('a row is marked as the one the panel is open on', () => {
  const on = renderItem(item(), STATE, ui({ detailFor: 'email:thread:1' }), HANDLERS);
  assert.equal(on.dataset.detail, 'true');
  const off = renderItem(item(), STATE, ui({ detailFor: 'other' }), HANDLERS);
  assert.equal(off.dataset.detail, 'false');
  const [row] = resolveBoard([], [], new Date(NOW), []);
  assert.equal(row, undefined);
  void renderPullRow;
});
