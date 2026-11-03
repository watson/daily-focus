/**
 * An organization's Daily Focus setup on the page: the banner that offers one,
 * the review that says everything it would do, and the settings page's card
 * for the one in use.
 *
 * Nothing here applies anything on its own. The banner and the card only open
 * the review; the review's "Use it" is the click that does, and the server
 * restarts the dashboard to apply it (`src/organization.ts`). What a setup
 * suggests as sources is shown as text to copy, never saved.
 */

import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import type { OrganizationOffer, OrganizationReview, OrganizationState, ReviewFile, ReviewSetting } from '../src/organization.ts';
import type { DashboardState } from '../src/types.ts';
import { el } from './el.ts';
import { formatTime, parseDate, relativeDay } from './format.ts';
import type { Handlers, OrganizationReviewUi, UiState } from './types.ts';

/** The setup guide's section on organization setups. */
const GUIDE = 'https://dailyfocus.dev/setup/#organizations';

const short = (commit: string): string => commit.slice(0, 7);

/** What an offer says, in the banner (`banners.ts`), on the settings page and on the setup screen. */
export function offerText(offer: OrganizationOffer): string {
  return offer.kind === 'new' ? `${offer.name} has a Daily Focus setup.` : `${offer.name}'s setup changed.`;
}

export function reviewButton(org: string, handlers: Handlers, extra = ''): JSX.Element {
  return el('button', { type: 'button', class: `button${extra}`, onClick: () => handlers.reviewOrganization(org) }, 'Review');
}

/* ---------- the review ---------- */

/** The review, over the page, while one is open. */
export function OrganizationReviewDialog({ ui, handlers }: { ui: UiState; handlers: Handlers }): JSX.Element | null {
  const open = ui.organizationReview.value;
  const dialog = useRef<HTMLElement | null>(null);
  // The keyboard goes to the review as it opens, so Escape closes it and a
  // screen reader reads its title.
  useEffect(() => {
    if (open) dialog.current?.focus();
  }, [open?.org]);
  if (!open) return null;
  return el(
    'div',
    {
      class: 'org-review__backdrop',
      onClick: (event: MouseEvent) => {
        if (event.target === event.currentTarget) handlers.closeOrganizationReview();
      },
    },
    el(
      'section',
      {
        class: 'org-review',
        ref: dialog,
        tabIndex: -1,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'org-review-title',
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') handlers.closeOrganizationReview();
        },
      },
      reviewBody(open, handlers),
    ),
  );
}

function reviewBody(open: OrganizationReviewUi, handlers: Handlers): (JSX.Element | null)[] {
  const close = el('button', { type: 'button', class: 'button', onClick: () => handlers.closeOrganizationReview() }, 'Close');
  if (open.review === 'loading') {
    return [el('h2', { id: 'org-review-title', class: 'org-review__title' }, `${open.org}'s setup`), el('p', { class: 'empty' }, 'Reading it…'), el('div', { class: 'org-review__actions' }, close)];
  }
  if ('error' in open.review) {
    return [
      el('h2', { id: 'org-review-title', class: 'org-review__title' }, `${open.org}'s setup`),
      el('p', { class: 'settings-card__warning', role: 'alert' }, open.review.error),
      el('div', { class: 'org-review__actions' }, close),
    ];
  }
  const review = open.review;
  const inUse = review.adoptedCommit === review.commit;
  const update = review.kind === 'update' && !inUse;
  return [
    el(
      'h2',
      { id: 'org-review-title', class: 'org-review__title' },
      inUse ? `${review.name}'s setup, in use` : update ? `What changed in ${review.name}'s setup` : `${review.name}'s Daily Focus setup`,
    ),
    el(
      'p',
      { class: 'org-review__lede' },
      'From ',
      el('a', { href: review.url, target: '_blank', rel: 'noopener' }, `${review.repository} at ${short(review.commit)}`),
      review.account ? `, found as @${review.account}` : '',
      '. ',
      inUse
        ? 'This is what it sets now.'
        : update
          ? [
              `Nothing changes until you apply it: until then the setup you use stays at ${short(review.adoptedCommit ?? '')}. `,
              review.compareUrl ? el('a', { href: review.compareUrl, target: '_blank', rel: 'noopener' }, 'Every change on GitHub') : null,
            ]
          : 'Nothing changes until you use it. A value you save on the settings page always wins over the setup’s.',
    ),
    settingsPart(review, update),
    filesPart(review, update),
    skippedPart(review),
    sourcesPart(review, handlers),
    open.error ? el('p', { class: 'settings-card__warning', role: 'alert' }, open.error) : null,
    el(
      'div',
      { class: 'org-review__actions' },
      inUse
        ? null
        : [
            el(
              'button',
              { type: 'button', class: 'button button--primary', disabled: open.busy, onClick: () => handlers.adoptOrganization(review.org, review.commit) },
              open.busy ? 'Working…' : update ? 'Apply' : 'Use it',
            ),
            review.dismissed
              ? null
              : el('button', { type: 'button', class: 'button', disabled: open.busy, onClick: () => handlers.dismissOrganization(review.org, review.commit) }, 'Not now'),
          ],
      close,
    ),
  ];
}

