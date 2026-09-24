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
import { byClass, byTag, buttonLabels, mount, type StubElement } from './dom-stub.ts';
import { resolveInProgress, resolveTickets } from '../src/tickets.ts';
import type { InProgressTicket, Ticket, TicketRow } from '../src/types.ts';

const { renderTicketBoard, renderTicketRow, typeLegend } = (await import('../public/render.js')) as {
  renderTicketBoard: (state: unknown, ui: unknown, handlers: unknown) => void;
  renderTicketRow: (row: TicketRow | InProgressTicket, state: unknown, ui: unknown, handlers: unknown) => StubElement;
  typeLegend: (rows: readonly (TicketRow | InProgressTicket)[]) => StubElement | null;
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
  const base: Ticket = {
    id: 'jira:PROJ-8842',
    key: 'PROJ-8842',
    summary: 'Drop the retry loop from the ingest path',
    workflowStatus: 'Committed',
    statusCategory: 'new',
    issueType: 'Task',
    url: 'https://acme.atlassian.net/browse/PROJ-8842',
    hasAnyPr: true,
    hasOpenPr: false,
    allPrsClosed: true,
    ...overrides,
  };
  // Coherent with the two counts unless a test says otherwise, which is what a
  // confirmed development panel read produces.
  return { ...base, allPrsClosed: overrides.allPrsClosed ?? (base.hasAnyPr && !base.hasOpenPr) };
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


/* ---------- the warnings ---------- */

/**
 * A warning is the one place this board talks about a ticket without rendering a
 * row for it, and the held-out ones are exactly the rows somebody will want to go
 * and look at — so the key has to be clickable. `jira.ts` writes the link as
 * inline Markdown and only `render.js` turns it into an anchor, which is why this
 * is asserted here.
 */
function boardOf(overrides: Record<string, unknown> = {}, ui: object = UI, handlers: object = {}): StubElement {
  const board = {
    enabled: true,
    reason: null,
    fetchedAt: null,
    fetching: false,
    account: null,
    projects: [],
    warnings: [],
    pollMinutes: 15,
    rows: [],
    counts: { settled: 0, started: 0, idle: 0, parked: 0 },
    inProgress: [],
    checked: 0,
    statuses: {},
    ...overrides,
  };
  renderTicketBoard({ ...STATE, tickets: board }, ui, { ...HANDLERS, refreshTickets: () => {}, ...handlers });
  return mount('tickets');
}

function boardWith(warnings: readonly string[]): StubElement {
  return boardOf({ warnings: [...warnings] });
}

test('a key named in a warning is rendered as a link to it', () => {
  const node = boardWith([
    "Jira's search says [PROJ-8842](https://acme.atlassian.net/browse/PROJ-8842) has pull requests, " +
      'but its own development panel does not account for them.',
  ]);
  const banner = byClass(node, 'banner--warning')[0];
  assert.ok(banner, 'the warning is on the board');
  const links = byTag(banner, 'A');
  assert.equal(links.length, 1);
  assert.equal(links[0]!.href, 'https://acme.atlassian.net/browse/PROJ-8842');
  assert.equal(links[0]!.textContent, 'PROJ-8842');
  // The sentence around it survives being linkified.
  assert.match(banner.textContent, /does not account for them\.$/);
});

test('a warning with no link in it is still just words', () => {
  const node = boardWith(['Could not read how work gets finished in PROJ.']);
  const banner = byClass(node, 'banner--warning')[0]!;
  assert.deepEqual(byTag(banner, 'A'), [], 'nothing invents a link for a key with no site behind it');
  assert.match(banner.textContent, /Could not read how work gets finished in PROJ\./);
});


/* ---------- Working on rows ---------- */

function inProgress(overrides: Partial<Ticket> = {}): InProgressTicket {
  const found = resolveInProgress(
    [ticket({ workflowStatus: 'In Review', statusCategory: 'indeterminate', hasAnyPr: true, hasOpenPr: true, ...overrides })],
    [],
    NOW,
  );
  assert.equal(found.length, 1, 'the fixture should be in progress');
  return found[0]!;
}

/**
 * A park silences a complaint until a date, and nothing on this row is
 * complaining — so there is neither Park nor the Unpark it would lead to.
 */
test('a Working on row offers a note and nothing to park', () => {
  assert.deepEqual(buttonLabels(renderTicketRow(inProgress(), STATE, UI, HANDLERS)), ['Note']);
});

/**
 * `Object.assign` onto a dataset writes `undefined` as the word, which would put
 * `data-court="undefined"` on the row — a court the stylesheet and a test could
 * both go looking for.
 */
test('a Working on row claims no court and no park status', () => {
  const node = renderTicketRow(inProgress(), STATE, UI, HANDLERS);
  assert.ok(!('court' in node.dataset), `data-court="${node.dataset.court}"`);
  assert.ok(!('status' in node.dataset), `data-status="${node.dataset.status}"`);
  assert.equal(node.dataset.id, 'jira:PROJ-8842');
});

test('a Working on row can still have its status changed', () => {
  const row = inProgress();
  const node = renderTicketRow(
    row,
    { now: NOW.toISOString(), tickets: { statuses: VOCAB } },
    { ...UI, statusFor: row.id },
    { ...HANDLERS, toggleStatus: () => {}, moveTicket: () => {} },
  );
  assert.deepEqual(
    byTag(byClass(node, 'menu--status')[0]!, 'BUTTON').map((b) => b.textContent),
    ['Committed', 'Done', "Won't Fix"],
  );
});

test('a Working on row shows its notes and its open pull request', () => {
  const [row] = resolveInProgress(
    [ticket({ statusCategory: 'indeterminate', hasOpenPr: true })],
    [{ id: 'jira:PROJ-8842', action: 'note', at: '2026-09-22T08:00:00Z', text: 'waiting on the schema review' }],
    NOW,
  );
  const node = renderTicketRow(row!, STATE, UI, HANDLERS);
  assert.match(node.textContent, /waiting on the schema review/);
  assert.match(node.textContent, /open PR/);
});

/* ---------- the two views ---------- */

/** One ticket flagged and in progress, one only in progress, and one parked. */
function mixedBoard(): { rows: TicketRow[]; inProgress: InProgressTicket[] } {
  const idleTicket = ticket({
    id: 'jira:PROJ-1',
    key: 'PROJ-1',
    statusCategory: 'indeterminate',
    workflowStatus: 'In Progress',
    hasAnyPr: false,
  });
  const reviewTicket = ticket({
    id: 'jira:PROJ-2',
    key: 'PROJ-2',
    statusCategory: 'indeterminate',
    workflowStatus: 'In Review',
    hasOpenPr: true,
    issueType: 'Bug',
  });
  const parkedTicket = ticket({ id: 'jira:PROJ-3', key: 'PROJ-3' });
  const actions = [{ id: 'jira:PROJ-3', action: 'snooze' as const, at: '2026-09-22T08:00:00Z', until: '2026-09-30' }];
  const all = [idleTicket, reviewTicket, parkedTicket];
  return { rows: resolveTickets(all, actions, NOW), inProgress: resolveInProgress(all, actions, NOW) };
}

const modeSwitch = (node: StubElement): StubElement => byClass(node, 'mode-switch')[0]!;
const options = (node: StubElement): StubElement[] => byClass(modeSwitch(node), 'mode-switch__option');
const sectionTitles = (node: StubElement): string[] => byClass(node, 'section__title').map((t) => t.textContent);

test('the switch offers both views, each with its count, and opens on Out of sync', () => {
  const node = boardOf({ ...mixedBoard(), fetchedAt: NOW.toISOString(), checked: 3 });
  assert.equal(modeSwitch(node).attributes.role, 'tablist');
  assert.deepEqual(
    options(node).map((o) => o.textContent),
    ['Out of sync1', 'Working on2'],
    'the parked ticket is not counted as out of sync',
  );
  assert.deepEqual(
    options(node).map((o) => o.attributes['aria-selected']),
    ['true', 'false'],
  );
});

test('pressing a side of the switch asks for that view', () => {
  const asked: string[] = [];
  const node = boardOf(mixedBoard(), UI, { setTicketMode: (mode: string) => void asked.push(mode) });
  for (const option of options(node)) (option.listeners.click as (() => void)[])[0]!();
  assert.deepEqual(asked, ['sync', 'working']);
});

test('Out of sync shows the courts and Parked, and none of the work in progress', () => {
  const node = boardOf(mixedBoard());
  assert.deepEqual(sectionTitles(node), ['In flight with nothing linked']);
  assert.equal(byClass(node, 'drawer').length, 1, 'Parked');
  assert.ok(!node.textContent.includes('PROJ-2'), 'the In Review ticket belongs to the other view');
});

test('Working on shows the tickets in progress grouped by status, and no courts', () => {
  const node = boardOf(mixedBoard(), { ...UI, ticketMode: 'working' });
  assert.deepEqual(sectionTitles(node), ['In Progress', 'In Review']);
  assert.deepEqual(byClass(node, 'drawer'), [], 'Parked belongs to Out of sync');
  assert.deepEqual(byClass(node, 'court-hint'), []);
  assert.deepEqual(
    options(node).map((o) => o.attributes['aria-selected']),
    ['false', 'true'],
  );
});

/** One real board spelled it "In Progress" in one project and "In progress" in another. */
test('Working on groups a status case-insensitively, under the first spelling seen', () => {
  const inProgressRows = [
    inProgress({ id: 'jira:PROJ-1', key: 'PROJ-1', workflowStatus: 'In Progress' }),
    inProgress({ id: 'jira:OTHER-1', key: 'OTHER-1', workflowStatus: 'In progress' }),
  ];
  const node = boardOf({ inProgress: inProgressRows }, { ...UI, ticketMode: 'working' });
  assert.deepEqual(sectionTitles(node), ['In Progress']);
  assert.equal(byClass(node, 'item').length, 2);
});

test('each view has its own legend, from its own rows', () => {
  // Read straight after each render: `boardOf` hands back the one shared mount.
  const entries = (node: StubElement) => byClass(node, 'legend__entry').map((entry) => entry.textContent);
  assert.deepEqual(entries(boardOf(mixedBoard())), [], 'every out-of-sync row is a Task, so there is nothing to key');
  assert.deepEqual(entries(boardOf(mixedBoard(), { ...UI, ticketMode: 'working' })), ['Bug', 'Task']);
});

test('the refresh icon counts what the showing view counts', () => {
  const board = { ...mixedBoard(), fetchedAt: NOW.toISOString(), checked: 3 };
  // The status is the icon's tooltip, rendered into the header slot rather than the tab.
  const line = () => byClass(mount('tickets-refresh'), 'refresh-button')[0]!.title as string;
  boardOf(board);
  assert.match(line(), /1 of 3 unfinished tickets/);
  boardOf(board, { ...UI, ticketMode: 'working' });
  assert.match(line(), /2 of 3 unfinished tickets in progress/);
});

test('the refresh icon spins while reading, and a click mid-read is ignored', () => {
  let asked = 0;
  boardOf({ fetching: true }, UI, { refreshTickets: () => void asked++ });
  const icon = byClass(mount('tickets-refresh'), 'refresh-button')[0]!;
  assert.equal(icon.dataset.fetching, 'true');
  assert.match(icon.title as string, /^refreshing…/);
  (icon.listeners.click as (() => void)[])[0]!();
  assert.equal(asked, 0);

  boardOf({ fetchedAt: NOW.toISOString() }, UI, { refreshTickets: () => void asked++ });
  const idle = byClass(mount('tickets-refresh'), 'refresh-button')[0]!;
  assert.equal(idle.dataset.fetching, 'false');
  (idle.listeners.click as (() => void)[])[0]!();
  assert.equal(asked, 1);
});

test('the header names the source beside the icon, and when it last read', () => {
  const label = () => byClass(mount('tickets-refresh'), 'refresh-label')[0]!.textContent;
  boardOf({ fetchedAt: null });
  assert.equal(label(), 'Jira · not read yet');
  boardOf({ fetchedAt: null, fetching: true });
  assert.equal(label(), 'Jira · reading…');
  boardOf({ fetchedAt: NOW.toISOString(), fetching: true });
  assert.match(label(), /^Jira · \d/, 'the last read stays up while the next one runs');
});

test('the status is not a strip across the tab any more', () => {
  assert.equal(byClass(boardOf(mixedBoard()), 'refresh-button').length, 0);
});

test('an empty Working on says so, and how many tickets were looked at', () => {
  const node = boardOf({ fetchedAt: NOW.toISOString(), checked: 4 }, { ...UI, ticketMode: 'working' });
  assert.match(byClass(node, 'empty')[0]!.textContent, /Nothing in progress\. 4 unfinished tickets checked\./);
});

test('a server older than the page just has nothing in progress', () => {
  const node = boardOf({ inProgress: undefined }, { ...UI, ticketMode: 'working' });
  assert.deepEqual(options(node).map((o) => o.textContent), ['Out of sync0', 'Working on0']);
});

/* ---------- the flag that points back ---------- */

/**
 * The views are exclusive, so a ticket in both is never on screen twice — which
 * would leave an In Progress ticket whose pull requests have all closed reading,
 * in Working on, as work going fine. The flag is what stops that.
 */
test('a Working on row that is also out of sync says which court, and jumps to it', () => {
  const jumped: string[] = [];
  const node = boardOf(mixedBoard(), { ...UI, ticketMode: 'working' }, { jumpToTicket: (id: string) => void jumped.push(id) });
  const flags = byClass(node, 'pill--flag');
  assert.equal(flags.length, 1, 'only the flagged ticket carries one');
  assert.equal(flags[0]!.tagName, 'BUTTON');
  assert.equal(flags[0]!.textContent, 'Out of sync: In flight with nothing linked');
  (flags[0]!.listeners.click as (() => void)[])[0]!();
  assert.deepEqual(jumped, ['jira:PROJ-1']);
});

/** A park asked for exactly that complaint to stay quiet until its date. */
test('a parked court row puts no flag on its Working on row', () => {
  const flagged = ticket({ statusCategory: 'indeterminate', workflowStatus: 'In Progress', hasAnyPr: false });
  const actions = [{ id: 'jira:PROJ-8842', action: 'snooze' as const, at: '2026-09-22T08:00:00Z', until: '2026-09-30' }];
  const node = boardOf(
    { rows: resolveTickets([flagged], actions, NOW), inProgress: resolveInProgress([flagged], actions, NOW) },
    { ...UI, ticketMode: 'working' },
  );
  assert.equal(byClass(node, 'item').length, 1);
  assert.deepEqual(byClass(node, 'pill--flag'), []);
});

/* ---------- drawers remember being open ---------- */

/**
 * State arrives on a heartbeat and every render rebuilds the element, so a drawer
 * has to be told it was open. Without this it snapped shut within the minute, or
 * the moment a row inside it was clicked.
 */
test('an opened drawer stays open when the board is rebuilt', () => {
  const [parked] = resolveTickets(
    [ticket()],
    [{ id: 'jira:PROJ-8842', action: 'snooze', at: '2026-09-22T08:00:00Z', until: '2026-09-30' }],
    NOW,
  );
  const toggled: [string, boolean][] = [];
  const handlers = { toggleDrawer: (key: string, open: boolean) => void toggled.push([key, open]) };
  const closed = byClass(boardOf({ rows: [parked] }, UI, handlers), 'drawer')[0]!;
  assert.ok(!closed.open, 'closed by default');
  (closed.listeners.toggle as ((event: unknown) => void)[])[0]!({ currentTarget: { open: true } });
  assert.deepEqual(toggled, [['tickets:parked', true]]);

  const reopened = byClass(boardOf({ rows: [parked] }, { ...UI, openDrawers: new Set(['tickets:parked']) }), 'drawer')[0]!;
  assert.equal(reopened.open, true);
});
