/**
 * What one ticket row actually renders.
 *
 * The rules worth holding to something are the ones that live only in
 * `render.js`: that a row shows the status it currently claims, that it offers
 * park and note but never done, and that a ticket with no site behind it renders
 * as text rather than as an anchor going nowhere. None of those are visible to
 * `tickets.ts`, so nothing else would catch them going.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imported for its side effect before `render.js` is pulled in below.
import { byClass, byTag, buttonLabels, type StubElement } from './dom-stub.ts';
import { resolveTickets } from '../src/tickets.ts';
import type { Ticket, TicketRow } from '../src/types.ts';

const { renderTicketRow, typeLegend } = (await import('../public/render.js')) as {
  renderTicketRow: (row: TicketRow, state: unknown, ui: unknown, handlers: unknown) => StubElement;
  typeLegend: (rows: readonly TicketRow[]) => StubElement | null;
};

const NOW = new Date('2026-09-22T09:00:00Z');
const STATE = { now: NOW.toISOString() };
const UI = { selectedId: null, pending: new Set<string>(), noteFor: null, menuFor: null, noteDraft: '' };
const HANDLERS = {
  onSelect: () => {},
  onAction: () => {},
  toggleMenu: () => {},
  toggleNote: () => {},
  unpark: () => {},
};

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'jira:PROJ-8842',
    key: 'PROJ-8842',
    summary: 'Drop the retry loop from the ingest path',
    workflowStatus: 'Committed',
    statusCategory: 'new',
    issueType: 'Task',
    url: 'https://acme.atlassian.net/browse/PROJ-8842',
    hasAnyPr: true,
    hasOpenPr: false,
    ...overrides,
  };
}

function render(overrides: Partial<Ticket> = {}, actions: Parameters<typeof resolveTickets>[1] = []): StubElement {
  const rows = resolveTickets([ticket(overrides)], actions, NOW);
  assert.equal(rows.length, 1, 'the fixture should produce exactly one row');
  return renderTicketRow(rows[0]!, STATE, UI, HANDLERS);
}

test('the row names the ticket by key and links to it', () => {
  const node = render();
  const link = byTag(node, 'A').find((a) => String(a.href ?? '').includes('/browse/'));
  assert.equal(byTag(node, 'A').length, 1, 'the summary is the only link; an Open button would duplicate it');
  assert.ok(link, 'expected a browse link');
  assert.equal(link.href, 'https://acme.atlassian.net/browse/PROJ-8842');
  assert.equal(byClass(node, 'item__ref')[0]?.textContent, 'PROJ-8842');
  assert.match(node.textContent, /Drop the retry loop/);
});

/**
 * The heading says what is wrong; this says what the ticket currently claims,
 * which is the other half of the sentence and the thing the user is about to go
 * and change. Alone in its own element, because the stylesheet stands it in a
 * fixed gutter — fold it back in with the other pills and every summary on the
 * board stops lining up.
 */
test('the status is shown, on its own, in the element the gutter styles', () => {
  const node = render({ workflowStatus: 'In Review', statusCategory: 'indeterminate' });
  const gutter = byClass(node, 'item__meta--status')[0];
  assert.ok(gutter, 'expected the status to have its own element');
  assert.equal(gutter.textContent, 'In Review');
  assert.equal(byClass(gutter, 'pill').length, 1, 'the gutter holds the status and nothing else');
});

test('a ticket whose status Jira did not name still gets a gutter', () => {
  // An em dash rather than an empty pill, so the column never has a hole in it.
  assert.equal(byClass(render({ workflowStatus: '' }), 'item__meta--status')[0]?.textContent, '—');
});

/**
 * The type rides on the dot, which is the one place on this board where colour
 * carries a cue by itself — so it has to be readable without seeing the colour.
 * This is the assertion that stops that regressing quietly.
 */
test('the issue type is on the dot as text, not as colour alone', () => {
  const node = render({ issueType: 'Sub-task' });
  const dot = byClass(node, 'item__dot')[0];
  assert.ok(dot, 'expected a dot');
  assert.equal(dot.attributes['aria-label'], 'Sub-task');
  assert.equal(dot.title, 'Sub-task');
  assert.notEqual(dot.attributes['aria-hidden'], 'true', 'the dot carries meaning here, so it must not be hidden');
});

