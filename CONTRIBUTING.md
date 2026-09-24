# Contributing to Daily Focus

[Back to the README](README.md)

The server is TypeScript running directly in Node.js. The frontend uses plain
JavaScript modules. There is no build step or runtime package dependency.

Read [AGENTS.md](AGENTS.md) before changing behavior. It covers file ownership,
privacy, and constraints that apply across the codebase. For installation and account
setup, use [SETUP.md](SETUP.md).

## Run locally

Use Node.js 22.18 or newer, preferably Node 24. From the repo, start with a temporary
store so your changes don't affect a real brief:

```sh
npm install
export DAILY_FOCUS_DATA=$(mktemp -d)
export DAILY_FOCUS_GITHUB=off DAILY_FOCUS_JIRA=off DAILY_FOCUS_CALENDAR=off
npm run seed
npm run dev
```

Open [localhost:4321](http://127.0.0.1:4321). The server restarts on changes. An open
tab reloads when frontend files change, or offers a reload if you're writing a note.
Close this terminal when done to clear the temporary settings.

Use invented data for fixtures and screenshots. Never copy a real brief, calendar,
account name, or ticket into a tracked file. If you need a store inside the repo,
use the gitignored `data/` directory.

## Check your changes

```sh
npm run typecheck
npm test
```

The tests use Node's built-in test runner. They use fixtures and temporary stores;
keep them independent of live accounts and calendar permission prompts.

To check a generated brief, run `npm run audit` with `DAILY_FOCUS_DATA` pointing to
its store. The audit checks content and history; it doesn't replace the test suite.

## Find your way around

| Path | Responsibility |
|---|---|
| `src/server.ts` | HTTP endpoints and live state updates over SSE |
| `src/types.ts`, `schema/items.schema.json` | Types and the brief payload contract |
| `src/config.ts`, `src/env.ts` | Settings and `.env` loading |
| `src/store.ts`, `src/validate.ts`, `src/ids.ts` | Read the brief, salvage malformed items, and apply actions |
| `src/focus.ts`, `src/archive.ts` | Objective privacy and progress history |
| `src/agenda.ts`, `src/calendar.ts`, `src/calendarboard.ts` | Free time, calendar reads, and polling |
| `src/github.ts`, `src/prs.ts`, `src/board.ts` | GitHub reads, PR classification, and polling |
| `src/jira.ts`, `src/tickets.ts`, `src/ticketboard.ts` | Jira access, ticket classification, and polling |
| `src/sessions.ts`, `src/presence.ts` | Focus sessions and idle detection |
| `src/assistant.ts` | The on-demand assistant: runs a coding-agent CLI headless against one row |
| `src/agent.ts` | Reruns the morning agent through a coding-agent CLI when the user asks |
| `public/` | Rendering, styles, keyboard controls, and browser API calls |
| `scripts/` | Store initialization, sample data, and brief audits |
| `tools/dfcal/` | The macOS calendar helper |
| `prompts/` | The external briefing agent's instructions |
| `apps-script/` | Optional Google Tasks export |

## Keep the contracts in sync

Each store file has one writer. The agent writes `items.json`; the dashboard
appends actions and sessions, archives briefs, and maintains integration caches.
The user edits `focus.md` and `sources.md`. See the
[file ownership table](AGENTS.md#private-data-and-store-ownership) before adding
another write path. Never compact or rewrite the action log.

Keep new brief fields optional and parsing forgiving. One malformed item should
produce a warning without losing the rest of the brief. Preserve stable item IDs,
since they connect a brief to its action history.

When changing a contract, update the documents that describe it:

- Brief fields belong in the schema and both prompts, `prompts/morning-brief-work.md`
  and `prompts/morning-brief-personal.md`.
- The assistant's instructions belong in `prompts/assistant.md`, and its quick
  actions in `QUICK_ACTIONS` in `src/assistant.ts`.
- Agent instructions belong in the prompt for the profile they apply to, or both.
  Read [prompts/README.md](prompts/README.md) before editing one; an installed
  symlink can make changes live on the next scheduled run.
- Settings belong in `src/config.ts`, `.env.example`, and `SETUP.md`.
- Board buckets belong in server types, the client renderer, and the README.

`test/docs-contract.test.ts` checks these lists for drift. Keep private focus text
out of client state, and keep computed board classifications out of the caches.

## HTTP API

The server binds to localhost by default. These are the endpoints used by the UI;
see `src/server.ts` for request validation and additional session/calendar routes.

| Endpoint | Behavior |
|---|---|
| `GET /api/state` | The folded state: items with status, agenda, stats, warnings |
| `GET /api/events` | SSE stream, pushes `state` on every store change |
| `POST /api/actions` | `{id, action, until?, text?}`. Appends to the log, returns fresh state |
| `POST /api/board/refresh` | Polls GitHub now. Returns fresh state once it has |
| `POST /api/tickets/refresh` | Reads Jira now. Returns fresh state once it has |
| `POST /api/tickets/transition` | `{key, status}`. Moves one ticket in Jira, then re-reads. `409` with Jira's reason when the workflow refuses. The dashboard's only write to anything outside this machine |
| `POST /api/assistant/ask` | `{id, action?, text?}`. Starts the assistant on a row; returns state with the turn running. The reply streams in over SSE. `409` when it is off or already working on that row |
| `POST /api/assistant/stop` | `{id}`. Kills the turn running on a row |
| `POST /api/agent/run` | Starts the morning agent now; returns state with the run going. `application/json` only, so another site can't start one. `409` when it is off or already running |
| `POST /api/agent/stop` | Kills the morning agent's run |
| `GET /api/health` | Server health check |

## Update the screenshot

Use the temporary demo above with integrations disabled. Add an invented objective
to the temporary store's `focus.md` if needed. Capture the Today tab from the running
app, check that every visible name and detail is fictional, and save the image as
`docs/images/daily-focus.png`. Keep the README caption clear that it is sample data.
