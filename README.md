# Daily Focus

A localhost dashboard for "what should I actually do today", meant to live in a
pinned browser tab.

It doesn't fetch anything. A separate agent runs each weekday morning, gathers from
Calendar, Gmail, Slack, GitHub, Jira, Workday and your own Google Tasks list, and
writes the result to a shared file store. The dashboard reads that store and writes
back to it, so when you tick something off, tomorrow's brief leaves it out.

```
you            ──write──▶  ~/.daily-focus/focus.md       ──read──▶  agent + dashboard
morning agent  ──write──▶  ~/.daily-focus/items.json     ──read──▶  dashboard
    ▲                                                                   │
    ├────────read────────  ~/.daily-focus/actions.jsonl   ◀──append─────┤
    └────────read────────  ~/.daily-focus/sessions.jsonl  ◀──append─────┘
```

One owner per file. Nobody writes anybody else's file, so there is no locking, no
clobbering, and no database.

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

Everything is undoable, from the toast or with <kbd>u</kbd>.

| Key | |
|---|---|
| <kbd>j</kbd> / <kbd>k</kbd> | next / previous item |
| <kbd>e</kbd> | done |
| <kbd>s</kbd> | snooze until tomorrow |
| <kbd>x</kbd> | dismiss |
| <kbd>n</kbd> | note |
| <kbd>o</kbd> | open the source link |
| <kbd>u</kbd> | undo the last action |
| <kbd>f</kbd> | focus mode |
| <kbd>p</kbd> | start / stop a focus session on the selected item |
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

## Configuration

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
  focus.ts     focus.md, the standing objective
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
