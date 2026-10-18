/**
 * What `jira.ts` builds and what it reads back, without an `acli` anywhere near it.
 *
 * The JQL is asserted rather than trusted, for the reason `test/github.test.ts`
 * asserts the query split: every clause in it is load-bearing and invisible in
 * the output. Drop `statusCategory != Done` and the board fills with finished
 * work; drop the `ORDER BY` and the only thing this board can say about a row's
 * age silently stops being true.
 *
 * The fixtures are invented, as the GitHub ones are.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ANY_PR,
  AcliAuthError,
  OPEN_PR,
  acliIdentity,
  allPullRequestsClosed,
  buildJql,
  fetchTickets,
  projectOf,
  readDevPullRequests,
  readTransitionReport,
  statusesByProject,
  toTicket,
} from '../src/jira.ts';
import type { LinkedRead } from '../src/linked.ts';
import { judge } from '../src/tickets.ts';
import type { LinkedPull } from '../src/types.ts';
import { fakeCli } from './fakecli.ts';

/* ---------- the JQL ---------- */

test('the candidate clause asks only for unfinished work that is the user\'s to move', () => {
  const jql = buildJql([], null);
  assert.match(jql, /statusCategory != Done/);
  assert.match(jql, /assignee = currentUser\(\)/);
  // Raised by them and nobody has picked it up: theirs to move, and the same pair
  // the morning prompt uses.
  assert.match(jql, /reporter = currentUser\(\) AND assignee IS EMPTY/);
});

test('no status name appears in the JQL', () => {
  // The names are a site's own — "Committed", "In Review" — and this repo is
  // published. `statusCategory` is what every Jira has whatever its columns are
  // called, so a status name here would be both wrong and personal.
  for (const name of ['Committed', 'In Progress', 'In Review', 'Blocked', 'To Do']) {
    assert.ok(!buildJql(['PROJ'], ANY_PR).includes(name), `${name} leaked into the JQL`);
  }
});

test('ordering is asked for, since it is the only thing the board can say about age', () => {
  assert.match(buildJql([], null), /ORDER BY updated ASC$/);
  assert.match(buildJql(['PROJ'], OPEN_PR), /ORDER BY updated ASC$/);
});

test('the development predicates are the only two Jira accepts', () => {
  // `.merged` and `.declined` are parse errors, which is why "closed" is as far
  // as this board ever commits: it cannot tell a merge from an abandonment.
  assert.equal(ANY_PR, 'development[pullrequests].all > 0');
  assert.equal(OPEN_PR, 'development[pullrequests].open > 0');
  assert.match(buildJql([], ANY_PR), /AND development\[pullrequests\]\.all > 0 ORDER BY/);
});

test('projects narrow the search, and no projects leaves it unnarrowed', () => {
  assert.match(buildJql(['PROJ', 'OTHER'], null), /project IN \("PROJ", "OTHER"\)/);
  assert.ok(!buildJql([], null).includes('project IN'));
});

