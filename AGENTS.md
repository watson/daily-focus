# AGENTS.md

Keep this file short. Add guidance only for mistakes an agent is likely to make or
facts that are costly to rediscover. Keep feature details in code comments and tests.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the code map.

The morning briefing agents never read this file. Their instructions belong in
[`prompts/morning-brief-work.md`](prompts/morning-brief-work.md) and
[`prompts/morning-brief-personal.md`](prompts/morning-brief-personal.md), one per
`DAILY_FOCUS_PROFILE`, installed as a symlink in the private store. Payload fields
belong in [`schema/items.schema.json`](schema/items.schema.json). Update both prompts
when changing what a briefing agent must produce or understand.

Two agents, two words. "The agent" is the morning briefing agent. "The assistant" is
the CLI the dashboard runs headless when the user presses Ask on a row; its
instructions are [`prompts/assistant.md`](prompts/assistant.md) and its runner is
`src/assistant.ts`. Keep the words apart in code, prompts and UI copy. The setup
screen's CLI sessions are a third role, "onboarding" in code: `src/onboarding.ts`
runs them on [`prompts/onboarding.md`](prompts/onboarding.md), and the screen's copy
calls them "it" rather than either word.

## Private data and store ownership

- Use invented names, accounts, ticket keys, and content in tracked files, fixtures,
  screenshots, and commit messages. A real brief is private data, even as a fixture.
  Personal configuration belongs in the store's `settings.json`.
- The default data folder is `~/.daily-focus`, with a store per profile in it:
  `work/` and `personal/` (`src/stores.ts`). For development, set `DAILY_FOCUS_DATA`
  to a temporary directory or gitignored `./data`, and `DAILY_FOCUS_PORT` to a free port.
  Stop that server by its PID: the real dashboard and other worktrees' servers run on
  the same machine. Do not put real briefs at the repo root.
- `sources.md`, and the private half of `focus.md` after `<!-- agent-only -->`, reach
  the browser only through the endpoints that ask for them: the editors'
  (`/api/text/*`), and the setup screen's preview of the list it would write
  (`/api/onboarding/sources`). Never put either in `/api/state`, which every tab is
  sent: state carries `toPublicFocus` and nothing of the source list. The one
  exception is the setup screen itself, whose answers become the list; `onboarding`
  is in state only until the finish.

Each store file has one writer. There is no locking, so preserve these boundaries:

| Writer | Files |
|---|---|
| Briefing agent | `items.json` |
| Dashboard | `actions.jsonl`, `assistant.jsonl`, `agent.jsonl`, `agent-settings.json`, `archive/`, `assistant/`, `onboarding.json`, `onboarding/`, `prs.json`, `tickets.json`, `calendar-accounts.json`, `timezone.json`, `settings.json`, and the `prompt.md`, `assistant.md` and `items.schema.json` symlinks, relinked to the running copy at every start (on Windows, copies, recorded by hash in `copies.json`) |
| User, through the dashboard's editors, the setup screen, or by hand | `focus.md`, `sources.md` |

The dashboard saves `focus.md` and `sources.md` only when the user does, and only if
the file is unchanged since it was read (`src/editable.ts`), so a hand edit is never
overwritten. The setup screen's finish is such a save: it writes the source list the
user's answers add up to, shown to them first, and only when there is none, and
sets the objective they typed. Nothing else writes them on the user's behalf.

Never compact or rewrite `actions.jsonl`, `assistant.jsonl` or `agent.jsonl`. Do not write dashboard records on the briefing agent's behalf.
A store from before the profile folders lies in the data folder itself. The server
moves it into its profile's folder as it starts (`settleStore`), by rename, and only
a dashboard of that profile does: never over a folder that exists, never out of the
home folder, never merged. Scripts read a store wherever it lies and never move one.
The CLIs the dashboard runs get `DAILY_FOCUS_DATA` set to the store itself
(`cliEnvironment`), since at launch it names the data folder.
Integration caches use a sibling temporary file and rename; they store facts, not
computed board classifications. The calendar is the exception: what the live agenda
reads stays in memory, since the store is the morning agent's folder, and
`calendar.json`, where an older version kept it, is deleted at start.

`npm run seed` writes a sample brief. It refuses to replace an existing `items.json`
unless given `--force`; never pass `--force` against a real store. Always give it a
throwaway store:

