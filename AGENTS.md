# Working on Daily Focus

This file is for whoever is changing this repo's code — you, or a coding agent you
pointed at it. It describes the contract from the dashboard's side: what the code may
assume about the brief it reads, and what it has to tolerate.

**It is not addressed to the briefing agent, and that agent never reads it.** The
morning prompt lives in [`prompts/morning-brief.md`](./prompts/morning-brief.md) and
is installed into `~/.daily-focus/` as a symlink, so the agent's whole world is that
one directory. [`prompts/README.md`](./prompts/README.md) explains why the separation
is strict, and which document wins when they disagree. If you are here to change a
rule the *agent* follows, that prompt is the file you want.

## Nothing personal or private goes in git

Real calendar names, document ids, ticket keys, account handles, colleague names, and
the contents of any actual brief all belong in the private store (`~/.daily-focus/` —
see `focus.md` and `sources.md`), never in a tracked file, a test fixture, a seed
script, or a commit message. Every example in this repo is invented —
`acme/webapp#3421`, `jira:PROJ-8842`, `@alice`, `bob@example.com` — and new ones
should match.

Two things make that easy to get wrong. A brief is real data even when it looks like a
fixture, so if you need one to test against, read it from the store at runtime rather
than committing a copy. And if something needs to write inside the repo, point
`DAILY_FOCUS_DATA` at `./data`, which is already gitignored; a file dropped at the
repo root is not, and that is exactly how a real brief once got committed.

The one tracked-adjacent file that holds real names is `.env` at the repo root, which
is where GitHub logins and organisation names go. It is gitignored; `.env.example` is
the tracked template and must stay invented.

## Checks

```sh
npm run typecheck   # tsc --noEmit
npm test            # node:test
npm run audit       # re-derives the agent's own checklist from the brief on disk
```

Configuration is read from the real environment layered over a repo-root `.env`, see
`src/env.ts`. `test/docs-contract.test.ts` checks that `.env.example`, `SETUP.md` and
`src/config.ts` all name the same variables, so adding a knob means adding it in all
three.

Two scripts write into the store, and they are not equally safe. **`npm run seed`
overwrites `items.json`** — never point it at a store holding a real brief; give it a
throwaway one instead:

```sh
DAILY_FOCUS_DATA=$(mktemp -d) npm run seed
```

`npm run init` only ever creates what is missing, so it is safe against a live store.
It also installs the two symlinks described above; it will repoint a stale link, but
never overwrite a real file someone has put there deliberately.

## The store, and why it needs no locking

The store is a directory — `~/.daily-focus` unless `DAILY_FOCUS_DATA` says otherwise.
**Every file has exactly one writer.** That single rule is what makes the whole thing
safe without a lock, a database or a daemon, so a change that gives any file a second
writer needs to be a deliberate decision rather than a convenience:

| File | Written by | Read by |
|---|---|---|
| `items.json` | the briefing agent | the dashboard |
| `actions.jsonl` | the dashboard, append-only | the agent, and `resolveItems` |
| `sessions.jsonl` | the dashboard, append-only | the agent, and `sessions.ts` |
| `session.json` | the dashboard | the dashboard |
| `focus.md` | the user, by hand | both |
| `sources.md` | the user, by hand | the agent only — the server never opens it |
| `archive/items-<date>.json` | the server | the agent, and `archive.ts` |
| `prs.json` | the server, from GitHub | the dashboard; the agent may read it |
| `tickets.json` | the server, from Jira via `acli` | the dashboard; the agent may read it |
| `calendar.json` | the server, from Calendar.app | the dashboard |
| `prompt.md`, `items.schema.json` | `npm run init`, as symlinks into this repo | the agent only |

The server never writes `items.json`, and nothing in this repo writes `actions.jsonl`,
`sessions.jsonl`, `focus.md`, `sources.md` or anything under `archive/` on the agent's
behalf. The action log in particular is append-only and unreproducible — it is the only
record that a thing was dealt with, so nothing may compact or rewrite it.

`prs.json`, `tickets.json` and `calendar.json` are the files here that come from
outside the store: the server's last successful read of the user's open pull requests,
of the Jira tickets whose status looks wrong, and of today's calendar. Each is written
via a sibling temp file and rename so a reader never sees half of it. All three are
caches rather than records — losing one costs a restart its first paint and nothing
else — and `board.ts`, `ticketboard.ts` and `calendarboard.ts` each read theirs back
defensively for the same reason `validate.ts` is forgiving.

`sources.md` is the one file here the dashboard never opens at all. It is the personal
half of the brief — who the user is, which calendars to query, which accounts to judge
authorship against, which recurring documents to read — and it is deliberately out of
the repo so that the prompt implementing this contract can be published without
carrying anyone's real names. Its identity section is load-bearing rather than
decoration, since notes and tickets attribute work by name; the prompt is where that is
specified, and it matters here only as the reason the file has to stay private.

## What the code may assume, and what it must tolerate

### `items.json` is written by an LLM

