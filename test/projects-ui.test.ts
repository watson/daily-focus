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
import { Flyout } from '../client/flyout.ts';
import { projectStatus } from '../client/projects.ts';
import { detailRow, panelInProject } from '../client/state.ts';
import { renderTicketBoard } from '../client/tickets.ts';
import type { Handlers, UiValues } from '../client/types.ts';
import type { ProjectState, ProjectsState, ReadFailure } from '../src/types.ts';
import { OPS_7, PULLS, epicRead, epicTickets, hoursAgo, linked, planned, projectsState, stateWith, summary, ticket, ticketRows } from './projectfixtures.ts';

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

test('Projects has no picker: its cards and its breadcrumb are the way about it', () => {
  assert.deepEqual(byClass(view(projectsState()), 'project-picker'), []);
  assert.deepEqual(byClass(epic(), 'project-picker'), []);
});

test('the type key is left off, since no row here carries a type dot', () => {
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

test('with nothing chosen, the epics are cards to click into, and no Initiatives section without any', () => {
  const asked: string[] = [];
  const node = view(projectsState(), {}, { openProject: (key) => void asked.push(key) });
  const sections = byClass(node, 'project-choices');
  assert.deepEqual(sections.map((section) => text(byClass(section, 'section__title')[0])), ['Epics']);
  assert.equal(text(byClass(sections[0]!, 'section__count')[0]), '2');
  const choices = byClass(sections[0]!, 'epic-choice');
  assert.deepEqual(
    choices.map((choice) => text(byClass(choice, 'epic-choice__title')[0])),
    ['Ledger rewrite', 'Refund flow'],
  );
  assert.equal(choices[0]!.tagName, 'BUTTON', 'the whole card is the button');
  choices[1]!.click();
  assert.deepEqual(asked, ['PAY-300']);
});

test('initiatives have a section of their own, first, including one above an epic read this session', () => {
  const assigned = view(projectsState({ epics: [...projectsState().epics, summary('PAY-900', { summary: 'Checkout revamp', issueType: 'Initiative', level: 2 })] }), {});
  const sections = byClass(assigned, 'project-choices');
  assert.deepEqual(sections.map((section) => text(byClass(section, 'section__title')[0])), ['Initiatives', 'Epics']);
  assert.deepEqual(byClass(sections[0]!, 'epic-choice__title').map(text), ['Checkout revamp']);

  // PAY-200's parent is the initiative PAY-100, which Jira's search for your own doesn't name.
  const above = byClass(byClass(view(projectsState({ open: opened() }), {}), 'project-choices')[0]!, 'epic-choice__title').map(text);
  assert.deepEqual(above, ['Payments platform']);
});

test('an epic read this session carries its strip and how much is done on its card', () => {
  const node = view(projectsState({ open: opened() }), {});
  const epics = byClass(node, 'project-choices').find((section) => text(byClass(section, 'section__title')[0]) === 'Epics')!;
  const [read, unread] = byClass(epics, 'epic-choice');
  assert.ok(byClass(read!, 'progress-strip__seg').length > 0);
  assert.match(text(byClass(read!, 'epic-choice__count')[0]), /^1 of 10 done, as of /);
  assert.equal(byClass(unread!, 'progress-strip').length, 0, 'nothing it has not read');
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
  assert.match(text(crumbs), /^Projects \/ Payments platform \/ PAY-200/);
  asked.length = 0;
  byClass(crumbs, 'project-crumbs__up')[1]!.click();
  assert.deepEqual(asked, ['PAY-100']);
  const title = byClass(node, 'project-title')[0]!;
  assert.equal(title.tagName, 'H2');
  assert.equal((byTag(title, 'a')[0] as HTMLAnchorElement).href, 'https://acme.atlassian.net/browse/PAY-200');
});

test('a project at the top has no way up but back to the epics', () => {
  let closed = 0;
  const read = planned(epicTickets(), { parent: null });
  const node = view(projectsState({ open: opened(read) }), { projectKey: 'PAY-200' }, { closeProject: () => void closed++ });
  const ups = byClass(node, 'project-crumbs__up');
  assert.deepEqual(ups.map((up) => text(up)), ['Projects']);
  assert.match(text(byClass(node, 'project-crumbs')[0]), /^Projects \/ PAY-200/);
  ups[0]!.click();
  assert.equal(closed, 1);
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

test("a card lists the user's pull requests: Draft or In review, then the board's words, with a stack named", () => {
  const node = epic();
  const lines = (key: string) => byClass(card(node, key), 'project-pull').map(text);
  assert.deepEqual(lines('PAY-201'), ['acme/payments-api #412 In review Ready to merge Merge']);
  assert.deepEqual(lines('PAY-202'), ['acme/payments-api #415 In review Ready to merge Stacked on #412']);
  assert.deepEqual(lines('PAY-203'), ['acme/payments-api #420 Draft checks passed']);
  assert.deepEqual(lines('PAY-209'), ['acme/web #88 In review Waiting on reviewers for 3 days']);
  const link = byTag(card(node, 'PAY-201'), 'a').find((a) => a.textContent === 'acme/payments-api #412') as HTMLAnchorElement;
  assert.equal(link.href, 'https://github.com/acme/payments-api/pull/412');
});

const toggles = new Set(['Draft', 'In review']);

test('a card offers a merge only where Do next does', () => {
  const node = epic();
  const merges = (key: string) => byClass(card(node, key), 'project-pull').map((line) => labels(line).filter((label) => !toggles.has(label)));
  assert.deepEqual(merges('PAY-201'), [['Merge']]);
  assert.deepEqual(merges('PAY-202'), [[]], 'it waits for PAY-201, so no merge is offered out of order');
  assert.deepEqual(merges('PAY-203'), [[]]);
  assert.deepEqual(merges('PAY-210'), [[]]);
});

test('Draft or In review opens a menu that names the action, and only choosing it changes GitHub', () => {
  const clicked: string[] = [];
  const handlers = {
    toggleStatus: (key: string) => void clicked.push(`menu ${key}`),
    markReady: (id: string) => void clicked.push(`ready ${id}`),
    markDraft: (id: string) => void clicked.push(`draft ${id}`),
  };
  const closed = epic(handlers);
  const toggle = (node: HTMLElement, key: string) => byClass(card(node, key), 'project-pull__flag--toggle')[0]!;
  assert.equal(text(toggle(closed, 'PAY-203')), 'Draft');
  assert.equal(toggle(closed, 'PAY-203').getAttribute('aria-haspopup'), 'menu');
  toggle(closed, 'PAY-203').click();
  assert.deepEqual(clicked, ['menu pull:card:github:pr:acme/payments-api#420'], 'a click only opens the menu');

  const draftMenu = view(projectsState({ open: opened() }), { projectKey: 'PAY-200', statusFor: 'pull:card:github:pr:acme/payments-api#420' }, handlers);
  const menu = byClass(card(draftMenu, 'PAY-203'), 'menu--pull')[0]!;
  assert.match(text(menu), /acme\/payments-api#420 is a draft on GitHub\./);
  byTag(menu, 'button').find((button) => text(button) === 'Mark as ready for review')!.click();

  const reviewMenu = view(projectsState({ open: opened() }), { projectKey: 'PAY-200', statusFor: 'pull:card:github:pr:acme/payments-api#412' }, handlers);
  byTag(byClass(card(reviewMenu, 'PAY-201'), 'menu--pull')[0]!, 'button').find((button) => text(button) === 'Convert to draft')!.click();
  assert.deepEqual(clicked.slice(1), ['ready github:pr:acme/payments-api#420', 'draft github:pr:acme/payments-api#412']);
});

test('where the board offers no toggle, Draft or In review is only text', () => {
  const state = stateWith(projectsState({ open: opened() }));
  for (const row of state.board.rows) row.offers = [];
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.deepEqual(byClass(card(node, 'PAY-203'), 'project-pull__flag--toggle'), []);
  assert.equal(text(byClass(card(node, 'PAY-203'), 'project-pull__flag')[0]), 'Draft');
});

test('a draft Do next does not suggest can still be marked ready from its card', () => {
  const state = stateWith(projectsState({ open: opened() }));
  // Red CI: Do next asks for a fix rather than a review, but marking it ready is still the user's call.
  for (const row of state.board.rows) if (row.number === 420) row.checks = 'failure';
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.ok(!labels(byClass(node, 'project-next')[0]!).includes('Ready for review'), 'not a suggestion now');
  assert.equal(text(byClass(card(node, 'PAY-203'), 'project-pull__flag--toggle')[0]), 'Draft');
});

/* ---------- the panel and the status, as on the ticket board ---------- */

test('clicking a card opens the panel on its ticket, as a row on the ticket board does', () => {
  const selected: string[] = [];
  const node = view(projectsState({ open: opened() }), { projectKey: 'PAY-200', detailFor: 'jira:PAY-202' }, { onSelect: (id) => void selected.push(id) });
  const target = card(node, 'PAY-201').querySelector('.project-card')! as HTMLElement;
  target.click();
  assert.deepEqual(selected, ['jira:PAY-201']);
  (byTag(target, 'a')[0] as HTMLElement).click();
  assert.deepEqual(selected, ['jira:PAY-201'], 'a link on the card goes where it says instead');
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(selected, ['jira:PAY-201', 'jira:PAY-201'], 'and from the keyboard');
  assert.equal(target.tabIndex, 0);
  assert.equal((card(node, 'PAY-202').querySelector('.project-card') as HTMLElement).dataset.detail, 'true', 'the one the panel is open on is marked');
  assert.equal(target.dataset.detail, 'false');
});

test("the user's own tickets get the ticket board's status menu; a teammate's status is only text", () => {
  const moved: string[] = [];
  const toggled: string[] = [];
  const state = stateWith(projectsState({ open: opened() }), { tickets: { statuses: { PAY: ['To Do', 'In Progress', 'In Review', 'Done'] } } });
  const handlers = handlersWith({ toggleStatus: (key) => void toggled.push(key), moveTicket: (key, status, from) => void moved.push(`${key} ${status} ${from}`) });
  const closed = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlers)));
  const pill = byClass(card(closed, 'PAY-201'), 'pill--button')[0]!;
  assert.equal(text(pill), 'In Review');
  pill.click();
  assert.deepEqual(toggled, ['project:jira:PAY-201']);
  assert.deepEqual(byClass(card(closed, 'PAY-205'), 'pill--button'), [], "Dana's ticket: hers to move");
  assert.equal(text(byClass(card(closed, 'PAY-205'), 'pill--status')[0]), 'In Progress');

  const open = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200', statusFor: 'project:jira:PAY-201' }), handlers)));
  const items = byTag(byClass(card(open, 'PAY-201'), 'menu--status')[0]!, 'button');
  assert.deepEqual(items.map((item) => text(item)), ['To Do', 'In Progress', 'Done'], 'everywhere it can go but where it is');
  items[2]!.click();
  assert.deepEqual(moved, ['PAY-201 Done In Review']);
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
  assert.equal(text(byClass(meta('PAY-201'), 'pill--status')[0]), 'In Review');
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
  // Two tickets with no stack between their pull requests, which would settle the order instead.
  const tickets = [
    ticket('PAY-209', { blockedBy: ['PAY-210'] }),
    ticket('PAY-210', { blockedBy: ['PAY-209'] }),
  ];
  const node = view(projectsState({ open: opened(planned(tickets)) }), { projectKey: 'PAY-200' });
  assert.ok(
    byClass(node, 'banner__text').some(
      (banner) => text(banner) === 'These tickets block each other: PAY-209 → PAY-210 → PAY-209. Fix the links in Jira.',
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

test('the panel opens on a ticket only a project shows, with its notes and, on your own, its status menu', () => {
  const tickets = epicTickets().map((each) => (each.key === 'PAY-204' ? { ...each, notes: [{ text: 'after the migration', at: hoursAgo(2) }] } : each));
  // The brief's items too, which a real state always has and the fixture leaves out.
  const state = { ...stateWith(projectsState({ open: opened(planned(tickets)) }), { tickets: { statuses: { PAY: ['To Do', 'In Progress', 'Done'] } } }), items: [] };
  const ui = uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: 'PAY-200', detailFor: 'jira:PAY-204' });
  const row = detailRow(state, ui);
  assert.equal(row?.id, 'jira:PAY-204', 'not on the ticket board, and found anyway');
  const panel = mount(h(Flyout, { row, run: null, state, ui, handlers: handlersWith() }));
  assert.match(text(byClass(panel, 'flyout__title')[0] ?? panel), /PAY-204/);
  assert.match(text(panel), /after the migration/);
  assert.equal(text(byClass(panel, 'pill--button')[0]), 'To Do', 'the status, to move from here too');

  const theirs = detailRow(state, uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: 'PAY-200', detailFor: 'jira:PAY-205' }));
  const theirPanel = mount(h(Flyout, { row: theirs, run: null, state, ui, handlers: handlersWith() }));
  assert.deepEqual(byClass(theirPanel, 'pill--button'), [], "a teammate's ticket: its status as text");
  assert.equal(detailRow(state, uiWith({ view: 'tickets', detailFor: 'jira:PAY-999' })), null, 'nothing for a ticket no project has');
});

test('a project still on its way, or one whose first read failed, has the crumb back to the projects', () => {
  let closed = 0;
  const loading = view(projectsState({ open: { 'PAY-200': { key: 'PAY-200', read: null, fetching: true, reason: null } } }), { projectKey: 'PAY-200' }, { closeProject: () => void closed++ });
  assert.match(text(byClass(loading, 'project-crumbs')[0]), /^Projects \/ PAY-200$/);
  byClass(loading, 'project-crumbs__up')[0]!.click();
  const failed = view(projectsState({ open: opened(epicRead(), { read: null, reason: failure('could not read PAY-200 from Jira: gone') }) }), { projectKey: 'PAY-200' });
  assert.match(text(byClass(failed, 'project-crumbs')[0]), /^Projects \/ PAY-200$/);
  assert.equal(closed, 1);
});

test('with a card open, the panel sits inside the project beside its list, under the headline and the strip', () => {
  const state = stateWith(projectsState({ open: opened() }));
  const ui = uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: 'PAY-200', detailFor: 'jira:PAY-203' });
  const node = mount(h('div', null, renderTicketBoard(state, ui, handlersWith())));
  const body = byClass(node, 'project-body')[0]!;
  assert.equal(body.dataset.panel, 'true');
  assert.ok(body.querySelector('aside.flyout'), 'the panel is in the body');
  assert.equal(body.querySelector('.project-head'), null, 'the headline is above it, at the full width');
  assert.equal(body.querySelector('.progress'), null, 'and so is the strip');
  assert.equal(panelInProject(state, ui), true, 'so the page keeps its single column');
  assert.equal(panelInProject(state, uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: null })), false);

  const closed = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.equal(byClass(closed, 'project-body')[0]!.dataset.panel, 'false');
});