```sh
DAILY_FOCUS_DATA=$(mktemp -d) npm run seed
```

`npm run service` points a LaunchAgent at the checkout it runs from and replaces any
service for the same store. Never run it from a worktree against the real store. To
test it, give it a throwaway `DAILY_FOCUS_DATA` and a free `DAILY_FOCUS_PORT`, and
run it again with `--remove` afterwards.

## Behavior to preserve

- Keep new brief fields optional and parsing forgiving. One malformed item must not
  prevent the rest of the brief from rendering.
- Treat item IDs as opaque and stable. Match with `canonicalId`; `fingerprintId` is
  only for drift warnings. The action log decides whether a brief item is handled,
  never upstream read status or absence from a query. PR and Jira boards deliberately
  ignore `done` and `dismiss` because they show upstream state.
- A failed integration read is not an empty result. Preserve the last successful
  data or use the documented fallback, and surface the failure.
- `transitionTicket` is the dashboard's only external write. It moves one Jira ticket
  to one status after a user click. Do not add automatic transitions or other external
  writes without an explicit scope change.
- GitHub and Jira are optional. `DAILY_FOCUS_GITHUB` and `DAILY_FOCUS_JIRA` off
  leave them out of everything, the brief included (`agentSettings`). A user's own
  `gh` or `acli` always wins; only without one does connecting fetch it from its
  maker into the data folder's `tools/` (`src/tools.ts`), checked before use.
  Nothing ships either: Atlassian's terms forbid passing acli on. Fetching and
  signing in (`src/connect.ts`) start only from a click; nothing connects on its own.
- Everything shipped that others wrote is credited in the acknowledgements. npm
  packages are found from the bundles (`scripts/licenses.ts`), and one without a
  licence file fails the build; anything else, like the fonts, is listed there by
  hand. The Mac app adds Node's (`macos/build.sh`), and its own binaries may link
  only macOS's libraries.
- Daily Focus is MIT licensed, and nothing it ships may change that. Never add
  code, a package or an asset under a copyleft licence, which would require the
  work that includes it to be released under its terms: the GPL family (GPL, LGPL,
  AGPL), SSPL, EUPL, OSL or CC-BY-SA. Weak copyleft (MPL, EPL, CDDL) needs the
  maintainer's explicit go-ahead first. The package build refuses them. Node's
  licence quotes the GPL only for ICU build scripts under Autoconf's exception,
  which aren't in the binary.
- The server has no login. `src/guard.ts` refuses a non-JSON `POST` and an untrusted
  `Host` before any route runs; keep every route behind it and every `GET` free of
  side effects, or any page open in the browser can act through the dashboard.
- Setup's sessions only read: no drafts, and Claude Code gets read tools by name
  (`ONBOARDING_TOOLS`). Nothing runs on the user's behalf until the screen asks: it
  posts `/api/onboarding/detect` when it opens, which looks for the CLIs
  (`src/clis.ts`), and the sessions, `gh` and the calendar helper wait for the
  first answer. A new store's state is read before anyone is there, tests included.
  Setup picks the CLI itself when one is ready, Codex first (`CLI_PREFERENCE`), and
  asks only when none is. The dashboard owns
  the questions (`src/questions.ts`); a session only fills one in, in the JSON its
  schema fixes, and never decides what is asked or writes anything.
- Off a Mac, the live agenda reads Google and Microsoft accounts the user connects
  (`src/calendaraccounts.ts`), on the apps in `src/oauthclients.ts`, whose consent
  screens point at dailyfocus.dev's privacy policy and terms. Keep it to what the
  policy says: read-only scopes, signing in only from a click, the refresh token
  sealed by the operating system (`src/calendarvault.ts`), and what is read held
  in memory, never given to the agent, the assistant or setup's sessions, not even
  calendar names: Google's terms for calendar data hold us to that. Disconnecting
  asks Google to revoke the sign-in, the one request besides `transitionTicket`
  that changes anything elsewhere. Change what it reads only with the policy, at
  `site/privacy/`. Never commit Google's client secret: the package build writes it
  in from `GOOGLE_CLIENT_SECRET` (`src/oauthclients.ts`).