test('a type Jira did not name says so rather than going quietly grey', () => {
  const dot = byClass(render({ issueType: '' }), 'item__dot')[0];
  assert.equal(dot?.attributes['aria-label'], 'unknown type');
});

test('the type no longer takes a pill, since that cost a line in the gutter', () => {
  const pills = byClass(render({ issueType: 'Bug' }), 'pill').map((p) => p.textContent);
  assert.deepEqual(pills, ['Committed'], 'only the status should be a pill');
});

/* ---------- the legend ---------- */

const rowsOf = (...types: string[]): TicketRow[] =>
  types.map((issueType, i) => ({
    ...ticket({ id: `jira:PROJ-${i}`, key: `PROJ-${i}`, issueType }),
    court: 'settled' as const,
    status: 'open' as const,
    notes: [],
  }));

test('the legend names every type on screen, once, in a stable order', () => {
  const legend = typeLegend(rowsOf('Task', 'Bug', 'Task', 'Sub-task'));
  assert.ok(legend);
  assert.deepEqual(
    byClass(legend, 'legend__entry').map((entry) => entry.textContent),
    ['Bug', 'Sub-task', 'Task'],
  );
  assert.equal(byClass(legend, 'legend__dot').length, 3, 'every entry carries its swatch');
});

/** A key to one colour explains nothing, and is a row of furniture every morning. */
test('there is no legend when every ticket is the same type', () => {
  assert.equal(typeLegend(rowsOf('Task', 'Task')), null);
  assert.equal(typeLegend(rowsOf()), null);
});

test('a type the palette has never heard of still gets a legend entry', () => {
  const legend = typeLegend(rowsOf('Task', 'Spike'));
  assert.deepEqual(
    byClass(legend!, 'legend__entry').map((entry) => entry.textContent),
    ['Spike', 'Task'],
  );
});

test('a row carries its court, so the stylesheet and a test can both see it', () => {
  assert.equal(render().dataset.court, 'settled');
  assert.equal(render({ hasAnyPr: false, statusCategory: 'indeterminate' }).dataset.court, 'idle');
});

/**
 * `el()` drops a null href, which would leave an anchor that looks clickable and
 * goes nowhere. A site nobody named means a plain row instead.
 */
test('no site means no anchor at all, not an anchor with no target', () => {
  const node = render({ url: null });
  assert.deepEqual(byTag(node, 'A'), []);
  assert.match(node.textContent, /PROJ-8842/);
  assert.match(node.textContent, /Drop the retry loop/);
});

/**
 * The strip sits over the card's top right and every button in it is width taken
 * off the summary, so Open had to justify itself and couldn't: the summary beside
 * it already links to the same URL.
 */
test('there is no Open button, because the summary is the link', () => {
  for (const labels of [buttonLabels(render()), buttonLabels(render({ url: null }))]) {
    assert.ok(!labels.includes('Open'), labels.join(','));
  }
});

/**
 * The fix is a status change in Jira, and the next read drops the row on its
 * own — so there is nothing here for Done to mean. Nudged is absent for a
 * different reason: there is nobody to nudge about your own ticket.
 */
test('park and note are offered; done, dismiss and nudge are not', () => {
  const labels = buttonLabels(render());
  assert.ok(labels.includes('Park'), labels.join(','));
  assert.ok(labels.includes('Note'), labels.join(','));
  for (const absent of ['Done', 'Mark done', 'Dismiss', 'Nudged', 'Start', 'Open']) {
    assert.ok(!labels.includes(absent), `${absent} should not be offered on a ticket row`);
  }
});

test('a parked row says until when, and offers Unpark instead of Park', () => {
  const node = render({}, [{ id: 'jira:PROJ-8842', action: 'snooze', at: '2026-09-22T08:00:00Z', until: '2026-09-30' }]);
  assert.equal(node.dataset.status, 'snoozed');
  assert.match(node.textContent, /parked until/);
  const labels = buttonLabels(node);
  assert.ok(labels.includes('Unpark'), labels.join(','));
  assert.ok(!labels.includes('Park'), labels.join(','));
});

test('a note left on a ticket is shown on its row', () => {
  const node = render({}, [
    { id: 'jira:PROJ-8842', action: 'note', at: '2026-09-22T08:00:00Z', text: 'two more repos to go' },
  ]);
  assert.match(node.textContent, /two more repos to go/);
});

/**
 * The same ticket can be a brief item as well, and two elements sharing one id is
 * invalid HTML and an ambiguous fragment target — so the row namespaces its own.
 */
