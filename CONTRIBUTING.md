# Contributing to Daily Focus

[Back to the README](README.md)

The server is TypeScript run directly by Node.js, with no runtime package
dependency. The client is TypeScript too, written on Preact and bundled by esbuild
into `public/app.js`, which is not tracked: `npm run dev` rebuilds it as you edit,
and `npm start` builds it once before listening.

Read [AGENTS.md](AGENTS.md) before changing behavior. It covers file ownership,
privacy, and constraints that apply across the codebase. For installation and account
setup, use [SETUP.md](SETUP.md).

## Run locally

Use Node.js 22.18 or newer, preferably Node 24. From the repo, start with a temporary
store so your changes don't affect a real brief:

```sh
npm install
export DAILY_FOCUS_DATA=$(mktemp -d)
export DAILY_FOCUS_AGENT=off DAILY_FOCUS_ASSISTANT=off
export DAILY_FOCUS_GITHUB=off DAILY_FOCUS_JIRA=off DAILY_FOCUS_CALENDAR=off
npm run seed
npm run dev
```

Set the agent and the assistant off explicitly: a variable left unset falls through
to your `.env`, and a dashboard with the agent on starts a real run the moment it is
past the morning's hour. `npm run demo` is the quicker look, on its own throwaway
store with everything off, and is what `npx daily-focus --demo` runs.