/** What a change to a setting or a file says, for an update. */
function changeNote(change: ReviewSetting['change'], was: string | null): string | null {
  if (change === 'added') return 'new';
  if (change === 'changed') return was === null ? 'changed' : `was ${was}`;
  return null;
}

function settingsPart(review: OrganizationReview, update: boolean): JSX.Element {
  return el(
    'div',
    { class: 'org-review__part' },
    el('h3', null, 'Settings it sets'),
    review.settings.length === 0 && review.removed.length === 0
      ? el('p', { class: 'empty' }, 'None.')
      : el(
          'dl',
          { class: 'org-review__list' },
          review.settings.map((setting) =>
            el(
              'div',
              { key: setting.key, 'data-change': setting.change },
              el('dt', null, setting.label),
              el(
                'dd',
                null,
                el('code', null, setting.value),
                update && changeNote(setting.change, setting.was) ? el('small', { class: 'org-review__change' }, changeNote(setting.change, setting.was)) : null,
              ),
            ),
          ),
          review.removed.map((setting) =>
            el(
              'div',
              { key: setting.key, 'data-change': 'removed' },
              el('dt', null, setting.label),
              el('dd', null, el('small', { class: 'org-review__change' }, `no longer set; was ${setting.was}`)),
            ),
          ),
        ),
  );
}

