/** The pull request board. */

import { h, type ComponentChild, type JSX } from 'preact';

import type { BoardRow, BoardState, CourtReason, DashboardState, PendingCheck } from '../src/types.ts';
import { banner } from './banners.ts';
import { el } from './el.ts';
import { formatTime, parseDate, relativeDay, relativeTime } from './format.ts';
import { cssId, onCard, renderSnoozeMenu, rowPills, sourceColor, type RowProps } from './items.ts';
import { renderMarkdown } from './markdown.ts';
import { refreshControl } from './refresh.ts';
import { drawer, section } from './section.ts';
import type { Handlers, UiState } from './types.ts';

const COURT_TITLE = {
  you: 'Waiting on you',
  ready: 'Ready to merge',
  reviewers: 'Waiting on reviewers',
  gate: 'Waiting on merge gate',
  blocked: 'Merge blocked by GitHub',
  checks: 'Waiting on checks',
  draft: 'Drafts',
};

const COURT_ORDER = ['you', 'ready', 'reviewers', 'gate', 'blocked', 'checks', 'draft'] as const;

/** The courts whose rows carry a reason worth printing under the title. */
const COURTS_WITH_REASONS = new Set<string>(['you', 'gate', 'checks']);

export function BoardView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  return renderBoard(state, ui, handlers);
}

export function renderBoard(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const board = state.board;

  if (!board || !board.enabled) {
    return [el('p', { class: 'empty' }, 'The pull request board is switched off (DAILY_FOCUS_GITHUB=off).')];
  }

  const parts: JSX.Element[] = [];
  if (board.reason) parts.push(banner('critical', '!', board.reason));
  for (const warning of board.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));

  const open = board.rows.filter((row) => row.status === 'open');
  for (const court of COURT_ORDER) {
    const rows = open.filter((row) => row.court === court);
    if (rows.length === 0) continue;
    parts.push(section(COURT_TITLE[court], rows, state, ui, handlers, null, renderPullRow));
  }

  if (open.length === 0 && !board.reason) {
    parts.push(
      el(
        'p',
        { class: 'empty' },
        board.fetchedAt === null
          ? board.fetching
            ? 'Asking GitHub…'
            : 'Nothing fetched yet.'
          : board.scope.length > 0
            ? `No open pull requests in ${board.scope.map((q) => q.replace(/^\w+:/, '')).join(', ')}.`
            : 'No open pull requests.',
      ),
    );
  }

  const parked = board.rows.filter((row) => row.status === 'snoozed');
  if (parked.length > 0) {
    parts.push(drawer('board:parked', `Parked (${parked.length})`, parked, state, ui, handlers, renderPullRow));
  }

  return parts;
}

/** "as of 10:42 · polling alice, bob every 5 min", on the refresh control. */
export function boardStatus(board: BoardState, now: Date, handlers: Handlers): JSX.Element[] {
  const polled = board.accounts.filter((account) => account.ok).map((account) => account.login);
  const bits: string[] = [];
  if (board.fetching) bits.push('refreshing…');
  else if (board.fetchedAt) bits.push(`as of ${formatTime(board.fetchedAt)}`);
  if (polled.length > 0) {
    bits.push(`polling ${polled.join(', ')} every ${board.pollMinutes} min`);
  }
  let stale = false;
  if (board.fetchedAt && !board.fetching) {
    const ageMinutes = Math.round((now.getTime() - new Date(board.fetchedAt).getTime()) / 60_000);
    // Older than two polls means the poller has been failing or paused; say so
    // rather than let an "as of" from this morning pass for current. The label
    // and icon turn red too, since the age itself is only on hover.
    stale = ageMinutes > board.pollMinutes * 2;
    if (stale) bits.push(`${relativeTime(board.fetchedAt, now)}`);
  }

  return refreshControl({
    source: 'GitHub',
    fetchedAt: board.fetchedAt,
    status: bits.join(' · ') || 'Not polled yet',
    fetching: board.fetching,
    stale,
    action: 'Ask GitHub now (r)',
    onRefresh: () => handlers.refreshBoard(),
  });
}