Assume nothing about it beyond "probably JSON". `src/validate.ts` is deliberately
forgiving: a malformed *item* is skipped with a warning that surfaces in the UI, and
the rest of the brief still renders; a malformed *file* leaves a red banner and no
brief. Reads retry briefly in case they land mid-write. Keep new fields optional and
keep the parser salvaging — the failure mode to protect is "one bad field took the
whole morning's brief down".

The payload it accepts is `schema/items.schema.json`, which is the authoritative list
of field names and types. Top level:

| Field | Notes |
|---|---|
| `version` | Always `1`. |
| `generatedAt` | ISO 8601 timestamp of the run. Drives the staleness banner. |
| `generatedBy` | Free-form label naming whichever agent produced the brief. Shown in the UI; the dashboard does not care which agent it is. |
| `date` | The local date the brief is for, `YYYY-MM-DD`. |
| `headline` | One or two sentences. Inline Markdown only. |
| `dayStart`, `dayEnd` | Local `"HH:MM"` bounds of today's working day, read off the calendar. **These override `DAILY_FOCUS_WORK_START` / `_END`**, because the agent has seen today's calendar and the config has not. Free windows and remaining focus time are computed from them, so a short day that doesn't set `dayEnd` gets confidently told about a focus block that doesn't exist. |
| `items` | The array. |

And per item — `id`, `title`, `source`, `kind` required, the rest optional:

| Field | Notes |
|---|---|
| `id` | Stable across runs. See below. |
| `title` | One line. |
| `source` | `github` · `email` · `calendar` · `jira` · `slack` · `workday` · `tasks` · `atlassian` · `other`. Aliases (`gmail`, `gh`, `google-tasks`, `confluence`, …) are normalised by the dashboard. |
| `kind` | `task` (completable) · `event` (agenda) · `info` (context only, dismissable but not completable). Inferred from `start` when omitted. |
| `detail` | A sentence or two. Inline Markdown. |
| `url` | Deep link. Non-http(s) is dropped. |
| `priority` | `1`, `2`, `3` … lifts the item into the "Top priorities" band. The agent is capped at three. |
| `due` | ISO date or timestamp. Drives the due / overdue pill. |
| `start`, `end` | Events only. A bare `YYYY-MM-DD` start means all-day. |
| `blocking` | Events only. `false` for something that belongs on the agenda but takes none of your time — a delivery window, a booking. Absent means it blocks, because over-reserving the day is the safe direction. |
| `tags`, `people` | Short labels; handles or addresses. |
| `firstSeen` | ISO date the item was **first** raised, carried forward by the agent across runs. |
| `advancesObjective` | `true` only when finishing the item moves the objective in `focus.md`. |

The dashboard derives today's conflicts and free windows itself, from the `event`
items, so it stays accurate as the day passes. The agent is told to emit events and
not to pre-compute gaps; `src/agenda.ts` is the consumer.

### Ids are the join key, and they are only as stable as an LLM

An action is attached to an item by `id` alone, so an id that changes between runs
orphans the user's "done" and the item returns the next morning. That is the failure
this system exists to prevent, and the agent re-derives the id format from a prompt
every morning — so exact string equality is a stricter contract than can be relied
on. `src/ids.ts` splits the difference:

- `canonicalId` — trim and lowercase, used for **matching** an action to an item. Kept
  deliberately conservative, because a false match marks the wrong thing done, which
  is far worse than a missed one.
- `fingerprintId` — strips to letters and digits, used **only** to detect drift and
  never to match. Two ids sharing a fingerprint but not a canonical form are almost
  certainly the same upstream thing written two ways, which `src/checks.ts` and
  `npm run audit` both report.

Ids are namespaced by source (`github:pr:acme/webapp#3421`, `email:thread:18f2a9c4b7`,
`gtasks:task:…`). Nothing in the dashboard parses that structure — treat it as an
opaque string and leave the recipes to the prompt.

That includes the one place the structure looks tempting. A GitHub row shows the
`owner/repo` it belongs to, because the title is prose and names the organisation
almost never — but `githubRepo` in `public/render.js` reads it off `url`, not off
the id, and a link that names no repository renders nothing rather than a guess.
`test/items-ui.test.ts` holds both halves.

### Folding the action log

`actions.jsonl` is one JSON object per line, appended chronologically. `resolveItems`
in `src/store.ts` groups by canonical id and takes the **last** action per id:

| Last action | Resolved status | Notes |
|---|---|---|
| `done` | `done` | |
| `dismiss` | `dismissed` | |
| `snooze` | `snoozed` | Carries `until`, a `YYYY-MM-DD`. |
| `reopen` | `open` | As though nothing had been recorded. |
| `note` | *unchanged* | Free text for the agent. Accumulates; never affects status. |

The agent drops anything folding to `done`, `dismissed` or an unexpired `snooze`
before it writes, so items in a fresh brief are normally all open. Items that resolve
to a handled status in the *current* brief are the cleared drawer — the user clicking
"done" after the brief was written — and are not a contract breach. `npm run audit`
only counts actions that predated `generatedAt` for exactly this reason.

