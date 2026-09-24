import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.ts';
import { tempPathFor } from './fs.ts';
import { Store } from './store.ts';
import { Board } from './board.ts';
import { CalendarBoard } from './calendarboard.ts';
import { TicketBoard } from './ticketboard.ts';
import { watchDataDir } from './watch.ts';
import { computeAssetVersion } from './assets.ts';
import { faviconSvg } from './favicon.ts';
import { readIdleSeconds } from './presence.ts';
import { reconcileSession, startSession, stopSession } from './sessions.ts';
import type { Action, ActionType, DashboardState } from './types.ts';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const VALID_ACTIONS: ReadonlySet<string> = new Set<ActionType>([
  'done',
  'snooze',
  'dismiss',
  'reopen',
  'note',
]);

/** Body cap — actions are a few hundred bytes; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How often to ask whether anyone is still at the machine, while a session runs.
 *
 * This is the accuracy of a self-closed session's end time, since the checkpoint it
 * closes back to is only as fresh as the last poll — so it's the interval worth
 * spending a process spawn on. Half a minute of slop in a 90-minute session is
 * noise; ten minutes of it would not be.
 */
const PRESENCE_POLL_MS = 30_000;

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The dashboard is a long-lived tab; never let it show a cached brief.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Reply with a full dashboard state. Typed, so the reply an endpoint builds has to
 * carry every field the client will render: a store state handed back without the
 * board once compiled fine and made every save look failed.
 */
function sendState(res: ServerResponse, state: DashboardState): void {
  sendJSON(res, 200, state);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const relative = normalize(decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath));
  const filePath = join(PUBLIC_DIR, relative);

  // normalize() collapses "..", but a crafted path can still escape the root —
  // verify containment rather than trusting the string.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export interface StartedServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Start listening. `env` is the environment to configure from; the default reads
 * the real one over the repo's `.env`, and a test passes its own so a developer's
 * private file can't leak into it.
 */