test("the panel lists the ticket's pull requests, each with the same toggle and menu", () => {
  const clicked: string[] = [];
  const state = stateWith(projectsState({ open: opened() }));
  const handlers = handlersWith({ toggleStatus: (key) => void clicked.push(`menu ${key}`), markReady: (id) => void clicked.push(`ready ${id}`) });
  const ui = uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: 'PAY-200', detailFor: 'jira:PAY-203' });
  const panel = mount(h(Flyout, { row: detailRow(state, ui), run: null, state, ui, handlers }));
  const section = byClass(panel, 'flyout__section').find((each) => text(byClass(each, 'flyout__label')[0]) === 'Pull requests')!;
  assert.deepEqual(byClass(section, 'project-pull').map(text), ['acme/payments-api #420 Draft checks passed']);
  byClass(section, 'project-pull__flag--toggle')[0]!.click();
  assert.deepEqual(clicked, ['menu pull:panel:github:pr:acme/payments-api#420'], "its own menu, not the card's");

  const open = uiWith({ view: 'tickets', ticketMode: 'projects', projectKey: 'PAY-200', detailFor: 'jira:PAY-203', statusFor: 'pull:panel:github:pr:acme/payments-api#420' });
  const withMenu = mount(h(Flyout, { row: detailRow(state, open), run: null, state, ui: open, handlers }));
  byTag(byClass(withMenu, 'menu--pull')[0]!, 'button').find((button) => text(button) === 'Mark as ready for review')!.click();
  assert.deepEqual(clicked.slice(1), ['ready github:pr:acme/payments-api#420']);
});

