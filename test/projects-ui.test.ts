/**
 * What the Projects view renders: the third view of the Tickets tab, zoomed
 * into an epic or an initiative. The fixtures are invented; see
 * `projectfixtures.ts` for the epic they describe.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { byClass, byTag, handlersWith, mount, uiWith } from './dom.ts';
import { projectStatus } from '../client/projects.ts';
import { renderTicketBoard } from '../client/tickets.ts';
import type { Handlers, UiValues } from '../client/types.ts';
import type { ProjectState, ProjectsState, ReadFailure } from '../src/types.ts';
import { OPS_7, epicRead, epicTickets, hoursAgo, planned, projectsState, stateWith, summary, ticket } from './projectfixtures.ts';

const failure = (message: string): ReadFailure => ({ message, detail: '', since: hoursAgo(1), attempts: 2, retryAt: null, retrying: false });

function opened(read = epicRead(), overrides: Partial<ProjectState> = {}): Record<string, ProjectState> {
  return { [read.root.key]: { key: read.root.key, read, fetching: false, reason: null, ...overrides } };
}

function view(
  projects: ProjectsState | undefined,
  ui: Partial<UiValues> = {},
  handlers: Partial<Handlers> = {},
): HTMLElement {
  const state = stateWith(projects);
  return mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', ...ui }), handlersWith(handlers))));
}

/** The fixture epic, open and read. */
const epic = (handlers: Partial<Handlers> = {}): HTMLElement =>
  view(projectsState({ open: opened() }), { projectKey: 'PAY-200' }, handlers);

