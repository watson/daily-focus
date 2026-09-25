# Set up Daily Focus

[Back to the README](README.md)

Daily Focus needs Node.js 22.18 or newer. Node 24 is recommended. GitHub, Jira,
and the live macOS calendar are optional. A separate agent produces the morning brief.

## Start the dashboard

If you tried the README demo, open a new terminal first so its temporary settings
don't carry over. Run these commands from the repo:

```sh
npm install
npm run init
npm start
```

Open [localhost:4321](http://127.0.0.1:4321). Keep the server running while you use
the dashboard. The Today tab stays empty until your agent writes its first brief.

`npm run init` creates templates in `~/.daily-focus/` and links the work prompt and
schema into that directory. For your personal life, see
[A personal instance](#a-personal-instance). It preserves existing files and updates stale symlinks.
You can safely run it again.

## Set your objective and sources

Edit the two files created by `npm run init`:

| File | What to put in it |
|---|---|
| `~/.daily-focus/focus.md` | Your current objective, blockers, and context that should guide priorities. |
| `~/.daily-focus/sources.md` | Your accounts, calendars, and the places your agent should look for updates. |

For example, `focus.md` might start with:

```markdown
---
objective: Ship the checkout reliability update
blocker: Reproduce the staging failure
---
Start with the staging repro before picking up new work.
```

Leave `objective:` blank between objectives; the dashboard shows a quiet reminder and
the agent ranks by urgency alone. To turn the feature off entirely, delete `focus.md`.
Running `npm run init` again recreates it.

Add `<!-- agent-only -->` on its own line before context you don't want displayed.
The agent can read that section, but the server removes it before sending focus
text to the browser. The server never reads `sources.md`.

Keep real names, account handles, and work details in this private store, outside git.

## Connect your morning agent

Choose an agent that can read and write local files and reach the sources you list
in `sources.md`. Schedule it for your working mornings, with access to
`~/.daily-focus/`, and point it at:

```text
~/.daily-focus/prompt.md
```

Use the [scheduled-task wrapper in prompts/README.md](prompts/README.md#wiring-the-morning-brief-into-the-scheduled-task).
It tells the agent to reread the prompt each run. Don't paste a copy of the prompt
into the scheduler or point the briefing agent at this repo's `AGENTS.md`.

The agent writes `items.json`. The dashboard records your actions and focus sessions
for the next run to read. The dashboard doesn't schedule the agent; that stays
with your scheduler. It can start it by hand, though, if you let it:
[Rerun the brief from the dashboard](#rerun-the-brief-from-the-dashboard).

Run the agent once by hand to check access and see your first brief. Then run:

```sh
npm run audit
```

The audit checks the brief for duplicate or drifting IDs, missing history, handled
items raised again, and other contract problems. To compare with a particular brief:

```sh
npm run audit -- --against /path/to/earlier-items.json
```

For Google Tasks, this repo includes an optional
[Apps Script export](apps-script/README.md) that puts a JSON file in Drive for the
agent to read.

## Configure integrations

Copy the settings template once:

```sh
cp .env.example .env
```

If you already have a `.env`, edit it instead. Uncomment the settings you need and
restart the server. Environment variables override `.env`. The file is gitignored
because account and organisation names belong outside git.

### GitHub

Sign in with the GitHub CLI:

```sh
gh auth login
```

The board uses the active account by default. To choose accounts and repositories,
set these in `.env`, replacing the invented examples with your own:

```dotenv
DAILY_FOCUS_GITHUB_ACCOUNTS=alice,alice_corp
DAILY_FOCUS_GITHUB_SCOPE=acme,acme-labs/webapp
```

Named accounts stay fixed even if you switch the active account in another terminal.
For organisations using SAML, make sure the account's token has access. The board
reports access problems instead of silently showing no pull requests.

If your repository has a check that represents its merge policy, list its exact,
case-sensitive name in `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS`. Separate names with
commas. Pending matches appear under *Waiting on merge gate*.

Set `DAILY_FOCUS_GITHUB=off` to disable the board.

### Jira

Sign in with the Atlassian CLI:

```sh
acli jira auth login
```

The board uses that session. You can limit the projects and adjust which statuses
need attention:

```dotenv
DAILY_FOCUS_JIRA_PROJECTS=PROJ,OTHER
DAILY_FOCUS_JIRA_HOLD_STATUSES=Blocked,On Hold
DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES=In Progress
```

Hold statuses suppress *In flight with nothing linked* reminders. They don't hide
other status mismatches. The in-progress list filters the *Working on* view;
without it, that view includes every status Jira puts in its in-progress category,
which may include In Review.

Clicking a status in the dashboard writes one transition to Jira. All other Jira
access is read-only. See the [ticket board guide](README.md#the-jira-ticket-board)
for workflow limits and undo behavior.

Set `DAILY_FOCUS_JIRA=off` to disable the board.

### Live calendar on macOS

The live agenda reads Calendar.app, so meeting changes appear during the day.
It requires the Xcode command line tools with `swiftc`. Build the helper once:

```sh
npm run build:calendar
```

Choose calendar names exactly as Calendar.app shows them, and list your own email
addresses so the dashboard can recognize meetings you've declined:

```dotenv
DAILY_FOCUS_CALENDARS=Work,Personal
DAILY_FOCUS_CALENDAR_ADDRESSES=you@example.com,you@personal.example
```

Start the dashboard and allow the helper's calendar access when macOS asks.
Rebuilding the helper may prompt again.

Without live calendar access, the agenda uses events from the morning brief.
Set `DAILY_FOCUS_CALENDAR=off` to use those events explicitly.

## Ask the assistant

Every item's panel can have an assistant that runs a coding-agent CLI you already
have, headless, against that one item. Click the card, pick a quick action or type a
request, and the answer streams into the panel; you can follow up in the same
conversation.
The quick actions cover the common asks: whether a review comment is right, why CI
is failing, what a thread is asking of you, a reply to an email drafted straight into
Gmail as a draft on the thread.

Install and log in to [Claude Code](https://code.claude.com/docs) or the
[Codex CLI](https://developers.openai.com/codex/cli), then set:

```dotenv
DAILY_FOCUS_ASSISTANT=claude
```

Restart the server and the assistant appears in the panel. Model and effort default to whatever
the CLI is configured with; `DAILY_FOCUS_ASSISTANT_MODEL` and
`DAILY_FOCUS_ASSISTANT_EFFORT` override them. If the server can't find the CLI,
set `DAILY_FOCUS_ASSISTANT_BIN` to its path.

The assistant reads and drafts; it never sends, posts or edits anything, and it has
no checkout to work in. That is deliberate. Fixing merge conflicts or a failing build
belongs in a real coding session; this panel is for the questions you'd otherwise
answer by opening six tabs. The Gmail draft is the one thing it creates, through the
Gmail tool the CLI has: with Claude Code that is the claude.ai Gmail connector, which
`DAILY_FOCUS_ASSISTANT_TOOLS` allows by default; with Codex it is the Gmail plugin
from the Codex app, which the CLI finds through its plugin catalogue. Without either,
the assistant hands you the text instead and says so.

Its instructions live in `prompts/assistant.md`, linked into the store by
`npm run init` as `assistant.md`. What it says stays in the chat in the panel: it
never leaves notes on the item or marks it handled. That is yours to do once you have
read the reply.

## Rerun the brief from the dashboard

When the day has moved on from the morning's brief, the refresh icon beside
"updated … ago" on the Today tab starts the morning agent now, rather than
tomorrow. It runs the agent through a CLI you already have, headless, with the
same wrapper your scheduler uses and the store as its working directory, so it
writes the brief exactly as a scheduled run does. What you have marked done,
snoozed or noted is kept; the brief it replaces is in the archive.

Install and log in to the [Codex CLI](https://developers.openai.com/codex/cli) or
[Claude Code](https://code.claude.com/docs), then set:

```dotenv
DAILY_FOCUS_AGENT=codex
```

Restart the server and the icon appears. Set `DAILY_FOCUS_AGENT_MODEL` and
`DAILY_FOCUS_AGENT_EFFORT` to what your scheduled task uses, so a hand-started
brief is as thorough as a scheduled one; unset, the CLI's own defaults apply. If
the server can't find the CLI, set `DAILY_FOCUS_AGENT_BIN`.

While it runs, a banner shows what the agent is doing and offers Stop. When it
finishes, the banner holds the agent's report — what it wrote, what it dropped as
handled, and any source it could not reach — until you dismiss it.

It reaches your sources the way the CLI does, which may not be the way your
scheduler does:

- **Codex** runs in its workspace-write sandbox with network access, confined to the
  store. Connectors from the Codex app are found through its plugin catalogue. There
  is nobody to approve a command outside the sandbox, so the agent reports that
  restriction for any `gh` command that needs it, such as switching accounts.
- **Claude Code** may write `items.json` and nothing else in the store, and reach
  its sources with only what `DAILY_FOCUS_AGENT_TOOLS` allows. The default covers
  GitHub, Jira, web pages and the claude.ai Gmail connector. Add your calendar, chat
  and document connectors to the list by name, or the brief will report them as
  unreachable.

One run at a time. The dashboard can't see your scheduler, so avoid starting a run
just before a scheduled one; if both run, the later brief replaces the earlier one.

## A personal instance

Daily Focus can brief your personal life as well as your work: email, family
calendars, Apple Reminders, Apple Messages, e-Boks and your own GitHub projects. Run it as a second instance
with its own store, server and morning agent, and set:

```dotenv
DAILY_FOCUS_PROFILE=personal
```

Run `npm run init` with that set. It links the personal prompt,
`prompts/morning-brief-personal.md`, into the store as `prompt.md`, and writes a
`sources.md` template with sections for those sources. The profile also switches off
the Jira board and away detection, and gives the tab a green house icon instead of the blue briefcase. The pull request
board stays on for side projects; point it at your personal account with
`DAILY_FOCUS_GITHUB_ACCOUNTS`, or set `DAILY_FOCUS_GITHUB=off`.

The personal sources often live on another machine, such as a home Mac with access
to Messages and Reminders. Run the instance there, keep `DAILY_FOCUS_HOST` on
loopback, and share it with your other devices through
[Tailscale Serve](https://tailscale.com/kb/1312/serve):

```sh
tailscale serve --bg http://127.0.0.1:4321
```

Only your tailnet can reach it, over HTTPS. Don't bind the server to your LAN
instead: it has no login, and a personal brief holds your mail and messages.

To run both instances on one machine, start the second with its own
`DAILY_FOCUS_DATA`, `DAILY_FOCUS_PORT` and `DAILY_FOCUS_PROFILE` in its environment,
which takes precedence over `.env`.

## Match your working week

Set `DAILY_FOCUS_AGENT_DAYS` to the days your agent runs. It uses cron weekday
numbers: `1-5` for Monday to Friday, `0-4` for Sunday to Thursday, or `0,6` for
weekends.

If unset, the dashboard infers the schedule after three weeks of archived briefs.
Until then it assumes Monday to Friday. `npm run audit` shows the schedule in use.
Days without scheduled runs don't make a brief overdue. Once a refresh is due,
the dashboard allows 45 minutes before showing a warning.

## Settings reference

All settings can go in `.env` or the environment. Restart after changing them.
The brief's `dayStart` and `dayEnd` override the configured working hours. Neither
matters when `DAILY_FOCUS_FREE_WINDOWS` is off.

| Variable | Default | Purpose |
|---|---|---|
| `DAILY_FOCUS_PROFILE` | `work` | `work` or `personal`. Picks the prompt `npm run init` links and the defaults marked below |
| `DAILY_FOCUS_DATA` | `~/.daily-focus` | Where the store lives |
| `DAILY_FOCUS_PORT` | `4321` | Port for the dashboard |
| `DAILY_FOCUS_HOST` | `127.0.0.1` | Loopback only by default, since this is personal data |
| `DAILY_FOCUS_FREE_WINDOWS` | `on`; `off` for personal | `off` shows events only: no free windows in the agenda, and the next event in place of focus time left |
| `DAILY_FOCUS_WORK_START` | `9` | Local hour the working day starts, when the brief doesn't say |
| `DAILY_FOCUS_WORK_END` | `17` | Local hour the working day ends when the brief does not specify it |
| `DAILY_FOCUS_MIN_FREE_WINDOW` | `45` | Minutes before a gap counts as a focus window |
| `DAILY_FOCUS_STALE_AFTER_HOURS` | `24` | When to expect a refresh. Shows an informational message for 45 minutes before warning that the agent may not have run. Counted only in hours a run was due, so days off never trip it |
| `DAILY_FOCUS_AGENT_DAYS` | *inferred* | Weekdays the agent is scheduled on, cron-style and cron-numbered: `1-5` for Monday to Friday, `0-4` for Sunday to Thursday, `0,6` for a weekend-only run |
| `DAILY_FOCUS_SESSION_MINUTES` | `25` | Default focus session length |
| `DAILY_FOCUS_AWAY_AFTER` | `10`; `0` for personal | Minutes of an untouched machine before a session is closed at the last sign of life. `0` turns it off |
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
| `DAILY_FOCUS_JIRA` | `on`; `off` for personal | `off` disables the Jira ticket board; nothing is read |
| `DAILY_FOCUS_JIRA_PROJECTS` | *everything* | Project keys to limit the search to, comma-separated |
| `DAILY_FOCUS_JIRA_HOLD_STATUSES` | *none* | Statuses where standing still is deliberate, comma-separated and spelled as your Jira spells them. Their rows are exempt from *In flight with nothing linked*, and from nothing else |
| `DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES` | *all of them* | The statuses the ticket board's *Working on* view shows, comma-separated and case-insensitive. Use `In Progress` to leave out In Review |
| `DAILY_FOCUS_JIRA_POLL_MINUTES` | `15` | Minutes between reads while a tab is open |
| `DAILY_FOCUS_JIRA_SITE` | *acli's own* | Atlassian site host the browse links are built from. A pasted URL is fine |
| `DAILY_FOCUS_ACLI` | `acli` | Path to the Atlassian CLI, for when the server's PATH lacks it. `~` is expanded |
| `DAILY_FOCUS_ASSISTANT` | `off` | `claude` or `codex` puts an assistant in every item's panel that runs that CLI headless against the item. `off` hides it |
| `DAILY_FOCUS_ASSISTANT_BIN` | *the CLI's name* | Path to the assistant's CLI, for when the server's PATH lacks it. `~` is expanded |
| `DAILY_FOCUS_ASSISTANT_MODEL` | *the CLI's own* | Model passed to the CLI untouched: an alias like `opus`, or a full id. Unset passes no flag |
| `DAILY_FOCUS_ASSISTANT_EFFORT` | *the CLI's own* | Effort passed to the CLI untouched: `low`, `medium`, `high`, `xhigh` or `max`. Unset passes no flag |
| `DAILY_FOCUS_ASSISTANT_TOOLS` | `Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail` | What Claude Code may use without asking, in its permission syntax, comma-separated. Editing tools are denied regardless. Ignored by Codex |
| `DAILY_FOCUS_AGENT` | `off` | `codex` or `claude` puts a refresh icon beside the brief's age that runs the morning agent through that CLI now. `off` hides it |
| `DAILY_FOCUS_AGENT_BIN` | *the CLI's name* | Path to that CLI, for when the server's PATH lacks it. `~` is expanded |
| `DAILY_FOCUS_AGENT_MODEL` | *the CLI's own* | Model passed to the CLI untouched. Match your scheduled task's. Unset passes no flag |
| `DAILY_FOCUS_AGENT_EFFORT` | *the CLI's own* | Effort passed to the CLI untouched. Match your scheduled task's. Unset passes no flag |
| `DAILY_FOCUS_AGENT_TOOLS` | `Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail` | What Claude Code may use to reach your sources, in its permission syntax, comma-separated. Writing `items.json`, and nothing else in the store, is allowed regardless. Ignored by Codex |

## If something looks wrong

- An empty Today tab usually means the agent hasn't written `items.json` yet. Check
  that the agent and dashboard use the same store.
- A stale brief needs an agent run. Refreshing a board doesn't regenerate the brief;
  the icon beside the brief's age does, when `DAILY_FOCUS_AGENT` is set.
- A GitHub or Jira warning may mean the CLI session needs authentication. If the
  server can't find a CLI, set its full path with `DAILY_FOCUS_GH` or `DAILY_FOCUS_ACLI`.
- The boards keep their last successful results during an outage. Check the status
  line for the age of the data.
- If port 4321 is already in use, set `DAILY_FOCUS_PORT` to another port.

`npm run seed` refuses to replace an existing brief and prints the path it found.
Use the [temporary demo](README.md#try-it) for sample data, never your real store.
`npm run seed -- --force` overwrites the brief anyway.
