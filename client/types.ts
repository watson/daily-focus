/**
 * Types the client shares: the transient view state, and the handlers the
 * renderers call. The payload types are the server's, in `src/types.ts`, and the
 * client renders exactly those.
 */

import type { Signal } from '@preact/signals';
import type { ActionType } from '../src/types.ts';

export type View = 'today' | 'board' | 'tickets';
export type TicketMode = 'sync' | 'working';
export type FocusField = 'note' | 'assistant';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface Toast {
  message: string;
  onUndo: (() => void) | null;
}

/**
 * Transient view state that never round-trips to the server, one signal per
 * fact. A renderer reads the signals it cares about and is rerun when one of
 * them changes; a handler writes them. Nothing else in the client mutates.
 *
 * Passed to the renderers rather than imported by them, so a test can hand a
 * row exactly the state it wants it rendered in.
 */
export interface UiState {
  /** The row the keyboard cursor is on. */
  selectedId: Signal<string | null>;
  /** Rows with an action in flight, shown as pending until the server answers. */
  pending: Signal<ReadonlySet<string>>;
  /** Which row has its snooze or park menu open. */
  menuFor: Signal<string | null>;
  /**
   * Which ticket has its status menu open. Separate from `menuFor`, so the park
   * menu and the status menu can never be open on the same row at once.
   */
  statusFor: Signal<string | null>;
  /**
   * Which row the panel beside the list is open on, or which run of the
   * morning agent under `RUN_PREFIX`. Persisted per tab: a reply worth reading
   * is usually worth reading after the reload that landed meanwhile.
   */
  detailFor: Signal<string | null>;
  /** Text typed into the panel's note field but not saved yet. */
  noteDraft: Signal<string>;
  /**
   * Text typed into the panel's chat field but not sent yet. One field,
   * whichever the panel is open on: the assistant on a row, or a follow-up to a
   * run of the morning agent.
   */
  assistantDraft: Signal<string>;
  /**
   * Which of the panel's fields was asked for when it was opened by hand, so
   * the next render puts the cursor there. The panel clears it once it has.
   */
  focusField: Signal<FocusField | null>;
  /**
   * Which drawers are open, by key. In memory only, so a reload closes them
   * all: a drawer is a place you go and look, not part of the page's resting
   * state.
   */
  openDrawers: Signal<ReadonlySet<string>>;
  /**
   * Which of the ticket tab's two views is showing. In memory only, so a
   * reload opens on the one that asks for action.
   */
  ticketMode: Signal<TicketMode>;
  /**
   * Which self-closed session has been acknowledged, by its end time.
   *
   * In localStorage rather than the store: whether a notice has been read is a
   * fact about this browser, and the store is a contract with the agent — not
   * somewhere to keep the dashboard's own bookkeeping.
   */
  unattendedSeen: Signal<string | null>;
  /** Which failed run's notice has been put away, by run id. Browser-local, for the same reason. */
  agentReportSeen: Signal<string | null>;
  /**
   * Which of a run's messages are unfolded in its panel, by `runId:index`, when
   * the reader has said so; otherwise the latest is. In memory only.
   */
  messageOpen: Signal<ReadonlyMap<string, boolean>>;
  /** Which view the page is on. Persisted: a pinned tab should come back where it was. */
  view: Signal<View>;
  /**
   * Focus mode: the page collapsed to the objective, the top item and the
   * agenda. Persisted, because the point is to still be in it after you come
   * back from the thing that distracted you.
   */
  focusMode: Signal<boolean>;
  /** The colour scheme override, or `system` when there is none. */
  theme: Signal<ThemeMode>;
  /** The toast at the foot of the page, while one is showing. */
  toast: Signal<Toast | null>;
  /** Why the live connection is down, while it is. */
  connectionError: Signal<Error | null>;
  /** The wall clock in milliseconds, ticked every second while a focus session runs. */
  clock: Signal<number>;
}

/** The same facts as plain values, which is how a test says what it wants. */
export type UiValues = { [K in keyof UiState]: UiState[K] extends Signal<infer T> ? T : never };

export interface ActionExtra {
  until?: string;
  text?: string;
}

/** What the renderers can ask the page to do. Wired up in `actions.ts`. */
export interface Handlers {
  onAction(id: string, action: ActionType, extra?: ActionExtra): void;
  /** A click on a card: the cursor goes to it, and the panel opens on it, or closes if it was already open on this one. */
  onSelect(id: string): void;
  toggleMenu(id: string): void;
  toggleStatus(id: string): void;
  moveTicket(key: string, status: string, from: string | null): void;
  /** Open the panel on a row, with the cursor in `field`, or in neither. */
  openDetail(id: string, field?: FocusField | null): void;
  closeDetail(): void;
  /** Open the panel on a run of the morning agent — the newest, when no id is given. */
  openRun(id?: string | null): void;
  saveNote(id: string, text: string): void;
  toggleDrawer(key: string, open: boolean): void;
  setTicketMode(mode: TicketMode): void;
  setView(view: View): void;
  jumpToTicket(id: string): void;
  startSession(id: string): void;
  stopSession(): void;
  dismissUnattended(endedAt: string): void;
  nudge(id: string): void;
  unpark(id: string): void;
  refreshBoard(): void;
  refreshTickets(): void;
  ask(id: string, body: { action?: string; text?: string }): void;
  stopAssistant(id: string): void;
  runAgent(): void;
  stopAgent(): void;
  askAgent(run: string, text: string): void;
  dismissAgentRun(id: string): void;
  /** Null forgets the key: the fold is back at its default. */
  toggleMessage(key: string, open: boolean | null): void;
  toggleTheme(): void;
  setFocusMode(on: boolean): void;
  openHelp(): void;
  hideToast(): void;
}