const text = (node: Element | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/* ---------- the switch and the picker ---------- */

test('the switch offers Projects beside the other two, counting the epics to zoom into', () => {
  const node = view(projectsState());
  const options = byClass(node, 'mode-switch__option');
  assert.deepEqual(
    options.map((option) => option.textContent),
    ['Out of sync0', 'Working on6', 'Projects2'],
  );
  assert.equal(options[2]!.getAttribute('aria-selected'), 'true');
});

test('a server that reads no projects offers only the two ticket views, and shows Out of sync', () => {
  for (const projects of [undefined, projectsState({ enabled: false })]) {
    const node = view(projects);
    assert.deepEqual(
      byClass(node, 'mode-switch__option').map((option) => option.textContent?.replace(/\d+$/, '')),
      ['Out of sync', 'Working on'],
    );
    assert.deepEqual(byClass(node, 'projects'), []);
  }
});

test('pressing Projects on the switch asks for it', () => {
  const asked: string[] = [];
  const node = view(projectsState(), { ticketMode: 'sync' }, { setTicketMode: (mode) => void asked.push(mode) });
  byClass(node, 'mode-switch__option')[2]!.click();
  assert.deepEqual(asked, ['projects']);
});

test('the picker lists the epics by key and summary, and choosing one opens it', () => {
  const asked: string[] = [];
  const node = view(projectsState(), {}, { openProject: (key) => void asked.push(key) });
  const select = byClass(node, 'project-picker')[0] as HTMLSelectElement;
  assert.ok(select, 'the picker is on the switch line');
  assert.deepEqual(
    [...select.options].map((option) => option.textContent),
    ['Choose an epic…', 'PAY-200 · Ledger rewrite', 'PAY-300 · Refund flow'],
  );
  select.value = 'PAY-300';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(asked, ['PAY-300']);
});

test('a project open that is not one of the epics, as a parent zoomed out to, is still named in the picker', () => {
  const parent = planned([ticket('PAY-201', { parent: 'PAY-200' })], {
    root: summary('PAY-100', { summary: 'Payments platform', issueType: 'Initiative', level: 2 }),
    parent: null,
    epics: [summary('PAY-200', { summary: 'Ledger rewrite' })],
  });
  const node = view(projectsState({ open: opened(parent) }), { projectKey: 'PAY-100' });
  const select = byClass(node, 'project-picker')[0] as HTMLSelectElement;
  assert.equal(select.options[1]?.textContent, 'PAY-100 · Payments platform');
  assert.equal(select.value, 'PAY-100');
});

test('the type key gives way to the picker, since no row here carries a type dot', () => {
  assert.deepEqual(byClass(epic(), 'legend__dot'), []);
});

/* ---------- empty states ---------- */

test('no epics assigned says so', () => {
  const node = view(projectsState({ epics: [] }));
  assert.equal(text(byClass(node, 'empty')[0]), 'No unfinished epics are assigned to you.');
});

test('epics not read yet, and on their way', () => {
  assert.equal(text(byClass(view(projectsState({ epics: [], fetchedAt: null })), 'empty')[0]), 'Nothing read yet.');
  assert.equal(
    text(byClass(view(projectsState({ epics: [], fetchedAt: null, fetching: true })), 'empty')[0]),
    'Asking Jira for your epics…',
  );
});

test('with epics to choose from and none chosen, it asks for one', () => {
  assert.match(text(byClass(view(projectsState()), 'empty')[0]), /^Choose an epic/);
});

test('a failed read of the epics is a critical banner with a retry, not an empty list', () => {
  const retried: string[] = [];
  const node = view(projectsState({ epics: [], fetchedAt: null, reason: failure('could not read your epics from Jira: boom') }), {}, {
    refreshProjects: () => void retried.push('refresh'),
  });
  const notice = byClass(node, 'banner--critical')[0];
  assert.ok(notice, 'the failure is on screen');
  assert.match(text(notice), /could not read your epics from Jira: boom/);
  assert.ok(!text(node).includes('No unfinished epics'), 'a failed read must not look like an empty one');
  byClass(notice!, 'failure__retry')[0]!.click();
  assert.deepEqual(retried, ['refresh']);
});

test('a project being read for the first time says so, with its name when the page knows it', () => {
  const reading = (key: string) => ({ [key]: { key, read: null, fetching: true, reason: null } });
  const node = view(projectsState({ open: reading('PAY-200') }), { projectKey: 'PAY-200' });
  const loading = byClass(node, 'project-loading')[0]!;
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(byClass(loading, 'project-loading__spinner').length, 1);
  assert.equal(text(byClass(loading, 'project-loading__title')[0]), 'Ledger rewrite', 'from the epics the picker lists');
  assert.equal(text(byClass(loading, 'project-loading__line')[0]), 'Reading PAY-200 from Jira…');

  const unknown = view(projectsState({ open: reading('PAY-999') }), { projectKey: 'PAY-999' });
  assert.deepEqual(byClass(unknown, 'project-loading__title'), [], 'no name it does not have');
  assert.equal(text(byClass(unknown, 'project-loading__line')[0]), 'Reading PAY-999 from Jira…');
});

test('a project whose read failed with nothing read before shows the failure and nothing else', () => {
  const asked: string[] = [];
  const node = view(
    projectsState({ open: { 'PAY-200': { key: 'PAY-200', read: null, fetching: false, reason: failure('could not read PAY-200 from Jira: gone') } } }),
    { projectKey: 'PAY-200' },
    { openProject: (key) => void asked.push(key) },
  );
  const notice = byClass(node, 'banner--critical')[0]!;
  assert.match(text(notice), /could not read PAY-200 from Jira: gone/);
  assert.deepEqual(byClass(node, 'project-head'), []);
  asked.length = 0;
  byClass(notice, 'failure__retry')[0]!.click();
  assert.deepEqual(asked, ['PAY-200']);
});

test('a failed read over a good one is a warning, and the last good read stays', () => {
  const node = view(projectsState({ open: opened(epicRead(), { reason: failure('could not read PAY-200 from Jira: slow. Showing the last good read.') }) }), {
    projectKey: 'PAY-200',
  });
  assert.match(text(byClass(node, 'banner--warning')[0]), /Showing the last good read/);
  assert.equal(text(byClass(node, 'project-title')[0]), 'Ledger rewrite');
});

test("a read's warnings are warning banners", () => {
  const read = planned(epicTickets(), { warnings: ['Could not read the links of PAY-204, so the order may miss what it waits for.'] });
  const node = view(projectsState({ open: opened(read) }), { projectKey: 'PAY-200' });
  assert.ok(byClass(node, 'banner--warning').some((banner) => /Could not read the links of PAY-204/.test(text(banner))));
});

/* ---------- opening the remembered project ---------- */

/** Effects run after the paint, which happy-dom stands in for with a timer. */
async function afterPaint(until: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 20 && !until(); i++) await new Promise((done) => setTimeout(done, 10));
}

