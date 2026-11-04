/** The pull request board. */

import { h, type ComponentChild, type JSX } from 'preact';

import type { BoardRow, BoardState, CourtReason, DashboardState, PendingCheck } from '../src/types.ts';
import { banner } from './banners.ts';
import { el } from './el.ts';
import { failureNotice } from './failure.ts';
import { formatTime, relativeDay, relativeTime, waitedFor } from './format.ts';
import { cssId, onCard, renderAhead, renderSnoozeMenu, rowPills, sourceColor, type RowProps } from './items.ts';
import { renderMarkdown } from './markdown.ts';
import { refreshControl } from './refresh.ts';
import { drawer } from './section.ts';
import { connecting, connectionView } from './connect.ts';
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

/**
 * The courts whose rows carry a reason worth printing under the title. A
 * reviewers row has one only when a merge gate is what wants the review.
 */
const COURTS_WITH_REASONS = new Set<string>(['you', 'reviewers', 'gate', 'checks']);

export function BoardView({ state, ui, handlers }: { state: DashboardState; ui: UiState; handlers: Handlers }): JSX.Element[] {
  return renderBoard(state, ui, handlers);
}

/**
 * What failed in the board's last read, over the rows it kept from the read
 * before. Also shown in Projects, which offers the same writes from those rows.
 */
export function boardFailures(board: BoardState, now: Date, ui: UiState, handlers: Handlers): JSX.Element[] {
  const parts: JSX.Element[] = [];
  const retry = { icon: '!', lastGood: board.fetchedAt, now, onRetry: () => handlers.refreshBoard() };
  if (board.reason) {
    parts.push(failureNotice(board.reason, { ...retry, fold: 'failure:board', className: 'banner banner--critical' }, ui, handlers));
  }
  // Absent from a server older than the page, as the ticket board's `inProgress` can be.
  (board.failures ?? []).forEach((failure, i) => {
    parts.push(failureNotice(failure, { ...retry, fold: `failure:board:${i}`, className: 'banner banner--warning' }, ui, handlers));
  });
  return parts;
}

export function renderBoard(state: DashboardState, ui: UiState, handlers: Handlers): JSX.Element[] {
  const board = state.board;

  if (!board || !board.enabled) {
    return [el('p', { class: 'empty' }, 'The pull request board is switched off (DAILY_FOCUS_GITHUB=off).')];
  }

  const parts: JSX.Element[] = boardFailures(board, new Date(state.now), ui, handlers);
  for (const warning of board.warnings) parts.push(banner('warning', '!', renderMarkdown(warning)));
  // Under what failed, when connecting is what fixes it: fetching gh, or signing
  // it in, which the gh Daily Focus fetched has no terminal for. Absent from an older server.
  const connection = state.connections?.github;
  if (connection && (board.connect || connecting(connection))) parts.push(connectionView('github', connection, handlers));

  // Every court folds, as Snoozed does, and starts open: it holds what to look at.
  const open = board.rows.filter((row) => row.status === 'open');
  for (const court of COURT_ORDER) {
    const rows = open.filter((row) => row.court === court);
    // A nudged row waits on the same reviewers, but there is nothing to do about
    // it until it asks again. It sits apart until then, folded, and comes back on its own.
    const nudged = court === 'reviewers' ? rows.filter((row) => row.nudgedAt) : [];
    const waiting = rows.filter((row) => !row.nudgedAt);
    if (waiting.length > 0) {
      parts.push(drawer(`board:${court}`, COURT_TITLE[court], waiting, state, ui, handlers, renderPullRow, { open: true }));
    }
    if (nudged.length > 0) parts.push(drawer('board:nudged', 'Nudged', nudged, state, ui, handlers, renderPullRow));
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

  const snoozed = board.rows.filter((row) => row.status === 'snoozed');
  if (snoozed.length > 0) {
    parts.push(drawer('board:snoozed', 'Snoozed', snoozed, state, ui, handlers, renderPullRow));
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
      'data-nudged': String(Boolean(row.nudgedAt)),
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
      renderAhead(row.id, state),
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
  else if (row.checks === 'pending' && !onlyGatesPending(row)) pill('pill', 'checks running');
  if (row.mergeable === 'CONFLICTING') pill('pill pill--overdue', 'conflicts');
  if (row.autoMerge) pill('pill pill--good', 'auto-merge on');
  // In GitHub's merge queue, or in the merge helper's, as its `status` says.
  if (row.inMergeQueue || row.helperQueued) pill('pill pill--good', 'in merge queue');
  if (row.nudge) pill('pill pill--age', 'time to ask');
  if (row.nudgedAt && row.nudgedUntil) {
    pill('pill', `nudged ${relativeTime(row.nudgedAt, now)}, back ${relativeDay(row.nudgedUntil, now)} ${formatTime(row.nudgedUntil)}`);
  }
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
    pill('pill', row.snoozedUntil ? `snoozed until ${relativeDay(row.snoozedUntil, now)}` : 'snoozed');
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
      // What the gate is waiting for, only in its own words. Its rules are the
      // repository's, not ours, and the link is where they are readable.
      return reason.checks?.length ? ['merge policy pending: ', ...checkNames(reason.checks, true)] : ['merge policy pending'];
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
 * Pending check names, linked where GitHub gave somewhere to look. At most three.
 * `described` adds the line GitHub shows beside each, the way it shows it there.
 */
function checkNames(checks: readonly PendingCheck[], described = false): ComponentChild[] {
  const parts: ComponentChild[] = [];
  for (const check of checks.slice(0, 3)) {
    if (parts.length > 0) parts.push(', ');
    parts.push(
      check.detailsUrl
        ? el('a', { href: check.detailsUrl, target: '_blank', rel: 'noopener noreferrer' }, check.name)
        : check.name,
    );
    if (described && check.description) parts.push(` — ${check.description}`);
  }
  if (checks.length > 3) parts.push(` and ${checks.length - 3} more`);
  return parts;
}

/**
 * Whether the merge gates the reasons name are all that is unfinished, in which
 * case "checks running" would only repeat the reason. Pending checks that weren't
 * read, under a summary saying pending, aren't known to be gates.
 */
function onlyGatesPending(row: BoardRow): boolean {
  const pending = row.pendingChecks ?? [];
  const gates = new Set(row.reasons.flatMap((reason) => (reason.kind === 'merge-gate' ? (reason.checks ?? []) : [])).map((check) => check.name));
  return pending.length > 0 && pending.every((check) => gates.has(check.name));
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
    buttons.push(...renderPullWrites(row, ui, handlers));
    // Nudging happens on Slack, where the board can't see it. This is how it's told,
    // and the agent reads it too. A row already nudged has nothing to tell yet.
    if (row.court === 'reviewers' && !row.nudgedAt) {
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
          title: 'Snooze this until a date',
          'aria-haspopup': 'menu',
          'aria-expanded': String(ui.menuFor.value === row.id),
          onClick: () => handlers.toggleMenu(row.id),
        },
        'Snooze',
      ),
    );
  } else {
    buttons.push(el('button', { type: 'button', class: 'button', onClick: () => handlers.unsnooze(row.id) }, 'Unsnooze'));
  }

  return el('div', { class: 'item__actions' }, buttons);
}

