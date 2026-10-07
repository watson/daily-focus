/**
 * The demo: a throwaway store with a few weeks of sample data, and two sample
 * worlds in place of gh and acli, so every screen has something on it for
 * either profile.
 *
 * The rules worth holding: every file the demo writes is one the dashboard can
 * read without complaint, since a warning banner is the one thing a demo must
 * not open with; both profiles fill every tab they have; nothing in the real
 * environment reaches it; and the one write the dashboard can make, a ticket's
 * status, lands in the sample world and nowhere else.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { foldAgentLog } from '../src/agent.ts';
import { foldAssistantLog } from '../src/assistant.ts';
import { loadConfig, PROFILES, type Profile } from '../src/config.ts';
import { demoEnv, demoIntegrations, demoProfile, workingDayBack, writeDemoStore } from '../src/demo.ts';
import { envSources, layerEnv } from '../src/env.ts';
import { parseFocus } from '../src/focus.ts';
import { startServer } from '../src/server.ts';
import { placeholdersIn } from '../src/setup.ts';
import type { DashboardState } from '../src/types.ts';
import { parseActionLine, parseBrief } from '../src/validate.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-demo-test-'));
  dirs.push(dir);
  return dir;
}

/** Lines of a JSONL file, parsed; a blank last line is the newline the writer ends with. */
async function jsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The demo's dashboard, started as the CLI starts it, minus the browser. */
async function demoServer(profile: Profile) {
  const store = await tempStore();
  await writeDemoStore(store, profile);
  const env = demoEnv(
    { PATH: process.env.PATH, HOME: process.env.HOME, DAILY_FOCUS_PORT: '0', DAILY_FOCUS_HOST: '127.0.0.1' },
    store,
    profile,
  );
  const server = await startServer(env, { integrations: demoIntegrations(profile) });
  const fetchState = async (): Promise<DashboardState> => (await fetch(`${server.url}/api/state`)).json() as Promise<DashboardState>;
  // The boards fetch in the background once the server listens; wait for both.
  const settled = async (): Promise<DashboardState> => {
    let state = await fetchState();
    for (let i = 0; i < 200 && (state.board.fetchedAt === null || (state.tickets.enabled && state.tickets.fetchedAt === null)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = await fetchState();
    }
    return state;
  };
  return { server, store, settled, url: server.url };
}

test('the profile is checked before a store is made', () => {
  assert.equal(demoProfile(undefined), 'work');
  assert.equal(demoProfile(''), 'work');
  assert.equal(demoProfile('Personal'), 'personal');
  assert.throws(() => demoProfile('home'), /--profile must be one of work, personal/);
});

test('the demo environment says every setting that shapes the screen itself, so nothing real leaks in', () => {
  const real = {
    PATH: '/usr/bin',
    DAILY_FOCUS_GITHUB_SCOPE: 'realorg',
    DAILY_FOCUS_GITHUB_ACCOUNTS: 'me, me-work',
    DAILY_FOCUS_AGENT: 'codex',
    DAILY_FOCUS_AGENT_AT: '06:30',
    DAILY_FOCUS_ASSISTANT: 'claude',
    DAILY_FOCUS_JIRA: 'on',
    DAILY_FOCUS_JIRA_PROJECTS: 'REAL',
  };
  const personal = loadConfig(layerEnv(envSources(demoEnv(real, '/tmp/demo-store', 'personal'), {})));
  assert.equal(personal.profile, 'personal');
  assert.equal(personal.dataDir, '/tmp/demo-store');
  assert.equal(personal.agent.cli, null, 'the agent is off, whatever the real environment says');
  assert.equal(personal.agent.at, null);
  assert.equal(personal.assistant.agent, null);
  assert.equal(personal.calendar.enabled, false);
  assert.equal(personal.github.enabled, true);
  assert.deepEqual(personal.github.accounts, []);
  assert.deepEqual(personal.github.scope, []);
  assert.equal(personal.jira.enabled, false, 'the personal profile has no Jira, even with it on outside');
  assert.equal(personal.freeWindows, false);

  const work = loadConfig(layerEnv(envSources(demoEnv(real, '/tmp/demo-store', 'work'), {})));
  assert.equal(work.jira.enabled, true);
  assert.deepEqual(work.jira.projects, ['PROJ', 'PLAT']);
  assert.deepEqual(work.jira.holdStatuses, ['Blocked']);
  assert.deepEqual(work.github.scope, ['org:acme']);
  assert.deepEqual(work.github.mergeGateChecks, ['merge-policy']);
  assert.equal(work.port, 0, 'any free port unless one was asked for');
  assert.equal(demoEnv({ DAILY_FOCUS_PORT: '4322' }, '/tmp/demo-store', 'work').DAILY_FOCUS_PORT, '4322');
});

test('working days back skip the weekend, so nothing in the demo is dated on a Sunday', () => {
  const monday = new Date(2026, 9, 5, 10, 0); // 5 October 2026
  assert.equal(monday.getDay(), 1);
  assert.equal(workingDayBack(monday, 0).getDay(), 1);
  assert.equal(workingDayBack(monday, 1).getDay(), 5, 'Friday');
  assert.equal(workingDayBack(monday, 1).getDate(), 2);
  assert.equal(workingDayBack(monday, 3).getDate(), 30, 'the Wednesday before');
  const sunday = new Date(2026, 9, 4, 10, 0);
  assert.equal(workingDayBack(sunday, 1).getDay(), 5);
});

test('the demo refuses a store that already has a brief', async () => {
  const store = await tempStore();
  await writeFile(join(store, 'items.json'), '{"version":1,"items":[]}\n');
  await assert.rejects(writeDemoStore(store, 'work'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(await readFile(join(store, 'items.json'), 'utf8'), '{"version":1,"items":[]}\n');
});

for (const profile of PROFILES) {
  test(`the ${profile} demo store is one the dashboard reads without a single complaint`, async () => {
    const store = await tempStore();
    await writeDemoStore(store, profile);

    const { brief, error, warnings } = parseBrief(await readFile(join(store, 'items.json'), 'utf8'));
    assert.equal(error, null);
    assert.deepEqual(warnings, []);
    assert.ok(brief!.items.length >= 15, 'enough to fill the page');
    assert.equal(new Set(brief!.items.map((item) => item.id)).size, brief!.items.length, 'no id twice');
    const priorities = brief!.items.filter((item) => item.priority !== undefined).map((item) => item.priority).sort();
    assert.deepEqual(priorities, [1, 2, 3], 'three priorities, numbered from one');
    assert.ok(brief!.items.some((item) => item.advancesObjective), 'something moves the objective');
    assert.ok(brief!.items.some((item) => item.kind === 'event' && item.blocking === false), 'an event marked free');
    assert.ok(brief!.items.some((item) => item.kind === 'info'));

    const focus = parseFocus(await readFile(join(store, 'focus.md'), 'utf8'));
    assert.ok(focus.objective && focus.blocker && focus.note && focus.agentOnly, 'every part of focus.md is filled in');

    assert.equal(placeholdersIn(await readFile(join(store, 'sources.md'), 'utf8')), 0, 'the source list is filled in');

    const actions = (await readFile(join(store, 'actions.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.ok(actions.length >= 8);
    assert.ok(actions.every((line) => parseActionLine(line) !== null), 'every action line parses');
    const ats = actions.map((line) => parseActionLine(line)!.at);
    assert.deepEqual(ats, [...ats].sort(), 'oldest first, as the dashboard appends');
    assert.ok(actions.some((line) => parseActionLine(line)!.action === 'snooze'));
    assert.ok(actions.some((line) => parseActionLine(line)!.action === 'note'));

    const sessions = await jsonl(join(store, 'sessions.jsonl'));
    assert.ok(sessions.length >= 1);
    for (const session of sessions) assert.ok(session.id && session.startedAt && session.endedAt && session.endedBy);

    const runs = foldAgentLog(await readFile(join(store, 'agent.jsonl'), 'utf8'));
    assert.ok(runs.length >= 3, 'earlier runs to fold away');
    assert.ok(runs.every((run) => run.status !== 'running'), 'nothing left running, or the restart would abort it');
    const newest = runs.at(-1)!;
    assert.equal(newest.status, 'done');
    assert.match(newest.report, /Wrote \*\*\d+ items\*\*/);
    assert.ok(newest.messages.length >= 3, 'how it got there');
    assert.equal(newest.turns.length, 1, 'a question asked of it');
    assert.equal(newest.turns[0]!.status, 'done');
    assert.equal(newest.endedAt, brief!.generatedAt, 'the run ends when the brief says it was written');

    const turns = foldAssistantLog(await readFile(join(store, 'assistant.jsonl'), 'utf8'));
    assert.ok(turns.size >= 2);
    for (const turn of turns.values()) {
      assert.equal(turn.status, 'done');
      assert.ok(turn.reply.length > 40);
      assert.ok(brief!.items.some((item) => item.id === turn.itemId) || turn.itemId.startsWith('github:pr:'), 'about a row the demo shows');
    }

    const archived = (await readdir(join(store, 'archive'))).filter((name) => name.endsWith('.json')).sort();
    assert.equal(archived.length, 3);
    for (const name of archived) {
      const past = parseBrief(await readFile(join(store, 'archive', name), 'utf8'));
      assert.equal(past.error, null, name);
      assert.deepEqual(past.warnings, [], name);
      assert.ok(past.brief!.date! < brief!.date!, `${name} is from before today`);
    }
  });

  test(`the ${profile} demo dashboard has content on every screen, and no banner`, async () => {
    const { server, settled } = await demoServer(profile);
    try {
      const state = await settled();

      // Nothing to apologise for.
      assert.equal(state.problem, null);
      assert.deepEqual(state.warnings, []);
      assert.deepEqual(state.setupWarnings, []);
      assert.equal(state.setup.needed, false);
      assert.equal(state.setup.profile, profile);
      assert.equal(state.setup.sources.placeholders, 0);
      assert.equal(state.brief.stale, false);

      // Today: the objective and its history, the numbers, the list in every state.
      assert.ok(state.focus?.objective);
      assert.ok(state.focus?.blocker);
      assert.equal(typeof state.objectiveProgress?.workingDaysSince, 'number', 'the archive gives the objective a history');
      assert.ok(state.objectiveProgress?.lastTitle);
      assert.ok(state.stats.topPriority === 3);
      assert.ok(state.stats.completedToday >= 2, 'something cleared today');
      assert.ok(state.items.some((item) => item.status === 'snoozed'));
      assert.ok(state.items.some((item) => item.status === 'open' && item.notes.length > 0), 'a note on an open item');
      assert.ok(state.items.some((item) => item.status === 'open' && item.ageDays >= 5), 'something that has lingered');
      assert.ok(state.session.completedToday >= 1, 'a focus session in the tally');
      assert.equal(state.session.active, null);

      // The agenda: a clash, and free time only where the profile tracks it.
      assert.ok(state.agenda.events.length >= 5);
      assert.equal(state.agenda.conflictIds.length, 2, 'one clash');
      assert.equal(state.agenda.tracksFreeTime, profile === 'work');
      if (profile === 'work') assert.equal(state.agenda.freeWindows.length, 3);

      // The pull request board, from the sample world: a row in nearly every court, and one parked.
      assert.equal(state.board.enabled, true);
      assert.equal(state.board.reason, null);
      assert.deepEqual(state.board.failures, []);
      assert.deepEqual(state.board.warnings, []);
      assert.deepEqual(
        state.board.accounts.map((account) => [account.login, account.ok]),
        [['mara-l', true]],
      );
      const { counts } = state.board;
      assert.ok(counts.you >= 2 && counts.reviewers >= 1 && counts.checks >= 1 && counts.draft >= 1 && counts.parked === 1, JSON.stringify(counts));
      if (profile === 'work') {
        assert.ok(counts.ready === 1 && counts.gate === 1 && counts.blocked === 1, 'every court has a row');
      }
      assert.ok(state.board.rows.some((row) => row.nudge), 'one has waited long enough to ask');
      assert.ok(state.board.rows.some((row) => row.notes.length > 0));

      // The ticket board: work only, with every court and both Working on groups.
      assert.equal(state.tickets.enabled, profile === 'work');
      if (profile === 'work') {
        assert.equal(state.tickets.reason, null);
        assert.equal(state.tickets.account, 'mara@acme.example');
        assert.deepEqual(state.tickets.counts, { settled: 2, started: 2, idle: 2, parked: 1 });
        assert.ok(state.tickets.checked >= 10);
        assert.ok(state.tickets.inProgress.length >= 6);
        assert.deepEqual([...new Set(state.tickets.inProgress.map((row) => row.workflowStatus))].sort(), ['In Progress', 'In Review']);
        assert.ok(state.tickets.inProgress.some((row) => row.notes.length > 0));
        assert.ok(state.tickets.statuses.PROJ?.includes('Done'), 'the status menu has somewhere to go');
        assert.ok(state.tickets.rows.every((row) => row.url?.startsWith('https://acme.atlassian.net/browse/')));
      }

      // The morning agent's runs and the assistant's conversations, read back with both off.
      assert.equal(state.agentRun.enabled, false);
      assert.ok(state.agentRun.runs.length >= 3);
      assert.equal(state.agentRun.last?.status, 'done');
      assert.ok(state.agentRun.last?.report);
      assert.equal(state.assistant.enabled, false);
      assert.ok(Object.keys(state.assistant.items).length >= 2);
      for (const entry of Object.values(state.assistant.items)) {
        assert.equal(entry.running, false);
        assert.ok(entry.turns.every((turn) => turn.status === 'done'));
      }
    } finally {
      await server.close();
    }
  });
}

test('a status moved in the demo moves in its sample world, and Done drops the row', async () => {
  const { server, settled, url } = await demoServer('work');
  try {
    const before = await settled();
    assert.ok(before.tickets.rows.some((row) => row.key === 'PROJ-8842'));

    const post = (body: unknown) =>
      fetch(`${url}/api/tickets/transition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const moved = await post({ key: 'PROJ-8842', status: 'Done' });
    assert.equal(moved.status, 200);
    const after = (await moved.json()) as DashboardState;
    assert.ok(!after.tickets.rows.some((row) => row.key === 'PROJ-8842'), 'no longer out of sync');
    assert.ok(!after.tickets.inProgress.some((row) => row.key === 'PROJ-8842'), 'and no longer in progress');
    assert.equal(after.tickets.checked, before.tickets.checked, 'still counted among the tickets examined');

    const refused = await post({ key: 'PROJ-8871', status: 'Shipped' });
    assert.equal(refused.status, 409, "a status the project doesn't have is refused, as Jira would");
    assert.match(((await refused.json()) as { error: string }).error, /no status called Shipped/);
    const still = await settled();
    assert.ok(still.tickets.rows.some((row) => row.key === 'PROJ-8871' && row.workflowStatus === 'To Do'));
  } finally {
    await server.close();
  }
});