test('entering the view with a remembered project reads it again, once', async () => {
  const asked: string[] = [];
  epic({ openProject: (key) => void asked.push(key) });
  await afterPaint(() => asked.length > 0);
  await afterPaint();
  assert.deepEqual(asked, ['PAY-200']);
});

test('a remembered project the server no longer has is read, as after a restart', async () => {
  const asked: string[] = [];
  view(projectsState(), { projectKey: 'PAY-300' }, { openProject: (key) => void asked.push(key) });
  await afterPaint(() => asked.length > 0);
  assert.deepEqual(asked, ['PAY-300']);
});

test('with nothing remembered, nothing is read on entering', async () => {
  const asked: string[] = [];
  view(projectsState(), {}, { openProject: (key) => void asked.push(key) });
  await afterPaint();
  assert.deepEqual(asked, []);
});

/* ---------- the header and the progress ---------- */

test('the breadcrumb zooms out to the parent, and the headline is the summary in the serif', () => {
  const asked: string[] = [];
  const node = epic({ openProject: (key) => void asked.push(key) });
  const crumbs = byClass(node, 'project-crumbs')[0]!;
  assert.match(text(crumbs), /^Payments platform \/ PAY-200/);
  asked.length = 0;
  byClass(crumbs, 'project-crumbs__up')[0]!.click();
  assert.deepEqual(asked, ['PAY-100']);
  const title = byClass(node, 'project-title')[0]!;
  assert.equal(title.tagName, 'H2');
  assert.equal((byTag(title, 'a')[0] as HTMLAnchorElement).href, 'https://acme.atlassian.net/browse/PAY-200');
});

test('a project at the top has no way up', () => {
  const read = planned(epicTickets(), { parent: null });
  const node = view(projectsState({ open: opened(read) }), { projectKey: 'PAY-200' });
  assert.deepEqual(byClass(node, 'project-crumbs__up'), []);
  assert.match(text(byClass(node, 'project-crumbs')[0]), /^PAY-200/);
});

test('the strip splits the tickets by stage, furthest along first, each block as wide as its share', () => {
  const progress = byClass(epic(), 'progress')[0]!;
  assert.equal(text(byClass(progress, 'section__title')[0]), 'Tickets');
  assert.equal(text(byClass(progress, 'section__count')[0]), '10');
  const blocks = byClass(progress, 'progress-strip__seg');
  assert.deepEqual(
    blocks.map((block) => [block.dataset.stage, block.style.flexGrow]),
    [
      ['done', '1'],
      ['merged', '1'],
      ['ready', '2'],
      ['review', '3'],
      ['draft', '1'],
      ['not-started', '2'],
    ],
    'a stage with no tickets draws nothing',
  );
  assert.equal(blocks[2]!.title, 'Ready to merge: PAY-201 and PAY-202');
});

test('the key names each block in the same order, with its count, beside a swatch of its colour', () => {
  const key = byClass(epic(), 'stage-key')[0]!;
  assert.deepEqual(
    byClass(key, 'stage-key__entry').map((entry) => text(entry)),
    ['Done 1', 'Merged 1', 'Ready to merge 2', 'In review 3', 'Draft 1', 'Not started 2'],
  );
  assert.deepEqual(
    byClass(key, 'stage-key__swatch').map((swatch) => swatch.dataset.stage),
    ['done', 'merged', 'ready', 'review', 'draft', 'not-started'],
  );
});

test('a project with no tickets says so in place of the strip', () => {
  const node = view(projectsState({ open: opened(planned([])) }), { projectKey: 'PAY-200' });
  const progress = byClass(node, 'progress')[0]!;
  assert.equal(text(byClass(progress, 'empty')[0]), 'No tickets in it yet.');
  assert.deepEqual(byClass(progress, 'progress-strip'), []);
});

/* ---------- do next ---------- */

