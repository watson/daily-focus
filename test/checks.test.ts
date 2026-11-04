import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runContractChecks } from '../src/checks.ts';
import type { ArchivedItem } from '../src/archive.ts';
import { canonicalId, fingerprintId } from '../src/ids.ts';
import { resolveItems } from '../src/store.ts';
import type { Brief, Item } from '../src/types.ts';
import type { Focus } from '../src/focus.ts';

const NOW = new Date(2026, 8, 10, 12, 0, 0);

function item(id: string, extra: Partial<Item> = {}): Item {
  return { id, source: 'github', kind: 'task', title: `title for ${id}`, ...extra };
}

function brief(items: Item[]): Brief {
  return { version: 1, generatedAt: NOW.toISOString(), items };
}

const focus = (extra: Partial<Focus> = {}): Focus => ({
  objective: 'Ship it',
  blocker: null,
  note: null,
  agentOnly: null,
  ...extra,
});

function history(entries: Record<string, Partial<ArchivedItem>>): Map<string, ArchivedItem> {
  return new Map(
    Object.entries(entries).map(([id, e]) => [
      id,
      { title: `title for ${id}`, advancesObjective: false, ...e },
    ]),
  );
}

function check(
  items: Item[],
  opts: { focus?: Focus | null; history?: Map<string, ArchivedItem>; previous?: Item[] } = {},
) {
  const b = brief(items);
  return runContractChecks({
    brief: b,
    items: resolveItems(b.items, [], NOW),
    focus: opts.focus === undefined ? focus() : opts.focus,
    history: opts.history ?? new Map(),
    previous: opts.previous ? brief(opts.previous) : null,
  });
}

/* ---------- ids ---------- */

test('canonical form folds case and whitespace, nothing else', () => {
  assert.equal(canonicalId('  GitHub:PR:Acme/WebApp#3421 '), 'github:pr:acme/webapp#3421');
  // Distinct ids must stay distinct — a false match would tick off the wrong item.
  assert.notEqual(canonicalId('jira:PROJ-1'), canonicalId('jira:PROJ-2'));
});

test('fingerprint ignores punctuation so re-shaped ids collide', () => {
  assert.equal(
    fingerprintId('github:pr:Acme/WebApp#3421'),
    fingerprintId('github/pr/acme/webapp/3421'),
  );
  assert.notEqual(fingerprintId('jira:PROJ-8842'), fingerprintId('jira:PROJ-8843'));
});

/* ---------- objective coverage ---------- */

test('flags a day with no path to the objective', () => {
  const problems = check([item('a'), item('b')]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /Nothing in today's brief advances the objective/);
});

test('says nothing when the objective is covered', () => {
  assert.deepEqual(check([item('a', { advancesObjective: true }), item('b')]), []);
});

test('no objective means no objective checks', () => {
  assert.deepEqual(check([item('a')], { focus: null }), []);
  assert.deepEqual(check([item('a')], { focus: focus({ objective: null }) }), []);
});

test('flags a generously applied objective flag', () => {
  const items = Array.from({ length: 6 }, (_, i) => item(`a${i}`, { advancesObjective: true }));
  assert.match(check(items).join(' '), /flagged as advancing the objective/);
});

/* ---------- firstSeen ---------- */

test('flags firstSeen being moved forward on an item carried over from the brief before', () => {
  const problems = check([item('a', { firstSeen: '2026-09-10', advancesObjective: true })], {
    previous: [item('a', { firstSeen: '2026-09-01' })],
  });
  assert.deepEqual(problems, [
    '1 item(s) had their "first seen" date moved forward, which resets how old they look. Oldest affected: title for a',
  ]);
});

test('names the reset item that was first seen longest ago', () => {
  const problems = check(
    [item('b', { firstSeen: '2026-09-10', advancesObjective: true }), item('a', { firstSeen: '2026-09-10' })],
    { previous: [item('b', { firstSeen: '2026-09-05' }), item('a', { firstSeen: '2026-09-01' })] },
  );
  assert.match(problems.join(' '), /^2 item\(s\) .* Oldest affected: title for a$/);
});

test('an unchanged or earlier firstSeen is fine', () => {
  const unchanged = check([item('a', { firstSeen: '2026-09-01', advancesObjective: true })], {
    previous: [item('a', { firstSeen: '2026-09-01' })],
  });
  assert.deepEqual(unchanged, []);

  const earlier = check([item('a', { firstSeen: '2026-08-20', advancesObjective: true })], {
    previous: [item('a', { firstSeen: '2026-09-01' })],
  });
  assert.deepEqual(earlier, []);
});

test('an item back after a day away dates from its return', () => {
  // Raised on the 1st, handled upstream so the brief before dropped it, and
  // back today: older briefs knowing it doesn't make today's date a reset.
  const problems = check([item('a', { firstSeen: '2026-09-10', advancesObjective: true })], {
    history: history({ a: {} }),
    previous: [item('b', { firstSeen: '2026-09-01' })],
  });
  assert.deepEqual(problems, []);
});

test('with no brief before, there is nothing to carry over', () => {
  assert.deepEqual(check([item('a', { firstSeen: '2026-09-10', advancesObjective: true })]), []);
});

/* ---------- id drift ---------- */

test('flags an id that changed shape', () => {
  const problems = check([item('github/pr/acme/webapp/3421', { advancesObjective: true })], {
    history: history({ 'github:pr:Acme/WebApp#3421': {} }),
  });
  assert.match(problems.join(' '), /Item id changed shape/);
  assert.match(problems.join(' '), /will come back/);
});

test('a genuinely new id is not drift', () => {
  const problems = check([item('jira:PROJ-8844', { advancesObjective: true })], {
    history: history({ 'jira:PROJ-8842': {} }),
  });
  assert.deepEqual(problems, []);
});

test('an unchanged id is not drift', () => {
  assert.deepEqual(
    check([item('jira:PROJ-8842', { advancesObjective: true })], {
      history: history({ 'jira:PROJ-8842': {} }),
    }),
    [],
  );
});

/* ---------- the privacy boundary ---------- */

test('flags private focus.md text echoed into the brief', () => {
  const secret = 'the thing that actually decides whether this quarter went well';
  const problems = check([item('a', { advancesObjective: true, detail: `Note: ${secret}.` })], {
    focus: focus({ agentOnly: secret }),
  });
  assert.match(problems.join(' '), /Private text from focus.md appears in the brief/);
});

test('shared vocabulary alone is not a leak', () => {
  // Both halves legitimately mention progress, the calendar and the ticket key.
  const problems = check([item('a', { advancesObjective: true, detail: 'Progress on PROJ-8842 from the calendar.' })], {
    focus: focus({ agentOnly: 'Weight progress on PROJ-8842 highly; read the calendar for the real day bounds.' }),
  });
  assert.deepEqual(problems, []);
});
