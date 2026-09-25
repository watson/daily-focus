/**
 * The item panel.
 *
 * The rules worth holding: it is empty and hidden when nothing is open; it names
 * every kind of row in that row's own terms; a row's notes are read here and
 * only counted on the row; the note field is always there, since the panel is
 * the one place a note is written now; and a state push on the same row leaves
 * the field, its text and its cursor exactly where they were.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mountOne, settle, uiWith } from './dom.ts';
import { Flyout } from '../client/flyout.ts';
import { renderItem } from '../client/items.ts';
import { state } from '../client/state.ts';
import type { DetailRow } from '../client/state.ts';
import type { UiValues } from '../client/types.ts';
import { resolveBoard } from '../src/prs.ts';
import type { DashboardState, PullRequest, ResolvedItem } from '../src/types.ts';

const NOW = '2026-09-24T12:00:00Z';
const STATE = { now: NOW, session: { active: null }, agenda: { conflictIds: [] } } as unknown as DashboardState;
const HANDLERS = handlersWith();

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

function panel(row: DetailRow | null, overrides: Partial<UiValues> = {}): HTMLElement {
  const ui = uiWith({ detailFor: row?.id ?? null, ...overrides });
  return mountOne(h(Flyout, { row, run: null, state: STATE, ui, handlers: HANDLERS }));
}

test('nothing open: the panel is hidden and empty', () => {
  const node = panel(null);
  assert.equal(node.hidden, true);
  assert.equal(node.childNodes.length, 0);
});

test("a brief item: source, people, title, the agent's detail, and a place to write", () => {
  const node = panel(item());
  assert.equal(node.hidden, false);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent!, /Email/);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent!, /Dana/);
  assert.equal(byClass(node, 'flyout__title')[0]!.textContent, 'Reply to the vendor');
  assert.equal(byTag(byClass(node, 'flyout__detail')[0]!, 'strong')[0]?.textContent, 'signed');
  assert.match(byClass(node, 'flyout__empty')[0]!.textContent!, /Nothing noted yet/);
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
  const node = panel(row!);
  const title = byClass(node, 'flyout__title')[0]!;
  assert.equal(byClass(title, 'item__ref')[0]?.textContent, 'acme/webapp#3421');
  assert.equal((byTag(title, 'a')[0] as HTMLAnchorElement | undefined)?.href, pr.url);
  assert.match(byClass(node, 'flyout__where')[0]!.textContent!, /GitHub/);
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

  const row = mountOne(renderItem(noted, STATE, uiWith(), HANDLERS));
  assert.equal(byClass(row, 'pill--notes')[0]?.textContent, '2 notes');
  assert.doesNotMatch(row.textContent!, /no answer/);
  assert.equal(byClass(row, 'flyout__note-input').length, 0, 'no form on the row');
});

test('a draft in the fields is what the fields show', () => {
  const node = panel(item(), { noteDraft: 'half a thou', assistantDraft: 'and why' });
  assert.equal((byClass(node, 'flyout__note-input')[0] as HTMLInputElement).value, 'half a thou');
  assert.equal(byClass(node, 'assistant__input').length, 0, 'no assistant configured, no assistant field');
});

/**
 * The reason the client is built the way it is. State arrives on a heartbeat,
 * and every push used to rebuild the panel and take the field being typed into
 * with it. Now a push on the same row changes what differs and nothing else:
 * the field is the same element, still focused, with the caret where it was.
 */
test('a state push on the same row keeps the field, its text and its cursor', async () => {
  const ui = uiWith({ detailFor: 'email:thread:1', noteDraft: 'half a' });
  const first = item();
  const root = document.createElement('div');
  document.body.append(root);
  const { render } = await import('preact');
  render(h(Flyout, { row: first, run: null, state: STATE, ui, handlers: HANDLERS }), root);

  const input = byClass(root, 'flyout__note-input')[0] as HTMLInputElement;
  input.focus();
  input.setSelectionRange(2, 2);
  assert.equal(document.activeElement, input);

  // The same row, with a note the server just folded in — as a push would bring it.
  const pushed = item({ notes: [{ text: 'Called them', at: NOW }] });
  render(h(Flyout, { row: pushed, run: null, state: { ...STATE, now: '2026-09-24T12:01:00Z' }, ui, handlers: HANDLERS }), root);

  assert.equal(byClass(root, 'flyout__note-input')[0], input, 'the same element, not a rebuilt one');
  assert.equal(document.activeElement, input, 'still focused');
  assert.equal(input.value, 'half a');
  assert.equal(input.selectionStart, 2);
  assert.equal(byClass(root, 'flyout__note').length, 1, 'and the note arrived');

  // Typing writes the draft; the write reruns the field and leaves the element alone.
  input.value = 'half a thou';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  assert.equal(ui.noteDraft.value, 'half a thou');
  assert.equal(byClass(root, 'flyout__note-input')[0], input);
  void state;
});

test('opened by hand, the field asked for takes the cursor, once', async () => {
  const ui = uiWith({ detailFor: 'email:thread:1', focusField: 'note' });
  const node = panel(item(), { detailFor: 'email:thread:1', focusField: 'note' });
  void node;
  const root = document.createElement('div');
  document.body.append(root);
  const { render } = await import('preact');
  render(h(Flyout, { row: item(), run: null, state: STATE, ui, handlers: HANDLERS }), root);
  await settle();
  const input = byClass(root, 'flyout__note-input')[0] as HTMLInputElement;
  assert.equal(document.activeElement, input);
  assert.equal(ui.focusField.value, null, 'the request is spent');
});

test('the card opens the panel: no Note or Ask button on any row', () => {
  const labels = buttonLabels(mountOne(renderItem(item(), STATE, uiWith(), HANDLERS)));
  assert.ok(!labels.includes('Note') && !labels.includes('Ask'), labels.join(','));
  const noted = mountOne(renderItem(item({ notes: [{ text: 'x', at: NOW }] }), STATE, uiWith(), HANDLERS));
  assert.equal(byClass(noted, 'pill--notes')[0]?.tagName, 'SPAN');
});

test('a row is marked as the one the panel is open on', () => {
  const on = mountOne(renderItem(item(), STATE, uiWith({ detailFor: 'email:thread:1' }), HANDLERS));
  assert.equal(on.dataset.detail, 'true');
  const off = mountOne(renderItem(item(), STATE, uiWith({ detailFor: 'other' }), HANDLERS));
  assert.equal(off.dataset.detail, 'false');
});