test("a ticket of the user's the ticket board doesn't list still has its pull requests, and their toggle", () => {
  // PAY-203 off both of the ticket board's lists, as one in a status it doesn't count as in progress is;
  // the server hands it its pull requests on the project's ticket instead.
  const tickets = epicTickets().map((each) => (each.key === 'PAY-203' ? { ...each, github: [linked(PULLS.draft)] } : each));
  const state = stateWith(projectsState({ open: opened(planned(tickets)) }), { tickets: { inProgress: ticketRows().filter((row) => row.key !== 'PAY-203') } });
  const node = mount(h('div', null, renderTicketBoard(state, uiWith({ ticketMode: 'projects', projectKey: 'PAY-200' }), handlersWith())));
  assert.deepEqual(byClass(card(node, 'PAY-203'), 'project-pull').map(text), ['acme/payments-api #420 Draft checks passed']);
  assert.ok(byClass(card(node, 'PAY-203'), 'project-pull__flag--toggle').length > 0);
});

test('the stage word at the top right is never a toggle: that is each pull request line', () => {
  const node = epic();
  const stage = (key: string) => byClass(card(node, key), 'project-card__stage')[0]!;
  for (const key of ['PAY-201', 'PAY-203', 'PAY-205', 'PAY-210']) assert.equal(stage(key).tagName, 'SPAN', key);
});