**The log outranks upstream state, always.** An email replied to by phone looks
identical to one ignored; only the click distinguishes them. No code here may conclude
an item is handled from read-status, from its absence in a query, or from upstream
silence. The one place that reads the log differently is the pull request board, which
shows what is *open* rather than what is *handled*, and so ignores `done` and `dismiss`
on purpose; see below for what that means when the same id is in both.

### Ageing, and the progress metric

`firstSeen` drives the "5 days on the list" pill: things that linger should look worse
over time. It only works if the agent carries it forward, and an ageing display that
silently stops appearing is invisible by construction — so `src/checks.ts` reports it
moving forward, continuously, rather than leaving it to a check someone has to
remember to run.

`advancesObjective` is joined against the action log and the archive to produce the
number the dashboard leads with: **how many working days since anything actually moved
the objective.** That makes it the one boolean whose looseness would turn the headline
figure into flattery, which is why `checks.ts` also warns when more than five items
carry it. The archive is what makes the metric possible at all — the server snapshots
each brief to `archive/items-<date>.json`, and `archive.ts` reads that history back.

### `focus.md` has a private half

Anything after `<!-- agent-only -->` is read by the agent and **stripped server-side by
`toPublicFocus` before the state ever reaches the browser**, so context that shouldn't
be on screen during a screen share can still steer the ranking. There is a test
asserting it cannot survive serialisation; don't route focus text to the client by any
other path. `checks.ts` additionally looks for the agent having quoted it back into a
title or `detail`, comparing six-word runs — single-word overlap is nothing but false
positives, since both halves legitimately share the vocabulary.

### The pull request board is fetched, not read

The board on the second tab is the one part of the dashboard that gathers anything
itself, and the reason is that it is state rather than judgement. The agent decides
what deserves attention; the board only shows what GitHub can say for certain about the
pull requests the user authored, and it has to be current during the day, since a
review landing at eleven changes whose move it is.

Three modules, split so the part that needs a network is small:

- `github.ts` — borrows tokens from `gh auth token --user <login>` rather than storing
  any, runs the GraphQL search per account, and reduces each node to a `PullRequest` of
  facts. Bots are dropped as activity. Each `org:` in scope is probed by name first,
  because a search scoped to a SAML-protected org the token isn't authorised for returns
  nothing rather than an error, and nothing is what a quiet board looks like.

  Three requests per page, not one, and the split is not an accident. Asking for
  everything at once times the gateway out — measured at eleven seconds for a page of
  fifty, answered with a 502 or a truncated body. Since an account whose fetch fails
  keeps its previous rows, the symptom is a board that looks merely stale while every
  poll silently fails. Two fields are what cost the most. `mergeStateStatus` makes
  GitHub compute a trial merge per pull request; and a hundred check contexts per pull
  made a page of twenty-five 380 KB and eight to ten seconds, which is 28 KB and under
  four without them. So the search carries neither: `MERGE_STATE_QUERY` fetches the
  merge states keyed by node id, `CHECKS_QUERY` fetches the checks the same way in
  batches of `CHECKS_BATCH_SIZE`, and `PAGE_SIZE * MAX_PAGES` is the ceiling on pulls
  read. `test/github.test.ts` asserts the split rather than trusting it.

  The two follow-ups differ in what their failure costs, because they differ in what
  they are. A merge state that can't be fetched costs the field and a warning, and
  `prs.ts` falls back to judging ready from the reviews. The checks are not an
  improvement on the search but half of what a court is judged from, and a pull request
  with no reading at all looks *quiet* rather than unknown — a null `checks` beside an
  empty `pendingChecks` is exactly what reads as nothing outstanding. So a checks
  request that fails takes the account's round with it, and the board keeps the rows it
  had rather than showing a red pull request as ready to merge.

  The rollup is read from the individual contexts, not from its summary `state`,
  which has been seen saying `SUCCESS` over a failing required check. The summary is
  consulted only when the contexts can't answer — none returned, or they could not all
  be read — and that condition is load-bearing rather than an optimisation: the summary
  also says `FAILURE` for a commit whose only unhappy check was cancelled, which would
  put the reading back exactly where `CANCELLED` used to put it.

  **A re-run does not replace the run it supersedes.** Both stay on the commit, in
  separate check suites, and `statusCheckRollup` returns every one of them — so a check
  that failed and was then fixed *without a push*, by a workflow re-run or by an edit
  that re-triggers one, reads red for as long as the head commit stands. `latestChecks`
  collapses each check to its newest run before any verdict is folded, since a
  superseded failure that reached `worse` would already have outvoted its own fix.
  What a re-run replaces is a name *within one workflow*, not a name: a matrix can give
  two jobs of one workflow run the same display name, and dropping one of those would
  hide a real failure behind its namesake's pass, which is the worse mistake of the
  two. So the slot is the name plus the workflow (or the app, for checks Actions didn't
  run), the generation is the run and attempt number, and only a later generation drops
  anything.

  Which of the two numbers does the work is worth knowing, because GitHub is only
  inconsistent in one direction. Re-running a job *within* a workflow run — the flaky
  test case — replaces the check run, and the rollup carries the new attempt alone:
  measured across three pull requests, attempt 2 appears while no name ever shows two
  attempts of one run. A workflow re-triggered as a *new* run accumulates instead, and
  one commit was seen carrying 502 such superseded slots. So the run number is what
  actually drops anything today and the attempt number is defensive — which is the
  right way round, since it costs one comparison to be insulated from GitHub changing
  its mind about replacement. Run numbers rather than timestamps because check runs have been seen
  completing before they started. The selection this depends on is asserted too: trim
  `workflowRun` out of `CHECK_CONTEXTS` and supersession silently stops working.

  Reading the contexts means reading all of them, and a large matrix repository puts
  700–1300 on one commit against GraphQL's hundred per request. `walkRemainingChecks`
  pages the rest with one aliased field per pull request, so each resumes from its own
  cursor — `nodes(ids:)` can't, since it takes one argument list for all of them.
  Bounded by `MAX_CONTEXT_PAGES` per commit and `MAX_CONTEXT_REQUESTS` per poll; both
  are spent rather than enforced, and a pull request the budget didn't reach keeps the
  summary reading and warns. A push landing mid-walk is detected by `oid` and the
  reading discarded, rather than spliced onto the wrong commit.
