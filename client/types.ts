/**
 * Types the client shares: the transient view state, and the handlers the
 * renderers call. The payload types are the server's, in `src/types.ts`, and the
 * client renders exactly those.
 */

import type { Signal } from '@preact/signals';
import type { OrganizationReview } from '../src/organization.ts';
import type { SettingsView } from '../src/settings.ts';
import type { ActionType, CalendarProvider, DashboardState, MergeRoute, OnboardingAnswer, Service } from '../src/types.ts';

export type View = 'today' | 'board' | 'tickets' | 'settings';

/** The settings page as the server describes it, with whether saved settings are still waiting on a restart. */
export interface SettingsPage extends SettingsView {
  restart: DashboardState['restart'];
}

/** The two files in the user's words that the settings page edits. */
export type TextName = 'focus' | 'sources';

/** One of those files in its editor. */
export interface TextEditor {
  /** The file as it was loaded, or null when it doesn't exist yet. */
  saved: string | null;
  /** The version the edit started from, which a save has to match. */
  version: string;
  /** What a new file starts as. */
  template: string;
  /** What is in the editor now. */
  draft: string;
  /** The file changed on disk since it was loaded: what is there now, for the editor to offer. */
  conflict: { text: string | null; version: string } | null;
  saving: boolean;
}

/** A calendar Calendar.app has, as the helper reported it. */
export interface CalendarName {
  title: string;
  source: string;
}
/**
 * A setup card as the user has changed it, kept until it is answered. `version`
 * is the card's when the edit began: a proposal landing after it doesn't
 * overwrite the edit, it is offered instead.
 */
export interface SetupDraft {
  version: number;
  answer: Extract<OnboardingAnswer, { choices: unknown }>;
}

/**
 * An organization's setup open for review: asked for, shown, or why it
 * couldn't be, with a request on its way from its buttons.
 */
export interface OrganizationReviewUi {
  org: string;
  review: OrganizationReview | 'loading' | { error: string };
  busy: boolean;
  /** Why the last button press was refused, until the next. */
  error: string | null;
}

/** What the setup finish would write as the source list, once asked; see `previewSources`. */
export type SetupSources = { text: string | null; kept: boolean } | 'loading' | { error: string };

