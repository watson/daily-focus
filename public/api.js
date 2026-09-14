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