export async function startServer(env?: NodeJS.ProcessEnv): Promise<StartedServer> {
  const config = env ? loadConfig(env) : loadConfig();
  const store = new Store(config);
  await store.ensureDataDir();

  /** Open SSE connections. Each gets every state change until it disconnects. */
  const subscribers = new Set<ServerResponse>();

  let assetVersion = await computeAssetVersion(PUBLIC_DIR);

  // The board polls only while a tab is open, so it's told the audience below,
  // and it broadcasts on its own whenever a fetch starts or lands.
  const board = new Board(config, () => void broadcast());
  const calendar = new CalendarBoard(config, () => void broadcast());
  const tickets = new TicketBoard(config, () => void broadcast());

  /**
   * State plus the things the store doesn't own: the asset fingerprint the client
   * watches for self-reload, and the two boards, which are fetched rather than
   * read but join the same action log.
   */
  async function buildState(): Promise<DashboardState> {
    // One read of the log, folded for each surface: the brief and both boards
    // have to agree about what has been handled.
    const actions = await store.readActions();
    const now = new Date();
    const state = await store.getState(now, actions, calendar.state());
    return { ...state, board: board.view(actions, now), tickets: tickets.view(actions, now), assetVersion };
  }

  /** Push state to every open tab. A caller that just built one can hand it over. */
  async function broadcast(prebuilt?: DashboardState): Promise<void> {
    if (subscribers.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(prebuilt ?? (await buildState()));
    } catch (err) {
      console.error(`[daily-focus] could not build state: ${(err as Error).message}`);
      return;
    }
    const frame = `event: state\ndata: ${payload}\n\n`;
    for (const res of subscribers) res.write(frame);
  }

  // Sweep on startup so a brief the agent wrote while the dashboard was closed
  // still lands in the archive.
  await store.archiveCurrentBrief();

  const stopWatching = watchDataDir(
    config.dataDir,
    () => {
      // Archive before broadcasting, so the state we push already reflects the
      // snapshot the progress metric reads from.
      void store.archiveCurrentBrief().then(() => broadcast());
    },
    // The timer re-stamps its own file every poll and the two boards rewrite
    // prs.json and tickets.json every fetch; that's this process talking to
    // itself, and all three already broadcast when something actually changed.
    {
      ignore: [
        basename(config.sessionFile),
        basename(tempPathFor(config.sessionFile)),
        basename(config.pullsFile),
        basename(tempPathFor(config.pullsFile)),
        basename(config.ticketsFile),
        basename(tempPathFor(config.ticketsFile)),
      ],
    },
  );

  // The agenda's "now" marker and free windows drift as the day passes, so refresh
  // open tabs on a slow tick even when no file has changed.
  // Editing a renderer doesn't touch the data dir, so watch the assets as well.
  const stopWatchingAssets = watchDataDir(PUBLIC_DIR, () => {
    void computeAssetVersion(PUBLIC_DIR).then((next) => {
      if (next === assetVersion) return;
      assetVersion = next;
      void broadcast();
    });
  });

  /** Fires once, exactly when the running session reaches its target. */
  let sessionTick: NodeJS.Timeout | null = null;
  function scheduleSessionTick(endsAt: string | null): void {
    if (sessionTick) clearTimeout(sessionTick);
    sessionTick = null;
    if (!endsAt) return;
    const delay = new Date(endsAt).getTime() - Date.now();
    // The 60s heartbeat covers anything further out; this is for precision.
    if (delay <= 0 || delay > 3_600_000) return;
    sessionTick = setTimeout(() => void broadcast(), delay);
    sessionTick.unref();
  }

  /**
   * Ask the OS whether the user is still here, and close the running session back at
   * the last sign of life if not.
   *
   * Runs on a timer of its own rather than off a request, because the case this
   * exists for is precisely the one where nothing is asking: they walked out, the tab
   * went to sleep with the laptop, and the only process left to notice is this one.
   */
  async function checkPresence(): Promise<void> {
    let closed;
    try {
      closed = await reconcileSession(config, readIdleSeconds);
    } catch (err) {
      // A failed check must never take the dashboard with it; the backstop remains.
      console.error(`[daily-focus] presence check failed: ${(err as Error).message}`);
      return;
    }
    if (!closed) return;

    console.log(
      `[daily-focus] stopped "${closed.title}" at ${closed.endedAt} after ` +
        `${closed.actualMinutes} min — machine untouched since then`,
    );
    scheduleSessionTick(null);
    await broadcast();
  }

  // Before the first render, because the session left running may have been
  // abandoned while the machine slept or while this process was dead.
  await checkPresence();

  // A session may already be running from before a restart.
  scheduleSessionTick((await buildState()).session.active?.endsAt ?? null);

  // Reads the last fetch off disk, then fetches once in the background so the
  // first tab to open has something to show. Never awaited: GitHub being slow
  // must not hold up the dashboard listening.
  void board.start().catch((err: unknown) => {
    console.error(`[daily-focus] pull request board failed to start: ${(err as Error).message}`);
  });

  // Same treatment: a calendar that is slow, unbuilt or unpermitted must not hold
  // up the dashboard listening. The agenda falls back to the brief until it lands.
  void calendar.start().catch((err: unknown) => {
    console.error(`[daily-focus] live agenda failed to start: ${(err as Error).message}`);
  });

  // And again: three Jira searches through a CLI that may have to refresh an
  // OAuth token first is the slowest of the three starts, and the least urgent.
  void tickets.start().catch((err: unknown) => {
    console.error(`[daily-focus] jira ticket board failed to start: ${(err as Error).message}`);
  });

  const heartbeat = setInterval(() => {
    void broadcast();
  }, 60_000);
  heartbeat.unref();

  const presencePoll = setInterval(() => {
    void checkPresence();
  }, PRESENCE_POLL_MS);
  presencePoll.unref();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error(`[daily-focus] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendJSON(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (path === '/api/state' && req.method === 'GET') {
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Proxies aside, this stops any intermediary from buffering the stream.
        'x-accel-buffering': 'no',
      });
      res.write(`event: state\ndata: ${JSON.stringify(await buildState())}\n\n`);
      subscribers.add(res);
      board.setAudience(subscribers.size);
      calendar.setAudience(subscribers.size);
      tickets.setAudience(subscribers.size);

      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      keepAlive.unref();
      req.on('close', () => {
        clearInterval(keepAlive);
        subscribers.delete(res);
        board.setAudience(subscribers.size);
        calendar.setAudience(subscribers.size);
        tickets.setAudience(subscribers.size);
      });
      return;
    }

    if (path === '/api/board/refresh' && req.method === 'POST') {
      // Waits for the fetch so the response carries the fresh board; a fetch
      // already in flight is joined rather than doubled.
      await board.refresh();
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/tickets/refresh' && req.method === 'POST') {
      // Waits for the read, as the board's refresh does, so the reply carries it.
      await tickets.refresh();
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/tickets/transition' && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        sendJSON(res, 400, { error: 'body must be an object' });
        return;
      }

      const { key, status } = body as Record<string, unknown>;
      // The only endpoint here that changes anything outside this machine, so it
      // is the strictest about what it accepts. The key is matched against Jira's
      // own `<PROJECT>-<number>` shape rather than merely being non-empty: `acli`
      // would take a JQL query in this position just as happily, and a bulk
      // transition is not something this dashboard should be able to express.
      if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key.trim())) {
        sendJSON(res, 400, { error: '"key" must be a single Jira work item key, e.g. PROJ-8842' });
        return;
      }
      if (typeof status !== 'string' || status.trim() === '') {
        sendJSON(res, 400, { error: '"status" is required' });
        return;
      }

      try {
        await tickets.transition(key.trim(), status.trim());
      } catch (err) {
        // Jira's own words, and a 409: the request was well-formed and the
        // workflow refused it, which is a conflict rather than our mistake. It
        // is also the expected outcome for a move this board could not know was
        // illegal, so it must reach the user rather than being logged.
        sendJSON(res, 409, { error: (err as Error).message });
        return;
      }

      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    if (path === '/api/actions' && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendJSON(res, 400, { error: 'body must be an object' });
        return;
      }

      const { id, action, until, text } = body as Record<string, unknown>;
      if (typeof id !== 'string' || id === '') {
        sendJSON(res, 400, { error: '"id" is required' });
        return;
      }
      if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
        sendJSON(res, 400, { error: `"action" must be one of ${[...VALID_ACTIONS].join(', ')}` });
        return;
      }
      if (action === 'snooze' && until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(until))) {
        sendJSON(res, 400, { error: '"until" must be YYYY-MM-DD' });
        return;
      }
      if (action === 'note' && (typeof text !== 'string' || text.trim() === '')) {
        sendJSON(res, 400, { error: '"text" is required for a note' });
        return;
      }

      const record: Action = { id, action: action as ActionType, at: new Date().toISOString() };
      if (action === 'snooze' && typeof until === 'string') record.until = until;
      if (action === 'note' && typeof text === 'string') record.text = text.trim();

      await store.appendAction(record);
      // The full state, board included: the client swaps its whole state for this
      // reply, so anything missing here is a field the next render trips over.
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    if (path === '/api/session' && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        sendJSON(res, 400, { error: 'body must be an object' });
        return;
      }

      const { action, id, minutes } = body as Record<string, unknown>;

      if (action === 'stop') {
        await stopSession(config);
      } else if (action === 'start') {
        if (typeof id !== 'string' || id === '') {
          sendJSON(res, 400, { error: '"id" is required to start a session' });
          return;
        }
        // The title is snapshotted from the brief rather than taken from the
        // request, so the log records what was actually on screen.
        const { brief } = await store.readBrief();
        const item = brief?.items.find((candidate) => candidate.id === id);
        if (!item) {
          sendJSON(res, 404, { error: `no item with id ${id}` });
          return;
        }
        const requested = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes) : config.sessionMinutes;
        if (requested < 1 || requested > 120) {
          sendJSON(res, 400, { error: '"minutes" must be between 1 and 120' });
          return;
        }
        await startSession(config, {
          id,
          title: item.title,
          minutes: requested,
          advancesObjective: item.advancesObjective === true,
        });
      } else {
        sendJSON(res, 400, { error: '"action" must be "start" or "stop"' });
        return;
      }

      const state = await buildState();
      sendState(res, state);
      scheduleSessionTick(state.session.active?.endsAt ?? null);
      void broadcast(state);
      return;
    }

    if (path === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, dataDir: config.dataDir });
      return;
    }

    // Served rather than inlined in index.html, because it comes from config and
    // a pinned tab reads it before any script runs.
    if (path === '/favicon.svg' && (req.method === 'GET' || req.method === 'HEAD')) {
      const svg = faviconSvg(config.favicon);
      res.writeHead(200, {
        'content-type': 'image/svg+xml',
        'content-length': Buffer.byteLength(svg),
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : svg);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(res, path);
      return;
    }

    sendJSON(res, 405, { error: 'method not allowed' });
  }

  await new Promise<void>((resolvePromise) => {
    server.listen(config.port, config.host, resolvePromise);
  });

  // Read the port back off the socket rather than trusting config: port 0 means
  // "any free port", which tests rely on.
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const url = `http://${config.host}:${port}`;
  console.log(`[daily-focus] dashboard  ${url}`);
  console.log(`[daily-focus] store      ${config.dataDir}`);

  return {
    url,
    async close() {
      clearInterval(heartbeat);
      clearInterval(presencePoll);
      if (sessionTick) clearTimeout(sessionTick);
      board.stop();
      calendar.stop();
      tickets.stop();
      stopWatching();
      stopWatchingAssets();
      for (const res of subscribers) res.end();
      subscribers.clear();
      await new Promise<void>((done, fail) => {
        server.close((err) => (err ? fail(err) : done()));
      });
    },
  };
}

// Only auto-start when run directly, so tests can import startServer without binding a port.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const started = await startServer();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void started.close().then(() => process.exit(0));
    });
  }
}
