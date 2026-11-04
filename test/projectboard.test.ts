/**
 * The project poller, driven without an `acli` or a Jira: what it reads when,
 * what a failed read leaves on screen, and what it keeps.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadConfig, type Config } from '../src/config.ts';
import { AcliAuthError, JiraSearchError, type JiraIdentity } from '../src/jira.ts';
import { FRESH_FOR_MS, KEPT_PROJECTS, ProjectBoard, findProjectTicket, withProjectNotes, type ProjectBoardDeps } from '../src/projectboard.ts';
import type { ProjectRead, ProjectSummary, ProjectTicket } from '../src/types.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-projects-'));
  dirs.push(dataDir);
  return loadConfig({ DAILY_FOCUS_DATA: dataDir, DAILY_FOCUS_JIRA: 'on', ...env });
}

const IDENTITY: JiraIdentity = { site: 'acme.atlassian.net', account: 'alice@example.com' };

function summary(key: string, level = 1): ProjectSummary {
  return { key, summary: `Project ${key}`, issueType: level > 0 ? 'Epic' : 'Task', level, workflowStatus: 'In Progress', statusCategory: 'indeterminate', url: null };
}

function ticket(key: string, blockedBy: string[] = []): ProjectTicket {
  const { level: _level, ...facts } = summary(key, 0);
  return { ...facts, parent: 'PROJ-1', assignee: null, mine: true, blockedBy, blocks: [], pulls: null, linksRead: true };
}

function read(key: string, tickets: ProjectTicket[] = [], fetchedAt = new Date().toISOString()): ProjectRead {
  return { root: summary(key), parent: null, epics: [], tickets, outside: [], warnings: [], fetchedAt };
}

function fakeDeps(opts: {
  identity?: () => Promise<JiraIdentity>;
  epics?: () => Promise<ProjectSummary[]>;
  project?: (key: string, site: string | null) => Promise<ProjectRead>;
}): ProjectBoardDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async identity() {
      calls.push('identity');
      return (opts.identity ?? (async () => IDENTITY))();
    },
    async epics(_acli, site) {
      calls.push(`epics ${site}`);
      return (opts.epics ?? (async () => [summary('PROJ-1')]))();
    },
    async project(_acli, key, site) {
      calls.push(`project ${key} ${site}`);
      return (opts.project ?? (async (k: string) => read(k)))(key, site);
    },
  };
}

test('switched off with Jira, it reads nothing and says so', async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config({ DAILY_FOCUS_JIRA: 'off' }), () => {}, deps);
  await board.start();
  await board.open('PROJ-1');
  assert.deepEqual(deps.calls, []);
  assert.deepEqual(board.view(), { enabled: false, epics: [], fetchedAt: null, fetching: false, reason: null, open: {} });
});

test('it reads the epics at start, and a project only once it is opened', async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.start();
  assert.deepEqual(deps.calls, ['identity', 'epics acme.atlassian.net']);
  assert.deepEqual(board.view().epics.map((epic) => epic.key), ['PROJ-1']);
  assert.deepEqual(board.view().open, {});

  await board.open('PROJ-1');
  assert.deepEqual(deps.calls.at(-1), 'project PROJ-1 acme.atlassian.net');
  const opened = board.view().open['PROJ-1']!;
  assert.equal(opened.read?.root.key, 'PROJ-1');
  assert.equal(opened.fetching, false);
  assert.equal(opened.reason, null);
  board.stop();
});

test('a project opened before the epics were read still gets browse links', async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  assert.deepEqual(deps.calls, ['identity', 'project PROJ-1 acme.atlassian.net']);
});

test('the read carries its plan', async () => {
  const deps = fakeDeps({ project: async (key) => read(key, [ticket('PROJ-3', ['PROJ-2']), ticket('PROJ-2')]) });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  assert.deepEqual(board.view().open['PROJ-1']!.read?.plan.order, ['PROJ-2', 'PROJ-3']);
});

test('opening a project again soon after does not read it again', async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  await board.open('PROJ-1');
  assert.equal(deps.calls.filter((call) => call.startsWith('project')).length, 1);
});

test('opening a project read a while ago reads it again', async () => {
  const stale = new Date(Date.now() - FRESH_FOR_MS - 1000).toISOString();
  let reads = 0;
  const deps = fakeDeps({ project: async (key) => read(key, [], reads++ === 0 ? stale : new Date().toISOString()) });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  await board.open('PROJ-1');
  assert.equal(reads, 2);
});

test('a failed read keeps the last good one on screen and says so', async () => {
  let fail = false;
  const deps = fakeDeps({
    project: async (key) => {
      if (fail) throw new JiraSearchError('Jira is having a day');
      return read(key, [ticket('PROJ-2')], new Date(Date.now() - FRESH_FOR_MS - 1000).toISOString());
    },
  });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  fail = true;
  await board.open('PROJ-1');
  const opened = board.view().open['PROJ-1']!;
  assert.deepEqual(opened.read?.tickets.map((t) => t.key), ['PROJ-2']);
  assert.match(opened.reason!.message, /could not read PROJ-1 from Jira: Jira is having a day\. Showing the last good read\./);
  assert.equal(opened.reason!.attempts, 1);
});

test('a project that never read says so without pretending to be empty', async () => {
  const deps = fakeDeps({ project: async () => Promise.reject(new JiraSearchError('Issue does not exist')) });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-404');
  const opened = board.view().open['PROJ-404']!;
  assert.equal(opened.read, null);
  assert.match(opened.reason!.message, /^could not read PROJ-404 from Jira: Issue does not exist$/);
});

test('a failed read of the epics keeps the last ones, and a missing session says how to fix it', async () => {
  let failWith: Error | null = null;
  const deps = fakeDeps({
    identity: async () => {
      if (failWith) throw failWith;
      return IDENTITY;
    },
  });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.refresh();
  failWith = new AcliAuthError('acli has no Jira session (unauthorized) — run `acli jira auth login`');
  await board.refresh();
  const view = board.view();
  assert.deepEqual(view.epics.map((epic) => epic.key), ['PROJ-1']);
  assert.match(view.reason!.message, /no Jira session.*or set DAILY_FOCUS_JIRA=off/);
  board.stop();
});

test('a refresh reads the epics and every project kept', async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  await board.open('PROJ-2');
  deps.calls.length = 0;
  await board.refresh();
  assert.deepEqual(deps.calls.sort(), ['epics acme.atlassian.net', 'identity', 'project PROJ-1 acme.atlassian.net', 'project PROJ-2 acme.atlassian.net']);
  board.stop();
});

test(`it keeps the ${KEPT_PROJECTS} projects opened most recently`, async () => {
  const deps = fakeDeps({});
  const board = new ProjectBoard(await config(), () => {}, deps);
  for (let i = 1; i <= KEPT_PROJECTS + 2; i++) {
    await board.open(`PROJ-${i}`);
    // Each opened a moment after the last, so which is oldest is never a tie.
    await new Promise((done) => setTimeout(done, 2));
  }
  const kept = Object.keys(board.view().open).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  assert.deepEqual(kept, Array.from({ length: KEPT_PROJECTS }, (_, i) => `PROJ-${i + 3}`));
});

test('a project opened while every kept one is being read is the one kept', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => (release = done));
  const deps = fakeDeps({
    project: async (key) => {
      if (key !== 'PROJ-9') await gate;
      return read(key, [], new Date(0).toISOString());
    },
  });
  const board = new ProjectBoard(await config(), () => {}, deps);
  const held = Array.from({ length: KEPT_PROJECTS }, (_, i) => board.open(`PROJ-${i + 1}`));
  await new Promise((done) => setTimeout(done, 5));
  await board.open('PROJ-9');
  assert.equal(board.view().open['PROJ-9']?.read?.root.key, 'PROJ-9');
  assert.equal(Object.keys(board.view().open).length, KEPT_PROJECTS);
  release();
  await Promise.all(held);
});

test('two opens of the same project at once share one read', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => (release = done));
  const deps = fakeDeps({
    project: async (key) => {
      await gate;
      return read(key);
    },
  });
  const board = new ProjectBoard(await config(), () => {}, deps);
  const first = board.open('PROJ-1');
  const second = board.open('PROJ-1');
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(board.view().open['PROJ-1']!.fetching, true);
  release();
  await Promise.all([first, second]);
  assert.equal(deps.calls.filter((call) => call.startsWith('project')).length, 1);
});

test("the state carries each project ticket's notes from the action log, under the ticket board's id", async () => {
  const deps = fakeDeps({ project: async (key) => read(key, [ticket('PROJ-2'), ticket('PROJ-3')]) });
  const board = new ProjectBoard(await config(), () => {}, deps);
  await board.open('PROJ-1');
  const folded = new Map([['jira:proj-2', { status: 'open' as const, notes: [{ text: 'check the flag first', at: '2026-09-24T10:00:00Z' }] }]]);
  const view = withProjectNotes(board.view(), folded);
  const tickets = view.open['PROJ-1']!.read!.tickets;
  assert.deepEqual(tickets.map((each) => each.notes), [[{ text: 'check the flag first', at: '2026-09-24T10:00:00Z' }], []]);
  assert.equal(findProjectTicket(view, 'JIRA:PROJ-3')?.key, 'PROJ-3', 'by the id, whatever its case');
  assert.equal(findProjectTicket(view, 'jira:PROJ-9'), undefined);
});