- `prs.ts` — pure. `judge` decides the court from the facts, the clock and the
  configured merge-gate names; `resolveBoard` joins that with the action log. The
  rules are in its comments and in the README; the tests in `test/prs.test.ts` are the
  spec. The order the questions are asked in is load-bearing and written out above
  `judge`: a draft, then anything only the author can fix, then a review GitHub itself
  still requires, then a configured gate, then an unexplained blocked merge, then an
  ordinary check wait or unstable merge, then ready, then waiting on reviewers.
- `board.ts` — the poller. Once at startup, then only while an SSE subscriber exists,
  with backoff on failure and a pause near the rate limit. An account that fails a
  round keeps its previous rows. Its GitHub calls are injectable, which is how
  `test/board.test.ts` drives it without a network.

Two rules the board must keep:

The board's seven courts, and what each one is claiming, are in `Court` in
`src/types.ts`; the client's `COURT_TITLE` and `COURT_ORDER` in `public/render.js`
have to list the same seven.

- **It joins the same action log under the same ids** (`github:pr:<owner>/<repo>#<n>`),
  so a PR the brief also raises is one thing, not two. But it honours only `snooze` and
  `note`. `done` and `dismiss` are deliberately ignored: the brief may raise "CI failing
  on #3402" and the user may mark that done, and #3402 is still open. The newest note
  also resets the nudge timer, which is how "I asked on Slack" is told to a board that
  can't see Slack. The shared log cuts the other way too: a park from the board is a
  `snooze` on the id, and the fold is last-action-wins, so it replaces a `done` the brief
  recorded that morning — deliberately, so the agent leaves the PR alone until the date.
  Unparking restores what the park replaced when the client still remembers it, and is
  a plain `reopen` otherwise. Notes get no undo at all, since nothing un-notes.
- **Nothing computed is stored.** `prs.json` holds facts and a timestamp; court, reasons,
  nudge and stale flags are derived on every read from the facts, the clock and the
  log, so a row moves between courts as the day passes without a fetch. Whether a
  pending check is a merge gate is derived too, and for a second reason: the answer
  comes from `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS`, which is the user's private
  configuration and has no business in a cache of GitHub facts.
- **Ready means GitHub agrees.** `mergeable` answers only "does this conflict", so an
  approved, green, conflict-free pull request could still be called ready while GitHub
  was refusing the merge on policy. `mergeStateStatus` is the field that says so, and
  **Ready to merge** requires it to be `CLEAN` or `HAS_HOOKS`. A value the enum does
  not have reads as `UNKNOWN` rather than as a clean merge; `null` means nobody told
  us — an older cache — and falls back to the pre-merge-state reading, which is
  tightened to "approved and nothing outstanding" so the old bug can't return through
  the compatibility path. A configured gate pending outranks even a `CLEAN` state: the
  user said that check is the policy, and a clean state alongside it is a race, not a
  permission. `BLOCKED` without a pending check gets its own court rather than being
  labelled as a check wait: the only honest claim is that some GitHub policy refused
  the merge.
- **A cancellation is not a verdict.** `CANCELLED` is deliberately absent from
  `FAILED_CONCLUSIONS`, which is the one place this repo departs from `gh pr checks`
  besides distrusting the summary. A cancelled run says the run was abandoned, and
  the API never says by whom: a merge queue dropping an entry whose gate never
  cleared looks identical to a human hitting the button. Since the queue case is
  *caused* by the pending gate, calling it red moves the row to `you` and hides the
  gate — so cancellations go in `cancelledChecks`, contribute nothing to `checks` or
  `failingChecks`, and `judge` never reads them. They are rendered under the row as
  plain text in every court, which is the whole compensation for a run you cancelled
  yourself no longer reading as red. A check that genuinely failed beside one is
  untouched, and needs no special case: the failure reaches `you` on its own.
- **A gate is not a reviewer.** A pending merge gate says the merge is refused and
  nothing about whose action is missing. So `gate` rows carry the check's name and
  GitHub's `detailsUrl` and nothing else — no nudge button, no reviewer list, no
  reading of the check's own output. Parsing a check-run title, summary or app name to
  guess at the policy behind it is specifically out of scope; if that text is ever
  wanted it goes below the row as plain text and never changes a court.

