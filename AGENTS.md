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
`src/env.ts`. `test/docs-contract.test.ts` checks that `.env.example`, the README and
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
| `prompt.md`, `items.schema.json` | `npm run init`, as symlinks into this repo | the agent only |

The server never writes `items.json`, and nothing in this repo writes `actions.jsonl`,
`sessions.jsonl`, `focus.md`, `sources.md` or anything under `archive/` on the agent's
behalf. The action log in particular is append-only and unreproducible — it is the only
record that a thing was dealt with, so nothing may compact or rewrite it.

`prs.json` is the one file here that comes from outside the store: the server's last
successful fetch of the user's open pull requests, written via a sibling temp file and
rename so a reader never sees half of it. It is a cache, not a record — losing it costs
a restart its first paint and nothing else — and `board.ts` reads it back defensively
for the same reason `validate.ts` is forgiving.

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

  Two requests per page, not one, and the split is not an accident. `mergeStateStatus`
  makes GitHub compute a trial merge per pull request, and asking for that in the same
  request as the check rollups times the gateway out — measured at eleven seconds for a
  page of fifty, answered with a 502 or a truncated body. Since an account whose fetch
  fails keeps its previous rows, the symptom is a board that looks merely stale while
  every poll silently fails. So the search carries the rollup, a second request carries
  the merge states keyed by node id, `PAGE_SIZE` stays small enough that the first one
  is answerable, and a merge-state request that fails costs the field and a warning
  rather than the account's rows. `PAGE_SIZE * MAX_PAGES` is the ceiling on pulls read.

  The rollup is read from the individual contexts, not from its summary `state`,
  which has been seen saying `SUCCESS` over a failing required check. The summary is
  consulted only when the contexts can't answer — none returned, or `totalCount`
  exceeds the hundred asked for — and that condition is load-bearing rather than an
  optimisation: the summary also says `FAILURE` for a commit whose only unhappy check
  was cancelled, which would put the reading back exactly where `CANCELLED` used to
  put it.
- `prs.ts` — pure. `judge` decides the court from the facts, the clock and the
  configured merge-gate names; `resolveBoard` joins that with the action log. The
  rules are in its comments and in the README; the tests in `test/prs.test.ts` are the
  spec. The order the questions are asked in is load-bearing and written out above
  `judge`: a draft, then anything only the author can fix, then a review GitHub itself
  still requires, then a configured gate, then any other blocked or unstable merge
  state, then ready, then waiting on reviewers.
- `board.ts` — the poller. Once at startup, then only while an SSE subscriber exists,
  with backoff on failure and a pause near the rate limit. An account that fails a
  round keeps its previous rows. Its GitHub calls are injectable, which is how
  `test/board.test.ts` drives it without a network.

Two rules the board must keep:

The board's six courts, and what each one is claiming, are in `Court` in
`src/types.ts`; the client's `COURT_TITLE` and `COURT_ORDER` in `public/render.js`
have to list the same six.

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
  permission.
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

The server test sets `DAILY_FOCUS_GITHUB=off` so no test ever spawns `gh` or reaches
GitHub. Keep it that way: the fixtures in `test/github.test.ts` are invented, and
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