/** One board row, keyed by its id so a rebuilt list keeps the element. */
export function renderPullRow(row: BoardRow, state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element {
  return h(PullRow, { key: row.id, item: row, state, ui, handlers });
}

export function PullRow({ item: row, state, ui, handlers }: RowProps<BoardRow>): JSX.Element {
  const now = new Date(state.now);
  const selected = ui.selectedId.value === row.id;

  return el(
    'li',
    {
      class: 'item item--pull',
      // Its own scheme: the same PR can be a brief row too, and two elements
      // with one id is invalid HTML and an ambiguous fragment target.
      id: `pull-${cssId(row.id)}`,
      'data-id': row.id,
      'data-status': row.status,
      'data-court': row.court,
      'data-selected': String(selected),
      'data-pending': String(ui.pending.value.has(row.id)),
      'data-detail': String(ui.detailFor.value === row.id),
      onClick: (event: MouseEvent) => {
        if (onCard(event)) handlers.onSelect(row.id);
      },
    },
    el(
      'span',
      { class: 'item__mark' },
      el('span', { class: 'item__dot', style: `background:${sourceColor('github')}`, 'aria-hidden': 'true' }),
    ),
    el(
      'div',
      { class: 'item__body' },
      el(
        'p',
        { class: 'item__title' },
        el(
          'a',
          { href: row.url, target: '_blank', rel: 'noopener noreferrer' },
          el('span', { class: 'item__ref' }, `${row.repo}#${row.number}`),
          ' ',
          row.title,
        ),
      ),
      renderPullMeta(row, state, now),
      renderPullReasons(row, now),
      renderCancelledChecks(row),
    ),
    renderPullActions(row, ui, handlers),
    ui.menuFor.value === row.id ? renderSnoozeMenu(row, now, handlers, { indefinite: false }) : null,
  );
}

function renderPullMeta(row: BoardRow, state: DashboardState, now: Date): JSX.Element {
  const pills: JSX.Element[] = [];
  const pill = (cls: string, text: string): void => {
    pills.push(el('span', { class: cls }, text));
  };

  // The server's reading of the reviews, so the pill and the bucket can't disagree.
  if (row.isDraft) pill('pill pill--tag', 'draft');
  if (row.decision === 'APPROVED') pill('pill pill--good', 'approved');
  if (row.decision === 'CHANGES_REQUESTED') pill('pill pill--overdue', 'changes requested');
  if (row.checks === 'failure') pill('pill pill--overdue', 'CI failing');
  else if (row.checks === 'pending') pill('pill', 'checks running');
  if (row.mergeable === 'CONFLICTING') pill('pill pill--overdue', 'conflicts');
  if (row.autoMerge) pill('pill pill--good', 'auto-merge on');
  if (row.nudge) pill('pill pill--age', 'time to ask');
  // How long the merge has been refused, which the section header leaves out.
  // A span rather than a point in time: "last touched" is about people, and the
  // thing holding these courts up is not a person.
  if (row.court === 'blocked') {
    pill('pill', `blocked ${waitedFor(row.since, now)}`);
  } else if (row.court === 'gate' || row.court === 'checks') {
    pill('pill', `waiting ${waitedFor(row.since, now)}`);
  }
  if (row.stale) pill('pill pill--age', 'untouched for weeks');
  if (row.status === 'snoozed') {
    pill('pill', row.snoozedUntil ? `parked until ${relativeDay(row.snoozedUntil, now)}` : 'parked');
  }
  pills.push(...rowPills(row, state));

  const touched = row.lastActivityByOthers;
  const you = row.lastActivityByYou;
  let lastTouch: string | undefined;
  if (touched && (!you || touched.at > you)) {
    lastTouch = `@${touched.login} ${touched.kind === 'review' ? 'reviewed' : 'commented'} ${relativeTime(touched.at, now)}`;
  } else if (you) {
    lastTouch = `you, ${relativeTime(you, now)}`;
  }

  const waiting =
    row.court === 'reviewers' && row.requestedReviewers.length > 0
      ? `asked ${row.requestedReviewers.map((r) => `@${r}`).join(', ')}`
      : null;

  return el(
    'div',
    { class: 'item__meta' },
    el('span', { class: 'item__source' }, `opened ${relativeTime(row.createdAt, now)}`),
    lastTouch ? el('span', null, `· last touched by ${lastTouch}`) : null,
    waiting ? el('span', null, `· ${waiting}`) : null,
    pills,
  );
}

/**
 * Why the row sits where it does.
 *
 * A paragraph rather than a joined string, because the check-shaped reasons name
 * checks, and a check GitHub gave a link for should be clickable — that link is
 * the whole of what the board knows about a merge gate's internal policy.
 */
function renderPullReasons(row: BoardRow, now: Date): JSX.Element | null {
  if (!COURTS_WITH_REASONS.has(row.court) || row.reasons.length === 0) return null;
  const parts: ComponentChild[] = [];
  for (const reason of row.reasons) {
    // A kind this client doesn't know describes to nothing, and contributes no
    // separator either — a stray " · " is how a forward-compatible renderer
    // announces that it is out of date.
    const described = describeReason(reason, row, now);
    if (described.length === 0) continue;
    if (parts.length > 0) parts.push(' · ');
    parts.push(...described);
  }
  if (parts.length === 0) return null;
  const tone = row.court === 'you' ? '' : ' item__reason--waiting';
  return el('p', { class: `item__reason${tone}` }, parts);
}

/**
 * Cancelled checks, as a line of plain text under the reasons.
 *
 * Shown in every court, including ready, because it is a fact about the pull
 * request rather than a reason for where it sits — a cancelled run reached no
 * verdict, so it decides nothing, and the server keeps it out of the court
 * entirely. This line is what stops that silence from being invisible: it is the
 * whole compensation for a cancellation no longer reading as red.
 */
function renderCancelledChecks(row: BoardRow): JSX.Element | null {
  const cancelled = row.cancelledChecks ?? [];
  if (cancelled.length === 0) return null;
  return el('p', { class: 'item__reason item__reason--waiting' }, ['cancelled, no verdict: ', ...checkNames(cancelled)]);
}

/**
 * One reason, as an array of text and links. The server sends facts; the times are
 * relative and the wording belongs here.
 */
function describeReason(reason: CourtReason, row: BoardRow, now: Date): ComponentChild[] {
  switch (reason.kind) {
    case 'changes-requested':
      return [`changes requested${reason.login ? ` by @${reason.login}` : ''}${reason.at ? ` ${relativeTime(reason.at, now)}` : ''}`];
    case 'ci-failing': {
      const names = row.failingChecks ?? [];
      if (names.length === 0) return ['CI is failing'];
      const shown = names.slice(0, 3).join(', ');
      return [`CI failing: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`];
    }
    case 'conflicts':
      return ['conflicts with the base branch'];
    case 'behind':
      return ['the branch is behind its base — update it to merge'];
    case 'activity':
      return [`@${reason.login} ${reason.activity === 'review' ? 'reviewed' : 'commented'} ${relativeTime(reason.at, now)}`];
    case 'merge-gate':
      // Deliberately says nothing about what the gate is waiting for. Its rules
      // are the repository's, not ours, and the link is where they are readable.
      return reason.checks?.length ? ['merge policy pending: ', ...checkNames(reason.checks)] : ['merge policy pending'];
    case 'checks-pending':
      return reason.checks?.length ? ['still running: ', ...checkNames(reason.checks)] : ['checks are still running'];
    case 'merge-blocked':
      return ['merge blocked by GitHub'];
    case 'mergeability-unknown':
      return ['GitHub is still determining mergeability'];
    default:
      return [];
  }
}

/**
 * How long a wait has run, as a span. The same thresholds `relativeTime` uses, so
 * "waiting 30 h" and "last touched 30 h ago" on one row can't disagree.
 */
function waitedFor(since: string, now: Date): string {
  const at = parseDate(since);
  const minutes = at ? Math.round((now.getTime() - at.getTime()) / 60_000) : 0;
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Pending check names, linked where GitHub gave somewhere to look. At most three. */
function checkNames(checks: readonly PendingCheck[]): ComponentChild[] {
  const parts: ComponentChild[] = [];
  for (const check of checks.slice(0, 3)) {
    if (parts.length > 0) parts.push(', ');
    parts.push(
      check.detailsUrl
        ? el('a', { href: check.detailsUrl, target: '_blank', rel: 'noopener noreferrer' }, check.name)
        : check.name,
    );
  }
  if (checks.length > 3) parts.push(` and ${checks.length - 3} more`);
  return parts;
}

function renderPullActions(row: BoardRow, ui: UiState, handlers: Handlers): JSX.Element {
  const buttons: JSX.Element[] = [];

  buttons.push(
    el(
      'a',
      { class: 'button', href: row.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open on GitHub' },
      'Open',
    ),
  );

  if (row.status === 'open') {
    // Nudging happens on Slack, where the board can't see it. This is how it's told:
    // a note, so the agent reads it too, and the nudge timer starts over.
    if (row.court === 'reviewers') {
      buttons.push(
        el(
          'button',
          { type: 'button', class: 'button', title: 'Record that you asked for a review', onClick: () => handlers.nudge(row.id) },
          'Nudged',
        ),
      );
    }
    buttons.push(
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          title: 'Park this until a date',
          'aria-expanded': String(ui.menuFor.value === row.id),
          onClick: () => handlers.toggleMenu(row.id),
        },
        'Park',
      ),
    );
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onClick: () => handlers.unpark(row.id) }, 'Unpark'));
  }

  return el('div', { class: 'item__actions' }, buttons);
}