test('a project name is quoted, and a quote in one cannot end the literal', () => {
  assert.match(buildJql(['we"rd'], null), /project IN \("we\\"rd"\)/);
  assert.match(buildJql(['back\\slash'], null), /project IN \("back\\\\slash"\)/);
});

/* ---------- reading an issue ---------- */

/** The shape acli hands back, trimmed to the parts this code looks at. */
function issue(overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): unknown {
  return {
    key: 'PROJ-8842',
    ...overrides,
    fields: {
      summary: 'Drop the retry loop from the ingest path',
      status: { name: 'In Review', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      issuetype: { name: 'Task', hierarchyLevel: 0, subtask: false },
      ...fields,
    },
  };
}

test('an issue is reduced to the facts, with the brief\'s own id scheme', () => {
  const ticket = toTicket(issue(), 'acme.atlassian.net', true, false);
  assert.deepEqual(ticket, {
    id: 'jira:PROJ-8842',
    key: 'PROJ-8842',
    summary: 'Drop the retry loop from the ingest path',
    workflowStatus: 'In Review',
    statusCategory: 'indeterminate',
    issueType: 'Task',
    url: 'https://acme.atlassian.net/browse/PROJ-8842',
    hasAnyPr: true,
    hasOpenPr: false,
    // Not asked for, so not claimed — the caller repairs this from the panel.
    allPrsClosed: false,
  });
});

/**
 * An epic with merged children is a project in progress rather than an oversight,
 * and telling someone to close the epic tracking their current objective is worse
 * than saying nothing. Read off the level rather than a list of type names, so a
 * site's own tier above Epic is excluded without being named.
 */
test('anything above the base hierarchy level is dropped', () => {
  for (const [name, hierarchyLevel] of [
    ['Epic', 1],
    ['Initiative', 2],
  ] as const) {
    assert.equal(toTicket(issue({}, { issuetype: { name, hierarchyLevel } }), 'x', true, false), null, name);
  }
});

test('a sub-task is kept, and says it is one', () => {
  const ticket = toTicket(issue({}, { issuetype: { name: 'Sub-task', hierarchyLevel: -1 } }), 'x', true, false);
  assert.equal(ticket?.issueType, 'Sub-task');
});

test('no site means no link rather than a guessed one', () => {
  assert.equal(toTicket(issue(), null, false, false)?.url, null);
});

test('a key with something url-shaped in it cannot break out of the link', () => {
  const ticket = toTicket(issue({ key: 'PROJ-1/../../admin' }), 'acme.atlassian.net', false, false);
  assert.equal(ticket?.url, 'https://acme.atlassian.net/browse/PROJ-1%2F..%2F..%2Fadmin');
});

test('an unknown status category reads as uncategorised, never as done', () => {
  for (const key of ['brand-new', '', null, undefined, 42]) {
    const ticket = toTicket(issue({}, { status: { name: 'Odd', statusCategory: { key } } }), 'x', false, false);
    assert.equal(ticket?.statusCategory, 'undefined', String(key));
  }
});

test('an open pull request implies a pull request, whatever the other count said', () => {
  const ticket = toTicket(issue(), 'x', false, true);
  assert.equal(ticket?.hasAnyPr, true);
  assert.equal(ticket?.hasOpenPr, true);
});

test('an issue with no key at all is skipped rather than guessed at', () => {
  assert.equal(toTicket({ fields: {} }, 'x', false, false), null);
  assert.equal(toTicket({ key: '' }, 'x', false, false), null);
  assert.equal(toTicket(null, 'x', false, false), null);
  assert.equal(toTicket('PROJ-1', 'x', false, false), null);
});

test('missing fields fall back rather than taking the row down', () => {
  const ticket = toTicket({ key: 'PROJ-9' }, 'x', false, false);
  // The summary falls back to the key, so a row can always be identified.
  assert.equal(ticket?.summary, 'PROJ-9');
  assert.equal(ticket?.workflowStatus, '');
  assert.equal(ticket?.statusCategory, 'undefined');
  assert.equal(ticket?.issueType, '');
});

/* ---------- the development panel ---------- */

/**
 * The panel as Jira actually hands it over: a Java map rendering whose only
 * readable member is `json=`, wrapped in a trailing brace that is not part of
 * it. The shape is real; the repository and branch names are invented, as the
 * GitHub fixtures are.
 */
function devField(
  pullrequest: Record<string, unknown> | null,
  { errors = [] as unknown[], isStale = true } = {},
): string {
  const summary = pullrequest
    ? { pullrequest: { overall: pullrequest, byInstanceType: { 'oAuth-com.github.integration.production': { count: 1, name: 'GitHub' } } } }
    : { repository: { overall: { count: 6, dataType: 'repository' } } };
  const json = JSON.stringify({ cachedValue: { errors, summary }, isStale });
  return `{pullrequest={dataType=pullrequest}, build={count=6}, json=${json}}`;
}

function overall(state: string, count: number, stateCount = count): Record<string, unknown> {
  // `open` is carried because the real payload carries it, and to document that
  // nothing here reads it: it is false for a draft, which is the whole bug.
  return { count, stateCount, state, dataType: 'pullrequest', open: state === 'OPEN' };
}

test('the rollup is read out of the panel\'s one readable member', () => {
  assert.deepEqual(readDevPullRequests(devField(overall('MERGED', 3))), {
    count: 3,
    state: 'MERGED',
    stateCount: 3,
  });
});

/**
 * The regression this field exists for. Jira reports a draft as a state beside
 * `OPEN` with `open: false`, so `development[pullrequests].open` excludes it and
 * a draft-only ticket reaches the board looking exactly like a merged one.
 * Measured on a real board: five of nineteen settled rows were draft-only.
 */
test('a ticket whose pull requests are all drafts is not confirmed closed', () => {
  const dev = readDevPullRequests(devField(overall('DRAFT', 2)));
  assert.deepEqual(dev, { count: 2, state: 'DRAFT', stateCount: 2 });
  assert.equal(allPullRequestsClosed(dev), false);
});

test('merged and declined are the only states that mean the code side is over', () => {
  for (const state of ['MERGED', 'DECLINED']) {
    assert.equal(allPullRequestsClosed(readDevPullRequests(devField(overall(state, 2)))), true, state);
  }
  for (const state of ['DRAFT', 'OPEN', 'SOMETHING_NEW']) {
    assert.equal(allPullRequestsClosed(readDevPullRequests(devField(overall(state, 2)))), false, state);
  }
});

test('a rollup that does not account for every pull request confirms nothing', () => {
  // Two merged out of three: the third is in a state the rollup did not name,
  // and it could be a draft. Not knowing is the only honest answer.
  assert.equal(allPullRequestsClosed(readDevPullRequests(devField(overall('MERGED', 3, 2)))), false);
});

test('a panel naming no pull requests at all says nothing, rather than "none open"', () => {
  // A real case rather than a hypothetical: one ticket matched
  // `development[pullrequests].all > 0` while its panel carried six
  // repositories, twenty-two builds and no pull request summary whatsoever.
  assert.equal(readDevPullRequests(devField(null)), null);
  assert.equal(allPullRequestsClosed(null), false);
});

test('a panel that reported an error is not trusted to be complete', () => {
  // It may be missing a pull request, which is the one way this read can be
  // wrong in the unsafe direction.
  assert.equal(readDevPullRequests(devField(overall('MERGED', 2), { errors: ['github timed out'] })), null);
});

test('staleness is not consulted, because every panel claims it', () => {
  // Measured: `isStale` is true on every panel read through `acli`, including
  // ones checked by hand and found correct. Gating on it would empty the
  // settled court rather than guard anything.
  const fresh = readDevPullRequests(devField(overall('MERGED', 1), { isStale: false }));
  const stale = readDevPullRequests(devField(overall('MERGED', 1), { isStale: true }));
  assert.deepEqual(fresh, stale);
  assert.equal(allPullRequestsClosed(stale), true);
});

test('a brace inside a name cannot end the object early', () => {
  // The extent is matched rather than sliced to the last `}`, and strings are
  // skipped while matching, so a repository called something unfortunate still
  // parses.
  const field = devField({ ...overall('MERGED', 1), lastRepo: 'acme/we{ird}' });
  assert.deepEqual(readDevPullRequests(field)?.state, 'MERGED');
});

test('a panel that cannot be read answers nothing rather than throwing', () => {
  for (const field of [null, undefined, 42, '', '{}', '{json=}', '{json=not json}', '{json={"cachedValue":{}}}']) {
    assert.equal(readDevPullRequests(field), null, String(field));
  }
});

test('a rollup counting no pull requests is not a closed one', () => {
  assert.equal(allPullRequestsClosed(readDevPullRequests(devField(overall('MERGED', 0)))), false);
});

/* ---------- the status vocabulary ---------- */

test('a project key is read off a work item key, and only a real one', () => {
  assert.equal(projectOf('PROJ-8842'), 'PROJ');
  assert.equal(projectOf('  proj-1  '), 'PROJ', 'trimmed and upper-cased, so two spellings group as one');
  assert.equal(projectOf('A1B2-7'), 'A1B2');
  // Not a work item key: no number, no project, or something else entirely.
  for (const nope of ['PROJ', '-1', 'PROJ-', 'PROJ-1a', '1-1', '', 'https://x/browse/PROJ-1']) {
    assert.equal(projectOf(nope), null, nope);
  }
});

test('statuses are grouped per project, deduplicated and sorted', () => {
  const issues = [
    { key: 'PROJ-1', fields: { status: { name: 'In Review' } } },
    { key: 'PROJ-2', fields: { status: { name: 'Committed' } } },
    { key: 'PROJ-3', fields: { status: { name: 'Committed' } } },
    { key: 'OTHER-1', fields: { status: { name: 'To Do' } } },
  ];
  assert.deepEqual(statusesByProject(issues), { PROJ: ['Committed', 'In Review'], OTHER: ['To Do'] });
});

/**
 * The open and finished reads are separate searches, and the finished one is the
 * only place a completion status can come from — the candidate search excludes
 * that whole category, which is the move the user most often wants to make.
 */
test('the finished statuses join the open ones for the same project', () => {
  const open = [{ key: 'PROJ-1', fields: { status: { name: 'Committed' } } }];
  const done = [
    { key: 'PROJ-9', fields: { status: { name: 'Done' } } },
    { key: 'PROJ-8', fields: { status: { name: "Won't Fix" } } },
  ];
  assert.deepEqual(statusesByProject(open, done), { PROJ: ['Committed', 'Done', "Won't Fix"] });
});

test('two projects spelling a status differently stay apart', () => {
  // Measured on a real board: one project ran "In Progress" and another
  // "In progress". Offering one on the other's ticket is a guaranteed refusal.
  const issues = [
    { key: 'PROJ-1', fields: { status: { name: 'In Progress' } } },
    { key: 'OTHER-1', fields: { status: { name: 'In progress' } } },
  ];
  assert.deepEqual(statusesByProject(issues), { PROJ: ['In Progress'], OTHER: ['In progress'] });
});

test('unreadable issues are skipped rather than making up a project', () => {
  const issues = [null, 'PROJ-1', { key: 'PROJ-1' }, { key: 'PROJ-2', fields: { status: {} } }, { fields: {} }];
  assert.deepEqual(statusesByProject(issues), {});
});

/* ---------- what acli says about a transition ---------- */

/**
 * The shapes below are recorded from a real `acli jira workitem transition`, not
 * imagined, because the thing that makes this dangerous is invisible from the
 * outside: **it exits 0 whether or not the move happened.** An earlier version of
 * this reader looked for an `error` key, found none in the refusal payload, and
 * reported it as a success — a board whose whole job is catching statuses that
 * say untrue things, telling the user an untrue thing.
 */
test('a refusal is read as a refusal, in Jira\'s own words', () => {
  // Verbatim from `--status "Zzz Not A Real Status"` against a real ticket.
  const refusal = {
    results: [{ status: 'FAILURE', message: 'No allowed transitions found for given status', id: 'TWA-1' }],
    totalCount: 1,
    successCount: 0,
  };
  assert.throws(
    () => readTransitionReport(JSON.stringify(refusal), 'TWA-1', 'Zzz'),
    /No allowed transitions found for given status/,
  );
});

test('a success has to be stated, not merely un-refused', () => {
  const ok = { results: [{ status: 'SUCCESS', id: 'TWA-1' }], totalCount: 1, successCount: 1 };
  assert.doesNotThrow(() => readTransitionReport(JSON.stringify(ok), 'TWA-1', 'To Do'));
});

test('silence is not consent', () => {
  // No results, no counts, nothing that says the move happened.
  for (const quiet of ['{}', '{"results":[]}', '{"totalCount":1,"successCount":0}', '[]']) {
    assert.throws(() => readTransitionReport(quiet, 'TWA-1', 'To Do'), /check Jira|no successful move/, quiet);
  }
});

test('an unreadable answer is a failure, not an assumption', () => {
  assert.throws(() => readTransitionReport('not json', 'TWA-1', 'To Do'), /did not say whether/);
  assert.throws(() => readTransitionReport('', 'TWA-1', 'To Do'), /no output/);
});

test('a failure with no message still says something useful', () => {
  const vague = { results: [{ status: 'FAILURE', id: 'TWA-1' }], totalCount: 1, successCount: 0 };
  assert.throws(() => readTransitionReport(JSON.stringify(vague), 'TWA-1', 'Done'), /refused the move to Done/);
});

/** One item asked about, so one success expected — never a partial. */
test('a mixed report fails on the item that failed', () => {
  const mixed = {
    results: [{ status: 'SUCCESS', id: 'A-1' }, { status: 'FAILURE', message: 'nope', id: 'A-2' }],
    totalCount: 2,
    successCount: 1,
  };
  assert.throws(() => readTransitionReport(JSON.stringify(mixed), 'A-2', 'Done'), /nope/);
});

/* ---------- what a refusal keeps ---------- */

test('a refused session keeps one line for the page and the whole transcript for the details', async (t) => {
  // A stand-in acli: real enough to exit non-zero with a complaint over two lines.
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-acli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const acli = await fakeCli(join(dir, 'acli'), "fail('✗ Error: not logged in\\n  run acli jira auth login to sign in to acme.atlassian.net');");

  const err = await acliIdentity(acli).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(err instanceof AcliAuthError);
  assert.equal(err.message, 'acli has no Jira session (not logged in) — run `acli jira auth login`');
  // Quoted as a shell word when it needs to be, as a Windows path does.
  const shown = /^[\w@%+=:,./-]+$/.test(acli) ? acli : `'${acli}'`;
  assert.equal(err.detail, `$ ${shown} jira auth status\n✗ Error: not logged in\n  run acli jira auth login to sign in to acme.atlassian.net`);
});

/* ---------- the whole fetch, against a stand-in acli ---------- */

/**
 * An acli that answers from a JSON file: the three searches by which predicate
 * the JQL carries, a development panel per key, and nothing finished. It logs
 * every panel it is asked for, which is the part worth asserting — the panels
 * are the one per-ticket cost the fetch decides on.
 */
async function standInAcli(
  t: { after(fn: () => Promise<void>): void },
  world: { base: unknown[]; any: string[]; open: string[]; panels: Record<string, string> },
): Promise<{ acli: string; viewed(): Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-acli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'world.json');
  const log = join(dir, 'viewed.log');
  await writeFile(data, JSON.stringify(world));
  const acli = await fakeCli(
    join(dir, 'acli'),
    `const { readFileSync, appendFileSync } = fs;
const world = JSON.parse(readFileSync(${JSON.stringify(data)}, 'utf8'));
if (args[2] === 'view') {
  appendFileSync(${JSON.stringify(log)}, args[3] + '\\n');
  console.log(JSON.stringify({ key: args[3], fields: { customfield_10000: world.panels[args[3]] ?? null } }));
} else {
  const jql = args[args.indexOf('--jql') + 1];
  const only = (keys) => world.base.filter((issue) => keys.includes(issue.key));
  if (jql.startsWith('statusCategory = Done')) console.log('[]');
  else if (jql.includes('.open > 0')) console.log(JSON.stringify(only(world.open)));
  else if (jql.includes('.all > 0')) console.log(JSON.stringify(only(world.any)));
  else console.log(JSON.stringify(world.base));
}`,
  );
  return {
    acli,
    async viewed() {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).sort();
    },
  };
}

function inProgress(key: string): unknown {
  return issue({ key }, { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } });
}