/** The merge helper's button when it names none, as the server has it. */
export const HELPER_LABEL = 'Add to merge queue';

/** The merge helper's button on a row, where it merges the row's branch. */
export function helperLabel(row: BoardRow): string {
  return row.mergeHelper?.kind === 'queue' ? row.mergeHelper.label : HELPER_LABEL;
}

/** Which of a row's writes to show: Ready for review, the merge (or the merge helper's), or Merge stack. */
export type PullWrite = 'ready' | 'merge' | 'stack';

/**
 * The buttons that change the pull request on GitHub, where the server offers
 * them: ready for review on a draft, and merge on one that is ready, or the
 * merge helper's button where it merges the branch, and on the top of a stack
 * it can merge whole, Merge stack. Which rows offer what is the server's
 * reading (`pullOffers`, `findStack`), the same one it refuses a click by, so
 * the page never shows a button the server would turn down. While a click is
 * on its way the row is pending and they are disabled.
 *
 * `kinds` narrows them, for the Projects view, which offers a write only where
 * the merge order says it is the next thing to do.
 */
export function renderPullWrites(
  row: BoardRow,
  ui: UiState,
  handlers: Handlers,
  kinds: readonly PullWrite[] = ['ready', 'merge', 'stack'],
): JSX.Element[] {
  // Turning one back into a draft is the Projects card's, on its state, never a button here.
  const offers = (row.offers ?? []).filter((offer) => offer !== 'draft' && kinds.includes(offer === 'helper' || offer === 'queue' ? 'merge' : offer));
  const pending = ui.pending.value.has(row.id);
  const button = (label: string, title: string, onClick: () => void): JSX.Element =>
    el('button', { type: 'button', class: 'button', title, disabled: pending, 'aria-busy': pending ? 'true' : undefined, onClick }, label);
  const buttons: JSX.Element[] = [];
  if (offers.includes('ready')) {
    buttons.push(button('Ready for review', 'Mark this draft ready for review on GitHub', () => handlers.markReady(row.id)));
  }
  if (offers.includes('helper')) {
    buttons.push(button(helperLabel(row), `Hand to your merge helper for ${row.baseRef}, after asking`, () => handlers.mergePull(row.id)));
  } else if (offers.includes('merge')) {
    buttons.push(button('Merge', `Merge into ${row.baseRef} on GitHub, after asking`, () => handlers.mergePull(row.id)));
  } else if (offers.includes('queue')) {
    buttons.push(button('Add to merge queue', `Add to ${row.baseRef}'s merge queue on GitHub, after asking`, () => handlers.mergePull(row.id)));
  }
  if (offers.includes('stack') && row.stack) {
    const below = row.stack.length - 1;
    buttons.push(
      button(
        'Merge stack',
        `Have your merge helper merge the ${below} pull request${below === 1 ? '' : 's'} under this one and then this one, from the bottom, after asking`,
        () => handlers.mergeStack(row.id),
      ),
    );
  }
  return buttons;
}
