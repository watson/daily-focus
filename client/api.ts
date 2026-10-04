/** Everything that talks to the server. */

import type { DashboardState } from '../src/types.ts';
import type { CalendarName, SettingsPage, TextName } from './types.ts';

async function stateFrom(res: Response, what: string): Promise<DashboardState> {
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `${what} returned ${res.status}`);
  }
  return res.json() as Promise<DashboardState>;
}

/**
 * A POST that resolves with the server's fresh state, so the caller can skip a refetch.
 * Always JSON, even with nothing to say: the server refuses anything else, so a
 * page on another site can't post here with a form.
 */
async function post(path: string, body: unknown = {}): Promise<DashboardState> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return stateFrom(res, `POST ${path}`);
}

export async function fetchState(): Promise<DashboardState> {
  const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/state returned ${res.status}`);
  return res.json() as Promise<DashboardState>;
}

/** Record an action against an item. */
export function postAction(action: { id: string; action: string; until?: string; text?: string }): Promise<DashboardState> {
  return post('/api/actions', action);
}

/**
 * Subscribe to server-pushed state.
 *
 * EventSource reconnects on its own, so a server restart during `npm run dev`
 * heals without a page reload. `onError` is for surfacing the gap, not retrying.
 */
export function subscribe(
  onState: (state: DashboardState) => void,
  onError: (err: Error | null) => void,
): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    try {
      onState(JSON.parse((event as MessageEvent<string>).data) as DashboardState);
    } catch (err) {
      onError(err as Error);
    }
  });
  source.addEventListener('error', () => onError(new Error('lost connection to the server')));
  source.addEventListener('open', () => onError(null));
  return () => source.close();
}

/** Start or stop the focus timer. */
export function postSession(body: { action: 'start'; id: string } | { action: 'stop' }): Promise<DashboardState> {
  return post('/api/session', body);
}

/** Ask the server to poll GitHub now. Resolves once it has. */
export function postBoardRefresh(): Promise<DashboardState> {
  return post('/api/board/refresh');
}

/** Ask the server to read Jira now. Resolves once it has. */
export function postTicketsRefresh(): Promise<DashboardState> {
  return post('/api/tickets/refresh');
}

/** Ask the server to read the calendar now. Resolves once it has. */
export function postCalendarRefresh(): Promise<DashboardState> {
  return post('/api/calendar/refresh');
}

/**
 * Move a ticket to a status. Resolves once Jira has accepted it and the board
 * has been read back; rejects with Jira's own words when the workflow refuses,
 * which is an outcome the board cannot rule out in advance.
 */
export function postTicketTransition(key: string, status: string): Promise<DashboardState> {
  return post('/api/tickets/transition', { key, status });
}

/**
 * Ask the assistant about an item: a quick action, typed text, or both.
 * Resolves once the CLI is running, with the state showing the turn in
 * progress; the reply streams in over SSE.
 */
export function postAssistantAsk(body: { id: string; action?: string; text?: string }): Promise<DashboardState> {
  return post('/api/assistant/ask', body);
}

/** Stop the assistant's turn on an item. */
export function postAssistantStop(id: string): Promise<DashboardState> {
  return post('/api/assistant/stop', { id });
}

/**
 * Start the morning agent now. Resolves once it is running; the brief lands
 * through the store like any other, and the report streams in over SSE.
 */
export function postAgentRun(): Promise<DashboardState> {
  return post('/api/agent/run');
}

/**
 * Ask a finished run of the morning agent a question. Resolves once the agent
 * is working on it; the answer streams in over SSE.
 */
export function postAgentAsk(run: string, text: string): Promise<DashboardState> {
  return post('/api/agent/ask', { run, text });
}

/** Stop the morning agent, whether it is writing a brief or answering a question. */
export function postAgentStop(): Promise<DashboardState> {
  return post('/api/agent/stop');
}

/** An answer that isn't state, or the error the server gave instead. */
async function jsonFrom<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `${what} returned ${res.status}`), { status: res.status, body });
  return body;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<T>(res, `POST ${path}`);
}

export async function fetchSettings(): Promise<SettingsPage> {
  return jsonFrom<SettingsPage>(await fetch('/api/settings'), 'GET /api/settings');
}

/** Save settings: a value per setting, or null for the default. Rejects with the server's reason when it refuses one. */
export function postSettings(values: Record<string, string | null>): Promise<SettingsPage> {
  return postJson<SettingsPage>('/api/settings', { values });
}

export interface TextFile {
  text: string | null;
  version: string;
  template: string;
}

export async function fetchText(name: TextName): Promise<TextFile> {
  return jsonFrom<TextFile>(await fetch(`/api/text/${name}`), `GET /api/text/${name}`);
}

/**
 * Save an editor over the version it started from. A file changed on disk since
 * rejects with status 409, and the error's `body` carries what is there now.
 */
export function postText(name: TextName, text: string, version: string): Promise<{ version: string }> {
  return postJson<{ version: string }>(`/api/text/${name}`, { text, version });
}

/** Set the objective and what blocks it, keeping the rest of focus.md. */
export function postObjective(objective: string, blocker: string): Promise<DashboardState> {
  return post('/api/focus/objective', { objective, blocker });
}

/** The calendars Calendar.app has. Launches the helper, which may ask for access the first time. */
export function postListCalendars(): Promise<{ calendars: CalendarName[] }> {
  return postJson<{ calendars: CalendarName[] }>('/api/calendars/list', {});
}