function merged(key: string, number: number): LinkedPull {
  return {
    repo: 'acme/webapp',
    number,
    title: `${key}: something`,
    url: `https://github.com/acme/webapp/pull/${number}`,
    state: 'merged',
    closedAt: '2026-09-21T15:00:00Z',
  };
}

/**
 * The case the GitHub reading exists for, and the ones either side of it: Jira
 * still has a merged pull request open; GitHub has one Jira has not heard of;
 * Jira already agrees; and Jira knows more than GitHub can see.
 */
test("GitHub's reading corrects Jira where it is behind, and reads only the panels it needs", async (t) => {
  const { acli, viewed } = await standInAcli(t, {
    base: ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5'].map(inProgress),
    any: ['PROJ-1', 'PROJ-3', 'PROJ-4', 'PROJ-5'],
    open: ['PROJ-1', 'PROJ-4', 'PROJ-5'],
    panels: {
      'PROJ-1': devField(overall('OPEN', 1)),
      'PROJ-3': devField(overall('MERGED', 1)),
      'PROJ-4': devField(overall('OPEN', 2)),
    },
  });
  const open: LinkedPull = { ...merged('PROJ-2', 3410), state: 'open', closedAt: null };
  const linked: LinkedRead = {
    byKey: new Map([
      ['PROJ-1', [merged('PROJ-1', 3401)]],
      ['PROJ-2', [open]],
      ['PROJ-3', [merged('PROJ-3', 3403)]],
      ['PROJ-4', [merged('PROJ-4', 3404)]],
    ]),
    complete: true,
    warnings: [],
  };

  const { tickets, warnings } = await fetchTickets(acli, { projects: [], site: 'acme.atlassian.net', linked: Promise.resolve(linked) });
  const by = new Map(tickets.map((ticket) => [ticket.key, ticket]));

  // Jira has it open; GitHub has it merged, and as many as Jira counts.
  assert.equal(judge(by.get('PROJ-1')!), 'settled');
  assert.equal(by.get('PROJ-1')!.fromGitHub, true);
  assert.deepEqual(by.get('PROJ-1')!.pulls, [merged('PROJ-1', 3401)]);
  // Jira has nothing; GitHub has one open, so it is not idle.
  assert.equal(by.get('PROJ-2')!.hasOpenPr, true);
  assert.equal(by.get('PROJ-2')!.fromGitHub, true);
  assert.equal(judge(by.get('PROJ-2')!), null);
  // Jira already agrees, so GitHub only brings the evidence.
  assert.equal(judge(by.get('PROJ-3')!), 'settled');
  assert.equal(by.get('PROJ-3')!.fromGitHub, undefined);
  // Jira knows two and GitHub can see one, so the other might be open.
  assert.equal(by.get('PROJ-4')!.hasOpenPr, true);
  assert.equal(by.get('PROJ-4')!.fromGitHub, undefined);
  // Nothing on GitHub: as Jira has it.
  assert.equal(by.get('PROJ-5')!.hasOpenPr, true);
  assert.equal(by.get('PROJ-5')!.pulls, undefined);

  // The settled candidate as ever, and the two Jira-open tickets GitHub has only
  // closed pull requests for. Not the one GitHub has open, nor the one it lacks.
  assert.deepEqual(await viewed(), ['PROJ-1', 'PROJ-3', 'PROJ-4']);
  assert.deepEqual(warnings, []);
});