### The ticket board is fetched too, and asks Jira rather than GitHub

The third tab is the Jira tickets whose status doesn't match what their pull requests
say. It is on a board rather than in the brief for the pull request board's reason and
a sharper one: the point of a row is that the user goes and changes the status, so the
row has to disappear when they do, which a brief written once at dawn can never do.
There are also roughly twenty of these on a real backlog at any time, which is an
order of magnitude past the brief's editorial bar and exactly the sort of list that
belongs somewhere visible and undemanding.

Three modules, split as the pull request board is:

- `jira.ts` — borrows `acli`'s own OAuth session rather than storing a credential,
  which is the same bargain `github.ts` strikes with `gh` and the thing that made this
  board worth building. Builds the JQL, runs the searches, reduces each issue to a
  `Ticket` of facts.

  **`transitionTicket` is the only thing in this repo that writes to anything
  outside this machine**, and the boundary is drawn as narrowly as it can be: it
  moves one work item to one named status and does nothing else — no field edits,
  no comments, no deletes — and it runs only from a click a user made on a row.
  `--key` takes a single key rather than the JQL `acli` would equally accept, so a
  bulk transition is not something this dashboard can express. Every other call is
  a search or a status read. A second writing function needs to be a deliberate
  decision rather than a convenience, and so does widening this one.

  **The board cannot know which transitions are legal.** `acli` returns a work
  item's `transitions` as null and has no command for them, so the status menu is
  built from the statuses the user's *own* tickets are seen in — `statusesByProject`,
  fed by the candidate search plus one more for the finished ones, since the
  candidate search excludes that category by construction and "done" is the move
  most often wanted from a settled row. That makes the menu an offer and not a
  promise: Jira is the authority and says so by refusing, which is why a refusal is
  an expected outcome carried in `JiraTransitionError` with Jira's own words, and
  reaches the user as a 409 rather than being logged. Only observed statuses are
  offered and nothing takes a typed one, which is a deliberate limitation: a project
  whose workflow has never been seen reaching an end cannot be finished from this
  tab, and that is preferred to a field inviting names that don't exist.

  **`acli` exits 0 whether or not the move happened.** A refused transition reports
  `{"results":[{"status":"FAILURE","message":"…"}],"successCount":0}` with an empty
  stderr and a zero exit, so `readTransitionReport` demands to be *told* the move
  succeeded rather than merely failing to find a complaint — an earlier version
  looked for an `error` key, found none in that payload, and reported a refusal as a
  success. The polarity is the point: a false failure costs a confusing toast beside
  a row the refresh has already corrected, while a false success is a lie the user
  has no way to catch, on the one tab whose whole job is catching statuses that say
  untrue things. `test/jira.test.ts` records the real payloads. Grouped by project because
  projects disagree — one real board ran "In Progress" and "In progress" in two of
  them, and a third called its finished state "Done (ZD Automation)".

  A transition never touches the cache directly: `TicketBoard.transition` awaits
  `refresh()` afterwards, so the row on screen comes from Jira having accepted the
  move rather than from the click. On the one tab whose whole job is "your statuses
  are wrong", an optimistic status would be the exact lie it exists to catch.

  Three searches per read, and the split is forced rather than chosen. Jira exposes
  exactly two counts of a ticket's pull requests to JQL — `development[pullrequests].all`
  and `.open`, with `.merged` and `.declined` being parse errors — and they can be
  *filtered* on but never *selected*: no field returns them. So membership of a
  predicate is the only way to learn it, and the two extra searches ask for one field
  each and are read as sets of keys. `test/jira.test.ts` asserts the JQL rather than
  trusting it, because every clause in it is load-bearing and invisible in the output:
  drop `statusCategory != Done` and the board fills with finished work.

  **Any of the three failing takes the whole round with it.** Losing the base search
  is obvious; losing either set is worse than it looks, because a ticket missing from
  both reads as *no code was ever linked to this* — a perfectly plausible ticket rather
  than an error. One failed request would quietly empty one court and flood another, so
  the round fails and the poller keeps the rows it had. Same reasoning as the checks
  request in `github.ts`, and the same trap: nothing is what a quiet board looks like.

  Branching is on Jira's `statusCategory` (`new`, `indeterminate`, `done`) and never on
  a status name. The names are a site's own — Committed, In Review — and this repo is
  published; the categories are in every Jira whatever its columns are called. Tickets
  above the base issue-type hierarchy level are dropped, which excludes epics and any
  tier a site has above them without naming either.
- `tickets.ts` — pure. `judge` decides the court from the facts and the configured hold
  statuses; `resolveTickets` joins that with the action log. `test/tickets.test.ts` is
  the spec. The order the questions are asked in is written out above `judge`, and what
  is deliberately *not* asked is written out with it.
- `ticketboard.ts` — the poller, the same shape as `board.ts` and with its calls
  injectable, which is how `test/ticketboard.test.ts` drives it without an `acli`.