test('Do next ranks what to do, six at most, each with where to go', () => {
  const node = epic();
  const section = byClass(node, 'project-next')[0]!;
  const rows = byClass(section, 'next-step');
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((row) => byClass(row, 'item__mark')[0]!.dataset.rank),
    ['1', '2', '3', '4', '5', '6'],
  );
  assert.deepEqual(
    rows.map((row) => text(byClass(row, 'next-step__title')[0])),
    [
      'Merge acme/payments-api #412',
      'Then merge acme/payments-api #415 (after PAY-201)',
      'Move PAY-207 to Done',
      'Mark acme/payments-api #420 ready for review',
      'Answer the review on acme/payments-api #430',
      'Nudge reviewers on acme/web #88',
    ],
  );
  const buttons = rows.map((row) => byTag(row, 'a')[0] as HTMLAnchorElement);
  assert.equal(buttons[0]!.textContent, 'Open on GitHub');
  assert.equal(buttons[0]!.href, 'https://github.com/acme/payments-api/pull/412');
  assert.equal(buttons[2]!.textContent, 'Open in Jira');
  assert.equal(buttons[2]!.target, '_blank');
  assert.match(text(byClass(section, 'next-steps__more')[0]), /^And 1 more/);
});

/** A row's buttons, by their words. */
const labels = (node: Element): string[] => byTag(node, 'button').map((button) => text(button));

test("Do next offers the board's own Merge and Ready for review where it says to, beside the link", () => {
  const asked: string[] = [];
  const section = byClass(
    epic({ mergePull: (id) => void asked.push(`merge ${id}`), markReady: (id) => void asked.push(`ready ${id}`) }),
    'project-next',
  )[0]!;
  const rows = byClass(section, 'next-step');
  assert.deepEqual(
    rows.map(labels),
    [['Merge'], [], [], ['Ready for review'], [], []],
    'a merge that waits for another gets its link only, as does everything else',
  );
  byTag(rows[0]!, 'button')[0]!.click();
  byTag(rows[3]!, 'button')[0]!.click();
  // The handlers are the board's: the merge asks before it goes, as it does there.
  assert.deepEqual(asked, ['merge github:pr:acme/payments-api#412', 'ready github:pr:acme/payments-api#420']);
  assert.equal(text(byTag(rows[0]!, 'a')[0]), 'Open on GitHub', 'the link stays beside it');
});

test("a merge goes the way the board's row says: its merge queue's button where the branch has one", () => {
  const state = stateWith(projectsState({ open: opened() }));
  for (const row of state.board.rows) if (row.number === 412) row.offers = ['queue'];
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.deepEqual(labels(byClass(node, 'next-step')[0]!), ['Add to merge queue']);
});

test('nothing is offered that the board does not offer, as on a row read before the facts a write needs', () => {
  const state = stateWith(projectsState({ open: opened() }));
  for (const row of state.board.rows) row.offers = [];
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.deepEqual(byTag(byClass(node, 'project-next')[0]!, 'button'), []);
  assert.deepEqual(byTag(byClass(node, 'merge-order')[0]!, 'button'), []);
});

test('a write on its way disables its buttons, here as on the board', () => {
  const node = view(projectsState({ open: opened() }), { projectKey: 'PAY-200', pending: new Set(['github:pr:acme/payments-api#412']) });
  const merge = byTag(byClass(node, 'next-step')[0]!, 'button')[0] as HTMLButtonElement;
  assert.equal(merge.disabled, true);
});

test('a failed read of the pull request board is shown here too, over the rows it kept', () => {
  let retried = 0;
  const board = { reason: failure('GitHub is having a day'), failures: [failure('could not read acme/payments-api')], fetchedAt: hoursAgo(2) };
  const state = stateWith(projectsState({ open: opened() }), { board });
  const ui = uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' });
  const node = mount(h('div', null, renderTicketBoard(state, ui, handlersWith({ refreshBoard: () => retried++ }))));
  const critical = byClass(node, 'banner--critical')[0]!;
  assert.match(text(critical), /GitHub is having a day/);
  assert.match(text(byClass(node, 'banner--warning')[0]), /could not read acme\/payments-api/);
  (byTag(critical, 'button')[0] as HTMLButtonElement).click();
  assert.equal(retried, 1);
  assert.ok(labels(byClass(node, 'project-next')[0]!).includes('Merge'), 'the rows kept still offer what they did');
});

