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
import { test } from 'node:test';

import { ANY_PR, OPEN_PR, buildJql, projectOf, readTransitionReport, statusesByProject, toTicket } from '../src/jira.ts';

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
