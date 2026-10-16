/**
 * The assistant, asked ahead.
 *
 * When a pull request starts waiting on the user because someone reviewed or
 * commented, or because a check failed, the dashboard asks the assistant the
 * question the user would have asked — "is this review right", "why is CI red"
 * — so the answer is on the row by the time they look at it. The turn is an
 * ordinary one in the row's conversation, there to follow up on, marked as
 * asked on its own.
 *
 * What it may ask is narrow on purpose:
 *
 *  - Only the two quick actions that read and say, never one that drafts. A
 *    Gmail draft nobody asked for is a thing in the user's mailbox they did not
 *    make; an answer in the panel is not.
 *  - Only about pull requests in the "waiting on you" court and not parked,
 *    since those are the ones the user has to act on next.
 *  - Each state once. A key says what the answer is about — the newest review or
 *    comment, or the head commit and its failing checks — and a key that has
 *    been asked is never asked again, however it went, unless the dashboard
 *    going away cut it short. A new comment or a new failure is a new key.
 *  - One turn at a time, never on a row the user is asking about, never while
 *    saved settings wait on a restart, and no more than the day's limit.
 *
 * It is off unless `DAILY_FOCUS_ASSISTANT_AUTO` says otherwise: it spends the
 * CLI's usage without anyone pressing anything. It runs off the board, which
 * reads only while a tab is open, so it asks while the dashboard is in use.
 */

import { RESTARTED, SHUT_DOWN, type AskContext, type Assistant } from './assistant.ts';
import type { Config } from './config.ts';
import { localDateKey } from './time.ts';
import type { AssistantAuto, BoardRow } from './types.ts';

/** The quick actions it may ask on its own. Both read and answer; neither creates anything. */
export const AUTO_ACTIONS = ['assess-review', 'explain-ci'] as const;
export type AutoAction = (typeof AUTO_ACTIONS)[number];

/**
 * What a row's state calls for now: one key per question, `<action>@<what it is
 * about>`. Review first, since a person is waiting on that one.
 */
export function autoKeys(row: BoardRow): string[] {
  if (row.court !== 'you' || row.status !== 'open') return [];
  const keys: string[] = [];
  // The newest review or comment that put the ball in the user's court. The
  // reasons carry when; a reason without a time still asks, once.
  const heard = row.reasons
    .filter((reason) => reason.kind === 'changes-requested' || reason.kind === 'activity')
    .map((reason) => reason.at ?? '');
  if (heard.length > 0) keys.push(`assess-review@${heard.sort().at(-1) || row.updatedAt}`);
  if (row.reasons.some((reason) => reason.kind === 'ci-failing')) {
    // The same checks failing on the same commit is the same question, however
    // many times it is rerun. Before the head commit was kept, the last thing
    // the user did stands in for it.
    const commit = row.headSha ?? row.lastActivityByYou ?? row.updatedAt;
    keys.push(`explain-ci@${commit}:${[...row.failingChecks].sort().join(',')}`);
  }
  return keys;
}

/** The quick action a key asks. */
export function actionOf(key: string): AutoAction | null {
  const action = key.slice(0, key.indexOf('@'));
  return (AUTO_ACTIONS as readonly string[]).includes(action) ? (action as AutoAction) : null;
}

/** What `AutoAsk` needs of the assistant. */
export type AutoAssistant = Pick<Assistant, 'enabled' | 'start' | 'view' | 'autoTurns' | 'ask'>;

export interface AutoAskDeps {
  config: Config;
  assistant: AutoAssistant;
  /** The board's rows as the page would show them now. */
  rows: () => Promise<BoardRow[]>;
  /** What the assistant is told about a row, as when the user asks. */
  context: (id: string) => Promise<AskContext>;
  /** False while something must not be started: saved settings waiting on a restart. */
  canStart: () => boolean;
  now?: () => Date;
}

/** How long a poke waits for others before looking: a streaming turn pokes on every step. */
const SETTLE_MS = 1000;

export class AutoAsk {
  private readonly deps: AutoAskDeps;
  private timer: NodeJS.Timeout | null = null;
  /** A look is under way: one at a time, so two can't both start a turn. */
  private looking = false;
  /** Something changed while a look was under way, so look again after it. */
  private again = false;

  constructor(deps: AutoAskDeps) {
    this.deps = deps;
  }

  get enabled(): boolean {
    return this.deps.config.assistant.auto && this.deps.assistant.enabled;
  }

  /** Something changed — the board, or a turn — so look again shortly. Coalesced. */
  poke(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.consider().catch((err: unknown) => {
        console.error(`[daily-focus] could not ask ahead: ${(err as Error).message}`);
      });
    }, SETTLE_MS);
    this.timer.unref();
  }

  /**
   * Start the next question the board calls for, if one may start now. Returns
   * its key, or null when nothing was started. Each finished turn pokes, which
   * is what takes the queue on to the next.
   */
  async consider(): Promise<string | null> {
    if (!this.enabled || !this.deps.canStart()) return null;
    if (this.looking) {
      this.again = true;
      return null;
    }
    this.looking = true;
    try {
      return await this.look();
    } finally {
      this.looking = false;
      if (this.again) {
        this.again = false;
        this.poke();
      }
    }
  }

  private async look(): Promise<string | null> {
    const { assistant } = this.deps;
    // Its log read first, or everything asked before the last restart looks unasked.
    await assistant.start();
    const asked = assistant.autoTurns();
    if (asked.some((turn) => turn.status === 'running')) return null;
    if (this.usedToday(asked) >= this.deps.config.assistant.autoLimit) return null;

    const items = assistant.view().items;
    // Stopped by the user, timed out or failed, it was asked. Cut short by a
    // restart or a shutdown, nobody decided anything, and it is asked again.
    const cutShort = (turn: (typeof asked)[number]): boolean =>
      turn.status === 'aborted' && (turn.error === RESTARTED || turn.error === SHUT_DOWN);
    const done = new Set(asked.filter((turn) => !cutShort(turn)).map((turn) => `${turn.itemId} ${turn.auto}`));
    for (const row of await this.deps.rows()) {
      // The user is asking about this one; theirs goes first, and this waits.
      if (items[row.id]?.running) continue;
      for (const key of autoKeys(row)) {
        const action = actionOf(key);
        if (!action || done.has(`${row.id} ${key}`)) continue;
        try {
          await assistant.ask({ itemId: row.id, action }, await this.deps.context(row.id), { auto: key });
          return key;
        } catch {
          // The user started a turn on the row in the meantime, or the assistant
          // went off. Either way the next poke looks again.
          return null;
        }
      }
    }
    return null;
  }

  /** Asking ahead as the page shows it, for the board's rows as they are now. */
  view(rows: readonly BoardRow[]): AssistantAuto {
    const keyed: Record<string, string[]> = {};
    for (const row of rows) {
      const keys = autoKeys(row);
      if (keys.length > 0) keyed[row.id] = keys;
    }
    return {
      enabled: this.enabled,
      limit: this.deps.config.assistant.autoLimit,
      usedToday: this.usedToday(this.deps.assistant.autoTurns()),
      rows: keyed,
    };
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Turns started on its own today, on the server's calendar, however they went. */
  private usedToday(asked: readonly { startedAt: string }[]): number {
    const today = localDateKey(this.deps.now?.() ?? new Date());
    return asked.filter((turn) => localDateKey(new Date(turn.startedAt)) === today).length;
  }
}