export type TicketMode = 'sync' | 'working' | 'projects';
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
  /**
   * The row a click on its card put the cursor on, opening the panel there.
   * The cursor goes when the panel leaves that row: a mouse never asked for it,
   * and left behind it is a stray border. One the keyboard put there stays.
   */
  clickedId: Signal<string | null>;
  /** Rows with an action in flight, shown as pending until the server answers. */
  pending: Signal<ReadonlySet<string>>;
  /**
   * Which row has its snooze menu open: on its card, or under
   * `PANEL_PREFIX` in the panel. Or `THEME_MENU`, while the header's is open.
   */
  menuFor: Signal<string | null>;
  /**
   * Which ticket has its status menu open, keyed as `menuFor` is. Separate from
   * it, so the snooze menu and the status menu can never be open on the same row
   * at once.
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
   * The drawers opened or closed by hand, by key, true for open. A drawer not
   * here is as its caller has it by default. In memory only, so a reload puts
   * them all back: a drawer is a place you go and look, not part of the page's
   * resting state.
   */
  drawers: Signal<ReadonlyMap<string, boolean>>;
  /**
   * Which of the ticket tab's views is showing. In memory only, so a reload
   * opens on the one that asks for action.
   */
  ticketMode: Signal<TicketMode>;
  /**
   * The epic or initiative the Projects view is zoomed into, by key. In
   * localStorage, as the view is: which project someone is following is a fact
   * about this browser, and the view should open on it again.
   */
  projectKey: Signal<string | null>;
  /**
   * Which failed run's notice has been put away, by run id.
   *
   * In localStorage rather than the store: whether a notice has been read is a
   * fact about this browser, and the store is a contract with the agent — not
   * somewhere to keep the dashboard's own bookkeeping.
   */
  agentReportSeen: Signal<string | null>;
  /**
   * Which of the brief's warnings have been put away, and for which brief. In
   * localStorage, as `agentReportSeen` is, and for its reason. Only the brief
   * named holds them away, so the next brief's warnings show, a repeat included.
   */
  warningsSeen: Signal<WarningsSeen | null>;
  /**
   * Which of a run's messages are unfolded in its panel, by `runId:index`, when
   * the reader has said so; otherwise the latest is. In memory only.
   */
  messageOpen: Signal<ReadonlyMap<string, boolean>>;
  /** Which view the page is on. Persisted: a pinned tab should come back where it was. */
  view: Signal<View>;
  /** The colour scheme override, or `system` when there is none. */
  theme: Signal<ThemeMode>;
  /** The toast at the foot of the page, while one is showing. */
  toast: Signal<Toast | null>;
  /** Why the live connection is down, while it is. */
  connectionError: Signal<Error | null>;
  /**
   * The view Settings returns to: the one it was opened from. Kept so leaving it,
   * by its button, the gear, Escape or Back, lands where the user was, and so the
   * button can say where that is.
   */
  settingsReturn: Signal<View>;
  /** The settings page as the server last described it. Null until the page is first opened. */
  settings: Signal<SettingsPage | null>;
  /**
   * Values changed on the settings page and not saved yet, by setting. Null means
   * back to the default. In memory only: a reload is a way to throw them away.
   */
  settingsDraft: Signal<ReadonlyMap<string, string | null>>;
  /** Why the last save was refused, in the server's words, until the next edit. */
  settingsError: Signal<string | null>;
  /** Whether a save is on its way. */
  settingsSaving: Signal<boolean>;
  /** `focus.md` and `sources.md` in their editors, once loaded. */
  texts: Signal<Partial<Record<TextName, TextEditor>>>;
  /** The calendars Calendar.app has, once asked for; a string is why they couldn't be listed. */
  calendars: Signal<readonly CalendarName[] | string | null>;
  /** Setup cards the user has changed and not answered yet, by step. In memory only. */
  setupDrafts: Signal<ReadonlyMap<string, SetupDraft>>;
  /** The answered setup step reopened with Change, while it is. */
  setupEditing: Signal<string | null>;
  /** The setup step whose Continue was pressed while its CLI was still looking, which asks first. */
  setupConfirm: Signal<string | null>;
  /** The setup step with a request on its way, which its buttons wait for. */
  setupBusy: Signal<string | null>;
  /** Why the server refused the last answer, until the next one. */
  setupError: Signal<{ step: string; message: string } | null>;
  /** Text typed for the CLI looking into a setup step, by step, until it is sent. */
  setupTell: Signal<ReadonlyMap<string, string>>;
  /** What the finish would write as the source list, once looked at. */
  setupSources: Signal<SetupSources | null>;
  /** The organization setup open for review, while one is. In memory only. */
  organizationReview: Signal<OrganizationReviewUi | null>;
}

