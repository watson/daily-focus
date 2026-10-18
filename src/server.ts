import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectClis, probeCli } from './clis.ts';
import { loadConfig, type CliName, type Config } from './config.ts';
import { ABSENT, readEditable, saveEditable, setFocusFields } from './editable.ts';
import { dataRoot, launchProfile, layerSettings, oldDotenvWarning, settingSources, tilde, type SettingSources } from './env.ts';
import { tempPathFor } from './fs.ts';
import { Store } from './store.ts';
import { Board, type BoardDeps } from './board.ts';
import { CalendarBoard } from './calendarboard.ts';
import { runHelper } from './calendar.ts';
import { TicketBoard, type TicketBoardDeps } from './ticketboard.ts';
import { AgentRunner } from './agent.ts';
import { Assistant, type AskContext } from './assistant.ts';
import { AutoAsk } from './autoask.ts';
import { codexVersionWarning } from './codex.ts';
import { watchDataDir } from './watch.ts';
import { computeAssetVersion } from './assets.ts';
import { faviconSvg } from './favicon.ts';
import { Connection } from './connect.ts';
import { refusal } from './guard.ts';
import { Onboarding } from './onboarding.ts';
import { describeLink, linkStore, storeLinkWarning } from './links.ts';
import { applySettingsChange, describeSettings, saveSettings, type SettingsChange } from './settings.ts';
import { detectIdentity, fillIdentity, firstBriefPending, forgetIdentity, setupState } from './setup.ts';
import { hydratePath } from './shellpath.ts';
import { command, PACKAGED, packageVersion, ranDirectly } from './install.ts';
import { findStore, settleStore, type Profile } from './stores.ts';
import { FOCUS_TEMPLATE, sourcesTemplate } from './templates.ts';
import type { Action, ActionType, DashboardState, Service } from './types.ts';
import { ACTION_TYPES } from './validate.ts';
import { TimeZoneKeeper, validZone } from './zone.ts';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const VERSION = packageVersion();

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The files the dashboard's editors open, by the endpoint that serves them. */
const TEXT_FILES: Readonly<Record<string, { file: 'focusFile' | 'sourcesFile'; name: string }>> = {
  '/api/text/focus': { file: 'focusFile', name: 'focus.md' },
  '/api/text/sources': { file: 'sourcesFile', name: 'sources.md' },
};

const VALID_ACTIONS: ReadonlySet<string> = new Set<ActionType>(ACTION_TYPES);

/** Body cap — actions are a few hundred bytes; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;

/** How often the morning agent's clock checks whether a run is due. */
const AGENT_CLOCK_MS = 30_000;

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

/** Read a JSON object body, or answer 400 and return null. */
async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJSON(res, 400, { error: 'body must be an object' });
    return null;
  }
  return body as Record<string, unknown>;
}

/**
 * The config to start with, and anything worth saying about how it was reached.
 *
 * A settings file that can't be read, or holds a value the config refuses, is
 * set aside rather than allowed to stop the dashboard: the settings page is
 * where it gets fixed, and it has to be up for that. The page normally refuses
 * such a value before saving it, so this is for a file edited by hand.
 */
function configure(sources: SettingSources): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  if (sources.settingsError) {
    warnings.push(`${sources.settingsError}. The dashboard is ignoring it; saving on the settings page writes a fresh one.`);
  }
  try {
    return { config: loadConfig(layerSettings(sources)), warnings };
  } catch (error) {
    if (Object.keys(sources.settings).length === 0) throw error;
    warnings.push(
      `\`${sources.settingsPath}\` has a value the dashboard can't use, so it is ignoring the whole file: ` +
        `${(error as Error).message}. Fix it on the settings page.`,
    );
    return { config: loadConfig(layerSettings(sources, {})), warnings };
  }
}

/**
 * The few facts the menu bar app shows, without the whole state. `busy` is whether
 * the morning agent, the assistant or the setup screen's sessions are at work,
 * which a restart would cut short, and `busyWith` which: the app waits for them
 * before restarting into an update, or says what updating now would stop.
 * `usedAt` is when a page last said someone was using it, or when this dashboard
 * started if none has since: the app installs an update on its own only after a
 * quiet spell. See `client/presence.ts`.
 */