test('a card stacked on another ticket says so, and says when Jira had the order the other way', () => {
  // PAY-202's pull request is stacked on PAY-201's; here Jira says PAY-202 blocks PAY-201 instead.
  const tickets = epicTickets().map((each) =>
    each.key === 'PAY-201' ? { ...each, blockedBy: ['PAY-202'] } : each.key === 'PAY-202' ? { ...each, blockedBy: [], blocks: ['PAY-201', ...each.blocks] } : each,
  );
  const node = view(projectsState({ open: opened(planned(tickets)) }), { projectKey: 'PAY-200' });
  const order = cards(node).map((row) => row.dataset.key);
  assert.ok(order.indexOf('PAY-201') < order.indexOf('PAY-202'), 'the stack wins: PAY-201 lands first');
  assert.equal(text(byClass(card(node, 'PAY-202'), 'project-card__stacked')[0]), 'Stacked on PAY-201');
  assert.match(text(card(node, 'PAY-202')), /Jira says it blocks PAY-201, but its pull request is stacked on PAY-201's, so it is shown after PAY-201/);
  assert.deepEqual(byClass(node, 'banner--warning').filter((banner) => /block each other/.test(text(banner))), [], 'and no loop');
});

test('a loop made of a stack and Jira links is named the way the plan sees it', () => {
  // Stack: PAY-202 after PAY-201. Jira: PAY-203 waits for PAY-202, and PAY-201 waits for PAY-203.
  const tickets = epicTickets().map((each) =>
    each.key === 'PAY-201'
      ? { ...each, blockedBy: ['PAY-203'], blocks: [] }
      : each.key === 'PAY-202'
        ? { ...each, blockedBy: [], blocks: [] }
        : each.key === 'PAY-203'
          ? { ...each, blockedBy: ['PAY-202'], blocks: [] }
          : { ...each, blockedBy: each.blockedBy.filter((key) => !['PAY-201', 'PAY-202', 'PAY-203'].includes(key)) },
  );
  const node = view(projectsState({ open: opened(planned(tickets)) }), { projectKey: 'PAY-200' });
  assert.ok(
    byClass(node, 'banner__text').some((banner) => text(banner) === 'These tickets block each other: PAY-201 → PAY-202 → PAY-203 → PAY-201. Fix the links in Jira.'),
    byClass(node, 'banner__text').map(text).join(' | '),
  );
});
