# Daily Focus

A localhost dashboard for "what should I actually do today", meant to live in a
pinned browser tab.

The judgement comes from somewhere else. A separate agent runs each weekday morning,
gathers from Calendar, Gmail, Slack, GitHub, Jira, Workday and your own Google Tasks
list, and writes the result to a shared file store. The dashboard reads that store and
writes back to it, so when you tick something off, tomorrow's brief leaves it out.

```
you            ──write──▶  ~/.daily-focus/focus.md       ──read──▶  agent + dashboard
morning agent  ──write──▶  ~/.daily-focus/items.json     ──read──▶  dashboard
    ▲                                                                   │
    ├────────read────────  ~/.daily-focus/actions.jsonl   ◀──append─────┤
    └────────read────────  ~/.daily-focus/sessions.jsonl  ◀──append─────┘
dashboard      ──write──▶  ~/.daily-focus/prs.json       ──read──▶  dashboard
```

One owner per file. Nobody writes anybody else's file, so there is no locking, no
clobbering, and no database.

The one thing the dashboard gathers itself is the list of pull requests you have open,
on a second tab. That is state rather than judgement, and it changes during the day,
so it is polled live rather than left to the morning. See
[The pull request board](#the-pull-request-board).

`focus.md` is the standing objective, and it's the only input that isn't reactive.
Everything else describes what other people did overnight, and a brief built from
those alone cannot report the one thing that matters most: that nothing today moves
the work you're measured on. Nobody sends a notification about work that didn't
happen. So the prompt requires the agent to write that item when it's true.

The server also snapshots each brief to `archive/items-<date>.json`. Joining that
against the action log answers the question the dashboard leads with, *how many
working days since anything moved the objective*, and leaves a dated record of what
you shipped. That record is what a review asks for and nobody has.

## Run it

```sh
npm install
npm run init     # creates ~/.daily-focus/ with focus.md and sources.md to fill in
npm run seed     # optional: writes a realistic sample brief so there's something to look at
                 # it overwrites items.json, so skip it once an agent is running
npm start        # http://127.0.0.1:4321
```

`npm run init` writes commented templates for the two files the dashboard can't
invent for you: the standing objective, and the list of places worth looking. Then it
tells you what to edit. It also symlinks the morning prompt and the payload schema
into the store, so you can point your agent at `~/.daily-focus/prompt.md` and it
never needs to read anything outside that directory.

It never overwrites. Run it twice and the second run reports what is already there
and changes nothing. It doesn't create `items.json`, `actions.jsonl` or
`sessions.jsonl`, since each of those has exactly one writer and all three read as
empty when absent.

Settings live in a `.env` file at the repo root. Copy `.env.example` to `.env` and
uncomment what you want to change; see [Configuration](#configuration).

Node 22.18 or newer, 24 recommended. There is no build step. The server is
TypeScript run directly through Node's type stripping, and the frontend is plain ES
modules. The only dependencies are dev-time `typescript` and `@types/node`.

```sh
npm run dev        # restart on change
npm test           # node:test
npm run typecheck  # tsc --noEmit
npm run audit      # check the current brief against the contract
```

`npm run audit` re-derives the agent's own verification checklist from the files on
disk: unique ids, priority cap, day bounds, whether anything already handled got
re-raised, whether `firstSeen` survived, whether the private half of `focus.md`
leaked into anything rendered, and whether the ids stayed stable since the previous
brief. The agent self-reports on all of this, and that is the sort of claim not to
take on trust, because the reasoning that got a rule wrong will also report that it
followed it. Add `-- --against <path>` to diff a specific earlier brief. Without it,
the audit picks the most recent archived run.

## Using it

Each item can be marked done, snoozed, dismissed, or annotated with a note aimed at
the agent ("already replied on Slack"). The dashboard appends all four actions to
`actions.jsonl`. The agent folds that log on its next run and drops what you've
handled.

The distinction matters:

- **Done.** You handled it.
- **Snooze.** Not today. It comes back on the date you pick.
- **Dismiss.** It wasn't worth raising, and the agent can learn from that.
- **Note.** Free text for the agent. It doesn't change status, it tells the agent why.

Everything but a note is undoable, from the toast or with <kbd>u</kbd>. A note is
append-only, like the log it lands in.

| Key | |
|---|---|
| <kbd>1</kbd> / <kbd>2</kbd> | the Today tab / the pull request board |
| <kbd>j</kbd> / <kbd>k</kbd> | next / previous item |
| <kbd>e</kbd> | done |
| <kbd>s</kbd> | snooze until tomorrow |
| <kbd>x</kbd> | dismiss |
| <kbd>n</kbd> | note |
| <kbd>o</kbd> | open the source link |
| <kbd>u</kbd> | undo the last action |
| <kbd>f</kbd> | focus mode |
| <kbd>p</kbd> | start / stop a focus session on the selected item |
| <kbd>r</kbd> | refresh the pull request board now |
| <kbd>?</kbd> | shortcuts |

Focus mode (<kbd>f</kbd>) collapses the page to the objective, the single top-ranked
item, and today's agenda. A list of fourteen open items is fourteen invitations to
switch task, so this view answers the one question worth asking mid-work, what am I
doing right now, and hides the rest. It persists across reloads, so it's still there
when you come back from whatever interrupted you.

The page updates itself over SSE whenever the store changes, so when the agent runs
you see the new brief without touching the tab.

That stream carries state, not code, so the server also fingerprints `public/` and
sends the result with each push. When the fingerprint changes the tab reloads
itself. Without that, editing a renderer would leave a pinned tab showing fresh data
through stale markup, which looks exactly like the change not working and can
persist for days. If you're mid-way through typing a note it offers a reload instead
of taking the page away from you.

## The focus timer

Press <kbd>p</kbd> on an item, or hit **Focus** on the row. The countdown lives in
the tab title, so a pinned tab reads `18:42 · Restore the staging build` while
you're looking at something else. That is where most of the value is.

It's advisory. When the target passes it says so and keeps counting. It never stops
the work or forces a break, because a fixed interruption at 25 minutes is as likely
to cut across a run that was finally going well as it is to help. Set the default
with `DAILY_FOCUS_SESSION_MINUTES`.

It runs on the server, so it survives the tab reloading itself and the laptop lid
closing. It also knows your calendar, and says when a session would run into your
next meeting.

### It stops when you leave

This is the one thing it does on its own. Forgetting to stop the timer before lunch
or an afternoon out used to write two hours of "focus" into the record, with the
last forty minutes spent away from the desk. A log kept for an agent to reason over
is worse than useless once it flatters you.

So while a session runs, the server asks macOS how long the machine has been
untouched, via `ioreg` every 30 seconds. That is the same idle time that dims your
screen. It says nothing about the dashboard tab, which can't tell deep work in an
editor from an empty chair. Once nothing has happened for `DAILY_FOCUS_AWAY_AFTER`
minutes, the server closes the session back at the last keypress, not at the moment
it noticed. The threshold only decides how fast it catches on, so ten still minutes
over a design doc cost you nothing.

Shutting the lid needs no special handling. It stops the polling, and the gap that
leaves is the same evidence. That also covers a server restart, and it's the one case
where a keypress on waking is not believed, since it can't vouch for the hour the
laptop spent asleep.

When you sit back down the bar says what it did and what it wrote, with the item one
click from resuming. On a machine that can't report idle time the probe returns no
answer, the server closes nothing early, and the old two-hour ceiling still applies,
marked in the log as a bound rather than a measurement.

Every session appends to `sessions.jsonl`, which the agent reads. That is why the
timer is built here rather than borrowed from a timer app. The system learns what you
*worked on* as well as what you *finished*. A hard blocker can absorb three days with
nothing to mark done, and without this record that is indistinguishable from doing
nothing.

## The pull request board

The second tab (<kbd>2</kbd>) is every pull request you have open, sorted by whose
move it is. It exists because the brief is edited down on purpose, and a PR is not a
task: it outlives any single obligation on it, and "nudge the reviewers" needs doing
again next week. So the board is a status board rather than a to-do list, and it is
the one thing the dashboard fetches itself, since state changes during the day and a
review that landed at eleven should not read as "waiting on reviewers" until tomorrow.

Seven buckets, most actionable first:

- **Waiting on you.** Changes requested, CI red, a merge conflict, a branch behind
  its base, or someone acted after you did. The row says which.
- **Ready to merge.** Approved, nothing red, and GitHub agrees the merge would go
  through. Nothing left but the button.
- **Waiting on reviewers.** Nobody has acted since your last push. After a day it
  says *time to ask*.
- **Waiting on merge gate.** A check you named in `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS`
  hasn't finished. See below.
- **Merge blocked by GitHub.** GitHub reports `BLOCKED` but names no unfinished
  check. This is a repository or ruleset policy, not a claim that CI is running.
- **Waiting on checks.** An ordinary check is still running, or GitHub reports the
  merge as unstable. The row names whatever is still running when GitHub returns it.
- **Drafts.** Not asking anyone for anything. After a fortnight untouched it says so,
  because a draft you meant to finish and a draft you meant to abandon look the same.

Bots don't count as people acting. A review that approves is read as ready rather
than as your move, unless a comment landed after it. Reviewers GitHub is still
*asking* don't hold a pull request back on their own — GitHub keeps asking long after
the required approvals have landed, so only a review GitHub itself still requires
counts.

Three things you can do to a row, all through the same action log as the brief and
under the same `github:pr:` ids, so the morning agent sees them too:

- **Park** it until a date. It drops into a drawer and comes back when the date
  arrives. This is how a draft is shelved on purpose.
- **Note.** Free text, shown on the row and read by the agent.
- **Nudged.** On rows waiting on reviewers, and only those — on a gate, blocked
  merge, or check row the board has no idea whose action is missing, so it suggests
  asking nobody. You asked on Slack, which GitHub can't see, so this records a note
  saying so and the *time to ask* flag starts over from now.

Done and dismiss don't apply: marking the brief's "CI failing on #3402" done doesn't
close #3402, and the board shows what is open.

### Never ready when GitHub says blocked

`mergeable` only answers "does this conflict", which is why an approved, green,
conflict-free pull request could still be presented as ready while GitHub was quietly
refusing to merge it. `mergeStateStatus` is the broader answer, and it is what
**Ready to merge** requires: `CLEAN` or `HAS_HOOKS`, nothing else. `BLOCKED` and
`UNSTABLE` are not the same answer: a `BLOCKED` pull request with no unfinished
check goes to **Merge blocked by GitHub**, while an unstable one goes to
**Waiting on checks**. `BEHIND` and `DIRTY` go to **Waiting on you**, and an
`UNKNOWN` merge state is reported as GitHub not having worked it out yet rather than
assumed to be fine.

Some repositories put review policy, ownership, security and whatever else behind a
single status check, and let that one check speak for all of it. Such a check pending
means the merge is refused — but not whose action is missing: reviewers', yours, or
some system's. So naming those checks in `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS` gets
them a bucket that claims nothing more than it knows, with the check's name and
GitHub's own link to it, and no suggestion to nudge anybody. Names are matched exactly
and case-sensitively, the way GitHub's repository rules name a required check, and the
setting holds your organisation's names rather than any that ship here. Unset, nothing
gets that treatment and the rows simply say *waiting on checks*.

### A cancelled check is not a failing one

`gh pr checks` counts a cancelled check run as red, and on a merge queue that reading
is actively wrong. Queue an approved pull request whose merge gate never clears and the
queue eventually drops the entry, which lands on the pull request as a cancelled check
— caused by the gate, and cured by nothing the author can do. Called red, it takes the
row to **Waiting on you** and hides the gate that is the actual answer.

So a cancellation is read as what it is: a run that reached no verdict. Nobody can say
from the API who stopped it or why, so it counts as neither red nor still running, and
the court comes from whatever else is outstanding — usually the gate or check that
caused it. The names still appear under the row as *cancelled, no verdict*, because a
run you cancelled yourself is worth seeing even though it decides nothing. A check that
genuinely failed alongside one is unaffected: that failure is still red, still yours,
and needs no special case.

GitHub's own one-line summary of the rollup calls that commit `FAILURE`, so the summary
is consulted only where the individual checks can't answer — none came back, or there
are more than the hundred fetched. It is the weaker reading either way: it has also been
seen claiming `SUCCESS` over a failing required check.

### Where it gets its access

It borrows the GitHub CLI's login rather than keeping a token of its own. With nothing
configured it polls whatever account `gh` has active on github.com, so there is no
setup beyond `gh auth login`. If `gh` holds several accounts it says which one it
picked, since *active* is whichever you last switched to in a terminal. Name them in
`DAILY_FOCUS_GITHUB_ACCOUNTS` to poll more than one, each resolved through
`gh auth token --user` so a `gh auth switch` elsewhere changes nothing here.

`DAILY_FOCUS_GITHUB_SCOPE` narrows it to organisations, users or repositories, which
is how your open source PRs stay off a work board. Each owner in scope is probed before
searching, because a search scoped to a SAML-protected organisation the token isn't
authorised for returns nothing, and nothing is what a quiet board looks like. The
probe turns that into a warning naming the account, the organisation and the fix. An
organisation an account simply isn't a member of is not a warning; with two accounts,
each seeing its own is the normal case. Only a name no polled account can find is
flagged as a likely typo.

It polls once at startup and then every `DAILY_FOCUS_GITHUB_POLL_MINUTES` while a
browser tab holds the page open, backing off on failure and pausing near the rate
limit. The last good answer is kept in `prs.json` in the store, so a restart or an
outage shows the board as of an hour ago rather than an empty one, and the status line
says which. `DAILY_FOCUS_GITHUB=off` turns the whole thing off.

## Configuration

Every setting is an environment variable, and every one can be put in a `.env` file at
the repo root instead. `.env.example` lists them all, explained and commented out; copy
it to `.env` and uncomment what you change. A variable set in the real environment
always beats the file, and the file is gitignored because it will hold org names and
logins. Restart to apply.

| Variable | Default | |
|---|---|---|
| `DAILY_FOCUS_DATA` | `~/.daily-focus` | Where the store lives |
| `DAILY_FOCUS_PORT` | `4321` | |
| `DAILY_FOCUS_HOST` | `127.0.0.1` | Loopback only by default, since this is personal data |
| `DAILY_FOCUS_WORK_START` | `9` | Local hour the working day starts, when the brief doesn't say |
| `DAILY_FOCUS_WORK_END` | `17` | Same. The brief's `dayEnd` wins, since the agent read today's calendar |
| `DAILY_FOCUS_MIN_FREE_WINDOW` | `45` | Minutes before a gap counts as a focus window |
| `DAILY_FOCUS_STALE_AFTER_HOURS` | `24` | When to warn that the agent hasn't run. Counted only in hours a run was due, so days off never trip it |
| `DAILY_FOCUS_AGENT_DAYS` | *inferred* | Weekdays the agent is scheduled on, cron-style and cron-numbered: `1-5` for Monday to Friday, `0-4` for Sunday to Thursday, `0,6` for a weekend-only run |
| `DAILY_FOCUS_SESSION_MINUTES` | `25` | Default focus session length |
| `DAILY_FOCUS_AWAY_AFTER` | `10` | Minutes of an untouched machine before a session is closed at the last sign of life. `0` turns it off |
| `DAILY_FOCUS_GITHUB` | `on` | `off` disables the pull request board; nothing is polled |
| `DAILY_FOCUS_GITHUB_ACCOUNTS` | *gh's active account* | Logins to poll as, comma-separated, each resolved with `gh auth token --user` |
| `DAILY_FOCUS_GITHUB_SCOPE` | *everything* | Organisations or `owner/repo` entries to limit the board to, comma-separated |
| `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS` | *none* | Check names that stand for a repository's whole merge policy, comma-separated and matched exactly. Their rows get the *Waiting on merge gate* bucket |
| `DAILY_FOCUS_GITHUB_POLL_MINUTES` | `5` | Minutes between polls while a tab is open |
| `DAILY_FOCUS_GH` | `gh` | Path to the GitHub CLI, for when the server's PATH lacks it. `~` is expanded |
| `DAILY_FOCUS_CALENDAR` | `on` | `off` disables the live agenda; the brief's own events are used instead |
| `DAILY_FOCUS_CALENDARS` | *none* | Calendar names to show, comma-separated and spelled as Calendar.app spells them. Empty means nothing is read |
| `DAILY_FOCUS_CALENDAR_ADDRESSES` | *none* | Your own email addresses, comma-separated, used to find your reply among an event's attendees |
| `DAILY_FOCUS_CALENDAR_POLL_MINUTES` | `5` | Minutes between calendar reads while a tab is open |
| `DAILY_FOCUS_CALENDAR_APP` | *built copy* | Path to the calendar helper bundle, if it isn't the one `npm run build:calendar` produces |

### When is the weekend?

The dashboard can't say a brief is late without knowing which mornings a brief was
due, and Monday to Friday is a guess about your calendar. It is wrong for anyone on
the Sunday to Thursday week that is normal in Israel and much of the Gulf. So the
dashboard works the schedule out in this order: `DAILY_FOCUS_AGENT_DAYS` if you've
set it, otherwise the days briefs have landed on in `archive/`, otherwise Monday to
Friday.

The inferred answer needs three weeks of history and takes a majority, so one brief
you generate by hand on a Sunday doesn't read as a schedule and a week off doesn't
read as a cancelled Monday. Until then it uses the default, and `npm run audit`
prints the schedule and where it came from, because an inferred schedule being wrong
is otherwise invisible. Set the variable if you'd rather not wait or your week is
unusual. It always wins.

It doesn't ask `Intl.Locale.getWeekInfo()`, which does know `he-IL` has a Friday and
Saturday weekend. That answers a different question, what the region's weekend is
rather than what this machine's scheduled task does, and it needs a locale that can't
be sourced reliably. On the author's Mac, Node resolves `en-US` while the OS region is
set to a different country. A schedule you set, or one the dashboard observed, beats
one that is merely plausible.

## Wiring up your agent

[`prompts/morning-brief.md`](./prompts/morning-brief.md) is the prompt this setup
runs. `npm run init` symlinks it into the store as `prompt.md`, and that store path
is the only thing your scheduled task should name. The agent reads and writes one
directory and nothing else. The prompt is self-contained and holds nothing not
addressed to the agent, since it's read verbatim every morning.
[`prompts/README.md`](./prompts/README.md) covers the wiring, and why the boundary is
strict.

[`AGENTS.md`](./AGENTS.md) is the other side of the same contract, for whoever is
changing this repo's code. It says what the dashboard may assume about a brief and
what it has to tolerate. It is not meant to be handed to a briefing agent. The prompt
is. [`schema/items.schema.json`](./schema/items.schema.json) is the machine-readable
payload, and the tests check both documents against it.

Nothing here names a particular model or vendor. The dashboard's only requirement is
that something outside this project writes `items.json` to the contract. Which agent
does it is your choice, and it records its own name in `generatedBy`.

[`apps-script/`](./apps-script/) is the one source the agent can't reach on its own.
Google Tasks has no connector and no Google-published MCP server, and the Calendar API
never returns tasks. So a small Apps Script exports them to a JSON file in Drive,
which the agent reads like any other document. Its
[README](./apps-script/README.md) explains why it isn't a local script like everything
else.

## Layout

```
src/
  types.ts     the contract, documented
  config.ts    env-driven configuration
  env.ts       the repo-root .env, layered under the real environment
  focus.ts     focus.md, the standing objective
  github.ts    tokens from gh, the GraphQL search, and what a PR node becomes
  prs.ts       whose court a pull request is in, joined with the action log
  board.ts     the poller, and prs.json
  archive.ts   dated brief snapshots, and days-since-progress
  sessions.ts  focus sessions, and the session log
  presence.ts  whether anyone is at the machine
  validate.ts  forgiving parser for LLM-written JSON
  store.ts     read both files, fold the action log
  agenda.ts    conflicts and free windows from today's events
  server.ts    HTTP, SSE, POST /api/actions
  watch.ts     debounced fs watching
prompts/
  morning-brief.md   the scheduled prompt, nothing but prompt
                     (npm run init symlinks it into the store as prompt.md)
  README.md          how it's wired into the scheduler
apps-script/
  tasks-export.gs    exports Google Tasks to a JSON file in Drive, on an hourly trigger
  README.md          why it's there, and how to deploy it
public/        vanilla ES modules, no build step
  api.js       server calls
  format.js    dates and safe inline Markdown
  render.js    state to DOM, one pure-ish function per region
  app.js       wiring, optimistic updates, keyboard
```

`render.js` is a plain state-to-DOM function with no local state, so swapping it for
React later is mechanical rather than a rewrite.

## API

| | |
|---|---|
| `GET /api/state` | The folded state: items with status, agenda, stats, warnings |
| `GET /api/events` | SSE stream, pushes `state` on every store change |
| `POST /api/actions` | `{id, action, until?, text?}`. Appends to the log, returns fresh state |
| `POST /api/board/refresh` | Polls GitHub now. Returns fresh state once it has |
| `GET /api/health` | |

## Design notes

- **The action log is the source of truth for what's handled.** Read-status doesn't
  count, and neither does whether the item still appears upstream. An email you
  replied to by phone looks identical to one you ignored, and only your click
  distinguishes them.
- **An LLM writes `items.json`.** The parser salvages what it can. It skips a bad
  item with a visible warning rather than taking the brief down with it, and reads
  retry briefly in case they catch a non-atomic write mid-flight.
- **Ageing is deliberate.** `firstSeen` drives a "5 days on the list" pill. Things
  that linger should look worse over time.
- **`focus.md` has a private half.** The agent reads anything after
  `<!-- agent-only -->`, and the server strips it before the state reaches the
  browser, so context you don't want on screen during a screen share can still steer
  the ranking. A test asserts it never survives serialisation.
- **Colour never carries meaning alone.** Source hues come from a CVD-validated
  palette and always sit beside the source name in text.
- **The board is state, not judgement.** The agent decides what deserves attention;
  the server only reads what GitHub can say for certain, and reads it deterministically
  so two accounts either both work or fail visibly. Whose court a PR is in is computed
  at render time from the facts, the clock and the action log, never stored — and
  neither is whether a pending check is one of your merge gates, since that answer
  comes from your configuration rather than from GitHub.