function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 102.4) / 10} KB`;
}

function fileRow(file: ReviewFile, update: boolean): JSX.Element {
  const note = update && file.change !== 'same' ? (file.change === 'added' ? 'new' : 'changed') : null;
  return el(
    'div',
    { key: file.setting, 'data-change': file.change },
    el('dt', null, file.label),
    el(
      'dd',
      null,
      el('a', { href: file.url, target: '_blank', rel: 'noopener' }, file.path),
      file.size === null ? '' : ` · ${fileSize(file.size)}`,
      note ? el('small', { class: 'org-review__change' }, note) : null,
      el('br', null),
      el('small', { class: 'org-review__hash' }, `SHA-256 ${file.sha256}`),
    ),
  );
}

function filesPart(review: OrganizationReview, update: boolean): JSX.Element | null {
  if (review.files.length === 0 && review.removedFiles.length === 0) return null;
  return el(
    'div',
    { class: 'org-review__part' },
    el('h3', null, 'Programs it runs'),
    el(
      'p',
      { class: 'org-review__help' },
      'Daily Focus keeps a copy of each in its folder and runs it only while it has the SHA-256 shown here. Read it on GitHub before you use it.',
    ),
    el(
      'dl',
      { class: 'org-review__list' },
      review.files.map((file) => fileRow(file, update)),
      review.removedFiles.map((file) =>
        el(
          'div',
          { key: file.setting, 'data-change': 'removed' },
          el('dt', null, file.label),
          el('dd', null, el('small', { class: 'org-review__change' }, `no longer set; was ${file.path}`)),
        ),
      ),
    ),
  );
}

function skippedPart(review: OrganizationReview): JSX.Element | null {
  const lines = [
    ...review.skipped.map((entry) => ({ key: `s:${entry.key}`, name: entry.label ?? entry.key, why: entry.why })),
    ...review.skippedFiles.map((entry) => ({ key: `f:${entry.setting}`, name: `${entry.setting} from ${entry.path}`, why: entry.why })),
    ...(review.sourcesProblem ? [{ key: 'sources', name: 'Suggested sources', why: review.sourcesProblem }] : []),
  ];
  if (lines.length === 0) return null;
  return el(
    'div',
    { class: 'org-review__part' },
    el('h3', null, 'Left out'),
    el(
      'ul',
      { class: 'org-review__skipped' },
      lines.map((line) => el('li', { key: line.key }, el('b', null, line.name), ` ${line.why}.`)),
    ),
  );
}

function sourcesPart(review: OrganizationReview, handlers: Handlers): JSX.Element | null {
  if (!review.sources) return null;
  const text = review.sources.text;
  return el(
    'div',
    { class: 'org-review__part' },
    el('h3', null, 'Sources it suggests'),
    el(
      'p',
      { class: 'org-review__help' },
      'Daily Focus never adds these to your source list. Copy what applies to you into ',
      el('b', null, 'Where the agent looks'),
      ' on the settings page. From ',
      el('a', { href: review.sources.url, target: '_blank', rel: 'noopener' }, review.sources.path),
      '.',
    ),
    el('pre', { class: 'org-review__sources' }, text),
    el('button', { type: 'button', class: 'button', onClick: () => handlers.copy(text) }, 'Copy'),
  );
}

/* ---------- the settings page ---------- */

/** Whether the settings page has anything to say about organization setups: not with GitHub off and none in use. */
export function hasOrganizationCard(state: DashboardState): boolean {
  const organization = state.organization;
  return Boolean(organization && (organization.enabled || organization.adopted || organization.offers.length > 0));
}

/** The settings page's card: the setup in use, those on offer, and what couldn't be read. */
export function organizationCard(state: DashboardState, handlers: Handlers): JSX.Element | null {
  const organization: OrganizationState | undefined = state.organization;
  if (!organization || !hasOrganizationCard(state)) return null;
  const adopted = organization.adopted;
  const now = new Date(state.now);
  const since = adopted ? parseDate(adopted.adoptedAt) : null;
  return el(
    'section',
    { class: 'settings-card', id: 'settings-organization', 'aria-labelledby': 'settings-organization-title' },
    el('h3', { class: 'settings-card__title', id: 'settings-organization-title' }, 'Your organization'),
    el(
      'p',
      { class: 'settings-card__help' },
      'An organization can publish a Daily Focus setup in a private repository named ',
      el('code', null, '.daily-focus'),
      '. Daily Focus finds it through your GitHub sign-in, and uses it only when you say so. ',
      el('a', { href: GUIDE, target: '_blank', rel: 'noopener' }, 'How it works'),
      '.',
    ),
    adopted
      ? el(
          'div',
          { class: 'org-card__adopted' },
          el(
            'p',
            { class: 'field__note' },
            `Using ${adopted.name}'s setup, from ${adopted.repository} at ${short(adopted.commit)}`,
            since ? `, since ${relativeDay(adopted.adoptedAt, now)} ${formatTime(adopted.adoptedAt)}` : '',
            `. A setting it sets says “From ${adopted.name}'s setup”. A value you save wins over it, and clearing yours goes back to it.`,
          ),
          el(
            'div',
            { class: 'org-card__actions' },
            el('button', { type: 'button', class: 'button', onClick: () => handlers.reviewOrganization(adopted.org) }, 'See what it sets'),
            el('button', { type: 'button', class: 'button', onClick: () => handlers.leaveOrganization() }, `Stop using ${adopted.name}'s setup`),
          ),
        )
      : null,
    organization.offers.map((offer) =>
      el(
        'div',
        { class: 'org-card__offer', key: `${offer.org}@${offer.commit}` },
        el('p', { class: 'field__note' }, offerText(offer), offer.dismissed ? ' You put it off.' : ''),
        reviewButton(offer.org, handlers),
      ),
    ),
    !organization.enabled
      ? el('p', { class: 'field__note' }, 'GitHub is off, so Daily Focus doesn’t look for changes to it.')
      : !adopted && organization.offers.length === 0
        ? el(
            'p',
            { class: 'field__note' },
            organization.checking || organization.checkedAt === null
              ? 'Looking through your GitHub organizations…'
              : organization.warnings.length > 0
                ? 'Daily Focus couldn’t look through all of your GitHub organizations, so one of them may still have a setup.'
                : 'None of your GitHub organizations has a Daily Focus setup that Daily Focus can use.',
          )
        : null,
    organization.warnings.map((warning) => el('p', { class: 'settings-card__warning', key: warning }, warning)),
    organization.enabled
      ? el(
          'div',
          { class: 'org-card__actions' },
          el(
            'button',
            { type: 'button', class: 'button', disabled: organization.checking, onClick: () => handlers.checkOrganizations() },
            organization.checking ? 'Looking…' : 'Look again',
          ),
        )
      : null,
  );
}

/* ---------- the setup screen ---------- */

/** The setup screen's line about a setup on offer, whose review carries the sources it suggests to copy. */
export function organizationNotice(state: DashboardState, handlers: Handlers): JSX.Element | null {
  const offers = (state.organization?.offers ?? []).filter((offer) => !offer.dismissed);
  if (offers.length === 0) return null;
  return el(
    'div',
    { class: 'onboarding__org' },
    offers.map((offer) =>
      el(
        'p',
        { key: offer.org },
        offerText(offer),
        ' It can set some of these answers for you, and suggests sources you can copy into your list. ',
        reviewButton(offer.org, handlers),
      ),
    ),
  );
}