Open [localhost:4321](http://127.0.0.1:4321). If your own dashboard runs as a
service, it already has that port: export `DAILY_FOCUS_PORT=4322` as well and open
that one. The server restarts on changes, and the client is rebuilt. An open tab
reloads when the bundle changes, or offers a reload if you're writing a note.
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
keep them independent of live accounts and calendar permission prompts. The ones
that render the client do so into a happy-dom document through `test/dom.ts`, so a
rendered row can be asked the same questions a browser would answer.

To check a generated brief, run `npm run audit` with `DAILY_FOCUS_DATA` pointing to
its store. The audit checks content and history; it doesn't replace the test suite.

A pull request's title must be a [Conventional Commit](https://www.conventionalcommits.org/),
such as `feat(board): show draft pull requests` or `fix!: read settings from the
store`. It is squash-merged with that title as the commit on main, which is where
versions and release notes come from, so CI checks it.

## Find your way around

| Path | Responsibility |
|---|---|
| `src/server.ts` | HTTP endpoints and live state updates over SSE |
| `src/types.ts`, `schema/items.schema.json` | Types and the brief payload contract |
| `src/config.ts`, `src/env.ts` | Settings, layered: the environment over the store's `settings.json` over `.env` |
| `src/settings.ts` | The settings page: every setting's label, help and field, and checking a change before it is saved |
| `src/setup.ts`, `client/setup.ts` | What a new store still needs, and the setup steps Today shows until the first brief |
| `client/settings.ts` | The settings page, built from `src/settings.ts`, and the editors for `focus.md` and `sources.md` |
| `src/editable.ts`, `src/templates.ts` | Saving `focus.md` and `sources.md` from the editors without overwriting a hand edit, and what they start as |
| `src/shellpath.ts` | Your login shell's PATH, for a dashboard started by launchd or an app |
| `src/store.ts`, `src/validate.ts`, `src/ids.ts` | Read the brief, salvage malformed items, and apply actions |
| `src/links.ts` | Linking the prompt, schema and assistant's instructions into the store at every start, and noticing when something repoints them |
| `src/focus.ts`, `src/archive.ts` | Objective privacy and progress history |
| `src/agenda.ts`, `src/calendar.ts`, `src/calendarboard.ts` | Free time, calendar reads, and polling |
| `src/github.ts`, `src/prs.ts`, `src/board.ts` | GitHub reads, PR classification, and polling |
| `src/jira.ts`, `src/tickets.ts`, `src/ticketboard.ts` | Jira access, ticket classification, and polling |
| `src/failure.ts`, `client/failure.ts` | How the three pollers report a failed read: one line, and the detail behind a click |
| `src/sessions.ts`, `src/presence.ts` | Focus sessions and idle detection |
| `src/assistant.ts` | The on-demand assistant: runs a coding-agent CLI headless against one row |
| `src/agent.ts` | Runs the morning agent through a coding-agent CLI, on the dashboard's clock and when the user asks, and keeps each run's report and follow-up chat |
| `src/cli.ts`, `src/install.ts` | The `daily-focus` command the npm package installs, and telling a checkout from the package |
| `src/sample.ts` | The sample brief behind `npm run seed` and the demo |
| `client/` | The page: Preact components, view state, keyboard controls, and browser API calls |
| `public/` | The page shell, the stylesheet, and the built bundle |
| `scripts/` | Store initialization, the macOS background service, sample data, brief audits, and the package build |
| `tools/dfcal/` | The macOS calendar helper |
| `macos/` | The macOS menu bar app, which runs the dashboard in place of `daily-focus service`; `npm run app -- --test` builds and checks it |
| `prompts/` | The briefing agent's instructions |
| `apps-script/` | Optional Google Tasks export |

## Keep the contracts in sync

Each store file has one writer. The agent writes `items.json`; the dashboard
appends actions and sessions, archives briefs, maintains integration caches, saves
settings, and links the prompt. The user edits `focus.md` and `sources.md`, in the
dashboard's editors or by hand. See the
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
  symlink makes changes live on the next run.
- Settings belong in `src/config.ts`, `src/settings.ts`, `.env.example`, and `SETUP.md`.
- Board buckets belong in server types, the client renderer, and the README.

`test/docs-contract.test.ts` checks these lists for drift. Keep private focus text
out of client state, and keep computed board classifications out of the caches.

## HTTP API

The server binds to localhost by default. These are the endpoints used by the UI;
see `src/server.ts` for request validation and additional session/calendar routes.

There is no login, so `src/guard.ts` keeps other pages in the same browser out
before any route runs. Every `POST` must be `application/json`, which a form on
another site can't send, and every request's `Host` must be localhost, an IP
address, a `ts.net` name or `DAILY_FOCUS_HOST`, which a page that points its own
name at this server can't fake. Anything else gets `415` or `403`. Keep `GET`
free of side effects, since only `POST` is checked for its content type.

| Endpoint | Behavior |
|---|---|
| `GET /api/state` | The folded state: items with status, agenda, stats, warnings |
| `GET /api/events` | SSE stream, pushes `state` on every store change |
| `POST /api/actions` | `{id, action, until?, text?}`. Appends to the log, returns fresh state |
| `POST /api/board/refresh` | Polls GitHub now. Returns fresh state once it has |
| `POST /api/tickets/refresh` | Reads Jira now. Returns fresh state once it has |
| `POST /api/calendar/refresh` | Reads the calendar now, for the agenda's Retry. Returns fresh state once it has |
| `POST /api/tickets/transition` | `{key, status}`. Moves one ticket in Jira, then re-reads. `409` with Jira's reason when the workflow refuses. The dashboard's only write to anything outside this machine |
| `POST /api/assistant/ask` | `{id, action?, text?}`. Starts the assistant on a row; returns state with the turn running. The reply streams in over SSE. `409` when it is off or already working on that row |
| `POST /api/assistant/stop` | `{id}`. Kills the turn running on a row |
| `POST /api/agent/run` | Starts the morning agent now; returns state with the run going. `409` when it is off or already running |
| `POST /api/agent/ask` | `{run, text}`. Asks a finished run a question in its own session; returns state with the answer coming. The reply streams in over SSE. `409` when it is off, busy, or the run can't be continued |
| `POST /api/agent/stop` | Kills whatever the morning agent is doing: a run, or a question about one |
| `GET /api/settings` | Every setting: its value, where it came from (environment, settings, `.env` or default), its default, and the page's label and help |
| `POST /api/settings` | `{values: {NAME: value or null}}`. Checks the change by building the config from it, saves `settings.json`, and restarts the dashboard in place once nothing is running. `400` names the setting it refused |
| `GET /api/text/focus`, `GET /api/text/sources` | The whole file for its editor, private part included, with its version and the template a new one starts from. Never part of `/api/state` |
| `POST /api/text/focus`, `POST /api/text/sources` | `{text, version}`. Saves only if the file is still at `version`; otherwise `409` with what is there now |
| `POST /api/focus/objective` | `{objective, blocker}`. Sets the two frontmatter fields and keeps the rest of `focus.md`; returns fresh state |
| `POST /api/calendars/list` | The calendars Calendar.app has, for the settings page to choose from. A `POST` because it launches the helper, which may ask for access |
| `GET /api/status` | The few facts the menu bar app shows: brief age, open items, the morning agent's last run, setup and restart, the version, and whether a restart would stop the agent or the assistant |
| `GET /api/health` | Server health check |

## Update the screenshot

Use the temporary demo above with integrations disabled. Add an invented objective
to the temporary store's `focus.md` if needed. Capture the Today tab from the running
app, check that every visible name and detail is fictional, and save the image as
`docs/images/daily-focus.png`. Keep the README caption clear that it is sample data.

## The npm package

`npx daily-focus` runs the same code as a checkout, bundled. Node runs the
TypeScript in `src/` for a checkout but refuses it under `node_modules`, so
`npm run package` bundles `src/cli.ts` and everything it reaches into `dist/` with
esbuild, and `prepack` runs it along with the page's build. `test/package.test.ts`
builds it, installs it the way npm would, and runs the demo from there.

Two things follow from the bundle:

- Every module ends up in the CLI's files, so "was this file run directly" must be
  asked with `ranDirectly` from `src/install.ts`, which is only ever true for a
  `.ts` file. A module comparing its own URL with `process.argv[1]` would start
  itself inside any `daily-focus` command.
- Commands shown to the user come from `command()` there too: `npm run service`
  in a checkout is `daily-focus service` in the package.

Check what ships with `npm pack --dry-run`. Publishing is the Release workflow's
job, below; the version in `package.json` is a placeholder it stamps.

## The menu bar app

`macos/` is a Swift app that keeps the dashboard running from the menu bar: it starts
the server as its child, restarts it when it stops, shows the brief's age and the
morning agent's state from `GET /api/status`, and posts a notification when a brief
arrives or a run fails. It is built with `swiftc` and a shell script, no Xcode
project:

```sh
npm run app -- --test
```

That packs the npm package and puts exactly what it ships inside the app. It adds
the calendar helper, and Node.js at the version in `macos/node-version`: the official
Apple silicon release, checked against nodejs.org's checksums and cached in
`macos/build/`. The app is Apple silicon only, throughout. To move to a newer Node, change that file. It draws the icon and
the disk image's background (`macos/Artwork/main.swift`), signs everything, runs the
app's self-test, and makes `Daily-Focus.dmg` with dmgbuild (`macos/dmg-settings.py`),
which needs Python 3.10 or newer.

Signing uses a Developer ID Application certificate when the keychain has one,
otherwise Apple Development, which runs only on the Mac that built it. Set
`DAILY_FOCUS_NOTARY_PROFILE` to a `notarytool store-credentials` profile to notarise
the disk image and staple its ticket to it. Apple checks everything in the image,
so the ticket covers the app too; the app isn't stapled, so Gatekeeper looks its
ticket up online the first time it opens.

The app starts the server with `--exit-with-stdin` and holds its standard input, so
the server stops with the app however the app goes. To develop it against a
checkout, run the built binary with `DAILY_FOCUS_APP_SERVER_ENTRY=$PWD/src/cli.ts`,
a throwaway `DAILY_FOCUS_DATA` and a free `DAILY_FOCUS_PORT`.

The dashboard updates without the app (`macos/DailyFocus/Updater.swift`). Built
with a server, `macos/build.sh` also signs the same package as a bundle of its own,
`Daily Focus Dashboard.bundle`, zipped as `Daily-Focus-Dashboard.zip`, and checks
that the app it just built would run it (`--check-dashboard`). The app asks npm for
the newest version on its track (`latest` or `dev`) and downloads that release's
zip from GitHub. It keeps downloads in `~/Library/Application Support/Daily
Focus/Dashboards/` and runs the newest one only while its signature names the
app's own team and `dk.tson.daily-focus.dashboard`, with nothing in it changed. It
checks that again before every start. A download that stops three times before it
listens is given up on, and the app goes back to an older copy.

What a dashboard may ask of the app is `appInterface`, in `package.json` under
`daily-focus` and in `Updates.swift`. Raise both when the dashboard starts needing
something new from the app: a flag, the calendar helper, a permission in
`Info.plist` or the entitlements. `engines.node` is compared with the Node.js the app
carries, so keep it in the form `>=X.Y`. `test/app-interface.test.ts` checks both.
Set `DAILY_FOCUS_APP_UPDATES` to a URL to look up and download releases from
there instead, as `<url>/daily-focus/<tag>` and
`<url>/v<version>/Daily-Focus-Dashboard.zip`, to try an update against a local
server. A build without a Developer ID or Apple Development signature can't check
a download, so it only runs the dashboard it carries.

## Releases

`.github/workflows/release.yml` makes every release, from main, and main only
moves by pull request. Each one is a tag, a GitHub release holding the release
notes, `Daily-Focus.dmg` and `Daily-Focus-Dashboard.zip`, both signed, and the
same version on npm. The package it publishes carries `daily-focus.appSource`, the
last commit to change the app (`macos/` and `tools/dfcal/`), stamped at build time
and never committed. The app offers a newer release's disk image only when that
differs from its own, since otherwise only the dashboard changed:

- Every push to main is a development build, such as `0.2.0-dev.3`: a GitHub
  prerelease, and npm's `dev` tag, so `npx daily-focus@dev` runs the newest. Its
  disk image isn't notarised, which keeps the build to minutes, so macOS refuses
  it until it is allowed under System Settings → Privacy & Security; its notes
  say so. A build that main moves past while it runs isn't published, since the
  newer push's own build follows it.
- A stable release is cut by hand: Actions → Release → Run workflow, on main. It
  goes to npm's `latest` and is the GitHub release marked Latest. Its disk image
  is notarised, a wait on Apple's queue of anything from seconds to most of an
  hour. Leave the
  version empty to work it out, or give one, such as `1.0.0`, after the last.

`scripts/release.ts` works out the version from the commits since the last `vX.Y.Z`
tag: a breaking change bumps the major, a `feat` the minor, anything else the
patch, and below 1.0.0 a breaking change bumps the minor. A development build adds
`-dev.N`, N counting those commits. The notes follow conventional-changelog's
layout: breaking changes, features, fixes, performance and reverts, in that order,
with housekeeping types left out. To preview them:

```sh
node scripts/release.ts version --dev
node scripts/release.ts notes "$(node scripts/release.ts version --dev)"
```

npm takes the package from the workflow by trusted publishing, with no token. On
npmjs.com the package's settings name `watson/daily-focus` and `release.yml` as
its trusted publisher, with **Allow npm publish** ticked so a build goes out
without waiting for a 2FA approval, and **Allow npm dist-tag** left off: the tag
is set as part of the publish. Since that lets the workflow publish unattended,
the job that can is kept apart from everything that runs a dependency. `build`
installs, tests, packs and signs on macOS; `publish` has no checkout and no
`node_modules`, and only publishes the tarball and attaches the disk image
`build` handed it. The signing certificate likewise goes into the keychain only
after the last npm package has run.

Signing needs the first two of these repository secrets, and notarising, for a
stable release, the other three:

| Secret | What it is |
|---|---|
| `DEVELOPER_ID_P12` | The Developer ID Application certificate and its private key, exported from Keychain Access as a `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `DEVELOPER_ID_P12_PASSWORD` | The password the `.p12` was exported with |
| `NOTARY_KEY` | The contents of an App Store Connect API key's `AuthKey_XXXXXXXXXX.p8` (Users and Access → Integrations → Team Keys, Developer access) |
| `NOTARY_KEY_ID` | That key's ID |
| `NOTARY_ISSUER_ID` | The issuer ID shown above the team keys |

A run that fails can be rerun: it finds a release already made, or a version
already on npm, and finishes the rest. If only `publish` failed, Re-run failed
jobs reuses what `build` made. The GitHub release comes first because its tag is
the step GitHub may refuse: the workflow's token can't create a tag on a commit
whose workflows differ from main's. A stable release can therefore fail there if
a change to a workflow lands while it builds; run it again on the new main.