function statusOf(
  state: DashboardState,
  config: Config,
  busyWith: ('agent' | 'assistant' | 'setup')[],
  usedAt: Date,
): Record<string, unknown> {
  const last = state.agentRun.last;
  return {
    version: VERSION,
    dataDir: config.dataDir,
    profile: config.profile,
    setupNeeded: state.setup.needed,
    restartPending: state.restart !== null,
    busy: busyWith.length > 0,
    busyWith,
    usedAt: usedAt.toISOString(),
    brief: {
      generatedAt: state.brief.generatedAt,
      ageHours: state.brief.ageHours,
      stale: state.brief.stale,
      open: state.stats.open,
    },
    agent: {
      enabled: state.agentRun.enabled,
      running: last?.status === 'running',
      nextRunAt: state.agentRun.schedule?.nextRunAt ?? null,
      last: last
        ? { id: last.id, status: last.status, startedAt: last.startedAt, endedAt: last.endedAt, error: last.error }
        : null,
    },
    waitingOnYou: state.board.enabled ? state.board.counts.you : 0,
  };
}

export interface StartedServer {
  url: string;
  /** The profile of the store it opened, which a restart keeps. */
  profile: Profile;
  close(): Promise<void>;
}

/**
 * What the two boards talk to, when it isn't gh and acli. The demo hands over
 * its sample worlds here (see `demo.ts`); everything else leaves it unset and
 * gets the real ones.
 */
export interface Integrations {
  github?: BoardDeps;
  jira?: TicketBoardDeps;
}

export interface ServerOptions {
  /**
   * Called when saved settings can take effect: straight after the save, or once
   * the morning agent or the assistant has finished what it was doing. `runServer`
   * closes this instance and starts another, which reads the new settings. Without
   * it, the page says to restart the dashboard by hand.
   */
  onRestart?: () => void;
  integrations?: Integrations;
  /** Settings held over the store's: the demo's, so nothing in it runs. See `SettingSources`. */
  fixed?: Readonly<Record<string, string>>;
  /** Reads the Mac's zone; a test passes its own so it can move it. */
  readSystemZone?: () => Promise<string | null>;
  /**
   * The profile this process ran before restarting, when none was given at
   * launch: a restart opens the same store, not whichever `stores.ts` would
   * pick first.
   */
  profile?: Profile;
}

/** How long the page says a store has moved into its profile's folder. */
const MOVED_NOTICE_MS = 24 * 60 * 60 * 1000;

/**
 * Start listening. `env` is the environment the launch settings are read from,
 * the real one unless a test or the demo passes its own; every other setting
 * comes from the store's settings, or from `options.fixed`.
 */