test('the element id is namespaced away from the brief\'s', () => {
  assert.match(String(render().id ?? ''), /^ticket-/);
});

/* ---------- the park menu ---------- */

/**
 * Render the menu open and press one of its entries, returning the `until` the
 * click would have sent. Driving it through the handler rather than calling the
 * date maths directly is the point: the arithmetic is only correct if the button
 * carrying it is wired to the label above it.
 */
function park(label: string, today = '2026-09-22'): string | undefined {
  const rows = resolveTickets([ticket()], [], new Date(`${today}T09:00:00Z`), []);
  let sent: { until?: string } | undefined;
  const node = renderTicketRow(
    rows[0]!,
    { now: `${today}T09:00:00` },
    { ...UI, menuFor: 'jira:PROJ-8842' },
    { ...HANDLERS, onAction: (_id: string, _action: string, extra: { until?: string }) => void (sent = extra) },
  );
  const menu = byClass(node, 'menu')[0];
  assert.ok(menu, 'expected the menu to render when ui.menuFor matches');
  const button = byTag(menu, 'BUTTON').find((b) => b.textContent.startsWith(label));
  assert.ok(button, `no "${label}" entry; menu had ${byTag(menu, 'BUTTON').map((b) => b.textContent).join(' | ')}`);
  (button.listeners.click as (() => void)[])[0]!();
  return sent?.until;
}

test('the ticket board offers months and quarters as well as days', () => {
  assert.equal(park('Tomorrow'), '2026-09-23');
  assert.equal(park('In 3 days'), '2026-09-25');
  assert.equal(park('Next week'), '2026-09-29');
  assert.equal(park('Next month'), '2026-10-22');
  assert.equal(park('Next quarter'), '2026-12-22');
});

/**
 * `new Date(2026, 0 + 1, 31)` is the 3rd of March: the day overflows February and
 * rolls on, so a park set on the 31st would land in the month after the one it
 * named. Both directions of the clamp are pinned, since only one of them is the
 * leap-year case.
 */
test('a park from the end of a long month lands inside the month it named', () => {
  assert.equal(park('Next month', '2026-01-31'), '2026-02-28');
  assert.equal(park('Next month', '2028-01-31'), '2028-02-29', 'a leap February has a 29th to land on');
  assert.equal(park('Next month', '2026-03-31'), '2026-04-30');
  assert.equal(park('Next quarter', '2026-05-31'), '2026-08-31', 'three long months apart needs no clamp');
  assert.equal(park('Next quarter', '2026-11-30'), '2027-02-28', 'and a quarter can cross a year end');
});

test('the long-range entries say which date they mean, and the short ones do not', () => {
  const rows = resolveTickets([ticket()], [], NOW, []);
  const node = renderTicketRow(rows[0]!, { now: NOW.toISOString() }, { ...UI, menuFor: 'jira:PROJ-8842' }, HANDLERS);
  const labels = byTag(byClass(node, 'menu')[0]!, 'BUTTON').map((b) => b.textContent);
  assert.ok(
    labels.some((l) => l.startsWith('Next quarter') && /Dec/.test(l)),
    labels.join(' | '),
  );
  assert.ok(labels.includes('Next week'), 'a week out needs no date spelled out');
});

/** A dateless park would hide a board row forever with nothing on screen to say so. */
test('the board still refuses an open-ended park', () => {
  const rows = resolveTickets([ticket()], [], NOW, []);
  const node = renderTicketRow(rows[0]!, { now: NOW.toISOString() }, { ...UI, menuFor: 'jira:PROJ-8842' }, HANDLERS);
  const labels = byTag(byClass(node, 'menu')[0]!, 'BUTTON').map((b) => b.textContent);
  assert.ok(!labels.some((l) => /agent decides/.test(l)), labels.join(' | '));
});

/* ---------- the status control ---------- */

const VOCAB = { PROJ: ['Committed', 'Done', 'In Review', "Won't Fix"], OTHER: ['To Do'] };

function statusRow(overrides: Partial<Ticket> = {}, statuses: Record<string, string[]> = VOCAB, open = true) {
  const rows = resolveTickets([ticket(overrides)], [], NOW, []);
  const moved: { key: string; status: string; from: string }[] = [];
  const node = renderTicketRow(
    rows[0]!,
    { now: NOW.toISOString(), tickets: { statuses } },
    { ...UI, statusFor: open ? rows[0]!.id : null },
    { ...HANDLERS, toggleStatus: () => {}, moveTicket: (key: string, status: string, from: string) => void moved.push({ key, status, from }) },
  );
  return { node, moved };
}