The three courts are `TicketCourt` in `src/types.ts`; the client's
`TICKET_COURT_TITLE`, `TICKET_COURT_ORDER` and `TICKET_COURT_HINT` in
`public/render.js` have to list the same three, and `test/docs-contract.test.ts`
fails when they don't.

**The tab has two views behind a switch**, because it answers two different
questions. *Out of sync* is the courts, what the tab opens on, and all the tab
badge counts, since it is the view that wants action. *Working on* is
`resolveInProgress`: every ticket in Jira's `indeterminate` category, grouped by
status. `ui.ticketMode` holds which view is showing, in memory only, so a reload
opens on the view that asks for action; `w` flips it. The Working on list used to
be a drawer under Parked, and read as overflow from the courts, which is the reason
for the switch.

Working on **does not ask `judge`**, so a ticket a court flags is in it as well. An
earlier version kept the two disjoint, and that removed exactly the tickets it is
for: an In Progress ticket with no pull request yet is work in progress, and it was
missing because the idle court had it. The views are exclusive, so a ticket in both
is never on screen twice. Instead, its Working on row carries an *Out of sync* flag
naming the court, which jumps to it, because the calm list must not hide the urgent
one. A parked court row gets no flag, since the park asked for exactly that
complaint to stay quiet. The hold statuses don't reach Working on either, since
they only answer the idle court's question.

`DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES` narrows Working on to named statuses. Jira
files In Progress and In Review under the one category, so only a status name can
separate them, and this repo names none: the user lists the statuses to show,
matched as loosely as the hold list. The list only filters, and never admits a
ticket from outside the category. Working on reads notes from the log and never
snoozes: a park answers a complaint, so its rows offer Note and never Park. Like the
courts, it is derived on every read and never stored.

Drawers keep their open state in `ui.openDrawers`, keyed per drawer, and not on the
`<details>` element. Every render rebuilds the element and state arrives on a
heartbeat, so a drawer left to remember for itself snapped shut within the minute.
`visibleItemIds` skips the rows inside a closed one, so `j` never selects a row
nobody can see.

Five rules this board must keep:

- **A ticket can need more than one pull request, and this is why it asks Jira.** The
  naive reading — every linked pull request merged, so the ticket must be done — is
  wrong for work spanning several repositories, and wrong in the direction that teaches
  the user to distrust the board. What makes it safe is that **a draft counts as open**,
  so the habit of opening all of a ticket's pull requests up front keeps the ticket out
  of the settled court until the last one merges, with no judgement applied at all.
  Asking Jira also avoids a join that does not work: Jira links pull requests itself
  from branches and commits and is right about all of them, while matching from the
  GitHub side needs a ticket key in the pull request — measured at one title and
  eighteen branches out of thirty-three open pull requests on one real board.

  **JQL does not supply that on its own, and believing it did was a real bug.**
  `development[pullrequests].open` counts only what GitHub calls `OPEN`; its Jira
  integration reports `DRAFT` as a state *beside* `OPEN` and sets `open: false` on the
  rollup. So a ticket whose every pull request was still a draft matched `.all > 0` and
  not `.open > 0` — through JQL alone, indistinguishable from one whose every pull
  request had merged, and duly filed under "no open pull requests left". Five of
  nineteen settled rows on a real board were draft-only. `.draft` is not a predicate
  either; Jira's parser names the whole whitelist when asked for one.

  So `fetchTickets` reads the development panel itself for the settled candidates
  only — `customfield_10000`, which `acli jira workitem search` refuses and `acli jira
  workitem view` returns — and repairs the count. The field carrying the answer is
  `allPrsClosed`, and the settled court demands it rather than inferring it from
  `hasAnyPr && !hasOpenPr`, because those two cannot tell "every pull request is
  closed" from "the panel could not be read". Unlike the three searches, one panel
  read failing costs its row and not the round: the fallback withholds a verdict
  instead of inventing one, so the ticket drops out of the court rather than being
  judged on counts already known to be misleading. The panel's `isStale` flag is
  deliberately ignored — it is true on every panel read this way, including ones
  verified correct by hand.

  **The two ways of learning nothing get two different warnings**, because they say
  different things: this machine could not get an answer out of `acli`, or it got
  one that contradicts the search. The second is Jira disagreeing with itself — the
  panel answers and names no pull requests at all while the JQL index counts some.
  One real ticket read that way carrying six repositories, 22 builds and no pull
  request summary, and answered with a plain `OPEN` rollup hours later, so neither
  message claims to be permanent and the second says the row returns when one of
  Jira's caches catches up. Both hold the row out of the settled court; what a
  single "could not read the panel" got wrong was which of the two had happened, on
  a board whose whole job is not saying untrue things.

  These warnings name keys, and a warning is the one place this board talks about a
  ticket without rendering a row for it — so the keys are written as inline
  Markdown links through the same `browseUrl` the rows use, and are plain text when
  `acli` never said which site it is. `render.js` puts board warnings through
  `renderMarkdown` for that, which the brief's warnings deliberately don't get:
  those quote titles and ids an LLM wrote, and a stray bracket in one should read as
  a stray bracket. `test/tickets-ui.test.ts` holds the anchor, since it exists only
  in `render.js`.