/* ---------- the merge order ---------- */

const cards = (node: HTMLElement) => byClass(byClass(node, 'merge-order')[0]!, 'merge-order__row');
const card = (node: HTMLElement, key: string) => cards(node).find((row) => row.dataset.key === key)!;

test('every unfinished ticket is a card, in merge order', () => {
  assert.deepEqual(
    cards(epic()).map((row) => row.dataset.key),
    ['PAY-201', 'PAY-202', 'PAY-203', 'PAY-204', 'PAY-205', 'PAY-206', 'PAY-207', 'PAY-209', 'PAY-210'],
  );
});

test("a card names its stage on the right, in the stage's tone", () => {
  const node = epic();
  const stage = (key: string) => byClass(card(node, key), 'project-card__stage')[0]!;
  assert.equal(text(stage('PAY-201')), 'Ready to merge');
  assert.equal(stage('PAY-201').dataset.tone, 'good');
  assert.equal(text(stage('PAY-210')), 'Changes requested');
  assert.equal(stage('PAY-210').dataset.tone, 'critical');
  assert.equal(text(stage('PAY-204')), 'Not started');
  assert.equal(stage('PAY-204').dataset.tone, 'plain');
  assert.equal(text(stage('PAY-207')), 'Merged');
});

test("a card lists the user's pull requests in the board's words, with a stack named", () => {
  const node = epic();
  const lines = (key: string) => byClass(card(node, key), 'project-pull').map(text);
  assert.deepEqual(lines('PAY-201'), ['acme/payments-api #412 Ready to merge Merge']);
  assert.deepEqual(lines('PAY-202'), ['acme/payments-api #415 Ready to merge Stacked on #412']);
  assert.deepEqual(lines('PAY-203'), ['acme/payments-api #420 Draft, checks passed Ready for review']);
  assert.deepEqual(lines('PAY-209'), ['acme/web #88 Waiting on reviewers for 3 days']);
  const link = byTag(card(node, 'PAY-201'), 'a').find((a) => a.textContent === 'acme/payments-api #412') as HTMLAnchorElement;
  assert.equal(link.href, 'https://github.com/acme/payments-api/pull/412');
});

test('a card offers the same write on a pull request as Do next, and only that', () => {
  const node = epic();
  const writes = (key: string) => byClass(card(node, key), 'project-pull').map(labels);
  assert.deepEqual(writes('PAY-201'), [['Merge']]);
  assert.deepEqual(writes('PAY-202'), [[]], 'it waits for PAY-201, so no merge is offered out of order');
  assert.deepEqual(writes('PAY-203'), [['Ready for review']]);
  assert.deepEqual(writes('PAY-210'), [[]]);
});

test("a teammate's card has no pull requests, and names whose it is", () => {
  const theirs = card(epic(), 'PAY-205');
  assert.deepEqual(byClass(theirs, 'project-pull'), []);
  assert.match(text(byClass(theirs, 'project-card__meta')[0]), /Dana Reyes/);
  assert.equal(text(byClass(theirs, 'project-card__stage')[0]), 'In review');
});

test('the meta line carries the Jira status, what it waits for and what it blocks', () => {
  const node = epic();
  const meta = (key: string) => byClass(card(node, key), 'project-card__meta')[0]!;
  assert.equal(text(byClass(meta('PAY-201'), 'project-card__status')[0]), 'In Review');
  assert.equal(byClass(meta('PAY-201'), 'pill__dot').length, 1);
  assert.equal(text(byClass(meta('PAY-201'), 'project-card__blocks')[0]), 'Blocks PAY-202 and PAY-203');
  assert.equal(text(byClass(meta('PAY-204'), 'project-card__waits')[0]), 'Waits for PAY-202 and PAY-203');
  assert.ok(!/Alex Moreau/.test(text(meta('PAY-201'))), "the user's own name is left out");
});

