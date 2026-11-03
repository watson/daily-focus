/**
 * Check now over HTTP: what the route accepts, what it refuses before any CLI
 * runs, and a verdict landing on the ticket from a click with automatic checks
 * off. Jira is a stand-in, GitHub is off, and Claude Code is a script.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';
import type { TicketBoardDeps } from '../src/ticketboard.ts';
import type { DashboardState, Ticket } from '../src/types.ts';
import { fakeCli, quoted } from './fakecli.ts';

function ticket(key: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `jira:${key}`,
    key,
    summary: `Work for ${key}`,
    workflowStatus: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: `https://acme.atlassian.net/browse/${key}`,
    hasAnyPr: true,
    hasOpenPr: true,
    allPrsClosed: false,
    descriptionHash: '0123456789abcdef',
    ...overrides,
  };
}

const jira: TicketBoardDeps = {
  identity: async () => ({ site: 'acme.atlassian.net', account: 'alice@example.com' }),
  fetch: async () => ({
    tickets: [
      ticket('PAY-1', {
        pulls: [{ repo: 'acme/ledger', number: 7, title: 'Cap retries', url: 'https://github.com/acme/ledger/pull/7', state: 'open', closedAt: null, headSha: 'a1b2c3d4' }],
      }),
      ticket('PAY-2', { hasAnyPr: false, hasOpenPr: false }),
    ],
    statuses: {},
    warnings: [],
  }),
  transition: async () => assert.fail('nothing here moves a ticket'),
  linked: async () => assert.fail('GitHub is off'),
};

let server: StartedServer;
let root: string;
let store: string;
/** The stand-in waits for this file before it answers, so a test can see it running. */
let go: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-focus-server-donecheck-'));
  store = join(root, 'work');
  go = join(root, 'go');
  await mkdir(store);
  const bin = await fakeCli(
    join(root, 'fake-claude'),
    [
      `fs.writeFileSync(${quoted(join(root, 'argv'))}, args.map((arg) => arg + '\\n').join(''));`,
      `for (let i = 0; i < 500 && !fs.existsSync(${quoted(go)}); i++) sleep(20);`,
      `say(${quoted(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', result: '{"verdict":"work-left","line":"The backoff never resets."}' }))});`,
    ].join('\n'),
  );
  await writeFile(
    join(store, 'settings.json'),
    JSON.stringify({
      DAILY_FOCUS_PROFILE: 'work',
      DAILY_FOCUS_AGENT: 'off',
      DAILY_FOCUS_CALENDAR: 'off',
      DAILY_FOCUS_GITHUB: 'off',
      DAILY_FOCUS_ASSISTANT: 'claude',
      DAILY_FOCUS_ASSISTANT_BIN: bin,
      // Nothing here may reach a real acli, even by accident.
      DAILY_FOCUS_ACLI: join(root, 'no-acli'),
    }),
  );
  server = await startServer(
    { PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_DATA: root, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' },
    { integrations: { jira } },
  );
  // The ticket board reads once as the dashboard starts.
  for (let i = 0; i < 200 && (await state()).tickets.fetchedAt === null; i++) await new Promise((resolve) => setTimeout(resolve, 25));
});

after(async () => {
  await writeFile(go, '');
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown, contentType = 'application/json') =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });

async function state(): Promise<DashboardState> {
  return (await (await fetch(`${server.url}/api/state`)).json()) as DashboardState;
}

test('the state lists the tickets the check can look at, and none it cannot', async () => {
  const checks = (await state()).doneCheck!;
  assert.equal(checks.enabled, true);
  assert.equal(checks.auto, false, 'automatic checks are off by default');
  assert.equal(checks.limit, 50);
  assert.deepEqual(Object.keys(checks.tickets), ['PAY-1']);
  assert.deepEqual(checks.tickets['PAY-1'], { checkable: true, verdict: null, running: null, failure: null, dueAt: null });
});

test('the route takes one ticket key, behind the same guard as every POST, and refuses what it cannot check', async () => {
  for (const body of [{}, { key: 7 }, { key: 'PAY-1 OR project = PAY' }, { key: '' }]) {
    assert.equal((await post('/api/tickets/check', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post('/api/tickets/check', ['PAY-1'])).status, 400, 'an array is not a body');
  assert.equal((await post('/api/tickets/check', { key: 'PAY-1' }, 'text/plain')).status, 415, 'a form on another site');
  const unknown = await post('/api/tickets/check', { key: 'PAY-9' });
  assert.equal(unknown.status, 404);
  assert.match(((await unknown.json()) as { error: string }).error, /not one of your unfinished tickets/);
  const bare = await post('/api/tickets/check', { key: 'PAY-2' });
  assert.equal(bare.status, 409);
  assert.match(((await bare.json()) as { error: string }).error, /no pull request/);
  await assert.rejects(readFile(join(root, 'argv'), 'utf8'), 'the CLI never ran');
});

test('Check now runs with automatic checks off, outside the count, and its verdict lands on the ticket', async () => {
  const res = await post('/api/tickets/check', { key: 'PAY-1' });
  assert.equal(res.status, 200);
  const started = ((await res.json()) as DashboardState).doneCheck!.tickets['PAY-1']!;
  assert.equal(started.running?.by, 'click');

  const twice = await post('/api/tickets/check', { key: 'PAY-1' });
  assert.equal(twice.status, 409, 'one at a time on a ticket');
  assert.match(((await twice.json()) as { error: string }).error, /being checked already/);

  await writeFile(go, '');
  let entry = started;
  for (let i = 0; i < 400 && !entry.verdict; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    entry = (await state()).doneCheck!.tickets['PAY-1']!;
  }
  assert.equal(entry.verdict?.verdict, 'work-left');
  assert.equal(entry.verdict?.line, 'The backoff never resets.');
  assert.equal(entry.verdict?.current, true);
  assert.equal(entry.running, null);
  const current = await state();
  assert.equal(current.doneCheck!.usedToday, 0, 'a click is not counted');
  // Advice only: the ticket is where it was, in the status it was.
  assert.equal(current.tickets.inProgress.find((row) => row.key === 'PAY-1')?.workflowStatus, 'In Progress');

  const argv = (await readFile(join(root, 'argv'), 'utf8')).split('\n');
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');

  let log: Record<string, unknown>[] = [];
  for (let i = 0; i < 100 && log.length < 2; i++) {
    log = (await readFile(join(store, 'donecheck.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (log.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(
    log.map((line) => [line.event, line.ticket ?? line.verdict]),
    [
      ['started', 'PAY-1'],
      ['finished', 'work-left'],
    ],
  );
  assert.equal(log[0]!.by, 'click');
  assert.equal(typeof log[1]!.ms, 'number');
});
