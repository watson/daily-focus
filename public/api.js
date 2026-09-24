/** Everything that talks to the server. */

export async function fetchState() {
  const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/state returned ${res.status}`);
  return res.json();
}

/**
 * Record an action against an item.
 * Resolves with the server's fresh state, so the caller can skip a refetch.
 */
export async function postAction(action) {
  const res = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/actions returned ${res.status}`);
  }
  return res.json();
}

/**
 * Subscribe to server-pushed state.
 *
 * EventSource reconnects on its own, so a server restart during `npm run dev`
 * heals without a page reload. `onError` is for surfacing the gap, not retrying.
 */
export function subscribe(onState, onError) {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    try {
      onState(JSON.parse(event.data));
    } catch (err) {
      onError?.(err);
    }
  });
  source.addEventListener('error', () => onError?.(new Error('lost connection to the server')));
  source.addEventListener('open', () => onError?.(null));
  return () => source.close();
}

/** Start or stop the focus timer. Resolves with fresh state. */
export async function postSession(body) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/session returned ${res.status}`);
  }
  return res.json();
}

/** Ask the server to poll GitHub now. Resolves with fresh state once it has. */
export async function postBoardRefresh() {
  const res = await fetch('/api/board/refresh', { method: 'POST' });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/board/refresh returned ${res.status}`);
  }
  return res.json();
}

/** Ask the server to read Jira now. Resolves with fresh state once it has. */
export async function postTicketsRefresh() {
  const res = await fetch('/api/tickets/refresh', { method: 'POST' });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/tickets/refresh returned ${res.status}`);
  }
  return res.json();
}

/**
 * Move a ticket to a status. Resolves with fresh state once Jira has accepted it
 * and the board has been read back; rejects with Jira's own words when the
 * workflow refuses, which is an outcome the board cannot rule out in advance.
 */
export async function postTicketTransition(key, status) {
  const res = await fetch('/api/tickets/transition', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, status }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/tickets/transition returned ${res.status}`);
  }
  return res.json();
}

/**
 * Ask the assistant about an item: a quick action, typed text, or both.
 * Resolves once the CLI is running, with the state showing the turn in progress;
 * the reply streams in over SSE.
 */
export async function postAssistantAsk(body) {
  const res = await fetch('/api/assistant/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/assistant/ask returned ${res.status}`);
  }
  return res.json();
}

/** Stop the assistant's turn on an item. Resolves with fresh state. */
export async function postAssistantStop(id) {
  const res = await fetch('/api/assistant/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `POST /api/assistant/stop returned ${res.status}`);
  }
  return res.json();
}