test('a blocker outside the project is named with its status, and linked', () => {
  const waits = byClass(card(epic(), 'PAY-209'), 'project-card__waits')[0]!;
  assert.equal(text(waits), 'Waits for OPS-7 (another epic, In Review)');
  assert.equal((byTag(waits, 'a')[0] as HTMLAnchorElement).href, OPS_7.url);
});

test('a ticket whose links could not be read says so', () => {
  const tickets = epicTickets().map((each) => (each.key === 'PAY-206' ? { ...each, linksRead: false } : each));
  const node = view(projectsState({ open: opened(planned(tickets)) }), { projectKey: 'PAY-200' });
  assert.match(text(card(node, 'PAY-206')), /Its links could not be read/);
  assert.ok(!/Its links could not be read/.test(text(card(node, 'PAY-201'))));
});

test('each card has a node on the rail, in its lane, without breaking where nothing can be measured', () => {
  const node = epic();
  const lanes = Object.fromEntries(cards(node).map((row) => [row.dataset.key, byClass(row, 'merge-order__node')[0]!.dataset.lane]));
  assert.deepEqual(lanes, {
    'PAY-201': '0',
    'PAY-202': '0',
    'PAY-203': '1',
    'PAY-204': '0',
    'PAY-205': '0',
    'PAY-206': '0',
    'PAY-207': '0',
    'PAY-209': '0',
    'PAY-210': '0',
  });
  const body = byClass(node, 'merge-order__body')[0]!;
  assert.equal(body.dataset.rail, 'true');
  assert.match(body.getAttribute('style') ?? '', /--lanes:\s*2\b/);
  // happy-dom lays nothing out, so there is nothing to draw the lines from.
  assert.deepEqual(byTag(body, 'path'), []);
});

test('a loop in the links is a warning naming the way round it', () => {
  const tickets = [
    ticket('PAY-201', { blockedBy: ['PAY-202'] }),
    ticket('PAY-202', { blockedBy: ['PAY-201'] }),
  ];
  const node = view(projectsState({ open: opened(planned(tickets)) }), { projectKey: 'PAY-200' });
  assert.ok(
    byClass(node, 'banner__text').some(
      (banner) => text(banner) === 'These tickets block each other: PAY-201 → PAY-202 → PAY-201. Fix the links in Jira.',
    ),
  );
});

const doneDrawer = (node: HTMLElement) => byClass(node, 'drawer').find((each) => text(byClass(each, 'drawer__title')[0]) === 'Done')!;

test('the done tickets are in a drawer of their own, headed like a section, that says it opens', () => {
  const node = epic();
  const drawer = doneDrawer(node);
  assert.equal(text(byClass(drawer, 'drawer__count')[0]), '1', 'a count as the sections above carry it, not in brackets');
  assert.equal(text(byClass(drawer, 'drawer__verb')[0]), 'Show');
  const opened = view(projectsState({ open: { 'PAY-200': { key: 'PAY-200', read: epicRead(), fetching: false, reason: null } } }), {
    projectKey: 'PAY-200',
    openDrawers: new Set(['projects:done:PAY-200']),
  });
  assert.equal(text(byClass(doneDrawer(opened), 'drawer__verb')[0]), 'Hide');
  assert.deepEqual(
    byClass(drawer, 'project-card').map((each) => text(byClass(each, 'item__ref')[0])),
    ['PAY-208'],
  );
  assert.ok(!cards(node).some((row) => row.dataset.key === 'PAY-208'), 'and not in the merge order');
});

test('an epic with everything done says so instead of an empty list', () => {
  const read = planned([ticket('PAY-201', { statusCategory: 'done', workflowStatus: 'Done' })]);
  const node = view(projectsState({ open: opened(read) }), { projectKey: 'PAY-200' });
  assert.deepEqual(byClass(node, 'merge-order'), []);
  assert.ok(byClass(node, 'empty').some((each) => text(each) === 'Every ticket in PAY-200 is done.'));
});

/* ---------- an initiative ---------- */