- The assistant may read anything and create or revise a Gmail draft; it must never
  send, post, or edit. It runs in an empty directory, so keep that a property of the
  process: no checkout, no worktree, no repository path setting. Work that needs one
  belongs in a coding session, not in this dashboard. Claude Code denies it the
  editing tools; under Codex, `src/codex.ts` refuses every connector write but the
  draft, for the agent too. Leave Codex's shell approvals, rules and sandbox escapes
  to the user's own config: briefs reach GitHub and other local sources through them,
  so tightening them needs a real brief run on each profile first.
- The assistant starts on its own only through `src/autoask.ts`: behind
  `DAILY_FOCUS_ASSISTANT_AUTO`, off by default, for pull requests waiting on the
  user, with `AUTO_ACTIONS` alone, each key once and within the daily limit. Never
  add a quick action that creates something, a draft included, to `AUTO_ACTIONS`.
- The menu bar app installs an update on its own only behind **Update
  Automatically**, off by default, and only when `/api/status` says nothing is
  busy and no page has reported use (`client/presence.ts`) for half an hour. An
  update the user starts while something is busy waits for it unless they choose
  to stop it.
- `src/agent.ts` starts the briefing agent on the dashboard's clock, 07:00 unless
  `DAILY_FOCUS_AGENT_AT` says otherwise, once a day, and after a user click. Nothing
  else starts it, so the run log is the whole record of its runs; do not add a
  second scheduling path. The setup screen's finish is a click whose settings
  restart the dashboard, so the first brief starts on the start after it, once
  (`takeBriefRequest`). The agent still writes `items.json` itself, from the
  store as its working directory, on the short wrapper in `agentPrompt`, which
  names `prompt.md` and nothing more. Do not hand it extra instructions, a
  checkout, or a copy of the prompt. A setting reaches it as a key in
  `agentSettings`, which the runner writes to `agent-settings.json` before each
  run with the values in force; explain each key in both
  prompts. A follow-up question resumes the run's session with nothing to write;
  it must never become a way to edit the brief.
- Under Codex, a run's subagents are read from Codex's own session files
  (`src/codexsessions.ts`), because `codex exec --json` leaves them out. Only read
  them: never write under `CODEX_HOME`, and a line or file that doesn't read is
  skipped, never a failed run.

## Checks

Run `npm run typecheck` and `npm test` for code changes. `npm test` loads
`test/sandbox.ts`, a throwaway home for the run; run one file the same way, with
`node --test --import ./test/sandbox.ts`. A test that starts the CLI, a script or a
server passes it a throwaway `DAILY_FOCUS_DATA`, even one that expects a refusal:
once the refusal stops holding, it runs on the real store. The npm package bundles
every module into the CLI's files: a module that runs when executed directly must
check with `ranDirectly` from `src/install.ts`, never by comparing its URL with
`process.argv[1]`. Never commit `dist/`. The menu bar app runs the package from
inside its signed bundle, or from a signed copy it downloaded as an update, so the
server must never write into its own install directory: anything it writes goes in
the store. A write there would also break the copy's signature, and the app would
refuse to run it. When the dashboard starts needing something new from the app (a
flag, the calendar helper, a permission, a newer Node), raise `appInterface` in
`package.json` and `macos/DailyFocus/Updates.swift` together. Keep tests independent of
live accounts and calendar permission prompts. CI runs them on Windows too: fake a
CLI with `fakeCli` from `test/fakecli.ts`, never a shell script. The client is built from `client/`
into `public/app.js`, which is not tracked: edit the source, never the bundle.

A pull request's title must be a Conventional Commit (`feat(board): …`, `fix: …`),
checked by CI: squash-merged, it becomes main's commit, and `scripts/release.ts`
works out versions and release notes from those. Never set the version in
`package.json`; the Release workflow stamps it. See CONTRIBUTING.md, Releases.

`npm run audit` checks the brief in the selected store, not the code.
`test/docs-contract.test.ts` checks prompt/schema, configuration, and board-label
consistency. New settings must appear in `src/config.ts` and `src/settings.ts` (the
settings page). Only `DAILY_FOCUS_DATA`, `_PORT` and `_HOST` stay off the page, and
the setup page (`site/setup/index.html`) documents them instead: they locate the
store, so they can't be kept in it. They and `DAILY_FOCUS_PROFILE`, which picks the
store when given at launch and is locked on the page, are the only settings read
from the environment (or `--data`, `--port`, `--host`, `--profile`); don't read
another from it, or a `.env`.