- **A pull request nobody has written yet is invisible, and the board says so.** No
  source can tell an unfinished ticket from a finished one when the remaining work has
  not been started, so the court claims only *no open pull requests left*, and the note
  button is where the rest goes. Judging it would mean reading the ticket's description
  and comments to notice that four services were named and two have pull requests —
  that is judgement, so it belongs to the agent and not here.
- **Nothing computed is stored.** `tickets.json` holds facts and a timestamp; the court
  is derived on every read from the facts and the hold statuses, so a row moves as the
  user's configuration changes without a re-read. The hold statuses in particular are
  the user's private configuration and have no business in a cache of Jira facts, which
  is the same rule `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS` follows.
- **A transition is not undone, it is reversed.** The toast's undo transitions the
  ticket back to where it came from, and the wording says "moved" rather than
  offering a rollback, because Jira's history keeps both moves and whatever
  automations fired have already fired. Nothing is written to `actions.jsonl` for
  it either: a status change is an upstream fact, the next read reflects it, and a
  log entry would be a second record of the same thing with no reader.
- **It joins the same action log under the same ids** (`jira:<KEY>`), which are the
  ids the prompt already uses for Jira items, so a ticket the brief also raises is one
  thing rather than two. Only `snooze` and `note` are honoured. `done` and `dismiss`
  are ignored for the pull request board's reason — the brief may raise "answer the
  question on PROJ-8842" and marking that done says nothing about the status — and for
  one of this board's own: the fix is a status change in Jira, and the next read drops
  the row without being told. A ticket that stops looking wrong is dropped even when
  parked, since the park was about a complaint that no longer stands.

The layout is the one place this view departs from the other two, and both departures
are measured rather than stylistic. The rows were 1200px wide for a summary running
520px at the median, so `#tickets .list` is `columns: 460px` — two columns at the
shared page width, three on a wide display, which is also why the tickets view is the
only one allowed past the 1280px cap. A fixed `6rem` gutter holds the status so every
summary starts at the same x.

**Columns rather than a grid, because a grid has rows and this board has none.** Cards
here disagree about height — one carrying a note is several times a bare one — and a
grid reserves the tallest card's height across the whole row, so the short card beside
it gets that space left blank underneath. `align-items: start` stops the short card
stretching but cannot reclaim the row, which is why this was a visible band of nothing
on a real board. A column flow places each card where the one above it ended and never
aligns across columns, so the space is simply not created; `break-inside: avoid` keeps
a card whole and the vertical rhythm is a margin, since a multicol container has no
`gap`. The earlier note here said multicol would break the absolutely positioned
`.item__actions` and snooze `.menu` — it does not, because `.item` is
`position: relative` and they resolve against their own card. Only a descendant whose
containing block is the multicol container itself lands beside the wrong row, and this
view has none.

**The dot is the one place in this dashboard where colour carries a cue on its own**,
and the stylesheet's rule at the top says source colour never does. The exception is
narrow and deliberate: every row here is Jira, so the source dot repeats itself once
per row and has no job, while the issue type had to leave the status gutter — in
6rem it wrapped underneath and cost a line on every card. So the dot carries the
type, Task keeping Jira's own amber so only the exceptions stand out. What keeps it
honest is that nothing load-bearing depends on the hue: the key, summary and status
are all text, each dot carries its type as an `aria-label` and a hover title rather
than being `aria-hidden` like the source dots, and `typeLegend` names the types
actually on screen — derived from the rows, so a type nobody anticipated gets a
swatch and its own name instead of going quietly grey. `test/tickets-ui.test.ts`
holds all three halves of that, since none of them are visible to `tickets.ts`.

Two things the board is deliberately quiet about, and both are quiet by construction
rather than by omission. It never says a pull request was *merged*, only that none is
open, because JQL offers no count of merged ones and an abandoned pull request is
indistinguishable from a landed one. And it says nothing about the **In Progress → In
Review** transition, which needs to know whether an open pull request is still a draft:
Jira's counts don't say, the pull request board does, and the only way to join them is
the branch-name match that more than a third of real pull requests fail. Rows also
carry no age pill — `acli`'s search permits a fixed handful of fields with no timestamp
among them, though it will sort on one, so the ordering is real and inherited and a
duration would have had to be invented.

### The agenda is read live, and falls back

The agenda pane prefers today's events as **Calendar.app** has them, and uses the
`kind: "event"` items in the brief when it can't. The reason is the same one the
board exists for: the brief is written once at dawn, so a meeting declined at eleven
leaves a gap nothing can see, and the focus time the dashboard offers is time you
don't have. About a third of the meetings on a real work calendar turn out to be
declined ones.

`tools/dfcal` is a Swift helper built by `npm run build:calendar`. It is an `.app`
bundle and launched with `open`, and neither is a style choice: macOS attributes a
calendar request to the *responsible process*, so a bare binary spawned by the server
inherits whatever launched the server and is refused outright when that carries no
calendar usage description. The refusal is silent — the request returns false with no
error and the status never leaves "not determined" — and running the Mach-O inside
the bundle directly fails identically. Only launching it as an app gives it an
identity of its own. `open` returns before the helper does and gives back no exit
code and no stdout, so the contract is a file: the helper always writes one, refusals
included, and no file at all means it died.