test('without a GitHub reading the fetch is as Jira has it, and reads no extra panels', async (t) => {
  const { acli, viewed } = await standInAcli(t, {
    base: ['PROJ-1'].map(inProgress),
    any: ['PROJ-1'],
    open: ['PROJ-1'],
    panels: { 'PROJ-1': devField(overall('OPEN', 1)) },
  });
  const { tickets } = await fetchTickets(acli, { projects: [], site: null, linked: Promise.resolve(null) });
  assert.equal(tickets[0]?.hasOpenPr, true);
  assert.equal(tickets[0]?.fromGitHub, undefined);
  assert.deepEqual(await viewed(), []);
});

/**
 * A ticket held out because Jira contradicted itself stops being held out once
 * GitHub has an open pull request for it, and so stops being warned about.
 */
test('a ticket GitHub has an open pull request for is no longer warned about as held out', async (t) => {
  const { acli } = await standInAcli(t, {
    base: ['PROJ-1', 'PROJ-2'].map(inProgress),
    any: ['PROJ-1', 'PROJ-2'],
    open: [],
    panels: { 'PROJ-1': devField(null), 'PROJ-2': devField(null) },
  });
  const linked: LinkedRead = {
    byKey: new Map([['PROJ-1', [{ ...merged('PROJ-1', 3401), state: 'draft', closedAt: null }]]]),
    complete: true,
    warnings: [],
  };
  const { tickets, warnings } = await fetchTickets(acli, { projects: [], site: null, linked: Promise.resolve(linked) });
  assert.equal(tickets.find((ticket) => ticket.key === 'PROJ-1')?.hasOpenPr, true);
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.match(warnings[0]!, /PROJ-2 has pull requests, but its own development panel names none/);
  assert.ok(!warnings[0]!.includes('PROJ-1'));
});
