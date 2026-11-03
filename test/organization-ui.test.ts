/**
 * An organization's setup on the page: the banner that offers it, the review
 * that lists everything it would do, the settings page's card and fields, and
 * the setup screen's line. Rendered into happy-dom; the organization is
 * invented.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { h } from 'preact';

// Imported ahead of the client, for the document it installs.
import { buttonLabels, byClass, byTag, handlersWith, mount, settle, uiWith } from './dom.ts';
import { renderBanners } from '../client/banners.ts';
import { OrganizationReviewDialog, organizationCard, organizationNotice } from '../client/organization.ts';
import { SettingsView } from '../client/settings.ts';
import type { SettingsPage } from '../client/types.ts';
import type { OrganizationReview, OrganizationState } from '../src/organization.ts';
import type { DashboardState } from '../src/types.ts';

const C1 = '1111111111111111111111111111111111111111';
const C2 = '2222222222222222222222222222222222222222';

function stateWith(organization: Partial<OrganizationState>): DashboardState {
  return {
    now: '2026-11-03T09:00:00Z',
    brief: { generatedAt: '2026-11-03T06:30:00Z', ageHours: 2, refreshPending: false, stale: false },
    schedule: { runsToday: true },
    problem: null,
    warnings: [],
    focus: null,
    setup: { sources: { exists: true, placeholders: 0 }, calendar: { supported: false, built: false, chosen: 0 } },
    board: { accounts: [] },
    tickets: { account: null, reason: null },
    organization: { enabled: true, checking: false, checkedAt: '2026-11-03T07:00:00Z', adopted: null, offers: [], warnings: [], ...organization },
  } as unknown as DashboardState;
}

const NEW_OFFER = { org: 'acme', name: 'Acme', commit: C1, kind: 'new' as const, dismissed: false };

function review(overrides: Partial<OrganizationReview> = {}): OrganizationReview {
  return {
    org: 'acme',
    name: 'Acme',
    kind: 'new',
    repository: 'acme/.daily-focus',
    account: 'alice',
    branch: 'main',
    commit: C1,
    url: `https://github.com/acme/.daily-focus/tree/${C1}`,
    compareUrl: null,
    adoptedCommit: null,
    dismissed: false,
    settings: [{ key: 'DAILY_FOCUS_GITHUB_SCOPE', label: 'Only these organisations or repositories', value: 'org:acme', change: 'added', was: null }],
    removed: [],
    skipped: [{ key: 'DAILY_FOCUS_GH', label: 'Path to gh', value: '/opt/acme/gh', why: 'names a program to run, which a setup never sets' }],
    files: [
      {
        setting: 'DAILY_FOCUS_MERGE_HELPER',
        label: 'Merge helper',
        path: 'bin/merge-helper',
        url: `https://github.com/acme/.daily-focus/blob/${C1}/bin/merge-helper`,
        sha256: 'ab'.repeat(32),
        size: 512,
        change: 'added',
        was: null,
      },
    ],
    removedFiles: [],
    skippedFiles: [],
    sources: { path: 'sources.md', url: `https://github.com/acme/.daily-focus/blob/${C1}/sources.md`, text: '- The #payments-oncall channel\n' },
    sourcesProblem: null,
    ...overrides,
  };
}

test('a setup on offer is a banner whose Review opens the review, and one put off is not', () => {
  const opened: string[] = [];
  const handlers = handlersWith({ reviewOrganization: (org) => opened.push(org) });
  const container = mount(h('div', null, renderBanners(stateWith({ offers: [NEW_OFFER] }), uiWith(), handlers)));
  assert.match(container.textContent!, /Acme has a Daily Focus setup\./);
  const button = byTag(container, 'button').find((node) => node.textContent === 'Review')!;
  button.click();
  assert.deepEqual(opened, ['acme']);

  const changed = mount(h('div', null, renderBanners(stateWith({ offers: [{ ...NEW_OFFER, commit: C2, kind: 'update' }] }), uiWith(), handlers)));
  assert.match(changed.textContent!, /Acme's setup changed\./);

  const putOff = mount(h('div', null, renderBanners(stateWith({ offers: [{ ...NEW_OFFER, dismissed: true }] }), uiWith(), handlers)));
  assert.doesNotMatch(putOff.textContent!, /Acme/);
});

test('the review lists every setting, file, what was left out and why, and the sources to copy', async () => {
  const calls: string[] = [];
  const handlers = handlersWith({
    adoptOrganization: (org, commit) => calls.push(`adopt ${org} ${commit}`),
    dismissOrganization: (org, commit) => calls.push(`dismiss ${org} ${commit}`),
    copy: (text) => calls.push(`copy ${text}`),
    closeOrganizationReview: () => calls.push('close'),
  });
  const ui = uiWith({ organizationReview: { org: 'acme', review: review(), busy: false, error: null } });
  const container = mount(h(OrganizationReviewDialog, { ui, handlers }));
  const dialog = container.querySelector('[role="dialog"]')!;
  assert.ok(dialog, 'a dialog');
  assert.match(dialog.textContent!, /Acme's Daily Focus setup/);
  assert.match(dialog.textContent!, /Only these organisations or repositories\s*org:acme/);
  assert.match(dialog.textContent!, /Path to gh names a program to run, which a setup never sets\./);
  const links = byTag(container, 'a').map((node) => (node as HTMLAnchorElement).href);
  assert.ok(links.includes(`https://github.com/acme/.daily-focus/blob/${C1}/bin/merge-helper`), 'the file on GitHub, at the commit');
  assert.match(dialog.textContent!, new RegExp(`SHA-256 ${'ab'.repeat(32)}`));
  assert.equal(byClass(container, 'org-review__sources')[0]!.textContent, '- The #payments-oncall channel\n');
  assert.match(dialog.textContent!, /never adds these to your source list/);

  assert.deepEqual(buttonLabels(container), ['Copy', 'Use it', 'Not now', 'Close']);
  for (const label of ['Copy', 'Use it', 'Not now', 'Close']) byTag(container, 'button').find((node) => node.textContent === label)!.click();
  assert.deepEqual(calls, ['copy - The #payments-oncall channel\n', `adopt acme ${C1}`, `dismiss acme ${C1}`, 'close']);

  ui.organizationReview.value = { org: 'acme', review: review(), busy: false, error: 'Acme’s setup can’t be used with your own settings' };
  await settle();
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /can’t be used with your own settings/);
});

test('an update says what changed, links the comparison, and offers Apply', () => {
  const update = review({
    kind: 'update',
    commit: C2,
    adoptedCommit: C1,
    compareUrl: `https://github.com/acme/.daily-focus/compare/${C1}...${C2}`,
    settings: [{ key: 'DAILY_FOCUS_GITHUB_SCOPE', label: 'Only these organisations or repositories', value: 'org:acme, org:acme-labs', change: 'changed', was: 'org:acme' }],
    removed: [{ key: 'DAILY_FOCUS_JIRA_HOLD_STATUSES', label: 'Statuses that mean on hold', was: 'Blocked' }],
    skipped: [],
    sources: null,
  });
  const container = mount(h(OrganizationReviewDialog, { ui: uiWith({ organizationReview: { org: 'acme', review: update, busy: false, error: null } }), handlers: handlersWith() }));
  assert.match(container.textContent!, /What changed in Acme's setup/);
  assert.match(container.textContent!, /Nothing changes until you apply it: until then the setup you use stays at 1111111/);
  assert.match(container.textContent!, /was org:acme/);
  assert.match(container.textContent!, /no longer set; was Blocked/);
  assert.ok(byTag(container, 'a').some((node) => (node as HTMLAnchorElement).href === `https://github.com/acme/.daily-focus/compare/${C1}...${C2}`));
  assert.deepEqual(buttonLabels(container), ['Apply', 'Not now', 'Close']);
});

test('the setup in use, reviewed, has nothing to use', () => {
  const inUse = review({ kind: 'update', adoptedCommit: C1, settings: [] });
  const container = mount(h(OrganizationReviewDialog, { ui: uiWith({ organizationReview: { org: 'acme', review: inUse, busy: false, error: null } }), handlers: handlersWith() }));
  assert.match(container.textContent!, /Acme's setup, in use/);
  assert.deepEqual(buttonLabels(container).filter((label) => label !== 'Copy'), ['Close']);
});

test('the settings page’s card offers stopping the setup in use, and says what couldn’t be read', () => {
  const calls: string[] = [];
  const handlers = handlersWith({ leaveOrganization: () => calls.push('leave'), checkOrganizations: () => calls.push('check') });
  const state = stateWith({
    adopted: { org: 'acme', name: 'Acme', repository: 'acme/.daily-focus', commit: C1, adoptedAt: '2026-11-02T09:00:00Z' },
    warnings: ["Couldn't look for globex's Daily Focus setup as alice: GitHub answered 502"],
  });
  const card = mount(organizationCard(state, handlers));
  assert.match(card.textContent!, /Using Acme's setup, from acme\/\.daily-focus at 1111111/);
  assert.match(card.textContent!, /GitHub answered 502/);
  byTag(card, 'button').find((node) => node.textContent === "Stop using Acme's setup")!.click();
  byTag(card, 'button').find((node) => node.textContent === 'Look again')!.click();
  assert.deepEqual(calls, ['leave', 'check']);

  // A look that failed is not one that found none.
  const failed = mount(organizationCard(stateWith({ warnings: ["Couldn't list the organizations alice is in: GitHub answered 502"] }), handlers));
  assert.match(failed.textContent!, /couldn’t look through all of your GitHub organizations/);
  assert.doesNotMatch(failed.textContent!, /None of your GitHub organizations/);
  const none = mount(organizationCard(stateWith({}), handlers));
  assert.match(none.textContent!, /None of your GitHub organizations has a Daily Focus setup/);

  assert.equal(organizationCard(stateWith({ enabled: false }), handlers), null, 'nothing to say with GitHub off and none in use');
  const off = mount(organizationCard(stateWith({ enabled: false, adopted: state.organization!.adopted }), handlers));
  assert.match(off.textContent!, /GitHub is off, so Daily Focus doesn’t look for changes to it/);
  assert.ok(!buttonLabels(off).includes('Look again'));
});

test('a setting the setup sets says so, shows its value when empty, and says what clearing an override goes back to', () => {
  const page: SettingsPage = {
    groups: [{ id: 'github', title: 'Pull requests' }],
    settings: [
      {
        key: 'DAILY_FOCUS_GITHUB_SCOPE',
        group: 'github',
        label: 'Only these organisations or repositories',
        help: 'Comma-separated.',
        kind: 'list',
        choices: null,
        advanced: false,
        value: 'org:acme',
        source: 'organization',
        fallback: 'Everything',
        organization: 'org:acme',
      },
      {
        key: 'DAILY_FOCUS_GITHUB_ACCOUNTS',
        group: 'github',
        label: 'Accounts',
        help: 'Logins.',
        kind: 'list',
        choices: null,
        advanced: false,
        value: 'bob',
        source: 'settings',
        fallback: "gh's active account",
        organization: 'alice',
      },
      {
        key: 'DAILY_FOCUS_GITHUB',
        group: 'github',
        label: 'Use GitHub',
        help: 'On or off.',
        kind: 'flag',
        choices: null,
        advanced: false,
        value: 'off',
        source: 'organization',
        fallback: 'On',
        organization: 'off',
      },
    ],
    error: null,
    organization: { name: 'Acme' },
    restart: null,
  };
  const container = mount(h(SettingsView, { state: stateWith({}), ui: uiWith({ settings: page, texts: {} }), handlers: handlersWith() }));
  const scope = container.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_GITHUB_SCOPE')!;
  assert.equal(scope.value, '', 'empty, as a default is');
  assert.equal(scope.placeholder, 'org:acme');
  const sources = byClass(container, 'field__source').map((node) => node.textContent);
  assert.deepEqual(sources, ["From Acme's setup.", "Acme's setup sets alice. Clear yours to use it.", "From Acme's setup."]);
  assert.equal(container.querySelector<HTMLInputElement>('#setting-DAILY_FOCUS_GITHUB_ACCOUNTS')!.value, 'bob');
  const off = byTag(container, 'button').find((node) => node.getAttribute('role') === 'radio' && node.getAttribute('aria-checked') === 'true')!;
  assert.match(off.textContent!, /^OffAcme's$/, 'the setup’s choice stands in for the default');
});

test('the setup screen says a setup is on offer, and its Review opens the review', () => {
  const opened: string[] = [];
  const notice = mount(organizationNotice(stateWith({ offers: [NEW_OFFER] }), handlersWith({ reviewOrganization: (org) => opened.push(org) })));
  assert.match(notice.textContent!, /Acme has a Daily Focus setup\..*suggests sources you can copy/);
  byTag(notice, 'button')[0]!.click();
  assert.deepEqual(opened, ['acme']);
  assert.equal(organizationNotice(stateWith({ offers: [{ ...NEW_OFFER, dismissed: true }] }), handlersWith()), null);
});