The helper stays thin, because everything it does is untestable without a real
calendar. It makes exactly one judgement, and that one is privacy-shaped: attendees
are reduced to a single self-status before anything is written, so no colleague's
address reaches the disk. Matching is by address rather than `isCurrentUser`, which
is false for every attendee of every event on a Google account synced through
Calendar.app — which is why `DAILY_FOCUS_CALENDAR_ADDRESSES` exists, and why
declined meetings still block without it.

Three rules this has to keep:

- **Fallback is not merge.** The live events replace the brief's wholesale or aren't
  used at all. Blending the two would need the brief's ids to match the calendar's,
  and they don't: the agent writes Google's per-occurrence id while EventKit reports
  a series-level external identifier, so the join needs normalising *and* a start
  time and still misses whenever the agent departs from the id recipe. A source-level
  switch needs none of that to be right. Both paths fold through the same action log,
  so a dismissal sticks either way.
- **Nothing is empty by accident.** A day with no meetings, a mistyped calendar name,
  a revoked permission and an unbuilt helper all produce no events, and only the first
  may reach the screen as an empty agenda. So a read resolving no calendars at all
  falls back and says why, while a read resolving calendars and finding nothing is
  reported as live. This is the same trap `github.ts` probes each `org:` to avoid —
  nothing is what a quiet board looks like. An *unnamed* calendar list is neither: it
  is a feature nobody turned on, and must not produce a banner every morning.
- **The calendar names are the dashboard's own.** They are not read from `sources.md`,
  which the server has still never opened. The agent picks calendars to form judgement
  from and the dashboard picks calendars to display; the two reach the same calendars
  through different accounts and spell them differently, so one shared list would look
  like a single source of truth while quietly being two. A name matching several
  calendars keeps all of them and folds duplicates by id, because a calendar shared
  from a second account appears once per account and the copies are not identical —
  events Google creates from your email don't travel through sharing.

`agenda.ts` also honours `blocking: false`, which is how a delivery window or a
restaurant booking sits on the agenda without shortening the day. Only an explicit
`false` frees the slot, for the same reason `advancesObjective` refuses a truthy
string: over-reserving understates the time available, while the opposite mistake
promises a focus block that isn't there. `calendar.ts` sets it from EventKit's
`availability`, where only `free` clears it — `notSupported` means the calendar
can't answer, and reserving time you didn't need is the cheaper mistake.

The field is rendered as well as counted: `eventRow` in `public/render.js` marks the
row `data-blocking="false"` and says "marked free" beneath it. Both halves matter.
The emphasis step is one shade, not the `[data-past]` dimming, because a delivery
someone has to be home for is not a row to hide — and the words carry it rather
than the ink alone, for the reason the palette gives at the top of the stylesheet.
`test/agenda-ui.test.ts` holds that, since neither rule is visible to `agenda.ts`.

The server test sets `DAILY_FOCUS_GITHUB=off` and `DAILY_FOCUS_CALENDAR=off` so no
test ever spawns `gh`, reaches GitHub, or trips a calendar permission prompt. Keep it that way: the fixtures in `test/github.test.ts` are invented, and
real PRs, like real briefs, stay out of the repo.

### Sessions record effort, not completion

`sessions.jsonl` is one line per focus session. `actualMinutes` is real elapsed time
rather than the plan, and `endedBy` says how far to trust it:

| `endedBy` | How the session ended | What the number is worth |
|---|---|---|
| `user` | They pressed Stop. | Exact. |
| `away` | The machine sat untouched, so the dashboard closed the session back at the last keypress. | Honest to within a minute; the break is already excluded. |
| `limit` | It outran the two-hour ceiling on a machine that couldn't report idle time. | An upper bound, not a measurement. |

Absent on sessions recorded before this was tracked; treat those as `user` but don't
lean on the duration. The distinction matters because the log exists for an agent to
reason over, and a log that flatters the user is worse than no log — which is also why
`src/presence.ts` closes an abandoned session back at the last sign of life rather than
at the moment it noticed.

## Where the rest of the contract is written down

The rules the *agent* applies — what to gather from each source, how to judge it, the
editorial bar, the id recipes, what the standing objective obliges — live in
`prompts/morning-brief.md` and only there. They are not enforced by this code and
mostly can't be; they are judgement. This file covers what the code does.

Those two documents necessarily restate each other, because the prompt cannot follow a
pointer out of the store. `test/docs-contract.test.ts` fails when either drifts from
the schema on the field-level facts. The judgement calls it cannot check, so if you
change a rule that appears in both places, change both.

## Worked example

`scripts/seed.ts` builds a complete, realistic `items.json` and is the annotated
target shape. Read the script rather than running it — `npm run seed` overwrites the
brief in whatever store it is pointed at. If you want to see the output, give it a
throwaway one:

```sh
DAILY_FOCUS_DATA=$(mktemp -d) npm run seed
```
