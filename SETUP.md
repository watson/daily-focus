# Set up Daily Focus

[Back to the README](README.md)

Daily Focus runs on your own computer. Each morning it has Claude Code or Codex,
whichever you already use, write a brief of your day, and it keeps the brief beside
live boards for your pull requests and Jira tickets. This guide goes from installing
it to your first brief, then covers each integration and every setting.

You need:

- **Claude Code or Codex**, installed and logged in: [Claude Code](https://code.claude.com/docs)
  or the [Codex CLI](https://developers.openai.com/codex/cli). It writes the brief,
  and answers when you ask about an item. Each needs a paid plan: any paid Claude
  plan for Claude Code, and ChatGPT Plus or higher for Codex, whose Free and Go
  plans have it only in the desktop app.
- **A Mac with Apple silicon** for the menu bar app, or **Node.js 22.18 or newer**
  (Node 24 is recommended) on any other computer.
- Optionally, the GitHub CLI (`gh`) for the pull request board, and the Atlassian
  CLI (`acli`) for the Jira board.

## Install

### On a Mac: the menu bar app

The app is the simplest way on a Mac. It carries everything it runs, Node.js and
the calendar helper included, keeps the dashboard running, and updates itself. It
needs Apple silicon and macOS 13.5 or newer.

1. Download `Daily-Focus.dmg` from the
   [latest release](https://github.com/watson/daily-focus/releases/latest).
2. Open it, drag **Daily Focus** to Applications, and open it from there.
3. The app has no window and no Dock icon. Click the bullseye in the menu bar and
   choose **Open Daily Focus**: the dashboard opens in your browser, on the setup
   screen.
4. Tick **Open at Login** in the same menu, so the dashboard is running when the
   morning brief is due.

See [The menu bar app](#the-menu-bar-app) for the rest of its menu and how it
updates.

### With Node.js

On any computer with Node.js 22.18 or newer:

```sh
npx daily-focus
```

That starts the dashboard and opens [localhost:4321](http://127.0.0.1:4321) in your
browser, on the setup screen. It runs only as long as that terminal does, and the
morning brief is written only while it runs. On a Mac without the app, install it
and run it in the background instead:

```sh
npm install -g daily-focus
daily-focus service
```

See [A LaunchAgent](#a-launchagent). [Commands](#commands) lists the rest.

### Just looking

To look around on invented sample data first, without connecting anything:

```sh
npx daily-focus --demo
```

See [Try it](README.md#try-it) in the README.

## The setup screen

A new dashboard opens on the setup screen. It first looks for Codex and Claude
Code, on your login shell's `PATH` and where their installers put them, and checks
that each is logged in. If one is ready, it uses it, Codex first, and says so in a
line you can **Change**. If neither is, it says what is wrong with each and the
command that fixes it, such as `codex login` or `claude auth login`, links to the
installers with the plan each needs, and takes the path to one it couldn't find.

Then it asks a few questions, one at a time, each with the answer you most likely
want already ticked:

1. **Who writes the brief**, only when it couldn't pick for you.
2. **What it briefs**: your work, or your personal life. See
   [A personal instance](#a-personal-instance) to run both.
3. **When it runs**, and on which days.
4. **Who you are**: your name as meeting notes write it, your email, and each
   GitHub account `gh` is logged in to, with what it's for.
5. **What else to show**: the pull request board and the Jira board.
6. **Which calendars** the brief reads. The live agenda follows them too.
7. **Your objective**, which the brief ranks your day against, and what's in the
   way. It suggests a few from what you've been doing, and writes one up from
   whatever you tell it, however rough.

While you answer, Claude Code or Codex works on the questions ahead in the
background. It reads `gh`, your mail and your calendars to tell work from personal,
so most answers are a click. Each card says in a sentence why it ticked what it did;
reply under it with what to change, such as "also the on-call rota", and it tries
again. **Change** reopens an earlier answer. Two questions can be skipped: **Decide
later** leaves the brief without an agent for now, and **Leave this out** leaves out
who you are.

These sessions only read, in an empty directory. They run on the newest flagship
model at low effort, which measured as fast as the lighter models and, unlike them,
told your calendars from other people's. When your ChatGPT plan or workspace can't
use Codex's first model, as an Enterprise or Edu workspace can't until an admin
turns GPT-6.1 Sol on, they run on GPT-6 Sol, which answered the same; never on
anything lighter. When Claude or Codex is busy, the card says so and offers to try
again.

Nothing is saved until the last step. It shows the source list your answers add up
to, which the agent will read each morning, and its button, **Write my first
brief**, saves your settings, the source list (unless you already have one, which
it leaves alone) and your objective, and runs the morning agent once while you
watch. If you left the agent for later, the button is **Finish setup**, and no
brief is written yet. The [assistant](#the-assistant) comes on with the same tool
as the agent, unless you had already set it.

Every answer can be changed afterwards on the settings page: the gear in the
header, or <kbd>,</kbd>.

## Your objective and sources

Both are on the settings page, as **Your objective** and **Where the agent looks**.
They are two files in the store, `~/.daily-focus`, which you can also edit by hand:

| File | What to put in it |
|---|---|
| `focus.md` | Your current objective, what's blocking it, and context that should guide priorities. |
| `sources.md` | Your accounts, calendars, and the places the agent should look for updates. |

`focus.md` might start like this:

```markdown
---
objective: Ship the checkout reliability update
blocker: Reproduce the staging failure
---
Start with the staging repro before picking up new work.
```

Leave the objective blank between objectives: the dashboard shows a quiet reminder,
and the brief is ranked by urgency alone. Delete `focus.md` to turn objectives off.

Put `<!-- agent-only -->` on a line of its own before context you want the agent to
read but the board not to show: only the editor on the settings page shows what
follows it. The source list, likewise, is shown only in its editor.

The dashboard saves a file only if it hasn't changed since the editor opened it.
If you edited it by hand in the meantime, the editor says so and offers to load
your version.

To write both files by hand from the start, `daily-focus init` creates the store
with a template for each, and `daily-focus init --profile personal` the personal
ones. It never replaces a file that exists.

## The morning brief

### When it runs

The dashboard runs the agent at 07:00 your time, Monday to Friday. Change that under
**Morning agent** in the settings: **Run it at** (`DAILY_FOCUS_AGENT_AT`), such as
`06:30`, and **On these days** (`DAILY_FOCUS_AGENT_DAYS`), in cron weekday numbers:
`1-5` for Monday to Friday, `0-4` for Sunday to Thursday, or `0,6` for weekends.
With **Run it at** set to `off`, it runs only when you ask.

The dashboard has to be running. If it wasn't at that time, it runs the agent as
soon as it starts that day. It runs once a day: the first run of the day, by the
clock or by you and whatever became of it, is the day's run. So a run you start
before the set time is the morning's, and a failed morning is reported once, not
retried. The first brief always comes from the setup screen's last button, so the
clock never runs the agent before you've told it where to look.

"Your time" is the time zone of the browser you last opened the dashboard in, or
the Mac's, when the Mac it runs on changes zone; whichever changed last wins. So a
dashboard on a Mac at home follows you abroad as soon as you open it there, and
the Mac covers the morning after a flight before you have. Every time on the page
is in that zone, and a browser somewhere else says so under the page title.

### Its runs

The refresh icon beside "updated … ago" on the Today tab starts a run now, such as
when the morning's brief is out of date by lunch. A run rewrites the brief from
scratch. What you've marked done, snoozed or noted is kept, and the brief it
replaces goes to the archive. While it runs, a banner says so and offers **Stop**;
click the banner to watch. A run that fails that day stays as a warning until you
dismiss it.

The agent reads your sources in parallel, each through a subagent of its own. While
it runs, the panel says in one line what it is on and how many steps it has taken,
beside a **Stop** button. Open that line to follow along: what it says, each
command it runs and each thing it reads, with each subagent under the step that
started it. Claude Code reports its subagents itself. Codex doesn't, so for a
Codex run the dashboard reads them from Codex's own session files, under
`~/.codex/sessions` or `$CODEX_HOME`, and only ever reads them.

Click "updated … ago" to open the latest run. Its report says what it wrote, what
it dropped as handled, and which sources it couldn't reach, with everything it did
on the way folded away beneath. Read it after your first run. Below it is a field
to ask the agent about the run, in the same session, so it answers from what it
actually did: why it dropped an item, or whether it can find something now. A
question can't change the brief; if something should change, it says what, and you
run it again. Earlier runs are folded away at the foot of the panel.

The dashboard does one thing at a time: a run, or a question about one.

### Model and effort

**Model** (`DAILY_FOCUS_AGENT_MODEL`) and **Effort** (`DAILY_FOCUS_AGENT_EFFORT`) are
passed to Claude Code or Codex as they are, and left to its own defaults when
empty. A brief is worth a high effort. **Search deleted mail**
(`DAILY_FOCUS_AGENT_SEARCH_TRASH`) lets the agent look in your mail's Trash as well.
If the dashboard can't find the tool, set **Path to the CLI** (`DAILY_FOCUS_AGENT_BIN`).

For Google Tasks, an optional [Apps Script export](apps-script/README.md) puts a
JSON file in Drive for the agent to read.

## Connect your tools

Settings are saved in the store's `settings.json` by the settings page, and saving
one restarts the dashboard once nothing is running. Each is named here by its
label on the page and its key in the file. If you edit the file by hand, restart
the dashboard afterwards.

### GitHub

Sign in with the GitHub CLI:

```sh
gh auth login
```

The pull request board uses `gh`'s active account. Under **Pull requests**, set
**Accounts** (`DAILY_FOCUS_GITHUB_ACCOUNTS`), such as `alice, alice_corp`, to read
as particular accounts, and **Only these organisations or repositories**
(`DAILY_FOCUS_GITHUB_SCOPE`), such as `acme, acme-labs/webapp`, to narrow the board.
Named accounts stay fixed when you switch the active one in a terminal. For an
organisation that uses SAML, make sure the account's token is authorised for it:
the board reports a refused read rather than showing no pull requests.

If a repository has a check that stands for its whole merge policy, put its exact,
case-sensitive name in **Merge gate checks** (`DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS`).
Pull requests waiting on it get the *Waiting on merge gate* bucket.

Turn **Pull request board** (`DAILY_FOCUS_GITHUB`) off to hide the board.

### Jira

Sign in with the Atlassian CLI:

```sh
acli jira auth login
```

Under **Jira tickets**, **Only these projects** (`DAILY_FOCUS_JIRA_PROJECTS`), such
as `PROJ, OTHER`, narrows the board. **Statuses that mean on hold**
(`DAILY_FOCUS_JIRA_HOLD_STATUSES`), such as `Blocked, On Hold`, stops tickets in them
showing as *In flight with nothing linked*, and changes nothing else. **Statuses
that mean working on it** (`DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES`), such as
`In Progress`, is what the *Working on* view shows; without it, the view shows every
status Jira counts as in progress, which may include In Review.

Clicking a ticket's status on the board moves the ticket in Jira. That is the only
change the dashboard makes there. See the
[ticket board](README.md#the-jira-ticket-board) for what Jira may refuse and how undo
works.

Jira can hear of a pull request days late, so the board also asks GitHub, with the
pull request board's accounts and scope. With the pull request board off, it uses
Jira alone.

Turn **Jira ticket board** (`DAILY_FOCUS_JIRA`) off to hide the board.

### Calendar on a Mac

The live agenda reads Calendar.app through a small helper, so a meeting moved or
declined during the day shows at once. Under **Calendar**, tick the calendars to
show (`DAILY_FOCUS_CALENDARS`) and list your own addresses in **Your email
addresses** (`DAILY_FOCUS_CALENDAR_ADDRESSES`), so the dashboard can tell which
meetings you've declined. The first read asks for calendar access.

The menu bar app carries the helper. With `npx` or `npm`, build it once; it needs
the Xcode command line tools, and goes in `~/Library/Application Support/Daily Focus/`,
where every copy of the dashboard finds it:

```sh
daily-focus build-calendar
```

Rebuilding it may ask for access again. Without the helper, or with **Live agenda**
(`DAILY_FOCUS_CALENDAR`) off, the agenda shows the events in the morning brief.

## The assistant

Every item's panel has an assistant that runs Claude Code or Codex against that one
item. Click a card, pick a quick action or type a request, and the answer streams
into the panel, where you can follow up. The quick actions cover the common asks:
whether a review comment is right, why CI is failing, what a thread is asking of
you, and a reply to an email, drafted straight into Gmail.

Setup turns it on with the tool that writes the brief. To change that, set **Answer
questions with** under **Assistant** (`DAILY_FOCUS_ASSISTANT`). **Model**
(`DAILY_FOCUS_ASSISTANT_MODEL`) and **Effort** (`DAILY_FOCUS_ASSISTANT_EFFORT`) are
passed on as they are, and **Path to the CLI** (`DAILY_FOCUS_ASSISTANT_BIN`) helps
the dashboard find the tool.

The assistant is told to read and draft, and never to send, post or edit anything,
and it has no checkout to work in. Fixing a merge conflict or a failing build
belongs in a real coding session; the panel is for the questions you'd otherwise
answer by opening six tabs. A Gmail draft is the one thing it creates, and revises
when you ask. With Claude Code it uses the claude.ai Gmail connector; with Codex,
the Gmail app linked to your ChatGPT account. Without either, it hands you the text
instead and says so. What it says stays in the panel: it never leaves notes on the
item or marks it handled.

If you're curious, its instructions are `prompts/assistant.md` in this repository,
linked into the store as `assistant.md` each time the dashboard starts.

### Answer ahead

With **Answer ahead on pull requests** (`DAILY_FOCUS_ASSISTANT_AUTO`) on, the
assistant answers before you ask. When a pull request starts waiting on you
because someone reviewed or commented, it assesses the review; when a check fails,
it explains the failure. The answer's first line appears on the row, and on the
brief's item for the same pull request, while it still matches the pull request's
state. The whole answer is in the panel, to follow up on.

It asks about each state once: a new comment or a new failure is a new question,
and the same checks failing again on the same commit are not. It asks one question
at a time, only while a dashboard tab is open, never about a row you're asking
about, and no more than **Answer ahead at most** (`DAILY_FOCUS_ASSISTANT_AUTO_LIMIT`)
times a day, 10 by default. It only reads, and never drafts. It is off by default
because it spends your Claude or ChatGPT usage without you pressing anything.

## What the agent and the assistant can do

Both run the Claude Code or Codex you already use, with the access it already has.
The dashboard narrows some of that, as below, and leaves the rest to their
instructions: the morning agent's forbid it to change anything, and the
assistant's forbid it anything but a Gmail draft.

### Under Claude Code

The morning agent may write `items.json` and nothing else in the store. The
assistant may never use the file-editing tools. Beyond that, each may use only the
tools in its list, **Tools Claude Code may use**, under **Morning agent**
(`DAILY_FOCUS_AGENT_TOOLS`) and **Assistant** (`DAILY_FOCUS_ASSISTANT_TOOLS`).
Anything else is refused rather than asked about, though rules in your own Claude
Code settings that allow a tool still apply.

Both lists start as `Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail`: GitHub,
Jira, web pages and the claude.ai Gmail connector. Add your calendar, chat and
document connectors to the agent's list by name, or the brief will report them as
unreachable.

The defaults are broader than reading needs. `mcp__claude_ai_Gmail` allows every
Gmail tool, sending and deleting included, and `gh` and `acli` can comment, merge
and move tickets as well as read. To hold the assistant to reading mail and
drafting replies, name the Gmail tools instead of the connector:

```text
Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread,mcp__claude_ai_Gmail__get_message,mcp__claude_ai_Gmail__list_labels,mcp__claude_ai_Gmail__list_drafts,mcp__claude_ai_Gmail__get_draft,mcp__claude_ai_Gmail__create_draft,mcp__claude_ai_Gmail__update_draft
```

For the morning agent, leave out the last two, which draft. A tool left off the
list is refused, so if the connector renames one, you'll be told your mail is out of
reach rather than have it worked around.

### Under Codex

Every write through a connector (Gmail, Calendar, Drive, GitHub and the other apps
your ChatGPT account links) is refused, except that the assistant may create and
revise a Gmail draft. A connector tool counts as a write unless it is marked
read-only. A tool you have told Codex to always allow, or an app with approval
settings of its own in your Codex config, keeps them.

The morning agent runs in Codex's workspace-write sandbox, with network access,
confined to the store. The assistant's sandbox keeps writes to its own empty
directory. A shell command that needs to leave the sandbox, such as `gh` switching
accounts, is decided by your own Codex approval settings, as it would be in Codex
itself. That keeps `gh` working, and means it can write. With nobody set to approve,
it reports the restriction; with Codex's automatic reviewer, the reviewer
decides.

Computer use, the plugins that act in your apps and browser with your sign-ins, is
off for the assistant unless you turn on **Computer use**
(`DAILY_FOCUS_ASSISTANT_COMPUTER_USE`). The dashboard checks with Codex that it is
off before each question, and won't start one it can't confirm.

This needs a recent Codex. Before 0.144.0, Codex silently ignores the refusal of
connector writes, so the dashboard won't run the agent or the assistant on it at
all. Before 0.149.0 it can't switch computer use off, so the assistant won't answer
while **Computer use** is off. The page warns when yours is too old.

## Keep the dashboard running

The morning agent runs only while the dashboard does. On a Mac, let the menu bar
app or a LaunchAgent keep it running; use one, not both. Elsewhere, run
`daily-focus` in a terminal you keep open.

### The menu bar app

The app starts the dashboard, starts it again if it stops, and, with **Open at
Login** ticked, starts it when you log in. Its menu shows how old the brief is, how
many items are open and how many pull requests wait on you, and has:

- **Open Daily Focus** and **Settings…**, which open the dashboard in your browser.
- **Write a Fresh Brief**, which runs the morning agent now.
- **Open at Login**.
- **Updates**, below.
- **Restart Dashboard** and **Show Log**, for when something is wrong. The log is
  `~/Library/Logs/Daily Focus.log`.
- **About Daily Focus**, with the app's version and the dashboard's.

It posts a notification when a new brief arrives, when the morning agent fails, and
when an update is ready. As far as macOS is concerned, everything the dashboard
starts runs inside the app. So a permission prompt from the morning agent, for
Reminders, Messages or your calendars, names Daily Focus, and Full Disk Access, if a
source needs it, is granted to the app.

If something else already runs a dashboard on the port, such as
`daily-focus service` or a terminal, the app only watches it, and its menu says
**Run by another process**. To hand it to the app, stop the other one, then quit and
reopen Daily Focus.

**Updates.** A few times a day the app looks for a new release. When it finds one,
it posts a notification and the menu offers **Update Daily Focus to** that version.
Most releases change only the dashboard, a few hundred kilobytes, and the dashboard
restarts into it; if the new one doesn't start, the app goes back to the old one
and says so. A release that changes the app itself replaces the app, about 40 MB,
and opens it again. Either way it installs only what is signed by the same
developer as the app, with nothing in it changed. It waits until the morning agent,
the assistant and the setup screen aren't at work; choosing the update while one
is asks whether to wait for it or stop it.

Under **Updates**, choose **Stable Releases**, or **Development Builds** for a build
of every change as soon as it is merged. Updates install only when you choose them,
unless you tick **Update Automatically**, which the app offers once, when setup is
finished. Then an update goes in on its own, without a notification unless it
fails, once nobody has used the dashboard for half an hour on whichever computer
you read it, and never while anything in it is at work. An app opened straight
from the disk image can't replace itself, so it links to the new disk image
instead, and still updates its dashboard.

### A LaunchAgent

Without the app, `daily-focus service` installs a LaunchAgent for your user that
runs the dashboard now, at every login, and again after a crash. If you stop the
dashboard yourself, it stays stopped until the next login. The command waits until
the dashboard answers and prints its address, or the end of its log if it doesn't.

```sh
npm install -g daily-focus
daily-focus service
```

It won't install from `npx`, whose copy npm replaces with the next version: install
it globally first. Run `daily-focus service` again after updating
(`npm install -g daily-focus`) or switching Node.js versions, to restart it on the
new one. Each Mac runs the command once.

The service keeps two things from the shell you run it in: the Node.js that ran it,
and the store, port and host, whether given as `--data`, `--port` and `--host` or
set as `DAILY_FOCUS_DATA`, `DAILY_FOCUS_PORT` and `DAILY_FOCUS_HOST`. Each time it
starts, the dashboard asks your login shell for its `PATH`, so it finds `gh`, `acli`
and Claude Code or Codex, including one installed since. A tool that relies on a
token exported in your shell profile, rather than its own login, won't find it.

Each store gets one service: running the command again for the same store replaces
it, and another store gets its own. It refuses to install while something else has
the port, such as a dashboard started in a terminal; stop that one first. Its log is
`~/Library/Logs/local.daily-focus.log`, or a log named after the store if you use
another one. To stop and uninstall it:

```sh
daily-focus service --remove
```

## A personal instance

Daily Focus can brief your personal life as well as your work: mail, family
calendars, Apple Reminders, Apple Messages, e-Boks and your own GitHub projects.
Run it as a second instance, with its own store, and answer **Your personal life**
when its setup screen asks what to brief. The settings page has it as **What this
dashboard briefs** (`DAILY_FOCUS_PROFILE`).

A personal instance uses the personal prompt, `prompts/morning-brief-personal.md`,
and has no Jira board and no free time in the agenda. Its browser tab shows a green
house where a work one shows a blue briefcase. The pull request board stays, for
side projects: point it at your personal account with **Accounts**, or turn it off.

To run both on one Mac, give the second its own store and port. The menu bar app
runs one dashboard, on the default store, so run the other as a service beside it,
with the same flags each time:

```sh
daily-focus service --data ~/.daily-focus-personal --port 4322
```

Personal sources often live on another computer, such as a home Mac with access to
Messages and Reminders. Run the instance there, keep it listening on loopback, and
reach it from your other devices through
[Tailscale Serve](https://tailscale.com/kb/1312/serve):

```sh
tailscale serve --bg http://127.0.0.1:4321
```

Only your tailnet can reach it, over HTTPS. Don't listen on your local network
instead: the dashboard has no login, and a personal brief holds your mail and
messages. It answers only when reached as localhost, by IP address, by a Tailscale
`ts.net` name, or by the name in `DAILY_FOCUS_HOST`, so a web page can't point a
name of its own at your dashboard and read your brief. Reached any other way, it
replies `403` and names the host it was reached as.

## Commands

| Command | What it does |
|---|---|
| `daily-focus` | Start the dashboard and open it in your browser |
| `daily-focus --demo` | Look around on sample data, in a throwaway store; add `--profile personal` for the personal profile |
| `daily-focus service` | Keep the dashboard running in the background on macOS; `--remove` uninstalls it |
| `daily-focus init` | Create the store with templates to edit by hand; `--profile personal` for a personal one |
| `daily-focus audit` | Check the current brief against the brief's contract; `--against <items.json>` compares it with another |
| `daily-focus seed` | Write a sample brief into the store. It refuses to replace a brief unless given `--force`; to look at sample data, use the demo |
| `daily-focus build-calendar` | Build the calendar helper for the live agenda, when you don't use the app |

Each takes `--data`, `--port` and `--host`, below, and `daily-focus --help` lists
them all. To run Daily Focus from a checkout of this repository, see
[CONTRIBUTING.md](CONTRIBUTING.md).

The audit checks the brief for duplicate or drifting IDs, missing history, handled
items raised again, and other contract problems. It also shows the agent's
schedule.

## Settings reference

Three settings say where the store is and how the dashboard listens, so they can't
be kept in the store. Give them as flags, or set them in the environment the
dashboard starts in; a flag wins. Their defaults suit almost everyone.

| Flag | Variable | Default | Purpose |
|---|---|---|---|
| `--data` | `DAILY_FOCUS_DATA` | `~/.daily-focus` | Where the store lives |
| `--port` | `DAILY_FOCUS_PORT` | `4321` | Port for the dashboard |
| `--host` | `DAILY_FOCUS_HOST` | `127.0.0.1` | Loopback only by default, since this is personal data. A name here is also one the dashboard answers to, besides localhost, IP addresses and `ts.net` names |

Everything else is set on the settings page, which saves it in the store's
`settings.json` under the keys below; restart the dashboard after editing that file
by hand. Nothing else is read from the environment. The brief's `dayStart` and
`dayEnd` override the configured working hours. Neither matters when
`DAILY_FOCUS_FREE_WINDOWS` is off.

| Key | Default | Purpose |
|---|---|---|
| `DAILY_FOCUS_PROFILE` | `work` | `work` or `personal`. Picks the prompt the dashboard links and the defaults marked below |
| `DAILY_FOCUS_FREE_WINDOWS` | `on`; `off` for personal | `off` shows events only: no free windows in the agenda, and the next event in place of focus time left |
| `DAILY_FOCUS_WORK_START` | `9` | Local hour the working day starts, when the brief doesn't say |
| `DAILY_FOCUS_WORK_END` | `17` | Local hour the working day ends, when the brief doesn't say |
| `DAILY_FOCUS_MIN_FREE_WINDOW` | `45` | Minutes before a gap counts as a focus window |
| `DAILY_FOCUS_STALE_AFTER_HOURS` | `24` | When to expect a refresh. Shows an informational message for 45 minutes before warning that the agent may not have run. Counted only in hours a run was due, so days off never trip it |
| `DAILY_FOCUS_AGENT_DAYS` | `1-5` | Weekdays the dashboard runs the agent on, cron-style and cron-numbered: `1-5` for Monday to Friday, `0-4` for Sunday to Thursday, `0,6` for a weekend-only run |
| `DAILY_FOCUS_GITHUB` | `on` | `off` disables the pull request board, and the ticket board stops checking GitHub; nothing is polled |
| `DAILY_FOCUS_GITHUB_ACCOUNTS` | *gh's active account* | Logins to poll as, comma-separated, each resolved with `gh auth token --user` |
| `DAILY_FOCUS_GITHUB_SCOPE` | *everything* | Organisations or `owner/repo` entries to limit the board to, comma-separated |
| `DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS` | *none* | Check names that stand for a repository's whole merge policy, comma-separated and matched exactly. Their rows get the *Waiting on merge gate* bucket |
| `DAILY_FOCUS_GITHUB_POLL_MINUTES` | `5` | Minutes between polls while a tab is open |
| `DAILY_FOCUS_GH` | `gh` | Path to the GitHub CLI, for when the dashboard can't find it. `~` is expanded |
| `DAILY_FOCUS_CALENDAR` | `on` | `off` disables the live agenda; the brief's own events are used instead |
| `DAILY_FOCUS_CALENDARS` | *none* | Calendar names to show, comma-separated and spelled as Calendar.app spells them. Empty means nothing is read |
| `DAILY_FOCUS_CALENDAR_ADDRESSES` | *none* | Your own email addresses, comma-separated, used to find your reply among an event's attendees |
| `DAILY_FOCUS_CALENDAR_POLL_MINUTES` | `5` | Minutes between calendar reads while a tab is open |
| `DAILY_FOCUS_CALENDAR_APP` | *the app's, or the built copy* | Path to the calendar helper bundle, if it isn't the one the menu bar app carries or `daily-focus build-calendar` installs |
| `DAILY_FOCUS_JIRA` | `on`; `off` for personal | `off` disables the Jira ticket board; nothing is read |
| `DAILY_FOCUS_JIRA_PROJECTS` | *everything* | Project keys to limit the search to, comma-separated |
| `DAILY_FOCUS_JIRA_HOLD_STATUSES` | *none* | Statuses where standing still is deliberate, comma-separated and spelled as your Jira spells them. Their rows are exempt from *In flight with nothing linked*, and from nothing else |
| `DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES` | *all of them* | The statuses the ticket board's *Working on* view shows, comma-separated and case-insensitive. Use `In Progress` to leave out In Review |
| `DAILY_FOCUS_JIRA_POLL_MINUTES` | `15` | Minutes between reads while a tab is open |
| `DAILY_FOCUS_JIRA_SITE` | *acli's own* | Atlassian site host the browse links are built from. A pasted URL is fine |
| `DAILY_FOCUS_ACLI` | `acli` | Path to the Atlassian CLI, for when the dashboard can't find it. `~` is expanded |
| `DAILY_FOCUS_ASSISTANT` | `off` | `claude` or `codex` puts an assistant in every item's panel that runs that CLI headless against the item. `off` hides it. Setup sets it to the agent's CLI |
| `DAILY_FOCUS_ASSISTANT_BIN` | *the CLI's name* | Path to the assistant's CLI, for when the dashboard can't find it. `~` is expanded |
| `DAILY_FOCUS_ASSISTANT_MODEL` | *the CLI's own* | Model passed to the CLI untouched: an alias like `opus`, or a full id. Unset passes no flag |
| `DAILY_FOCUS_ASSISTANT_EFFORT` | *the CLI's own* | Effort passed to the CLI untouched: `low`, `medium`, `high`, `xhigh` or `max`. Unset passes no flag |
| `DAILY_FOCUS_ASSISTANT_TOOLS` | `Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail` | What Claude Code may use without asking, in its permission syntax, comma-separated. Editing tools are denied regardless. The default allows every Gmail tool, sending included; see [Under Claude Code](#under-claude-code) to narrow it. Ignored by Codex |
| `DAILY_FOCUS_ASSISTANT_COMPUTER_USE` | `off` | `on` lets the assistant use Codex's computer-use and browser plugins, which act in your apps and browser with your sign-ins. `off` switches them off for its runs. Ignored by Claude Code, which uses only the tools in its list |
| `DAILY_FOCUS_ASSISTANT_AUTO` | `off` | `on` asks the assistant ahead about pull requests waiting on you, after a review or a failing check, and puts the answer's first line on the row. See [Answer ahead](#answer-ahead) |
| `DAILY_FOCUS_ASSISTANT_AUTO_LIMIT` | `10` | How many times a day the assistant may start on its own, from 1 to 100 |
| `DAILY_FOCUS_AGENT` | `off` | `codex` or `claude` lets the dashboard run the morning agent through that CLI: each scheduled morning, and from the refresh icon beside the brief's age. `off` hides it |
| `DAILY_FOCUS_AGENT_AT` | `07:00` | Local time, `HH:MM`, at which the dashboard starts the agent on each scheduled day, or as soon as it is running after that. `off` means it never starts one on its own; the refresh icon still does. Needs `DAILY_FOCUS_AGENT` |
| `DAILY_FOCUS_AGENT_BIN` | *the CLI's name* | Path to that CLI, for when the dashboard can't find it. `~` is expanded |
| `DAILY_FOCUS_AGENT_MODEL` | *the CLI's own* | Model passed to the CLI untouched. Unset passes no flag |
| `DAILY_FOCUS_AGENT_EFFORT` | *the CLI's own* | Effort passed to the CLI untouched. Unset passes no flag |
| `DAILY_FOCUS_AGENT_SEARCH_TRASH` | `off` | Whether the agent searches the mail account's Trash as well as the inbox and archive. The dashboard writes it to `agent-settings.json` in the store before each run, where the agent reads it |
| `DAILY_FOCUS_AGENT_TOOLS` | `Bash(gh *),Bash(acli *),WebFetch,mcp__claude_ai_Gmail` | What Claude Code may use to reach your sources, in its permission syntax, comma-separated. Writing `items.json`, and nothing else in the store, is allowed regardless. The default allows every Gmail tool, sending included. Ignored by Codex |

## If something looks wrong

- **The dashboard is gone after a restart.** It was probably started in a terminal,
  and ended with it. Use the menu bar app or `daily-focus service` to keep it
  running.
- **The page doesn't load.** With the app, choose **Restart Dashboard**, or
  **Show Log** to see why. With the service, read
  `~/Library/Logs/local.daily-focus.log`.
- **The menu says "Run by another process".** A service or a terminal runs the
  dashboard, and the app only watches it. See [The menu bar app](#the-menu-bar-app).
- **The Today tab is empty.** Before the first brief, it says where that brief is,
  and offers to run it again if it didn't finish. After that, the agent hasn't
  written a new brief: start a run from the refresh icon beside the brief's age.
- **The brief is stale.** Refreshing a board doesn't regenerate the brief; the icon
  beside the brief's age does. Click "updated … ago" to see what the last run said,
  or whether there was one: the dashboard has to be running at **Run it at**, or
  started later that day.
- **A source is missing from the brief.** The run's report says which sources the
  agent couldn't reach. Under Claude Code, add the connector to
  [the agent's tools](#under-claude-code).
- **A GitHub or Jira warning.** The `gh` or `acli` session may need signing in again.
  If the dashboard can't find the tool, set its path in **Path to gh**
  (`DAILY_FOCUS_GH`) or **Path to acli** (`DAILY_FOCUS_ACLI`). During an outage, the
  boards keep their last good results; the time beside a board's refresh icon says
  how old they are, and its tooltip why the last read failed.
- **Port 4321 is in use.** The app's menu says so. Start the
  dashboard with `--port` and another port, or stop the other program.
