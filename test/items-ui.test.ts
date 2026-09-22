/**
 * Where a brief row says it lives.
 *
 * The repository behind a GitHub item is derived in `render.js` and nowhere else,
 * so nothing but a rendered row can be asked whether it survived — and the rule
 * worth holding is as much about the links it must *not* name a repository for
 * as about the ones it must.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported for its side effect before `render.js` is pulled in below: it installs
// the `document` and `Node` globals that `el()` reaches for.
import { byClass, type StubElement } from './dom-stub.ts';
import type { ResolvedItem } from '../src/types.ts';

const { renderItem } = (await import('../public/render.js')) as {
  renderItem: (item: ResolvedItem, state: unknown, ui: unknown, handlers: unknown) => StubElement;
};

const NOW = '2026-09-15T12:00:00Z';

const STATE = { now: NOW, session: { active: null }, agenda: { conflictIds: [] } };
const UI = { selectedId: null, pending: new Set<string>(), noteFor: null, menuFor: null, noteDraft: '' };
const HANDLERS = {
  onSelect: () => {},
  onAction: () => {},
  startSession: () => {},
  stopSession: () => {},
  toggleMenu: () => {},
  toggleNote: () => {},
  onNoteDraft: () => {},
  closeNote: () => {},
};

function render(overrides: Partial<ResolvedItem> = {}): StubElement {
  const item: ResolvedItem = {
    id: 'github:pr:acme/webapp#3421',
    source: 'github',
    kind: 'task',
    title: 'Land the session replay fix',
    url: 'https://github.com/acme/webapp/pull/3421',
    status: 'open',
    notes: [],
    ageDays: 0,
    ...overrides,
  };
  return renderItem(item, STATE, UI, HANDLERS);
}

/** The `owner/repo` shown on the row, or null when it declined to name one. */
function ref(node: StubElement): string | null {
  return byClass(node, 'item__ref')[0]?.textContent ?? null;
}

test('a GitHub row names its organisation and repository ahead of the title', () => {
  const node = render();
  assert.equal(ref(node), 'acme/webapp');

  // Inside the link, so the address and the title are one target.
  const title = byClass(node, 'item__title')[0];
  assert.ok(title);
  assert.equal(title.textContent, 'acme/webapp Land the session replay fix');
});

test('the repository comes off the URL, not the id', () => {
  // The id is the agent's to spell and is treated as opaque; an item whose id
  // drifted from the recipe still says where it lives.
  const node = render({ id: 'pr-3421', url: 'https://github.com/other-org/api/issues/77' });
  assert.equal(ref(node), 'other-org/api');
});

test('it is shown even when the title says it too', () => {
  const node = render({ title: 'Nudge review on acme/webapp #3421' });
  assert.equal(ref(node), 'acme/webapp');
});

test('a link naming no repository says nothing rather than guessing', () => {
  for (const url of [
    'https://github.com/orgs/acme/projects/5',
    'https://github.com/notifications',
    'https://github.com/acme',
    'https://gist.github.com/alice/2f9a1c',
    'https://example.com/acme/webapp/pull/1',
    'not a url',
  ]) {
    assert.equal(ref(render({ url })), null, url);
  }
});

test('an item with no link, or from another source, carries no repository', () => {
  assert.equal(ref(render({ url: undefined })), null);
  assert.equal(
    ref(render({ id: 'email:thread:18f2a9c4b7', source: 'email', url: 'https://github.com/acme/webapp/pull/3421' })),
    null,
  );
});