function initiative(): ReturnType<typeof planned> {
  const tickets = [
    ticket('PAY-221', { parent: 'PAY-200', statusCategory: 'done', workflowStatus: 'Done' }),
    ticket('PAY-222', { parent: 'PAY-200', statusCategory: 'new', workflowStatus: 'To Do' }),
    ticket('PAY-321', { parent: 'PAY-300', statusCategory: 'new', workflowStatus: 'To Do', blockedBy: ['PAY-222'] }),
    ticket('PAY-421', { parent: 'PAY-400', statusCategory: 'done', workflowStatus: 'Done' }),
  ];
  return planned(tickets, {
    root: summary('PAY-100', { summary: 'Payments platform', issueType: 'Initiative', level: 2 }),
    parent: null,
    epics: [
      summary('PAY-300', { summary: 'Refund flow' }),
      summary('PAY-200', { summary: 'Ledger rewrite' }),
      summary('PAY-400', { summary: 'Old cleanup', statusCategory: 'done', workflowStatus: 'Done' }),
    ],
  });
}

test('an initiative is a card per epic, in the order their work can land', () => {
  const node = view(projectsState({ open: opened(initiative()) }), { projectKey: 'PAY-100' });
  const epics = byClass(byClass(node, 'epic-cards')[0]!, 'epic-card');
  assert.deepEqual(
    epics.map((each) => each.dataset.key),
    ['PAY-200', 'PAY-300'],
  );
  assert.equal(text(byClass(epics[0]!, 'epic-card__count')[0]), '1 of 2 done');
  assert.equal(byClass(epics[0]!, 'progress-strip__seg').length, 2);
  assert.equal(text(byClass(epics[0]!, 'epic-card__next')[0]), 'Next: Start PAY-222');
  assert.match(text(byClass(epics[1]!, 'project-card__meta')[0]), /Waits for PAY-200/);
  assert.deepEqual(byClass(node, 'merge-order'), [], 'the epics stand in for the merge order');
  assert.equal(byClass(node, 'progress-strip__seg').length, 2 + 2 + 1 + 1, 'a block per stage: the whole strip, and a mini one per epic, the done one in its drawer included');
});

test("clicking an epic zooms into it, by its title or anywhere on its card but a link", () => {
  const asked: string[] = [];
  const node = view(projectsState({ open: opened(initiative()) }), { projectKey: 'PAY-100' }, { openProject: (key) => void asked.push(key) });
  asked.length = 0;
  const first = byClass(node, 'epic-card')[0]!;
  byClass(first, 'epic-card__open')[0]!.click();
  assert.deepEqual(asked, ['PAY-200'], 'the title is a button, once');
  byClass(first, 'epic-card__count')[0]!.click();
  assert.deepEqual(asked, ['PAY-200', 'PAY-200']);
  (byTag(byClass(first, 'epic-card__next')[0]!, 'a')[0] as HTMLAnchorElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(asked, ['PAY-200', 'PAY-200'], 'a link goes where it says, and zooms nowhere');
});

test("an initiative's finished epics are in the Done drawer", () => {
  const node = view(projectsState({ open: opened(initiative()) }), { projectKey: 'PAY-100' });
  const drawer = doneDrawer(node);
  assert.equal(text(byClass(drawer, 'drawer__count')[0]), '1');
  assert.deepEqual(
    byClass(drawer, 'epic-card').map((each) => each.dataset.key),
    ['PAY-400'],
  );
});

/* ---------- the header's refresh control ---------- */

test('in Projects the header asks Jira about the project, and its refresh reads everything again', () => {
  const asked: string[] = [];
  const state = stateWith(projectsState({ open: opened() }));
  const node = mount(
    h('span', null, projectStatus(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith({ refreshProjects: () => void asked.push('refresh') }))),
  );
  const button = byClass(node, 'refresh-button')[0]!;
  assert.match(button.title, /2 unfinished epics assigned to you · 10 tickets in PAY-200/);
  assert.match(text(byClass(node, 'refresh-label')[0]), /^Jira · /);
  button.click();
  assert.deepEqual(asked, ['refresh']);
});

test('the refresh control spins while the project is being read', () => {
  const state = stateWith(projectsState({ open: opened(epicRead(), { fetching: true }) }));
  const node = mount(h('span', null, projectStatus(state, uiWith({ projectKey: 'PAY-200' }), handlersWith())));
  assert.equal(byClass(node, 'refresh-button')[0]!.dataset.fetching, 'true');
});