test('the status is pressable, and offers the project\'s other statuses', () => {
  const { node } = statusRow();
  const menu = byClass(node, 'menu--status')[0];
  assert.ok(menu, 'expected a status menu when ui.statusFor matches');
  assert.deepEqual(
    byTag(menu, 'BUTTON').map((b) => b.textContent),
    ['Done', 'In Review', "Won't Fix"],
    'the current status is not offered as somewhere to move to',
  );
});

test('picking a status asks to move that key, and remembers where it came from', () => {
  const { node, moved } = statusRow();
  const done = byTag(byClass(node, 'menu--status')[0]!, 'BUTTON').find((b) => b.textContent === 'Done');
  (done!.listeners.click as (() => void)[])[0]!();
  // The `from` is what makes the toast's undo a transition back rather than a lie.
  assert.deepEqual(moved, [{ key: 'PROJ-8842', status: 'Done', from: 'Committed' }]);
});

/**
 * One real board ran "In Progress" in one project and "In progress" in another.
 * Offering one project's vocabulary on another's ticket is offering a refusal.
 */
test('only the row\'s own project is offered', () => {
  const { node } = statusRow({ key: 'OTHER-5', id: 'jira:OTHER-5' });
  assert.deepEqual(
    byTag(byClass(node, 'menu--status')[0]!, 'BUTTON').map((b) => b.textContent),
    ['To Do'],
    "PROJ's statuses must not be offered on an OTHER ticket",
  );
});

/**
 * Only what has been observed is offered, and there is deliberately no field for
 * typing a status name. So a project whose workflow has never been seen reaching
 * an end cannot be finished from this tab — a limitation taken on purpose, since
 * a free-text field mostly invites naming statuses that don't exist.
 */
test('a project nothing is known about leaves the status as plain text', () => {
  const { node } = statusRow({ key: 'NOPE-1', id: 'jira:NOPE-1' });
  assert.deepEqual(byClass(node, 'menu--status'), []);
  assert.deepEqual(byTag(byClass(node, 'item__meta--status')[0]!, 'BUTTON'), [], 'nothing to offer, so nothing to press');
  assert.equal(byClass(node, 'item__meta--status')[0]?.textContent, 'Committed');
});

test('a vocabulary of only the current status offers nothing', () => {
  const { node } = statusRow({}, { PROJ: ['Committed'] });
  assert.deepEqual(byTag(byClass(node, 'item__meta--status')[0]!, 'BUTTON'), []);
});

test('no vocabulary at all — an older cache — leaves the status as plain text', () => {
  const { node } = statusRow({}, {});
  assert.deepEqual(byTag(byClass(node, 'item__meta--status')[0]!, 'BUTTON'), []);
});

/** Nothing anywhere on a ticket row may take free text for a status. */
test('there is no way to type a status name', () => {
  const cases: Record<string, string[]>[] = [VOCAB, {}, { PROJ: ['Committed'] }];
  for (const statuses of cases) {
    const { node } = statusRow({}, statuses);
    const menu = byClass(node, 'menu--status')[0];
    if (!menu) continue;
    assert.deepEqual(byTag(menu, 'INPUT'), [], 'the status menu takes no typed input');
  }
});

test('the menu is closed unless this row is the one that opened it', () => {
  const { node } = statusRow({}, VOCAB, false);
  assert.deepEqual(byClass(node, 'menu--status'), []);
  // But the control is still there to open it.
  assert.equal(byTag(byClass(node, 'item__meta--status')[0]!, 'BUTTON').length, 1);
});

/** They looked good as plain pills, and a permanent hint is ink spent every row. */
test('the status control carries no persistent clickable marker', async () => {
  const css = await (await import('node:fs/promises')).readFile(
    new URL('../public/style.css', import.meta.url),
    'utf8',
  );
  const rule = /\.pill--button \{([^}]+)\}/.exec(css);
  assert.ok(rule, 'style.css no longer declares .pill--button where this test looks');
  assert.ok(!/text-decoration/.test(rule[1]!), 'no underline on the resting pill');
  assert.ok(/cursor:\s*pointer/.test(rule[1]!), 'the cursor is what says it does something');
});