/** The same facts as plain values, which is how a test says what it wants. */
/** The brief's warnings put away, by their text, and the brief they were put away on, by its `generatedAt`. */
export interface WarningsSeen {
  brief: string;
  warnings: readonly string[];
}

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
  /** Check now whether a ticket's pull requests finish it, which starts the assistant's CLI. */
  checkTicket(key: string): void;
  /** Open the panel on a row, with the cursor in `field`, or in neither. */
  openDetail(id: string, field?: FocusField | null): void;
  closeDetail(): void;
  /** Open the panel on a run of the morning agent — the newest, when no id is given. */
  openRun(id?: string | null): void;
  saveNote(id: string, text: string): void;
  toggleDrawer(key: string, open: boolean): void;
  setTicketMode(mode: TicketMode): void;
  /** Zoom the Projects view into an epic, an initiative or a ticket, and read it. */
  openProject(key: string): void;
  /** Read the epics, every project kept open, and the boards its stages come from, now. */
  refreshProjects(): void;
  /** Zoom all the way out, to the epics to choose from. */
  closeProject(): void;
  setView(view: View): void;
  jumpToTicket(id: string): void;
  nudge(id: string): void;
  unsnooze(id: string): void;
  /** Mark a draft pull request ready for review on GitHub. */
  markReady(id: string): void;
  /** Turn one of the user's open pull requests back into a draft on GitHub. */
  markDraft(id: string): void;
  /**
   * Merge a pull request, add it to its merge queue, or hand it to the merge
   * helper, once the user has said yes: `route` is which button, of those the
   * row offers, and without it the first.
   */
  mergePull(id: string, route?: MergeRoute): void;
  /** Have the merge helper merge the stack a pull request tops, bottom first, once the user has said yes. */
  mergeStack(id: string): void;
  refreshBoard(): void;
  refreshTickets(): void;
  refreshCalendar(): void;
  /** Connect GitHub or Jira, whose progress every tab is then shown; `again` signs in even if it is signed in. */
  connect(service: Service, again?: boolean): void;
  cancelConnect(service: Service): void;
  /** Answer which site, of those the CLI offers while connecting. */
  chooseConnect(service: Service, choice: string): void;
  ask(id: string, body: { action?: string; text?: string }): void;
  stopAssistant(id: string): void;
  /** Put text on the clipboard: a reply, or a block in one meant for pasting. */
  copy(text: string): void;
  runAgent(): void;
  stopAgent(): void;
  askAgent(run: string, text: string): void;
  dismissAgentRun(id: string): void;
  /** Put one of the brief's warnings away until the next brief, `brief` naming this one by its `generatedAt`. */
  dismissWarning(brief: string, text: string): void;
  /** Null forgets the key: the fold is back at its default. */
  toggleMessage(key: string, open: boolean | null): void;
  /** Light, dark or the system's, from the header's menu, which the choice closes. */
  setTheme(mode: ThemeMode): void;
  openHelp(): void;
  hideToast(): void;
  /** Go to the settings page, scrolled to a section when one is named. */
  openSettings(section?: string | null): void;
  /** Leave the settings page for the view it was opened from. */
  closeSettings(): void;
  loadSettings(): void;
  /** Change a field on the settings page without saving it; null means back to the default. */
  editSetting(key: string, value: string | null): void;
  discardSettings(): void;
  /** Save what has been changed on the settings page. */
  saveSettings(): void;
  loadText(name: TextName): void;
  editText(name: TextName, text: string): void;
  /** Save an editor: over the version it was loaded at, or over the newer one when `overwrite` says so. */
  saveText(name: TextName, overwrite?: boolean): void;
  /** Throw away an editor's changes and load the file as it is now. */
  reloadText(name: TextName): void;
  saveObjective(objective: string, blocker: string): void;
  listCalendars(): void;
  /** Go to the provider's sign-in page to connect a calendar account; rejects with why not, staying on this page. */
  connectCalendar(provider: CalendarProvider, returnTo: string, reconnect: string | null): Promise<void>;
  disconnectCalendar(id: string): void;
  /** Answer a setup step, or put it off with `{ later: true }`. */
  answerSetup(step: string, answer: OnboardingAnswer): void;
  /** Change a setup card without answering it; null throws the change away. */
  editSetupDraft(step: string, answer: SetupDraft['answer'] | null, version: number): void;
  /** Reopen an answered setup step, or close it again with null. */
  editSetupStep(step: string | null): void;
  /** Ask whether to continue without what the CLI is still looking for, or stop asking with null. */
  confirmSetup(step: string | null): void;
  /** What has been typed for the CLI looking into a step. */
  editSetupTell(step: string, text: string): void;
  /** Tell the CLI looking into a step what to change. */
  reviseSetup(step: string, text: string, draft: SetupDraft['answer']): void;
  /** Look for the CLIs, when the setup screen opens. */
  detectSetup(): void;
  /** Look again: ask a step's CLI again, or check again what it needs. */
  retrySetup(step: string): void;
  /** Save everything setup has, and start the first brief. */
  finishSetup(): void;
  loadSetupSources(): void;
  /** Open the review of an organization's setup. */
  reviewOrganization(org: string): void;
  closeOrganizationReview(): void;
  /** Use the setup the review shows, at its commit, or apply its newer commit; the dashboard restarts. */
  adoptOrganization(org: string, commit: string): void;
  /** "Not now" for the setup the review shows, at its commit. */
  dismissOrganization(org: string, commit: string): void;
  /** Stop using the organization's setup in use; the dashboard restarts. */
  leaveOrganization(): void;
  /** Look for organization setups again now. */
  checkOrganizations(): void;
}
