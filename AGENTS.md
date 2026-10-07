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
`src/assistant.ts`. Keep the words apart in code, prompts and UI copy.

## Private data and store ownership

- Use invented names, accounts, ticket keys, and content in tracked files, fixtures,
  screenshots, and commit messages. A real brief is private data, even as a fixture.
  Personal configuration belongs in the store (`settings.json`) or gitignored `.env`.
- The default store is `~/.daily-focus`. For development, set `DAILY_FOCUS_DATA` to a
  temporary directory or gitignored `./data`. Do not put real briefs at the repo root.
- `sources.md`, and the private half of `focus.md` after `<!-- agent-only -->`, reach
  the browser only through the editor endpoints that ask for them (`/api/text/*`).
  Never put either in `/api/state`, which every tab is sent: state carries
  `toPublicFocus` and nothing of the source list.

Each store file has one writer. There is no locking, so preserve these boundaries:

| Writer | Files |
|---|---|
| Briefing agent | `items.json` |
| Dashboard | `actions.jsonl`, `sessions.jsonl`, `assistant.jsonl`, `agent.jsonl`, `session.json`, `archive/`, `assistant/`, `prs.json`, `tickets.json`, `calendar.json`, `settings.json`, and the `prompt.md`, `assistant.md` and `items.schema.json` symlinks, relinked to the running copy at every start |
| User, through the dashboard's editors or by hand | `focus.md`, `sources.md` |

The dashboard saves `focus.md` and `sources.md` only when the user does, and only if
the file is unchanged since the editor loaded it (`src/editable.ts`), so a hand edit
is never overwritten. It never writes them on the user's behalf.

Never compact or rewrite `actions.jsonl`, `sessions.jsonl`, `assistant.jsonl` or
`agent.jsonl`. Do not write dashboard records on the briefing agent's behalf.
Integration caches use a sibling temporary file and rename; they store facts, not
computed board classifications. The demo (`src/demo.ts`) is the one exception to
all of this: it writes every one of those files into its own throwaway store before
the server starts, and refuses a store that already has a brief.

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
- The server has no login. `src/guard.ts` refuses a non-JSON `POST` and an untrusted
  `Host` before any route runs; keep every route behind it and every `GET` free of
  side effects, or any page open in the browser can act through the dashboard.
- The assistant may read anything and create a Gmail draft; it must never send, post,
  or edit. It runs in an empty directory with editing tools denied, so keep that a
  property of the process: no checkout, no worktree, no repository path setting.
  Work that needs one belongs in a coding session, not in this dashboard.
- `src/agent.ts` starts the briefing agent on the dashboard's clock, 07:00 unless
  `DAILY_FOCUS_AGENT_AT` says otherwise, once a day, and after a user click. Nothing
  else starts it, so the run log is the whole record of its runs; do not add a
  second scheduling path. The agent still writes `items.json` itself, from the
  store as its working directory, on the short wrapper in `agentPrompt`, which
  names `prompt.md` and nothing more. Do not hand it extra instructions, a
  checkout, or a copy of the prompt. A follow-up question resumes the run's session
  with nothing to write; it must never become a way to edit the brief.

## Checks

Run `npm run typecheck` and `npm test` for code changes. The npm package bundles
every module into the CLI's files: a module that runs when executed directly must
check with `ranDirectly` from `src/install.ts`, never by comparing its URL with
`process.argv[1]`. Never commit `dist/`. The menu bar app runs the package from
inside its signed bundle, or from a signed copy it downloaded as an update, so the
server must never write into its own install directory: anything it writes goes in
the store. A write there would also break the copy's signature, and the app would
refuse to run it. When the dashboard starts needing something new from the app (a
flag, the calendar helper, a permission, a newer Node), raise `appInterface` in
`package.json` and `macos/DailyFocus/Updates.swift` together. Keep tests independent of
live accounts and calendar permission prompts. The client is built from `client/`
into `public/app.js`, which is not tracked: edit the source, never the bundle.

A pull request's title must be a Conventional Commit (`feat(board): …`, `fix: …`),
checked by CI: squash-merged, it becomes main's commit, and `scripts/release.ts`
works out versions and release notes from those. Never set the version in
`package.json`; the Release workflow stamps it. See CONTRIBUTING.md, Releases.

`npm run audit` checks the brief in the selected store, not the code.
`test/docs-contract.test.ts` checks prompt/schema, configuration, and board-label
consistency. New settings must appear in `src/config.ts`, `src/settings.ts` (the
settings page), `.env.example`, and `SETUP.md`. Only `DAILY_FOCUS_DATA`, `_PORT` and
`_HOST` stay off the page: they locate the store, so they can't be kept in it.