export async function startServer(env?: NodeJS.ProcessEnv, options: ServerOptions = {}): Promise<StartedServer> {
  // Everything a setting can come from, read again whenever the settings page
  // asks: a save lands in the store before the restart that applies it.
  const processEnv = env ?? process.env;
  // Before anything reads the store: a store from before the profile folders
  // moves into its folder here, once. See `stores.ts`.
  const found = findStore(dataRoot(processEnv), { asked: launchProfile(processEnv), last: options.profile });
  const settled = await settleStore(found);
  const location = settled.location;
  if (settled.moved) console.log(`[daily-focus] ${settled.moved}`);
  // Worth a word on the page: the store isn't where it always was. A new store
  // renamed after setup's answer is no news to anyone.
  const movedAt = found.move?.kind === 'into-folder' ? new Date() : null;
  const readSources = (): SettingSources => settingSources(processEnv, options.fixed, location);
  const { config, warnings: configWarnings } = configure(readSources());
  if (location.problem) configWarnings.push(location.problem);
  // Only on a real start: a test or the demo has no business with a checkout's .env.
  const dotenvWarning = env ? null : oldDotenvWarning();
  if (dotenvWarning) configWarnings.push(dotenvWarning);
  for (const warning of configWarnings) console.warn(`[daily-focus] ${warning}`);

  const store = new Store(config);
  await store.ensureDataDir();
  const storeId = await store.fingerprint();

  // Before anything counts a day: the zone a browser last reported, or the Mac's
  // if it has moved since. See `zone.ts`.
  const zone = new TimeZoneKeeper(config.timeZoneFile, options.readSystemZone);
  await zone.start();

  // The prompt, the schema and the assistant's instructions, linked to this copy so
  // the agent follows whichever version is running, wherever it was installed from.
  for (const outcome of await linkStore(config)) {
    if (outcome.result === 'linked') console.log(`[daily-focus] linked ${describeLink(config, outcome)}`);
    if (outcome.result === 'copied') console.log(`[daily-focus] copied ${describeLink(config, outcome)}, as Claude Code on Windows won't read through a link`);
    if (outcome.result === 'failed') console.warn(`[daily-focus] could not link ${outcome.name}: ${outcome.detail}`);
  }

  /**
   * Whether saved settings are waiting for a restart. The agent's clock starts
   * nothing new meanwhile, and the endpoints that would start a process refuse,
   * so the wait can only get shorter.
   */
  let restart: DashboardState['restart'] = null;
  let restarting = false;
  /** The settings save in progress, which the next one waits for. */
  let settingsWrites: Promise<unknown> = Promise.resolve();

  // The client is built from `client/` into `public/app.js`, which is not
  // tracked. A checkout that skipped the build would serve a blank page with
  // nothing on it to say why.
  await stat(join(PUBLIC_DIR, 'app.js')).catch(() => {
    console.warn(
      PACKAGED
        ? '[daily-focus] public/app.js is missing from the package: reinstall it'
        : '[daily-focus] public/app.js is missing: run `npm run build` (npm start does so on its own)',
    );
  });

  /** Open SSE connections. Each gets every state change until it disconnects. */
  const subscribers = new Set<ServerResponse>();

  let assetVersion = await computeAssetVersion(PUBLIC_DIR);

  // Asks the assistant ahead about pull requests waiting on the user, whenever
  // the board or a turn changes. Made below, once what it reads exists.
  let autoAsk: AutoAsk | null = null;

  // The board polls only while a tab is open, so it's told the audience below,
  // and it broadcasts on its own whenever a fetch starts or lands.
  const board = new Board(
    config,
    () => {
      void broadcast();
      autoAsk?.poke();
    },
    options.integrations?.github,
  );
  const calendar = new CalendarBoard(config, () => void broadcast());
  const tickets = new TicketBoard(config, () => void broadcast(), options.integrations?.jira);

  // Connecting GitHub or Jira, which only a click starts: fetching the CLI if
  // need be, then signing it in. A new session is news to what reads through
  // it: the board looks again, and for GitHub setup asks gh afresh who the user
  // is. The ticket board's check against GitHub catches up on its next read.
  const connectionChanged = (): void => {
    void broadcast();
    restartWhenIdle();
  };
  const connections: Record<Service, Connection> = {
    github: new Connection('github', config, {
      onChange: connectionChanged,
      onConnected: () => {
        forgetIdentity();
        void board.refresh();
      },
    }),
    jira: new Connection('jira', config, { onChange: connectionChanged, onConnected: () => void tickets.refresh() }),
  };

  // Runs a CLI on request and broadcasts as its answer streams in. It writes
  // nothing to the store but its own log: what the assistant says stays in the
  // chat, and never becomes a note or an action on the item.
  const assistant = new Assistant(config, {
    onChange: () => {
      void broadcast();
      restartWhenIdle();
      autoAsk?.poke();
    },
  });

  autoAsk = new AutoAsk({
    config,
    assistant,
    rows: async () => board.view(await store.readActions(), new Date()).rows,
    context: async (id) => contextFor(id, await buildState()),
    // Nothing new starts while saved settings wait on the restart that applies them.
    canStart: () => restart !== 'waiting',
  });
  const ahead = autoAsk;

  // The morning agent, on the dashboard's clock and when the user asks for a
  // fresh brief. It writes the brief itself, and the watcher below picks it up
  // as it would any other; the runner keeps only its own log.
  const agent = new AgentRunner(config, {
    onChange: () => {
      void broadcast();
      restartWhenIdle();
    },
  });

  // When a page last said someone was using it; see `statusOf`.
  let usedAt = new Date();

  // The setup screen, while a new store is being set up. Its sessions only
  // read; it saves nothing until the finish, which saves everything at once.
  const onboarding = new Onboarding(config, {
    onChange: () => {
      void broadcast();
      restartWhenIdle();
    },
    // A path already set for either CLI is looked at before PATH.
    detectClis: () => {
      const configured: Partial<Record<CliName, string>> = {};
      if (config.agent.cli && config.agent.binPath !== config.agent.cli) configured[config.agent.cli] = config.agent.binPath;
      if (config.assistant.agent && config.assistant.binPath !== config.assistant.agent) configured[config.assistant.agent] = config.assistant.binPath;
      return detectClis(configured);
    },
    probeCli: (path) => probeCli(path, null, false),
    readSources,
    setup: () => setupState(config),
    identity: () => detectIdentity(config),
    // What each board found on its last read, or what a connection made since:
    // a board switched off reads nothing, so only connecting can tell.
    services: async () => {
      const actions = await store.readActions();
      const now = new Date();
      const pulls = board.view(actions, now);
      const jira = tickets.view(actions, now);
      const github = connections.github.view();
      const atlassian = connections.jira.view();
      const signedIn = pulls.accounts.find((account) => account.ok)?.login ?? null;
      const ticketsAccount = jira.reason ? null : jira.account;
      return {
        github: {
          enabled: config.github.enabled,
          connected: signedIn !== null || github.status === 'done',
          account: signedIn ?? github.login,
        },
        jira: {
          enabled: config.jira.enabled,
          connected: ticketsAccount !== null || atlassian.status === 'done',
          account: ticketsAccount ?? atlassian.login,
        },
      };
    },
    listCalendars: async () => {
      const facts = await runHelper(config.calendar.appPath, []);
      const today = new Map<string, number>();
      for (const event of facts.events) {
        if (typeof event.calendarId === 'string') today.set(event.calendarId, (today.get(event.calendarId) ?? 0) + 1);
      }
      return facts.calendars.map(({ id, title, source }) => ({ title, source, eventsToday: today.get(id) ?? 0 }));
    },
    checkSettings: (values) => {
      const applied = applySettingsChange(readSources(), values, { setup: true });
      return 'error' in applied ? applied.error : null;
    },
    saveSettings: (values) => saveSettingsValues(values, { setup: true }),
  });

  // A Codex older than the oldest the dashboard's limits on it work with ignores
  // some of them. Asked once, without holding up the start; the page shows the
  // warning when the answer lands.
  let codexWarnings: string[] = [];
  const codexBins = new Set<string>();
  if (config.agent.cli === 'codex') codexBins.add(config.agent.binPath);
  if (config.assistant.agent === 'codex') codexBins.add(config.assistant.binPath);
  void Promise.all([...codexBins].map((bin) => codexVersionWarning(bin))).then((found) => {
    codexWarnings = [...new Set(found.filter((warning): warning is string => warning !== null))];
    for (const warning of codexWarnings) console.warn(`[daily-focus] ${warning}`);
    if (codexWarnings.length > 0) void broadcast();
  });

  /**
   * The first brief, when the setup screen's finish asked for it. Its settings
   * restart the dashboard, so it is usually the start after the click that
   * begins the run; when nothing needed saving, it is the click itself.
   */
  async function startRequestedBrief(): Promise<void> {
    if (!agent.enabled || !(await firstBriefPending(config)) || !(await onboarding.takeBriefRequest())) return;
    await agent.run('hand').catch((err: unknown) => {
      console.error(`[daily-focus] could not start the first brief: ${(err as Error).message}`);
    });
  }

  /**
   * Save settings, for the settings page and the setup screen's finish, and ask
   * for the restart that applies them when anything changed. Resolves with why
   * not, or null. One save at a time, each reading the file afresh: two tabs
   * saving different settings at once must both land, not the later over the first.
   */
  function saveSettingsValues(values: SettingsChange, opts: { setup?: boolean } = {}): Promise<string | null> {
    const saved = settingsWrites.then(async (): Promise<string | null> => {
      const sources = readSources();
      const applied = applySettingsChange(sources, values, opts);
      if ('error' in applied) return applied.error;
      const changed = JSON.stringify(Object.entries(applied.settings).sort()) !== JSON.stringify(Object.entries(sources.settings).sort());
      if (changed) {
        await saveSettings(sources.settingsPath, applied.settings);
        requestRestart();
      }
      return null;
    });
    settingsWrites = saved.catch(() => {});
    return saved;
  }

  /** Ask for a restart to apply saved settings: now if nothing is running, otherwise once nothing is. */
  function requestRestart(): void {
    restart = options.onRestart ? 'waiting' : 'manual';
    restartWhenIdle();
  }

  function restartWhenIdle(): void {
    if (restart !== 'waiting' || restarting || agent.busy || assistant.busy || onboarding.busy) return;
    if (connections.github.busy || connections.jira.busy) return;
    restarting = true;
    // After the reply that asked for it has gone out.
    setImmediate(() => options.onRestart?.());
  }

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
    const [state, linkWarning] = await Promise.all([
      store.getState(now, actions, calendar.state()),
      // A link that can't be read is no reason to withhold the page.
      storeLinkWarning(config).catch(() => null),
    ]);
    const setup = await setupState(config);
    const pulls = board.view(actions, now);
    const onboardingState = await onboarding.view(setup);
    return {
      ...state,
      board: pulls,
      connections: { github: connections.github.view(), jira: connections.jira.view() },
      tickets: tickets.view(actions, now),
      assistant: { ...assistant.view(), auto: ahead.view(pulls.rows) },
      agentRun: agent.view(now),
      setupWarnings: [...configWarnings, ...codexWarnings, ...(linkWarning ? [linkWarning] : [])],
      setupNotices:
        movedAt && now.getTime() - movedAt.getTime() < MOVED_NOTICE_MS
          ? [
              `Daily Focus now keeps a folder for each profile, so this store has moved to \`${tilde(config.dataDir)}\`. ` +
                'Nothing in it changed.',
            ]
          : [],
      restart,
      setup,
      onboarding: onboardingState,
      assetVersion,
      storeId,
    };
  }

  /**
   * The row as the dashboard shows it, so the assistant is told what the user is
   * looking at rather than left to find it. The same id may be a brief item and
   * a board row at once; both go along.
   */
  function contextFor(id: string, current: DashboardState): AskContext {
    return {
      item: current.items.find((item) => item.id === id),
      pull: current.board.rows.find((row) => row.id === id),
      ticket: current.tickets.rows.find((row) => row.id === id) ?? current.tickets.inProgress.find((row) => row.id === id),
    };
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
    // The two boards rewrite prs.json and tickets.json every fetch; that's this
    // process talking to itself, and both already broadcast when something
    // actually changed.
    {
      ignore: [
        basename(config.pullsFile),
        basename(tempPathFor(config.pullsFile)),
        basename(config.ticketsFile),
        basename(tempPathFor(config.ticketsFile)),
        basename(config.timeZoneFile),
        basename(tempPathFor(config.timeZoneFile)),
        // Appended by this process, which broadcasts on its own.
        basename(config.assistantLogFile),
        basename(config.agentLogFile),
        // Rewritten by the runner before every run; nothing on the page shows it.
        basename(config.agentSettingsFile),
        basename(tempPathFor(config.agentSettingsFile)),
        // Rewritten by the setup screen, which broadcasts on its own.
        basename(config.onboardingFile),
        basename(tempPathFor(config.onboardingFile)),
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

  // Before the first render: a turn left running when the last process died is
  // closed as aborted now, rather than shown as a spinner that never stops.
  await assistant.start();
  await agent.start();
  await onboarding.start(await firstBriefPending(config));
  await startRequestedBrief();

  // The morning agent's clock. Once now, so a dashboard opened after the hour
  // catches up on a brief it missed while closed, and then every half minute:
  // a timer set for six-thirty doesn't fire at six-thirty on a machine that was
  // asleep, but a check each time it is awake does. A new store's first brief
  // comes from the setup screen's finish instead; see `firstBriefPending`.
  // One tick at a time: a browser moving the zone asks for one between the
  // clock's, and two side by side could both find a run due.
  let ticks: Promise<void> = Promise.resolve();
  function clockTick(): Promise<void> {
    ticks = ticks.then(tickOnce).catch((err: unknown) => {
      console.error(`[daily-focus] the morning clock failed: ${(err as Error).message}`);
    });
    return ticks;
  }
  async function tickOnce(): Promise<void> {
    // First, so a run due at seven is judged in the zone the Mac is in now.
    if (await zone.checkSystem()) zoneMoved();
    if (restart === 'waiting' || (await firstBriefPending(config))) return;
    await agent.tick();
  }

  /**
   * The dashboard's zone has changed. The agenda's day may have changed with it,
   * so the calendar is read again.
   */
  function zoneMoved(): void {
    console.log(`[daily-focus] time zone is now ${zone.current}`);
    void calendar.refresh();
    void broadcast();
  }
  void clockTick();
  const agentClock = setInterval(() => {
    void clockTick();
  }, AGENT_CLOCK_MS);
  agentClock.unref();

  // Reads the last fetch off disk, then fetches once in the background so the
  // first tab to open has something to show. Never awaited: GitHub being slow
  // must not hold up the dashboard listening.
  void board.start().catch((err: unknown) => {
    console.error(`[daily-focus] pull request board failed to start: ${(err as Error).message}`);
  });
  // The board's cached rows are there before its first read: whatever they call
  // for, and was not asked before the last shutdown, is asked now.
  ahead.poke();

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

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error(`[daily-focus] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendJSON(res, 500, { error: (err as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Before anything else, so no route can forget it: the server has no login,
    // and this is what keeps other pages in the same browser out.
    const refused = refusal(req, config.host);
    if (refused) {
      sendJSON(res, refused.status, { error: refused.error });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Saved settings waiting on a restart: nothing new starts until it has
    // happened, or the wait could stretch out indefinitely.
    if (
      restart === 'waiting' &&
      req.method === 'POST' &&
      ['/api/agent/run', '/api/agent/ask', '/api/assistant/ask', '/api/connect'].includes(path)
    ) {
      sendJSON(res, 409, { error: 'the dashboard is restarting to apply new settings; try again in a moment' });
      return;
    }

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

    if ((path === '/api/connect' || path === '/api/connect/cancel') && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const service = body.service;
      if (service !== 'github' && service !== 'jira') {
        sendJSON(res, 400, { error: '"service" must be github or jira' });
        return;
      }
      if (path === '/api/connect') {
        // The demo's boards answer from its sample world; a real connection
        // would be the one thing in it that reached outside.
        if (options.integrations?.github || options.integrations?.jira) {
          sendJSON(res, 409, { error: 'the demo connects to nothing' });
          return;
        }
        connections[service].start(body.again === true);
      } else {
        // Waits for it to stop, so the reply can't land after the broadcast
        // that says so and put a dead code back on the page.
        await connections[service].cancel();
      }
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/tickets/refresh' && req.method === 'POST') {
      // Waits for the read, as the board's refresh does, so the reply carries it.
      await tickets.refresh();
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/timezone' && req.method === 'POST') {
      // The page says where it is when you look at it; see `client/zone.ts`.
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }
      const timeZone = validZone((body as Record<string, unknown> | null)?.timeZone);
      if (!timeZone) {
        sendJSON(res, 400, { error: '"timeZone" must be an IANA time zone, such as Europe/Copenhagen' });
        return;
      }
      if (await zone.report(timeZone)) {
        zoneMoved();
        // The next run moves with the zone, and one may now be due.
        await clockTick();
      }
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/calendar/refresh' && req.method === 'POST') {
      // The same again, for the agenda's Retry: a failed read otherwise waits
      // out its backoff, and the calendar has no other way to be asked.
      await calendar.refresh();
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

    if (path === '/api/assistant/ask' && req.method === 'POST') {
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
      const { id, action, text } = body as Record<string, unknown>;
      if (typeof id !== 'string' || id === '') {
        sendJSON(res, 400, { error: '"id" is required' });
        return;
      }
      if (action !== undefined && typeof action !== 'string') {
        sendJSON(res, 400, { error: '"action" must be a quick action id' });
        return;
      }
      if (text !== undefined && typeof text !== 'string') {
        sendJSON(res, 400, { error: '"text" must be a string' });
        return;
      }
      if (!assistant.enabled) {
        sendJSON(res, 409, { error: 'the assistant is off; set DAILY_FOCUS_ASSISTANT to claude or codex' });
        return;
      }

      const context = contextFor(id, await buildState());
      if (!context.item && !context.pull && !context.ticket) {
        sendJSON(res, 404, { error: `no item with id ${id}` });
        return;
      }

      try {
        await assistant.ask({ itemId: id, action, text }, context);
      } catch (err) {
        sendJSON(res, 409, { error: (err as Error).message });
        return;
      }
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    if (path === '/api/agent/run' && req.method === 'POST') {
      try {
        await agent.run();
      } catch (err) {
        sendJSON(res, 409, { error: (err as Error).message });
        return;
      }
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    if (path === '/api/agent/ask' && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }
      const { run, text } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof run !== 'string' || run === '') {
        sendJSON(res, 400, { error: 'run must be a run id' });
        return;
      }
      if (typeof text !== 'string' || text.trim() === '') {
        sendJSON(res, 400, { error: 'text must be the question to ask' });
        return;
      }
      try {
        await agent.ask(run, text);
      } catch (err) {
        sendJSON(res, 409, { error: (err as Error).message });
        return;
      }
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    if (path === '/api/agent/stop' && req.method === 'POST') {
      await agent.stop();
      // As for the assistant: the exit handler records the abort and broadcasts.
      sendState(res, await buildState());
      return;
    }

    if (path === '/api/assistant/stop' && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        sendJSON(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return;
      }
      const { id } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (typeof id !== 'string' || id === '') {
        sendJSON(res, 400, { error: '"id" is required' });
        return;
      }
      await assistant.stop(id);
      // The exit handler records the abort and broadcasts; this reply may still
      // show the turn running for a moment, which is honest.
      sendState(res, await buildState());
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

    // The setup screen. Each answers with fresh state; what a session finds
    // streams in over SSE like everything else.
    if (path.startsWith('/api/onboarding/') && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const step = typeof body.step === 'string' ? body.step : '';
      let refused: string | null = null;
      if (path === '/api/onboarding/answer') {
        refused = await onboarding.answer(step, body.answer);
      } else if (path === '/api/onboarding/revise') {
        refused =
          typeof body.text === 'string' && body.text.trim() !== ''
            ? await onboarding.revise(step, body.text, body.draft)
            : '"text" is required: what to change';
      } else if (path === '/api/onboarding/retry') {
        refused = await onboarding.retry(step);
      } else if (path === '/api/onboarding/detect') {
        await onboarding.detect();
      } else if (path === '/api/onboarding/finish') {
        const finished = await onboarding.finish();
        if ('error' in finished) refused = finished.error;
        else if (!finished.restart) await startRequestedBrief();
      } else {
        sendJSON(res, 404, { error: `no such setup action: ${path}` });
        return;
      }
      if (refused) {
        sendJSON(res, 409, { error: refused });
        return;
      }
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    // What the finish would write as the source list, for the screen to show
    // before it does. Not in the state, as the file itself never is.
    if (path === '/api/onboarding/sources' && req.method === 'GET') {
      sendJSON(res, 200, await onboarding.previewSources());
      return;
    }

    if (path === '/api/settings' && req.method === 'GET') {
      sendJSON(res, 200, { ...describeSettings(readSources()), restart });
      return;
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const values = body.values;
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        sendJSON(res, 400, { error: '"values" must be an object of settings' });
        return;
      }
      const refused = await saveSettingsValues(values as SettingsChange);
      if (refused) {
        sendJSON(res, 400, { error: refused });
        return;
      }
      sendJSON(res, 200, { ...describeSettings(readSources()), restart });
      void broadcast();
      return;
    }

    // The two files in the user's words, whole, for the editor that asked: the
    // private part of focus.md included, which is why this is a request of its
    // own and never part of the state every tab is sent.
    const textFile = TEXT_FILES[path];
    if (textFile && req.method === 'GET') {
      const { text, version } = await readEditable(config[textFile.file]);
      // A new source list starts with whatever gh and git can say about who you
      // are, for you to check before saving; a file that exists is shown as it is.
      const template =
        textFile.file === 'focusFile'
          ? FOCUS_TEMPLATE
          : text === null
            ? fillIdentity(sourcesTemplate(config.profile), await detectIdentity(config))
            : sourcesTemplate(config.profile);
      sendJSON(res, 200, { text, version, template });
      return;
    }

    if (textFile && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const { text, version } = body;
      if (typeof text !== 'string' || typeof version !== 'string') {
        sendJSON(res, 400, { error: '"text" and "version" are required: the text, and the version it was edited from' });
        return;
      }
      const result = await saveEditable(config[textFile.file], text, version);
      if (!result.saved) {
        sendJSON(res, 409, {
          error: `${textFile.name} changed ${result.version === ABSENT ? 'on disk: it was deleted' : 'on disk'} since you opened it`,
          text: result.text,
          version: result.version,
        });
        return;
      }
      sendJSON(res, 200, { version: result.version });
      void broadcast();
      return;
    }

    if (path === '/api/focus/objective' && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return;
      const { objective, blocker } = body;
      for (const [name, value] of [['objective', objective], ['blocker', blocker]] as const) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          sendJSON(res, 400, { error: `"${name}" must be text, or null to clear it` });
          return;
        }
      }
      const current = await readEditable(config.focusFile);
      const next = setFocusFields(
        current.text,
        { objective: (objective as string | null | undefined) ?? null, blocker: (blocker as string | null | undefined) ?? null },
        FOCUS_TEMPLATE,
      );
      const result = await saveEditable(config.focusFile, next, current.version);
      if (!result.saved) {
        sendJSON(res, 409, { error: 'focus.md changed on disk while saving; try again' });
        return;
      }
      const state = await buildState();
      sendState(res, state);
      void broadcast(state);
      return;
    }

    // The calendars Calendar.app has, for the settings page to choose from. A POST
    // though it changes nothing: it launches the helper, which may ask for calendar
    // access, and only a POST is kept from other sites by the guard.
    if (path === '/api/calendars/list' && req.method === 'POST') {
      try {
        const facts = await runHelper(config.calendar.appPath, []);
        const seen = new Set<string>();
        const calendars = facts.calendars
          .filter((entry) => !seen.has(`${entry.title}\n${entry.source}`) && seen.add(`${entry.title}\n${entry.source}`))
          .map(({ title, source }) => ({ title, source }))
          .sort((a, b) => a.title.localeCompare(b.title));
        sendJSON(res, 200, { calendars });
      } catch (err) {
        sendJSON(res, 409, { error: (err as Error).message });
      }
      return;
    }

    if (path === '/api/status' && req.method === 'GET') {
      const busyWith = [
        ...(agent.busy ? (['agent'] as const) : []),
        ...(assistant.busy ? (['assistant'] as const) : []),
        ...(onboarding.busy ? (['setup'] as const) : []),
      ];
      sendJSON(res, 200, statusOf(await buildState(), config, busyWith, usedAt));
      return;
    }

    if (path === '/api/presence' && req.method === 'POST') {
      // Someone is using a page; see `client/presence.ts`. Kept in memory: a
      // restart counts as use anyway.
      usedAt = new Date();
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (path === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, dataDir: config.dataDir });
      return;
    }

    // Served rather than inlined in index.html, because it depends on the profile and
    // a pinned tab reads it before any script runs.
    if (path === '/favicon.svg' && (req.method === 'GET' || req.method === 'HEAD')) {
      const svg = faviconSvg(config.profile);
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

  /** Everything started above, stopped; the listening socket is the caller's to close. */
  async function stopEverything(): Promise<void> {
    clearInterval(heartbeat);
    clearInterval(agentClock);
    ahead.close();
    board.stop();
    calendar.stop();
    tickets.stop();
    connections.github.stop();
    connections.jira.stop();
    await assistant.close();
    await agent.close();
    await onboarding.close();
    stopWatching();
    stopWatchingAssets();
    for (const res of subscribers) res.end();
    subscribers.clear();
  }

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  } catch (err) {
    await stopEverything();
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new PortInUseError(config.host, config.port);
    }
    throw err;
  }

  // Read the port back off the socket rather than trusting config: port 0 means
  // "any free port", which tests rely on.
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  // An address to open rather than the one bound: a wildcard listens on loopback
  // too, and an IPv6 address needs brackets in a URL. The menu bar app reads this line.
  const shown =
    config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '[::1]' : config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${shown}:${port}`;
  console.log(`[daily-focus] dashboard  ${url}`);
  console.log(`[daily-focus] store      ${config.dataDir}`);

  return {
    url,
    profile: config.profile,
    async close() {
      await stopEverything();
      await new Promise<void>((done, fail) => {
        server.close((err) => (err ? fail(err) : done()));
        // Closing waits for every connection, and Node closes only those idle at
        // this moment: a request still in flight leaves its connection open for
        // the whole keep-alive timeout once it is answered, and a restart waits
        // that long. A tab simply reconnects, so a second is grace enough.
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 1_000).unref();
      });
    },
  };
}

/**
 * Something already listens where the dashboard would. Usually it is the
 * dashboard itself, started by the service or another terminal, so the message
 * says where to look before it says how to pick another port.
 */
export class PortInUseError extends Error {
  constructor(host: string, port: number) {
    super(
      `port ${port} on ${host} is already in use. If that is this dashboard, running as a service or in ` +
        `another terminal, open http://${host.includes(':') ? `[${host}]` : host}:${port}. ` +
        'To run this one beside it, give it another port with DAILY_FOCUS_PORT or --port.',
    );
    this.name = 'PortInUseError';
  }
}

export interface RunOptions {
  onStarted?: (url: string) => void;
  /** The environment to read the launch settings from, in place of the real one: the demo's names its store. */
  env?: NodeJS.ProcessEnv;
  integrations?: Integrations;
  fixed?: Readonly<Record<string, string>>;
}

/**
 * Run the dashboard until the process is told to stop, restarting it in place
 * whenever saved settings ask for that. In place rather than by exiting, so it
 * works the same however it was started: a terminal, `npm run dev`'s watcher,
 * the LaunchAgent, or the menu bar app, none of which has to know about it.
 */
export async function runServer(options: RunOptions = {}): Promise<void> {
  // Before anything reads PATH: a dashboard started by launchd or an app has
  // none of the CLIs it runs on its PATH until this finds your shell's.
  await hydratePath();

  let current: StartedServer | null = null;
  let stopping = false;
  let profile: Profile | undefined;

  async function start(): Promise<void> {
    current = await startServer(options.env, {
      onRestart: () => void restart(),
      integrations: options.integrations,
      fixed: options.fixed,
      profile,
    });
  }

  async function restart(): Promise<void> {
    console.log('[daily-focus] restarting to apply new settings');
    const previous = current;
    profile = previous?.profile ?? profile;
    current = null;
    await previous?.close();
    if (stopping) return;
    try {
      await start();
    } catch (err) {
      // The page checked the settings before saving them, so this is something
      // else entirely; exiting non-zero lets a LaunchAgent or the app try again.
      console.error(`[daily-focus] could not restart: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      void (current?.close() ?? Promise.resolve()).then(() => process.exit(0));
    });
  }

  try {
    await start();
  } catch (err) {
    if (!(err instanceof PortInUseError)) throw err;
    console.error(`[daily-focus] ${err.message}`);
    process.exit(1);
  }
  options.onStarted?.((current as StartedServer | null)?.url ?? '');
}

// Only auto-start when run directly, so tests can import startServer without binding a port.
if (ranDirectly(import.meta.url)) {
  await runServer();
}
