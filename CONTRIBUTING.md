# Contributing to Daily Focus

[Back to the README](README.md)

The server is TypeScript run directly by Node.js, with no runtime package
dependency. The client is TypeScript too, written on Preact and bundled by esbuild
into `public/app.js`, which is not tracked: `npm run dev` rebuilds it as you edit,
and `npm start` builds it once before listening.

Read [AGENTS.md](AGENTS.md) before changing behavior. It covers file ownership,
privacy, and constraints that apply across the codebase. For installation and account
setup, use the [setup guide](https://dailyfocus.dev/setup/), whose source is
`site/setup/index.html`.

## Run locally

Use Node.js 22.18 or newer, preferably Node 24. From the repo, start with a temporary
store so your changes don't affect a real brief:

```sh
npm install
export DAILY_FOCUS_DATA=$(mktemp -d)
mkdir "$DAILY_FOCUS_DATA/work"
echo '{"DAILY_FOCUS_GITHUB":"off","DAILY_FOCUS_JIRA":"off","DAILY_FOCUS_CALENDAR":"off"}' > "$DAILY_FOCUS_DATA/work/settings.json"
npm run seed
npm run dev
```

`DAILY_FOCUS_DATA` names the data folder, which holds a store per profile; `work/`
is the one a dashboard opens when it isn't given `DAILY_FOCUS_PROFILE=personal`.

A new store has the agent and the assistant off, and the settings file turns off
the boards and the live agenda, so nothing reaches your accounts. Turn anything on
from the settings page; it saves into the temporary store. Settings aren't read from
the environment, so nothing exported in your shell can switch one on behind the page.
`npm run demo` is the quicker look: its own throwaway store with a few weeks of
sample data for every screen, both boards answered from the sample worlds in
`src/demo.ts` rather than from gh and acli, and the agent and the assistant held
off. `npm run demo -- --profile personal` shows the personal profile. It is what
`npx daily-focus --demo` runs.

Open [localhost:4321](http://127.0.0.1:4321). If your own dashboard runs as a
service, it already has that port: export `DAILY_FOCUS_PORT=4322` as well and open
that one. The server restarts on changes, and the client is rebuilt. An open tab
reloads when the bundle changes, or offers a reload if you're writing a note.
Close this terminal when done to clear the temporary settings.

Use invented data for fixtures and screenshots. Never copy a real brief, calendar,
account name, or ticket into a tracked file. If you need a store inside the repo,
use the gitignored `data/` directory.

To run your own dashboard from a checkout rather than the package, `npm start` runs
it in the terminal, and `npm run service` keeps it running as a LaunchAgent for
that checkout, which rebuilds the page each time it starts; run it again after
pulling. Each `daily-focus <command>` that `daily-focus --help` lists is `npm run <command>`
here, with two differences: `build-calendar` is `build:calendar`, and flags go after
`--`, as in `npm run audit -- --against <file>`. To build the menu bar app, see
[The menu bar app](#the-menu-bar-app).

## Check your changes

```sh
npm run typecheck
npm test
```

The tests use Node's built-in test runner. They use fixtures and temporary stores;
keep them independent of live accounts and calendar permission prompts. The ones
that render the client do so into a happy-dom document through `test/dom.ts`, so a
rendered row can be asked the same questions a browser would answer.

CI runs the suite on Windows too. A test that stands in for Codex, Claude Code, `gh`
or `acli` writes the stand-in with `fakeCli` (`test/fakecli.ts`), a Node script
started the way the dashboard starts the real one, rather than a shell script, and
a path a test expects is built with `path.join`. Tests that make symlinks skip
where Windows won't let them (`test/symlinks.ts`), and the few about macOS alone
skip on Windows.

To check a generated brief, run `npm run audit` with `DAILY_FOCUS_DATA` pointing to
its data folder, and `-- --profile personal` for a personal store. The audit checks content and history; it doesn't replace the test suite.

A pull request's title must be a [Conventional Commit](https://www.conventionalcommits.org/),
such as `feat(board): show draft pull requests` or `fix!: read settings from the
store`. It is squash-merged with that title as the commit on main, which is where
versions and release notes come from, so CI checks it.

## Find your way around

| Path | Responsibility |
|---|---|
| `src/server.ts` | HTTP endpoints and live state updates over SSE |
| `src/types.ts`, `schema/items.schema.json` | Types and the brief payload contract |
| `src/config.ts`, `src/env.ts` | Settings: the store's `settings.json`, and where the data folder is, which profile, and how the server listens from the environment |
| `src/stores.ts` | Which store in the data folder a dashboard opens, and moving a store from before the profile folders into its folder |
| `src/settings.ts` | The settings page: every setting's label, help and field, and checking a change before it is saved |
| `src/setup.ts` | What a new store still needs: the CLIs installed, the calendar helper, whether a brief has ever existed |
| `src/clis.ts` | Finding Codex and Claude Code: installed, new enough and logged in, and which setup uses without asking |
| `src/questions.ts` | The setup screen's questions: each card, what a CLI is asked to propose for it, and what the answer writes |
| `src/onboarding.ts`, `client/onboarding.ts` | The setup screen: the CLI sessions that propose answers, the answers kept until the finish, and the page that asks |
| `client/setup.ts` | Today between the setup screen's finish and the first brief |
| `client/settings.ts` | The settings page, built from `src/settings.ts`, and the editors for `focus.md` and `sources.md` |
| `src/editable.ts`, `src/templates.ts` | Saving `focus.md` and `sources.md` from the editors without overwriting a hand edit, and what they start as |
| `src/shellpath.ts` | Your login shell's PATH, for a dashboard started by launchd or an app |
| `src/store.ts`, `src/validate.ts`, `src/ids.ts` | Read the brief, salvage malformed items, and apply actions |
| `src/links.ts` | Linking the prompt, schema and assistant's instructions into the store at every start, and noticing when something repoints them |
| `src/focus.ts`, `src/archive.ts` | Objective privacy and progress history |
| `src/agenda.ts`, `src/calendar.ts`, `src/calendarboard.ts` | Free time, calendar reads, and polling |
| `src/zone.ts`, `client/zone.ts` | The dashboard's time zone: the one the browser last reported, or the Mac's when it moves |
| `src/github.ts`, `src/prs.ts`, `src/board.ts` | GitHub reads, PR classification, and polling |
| `src/jira.ts`, `src/linked.ts`, `src/tickets.ts`, `src/ticketboard.ts` | Jira access, GitHub's correction to Jira's pull request states, ticket classification, and polling |
| `src/failure.ts`, `client/failure.ts` | How the three pollers report a failed read: one line, and the detail behind a click |
| `src/assistant.ts` | The on-demand assistant: runs a coding-agent CLI headless against one row |
| `src/autoask.ts` | Asking the assistant ahead, on its own, about pull requests waiting on you, and which question each row's state calls for |
| `src/agent.ts` | Runs the morning agent through a coding-agent CLI, on the dashboard's clock and when the user asks, and keeps each run's report, steps and follow-up chat |
| `src/codexsessions.ts` | Reads a Codex run's subagents from Codex's own session files, since `codex exec --json` doesn't say what they do |
| `src/cli.ts`, `src/install.ts` | The `daily-focus` command the npm package installs, and telling a checkout from the package |
| `src/sample.ts`, `src/demo.ts` | The sample brief for each profile behind `npm run seed`, and everything the demo puts around it: the store's files, the sample pull requests and tickets, and the settings it runs with |
| `client/` | The page: Preact components, view state, keyboard controls, and browser API calls |
| `public/` | The page shell, the stylesheet, the two typefaces it serves itself (`fonts/`, so nothing is fetched from a third party), and the built bundle |
| `scripts/` | Store initialization, the macOS background service, sample data, brief audits, and the package build |
| `tools/dfcal/` | The macOS calendar helper, which the app and the npm package carry built and signed |
| `macos/` | The macOS menu bar app, which runs the dashboard in place of `daily-focus service`; `npm run app -- --test` builds and checks it |
| `prompts/` | The briefing agent's instructions, the assistant's, and setup's |
| `apps-script/` | Optional Google Tasks export |
| `site/` | The marketing page for dailyfocus.dev: static HTML, CSS and script with no build step, in the dashboard's own fonts and colours, on its sample data; `.github/workflows/site.yml` publishes it to GitHub Pages when main changes it |

## Keep the contracts in sync

Each store file has one writer. The agent writes `items.json`; the dashboard
appends actions, archives briefs, maintains integration caches, saves
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
- Settings belong in `src/config.ts` and `src/settings.ts`. The three launch settings,
  which can't be on the settings page, are documented on the setup page instead,
  with the profile, which can be given at launch too.
- Board buckets belong in server types, the client renderer, and the README.

`test/docs-contract.test.ts` checks these lists for drift. Keep private focus text
out of client state, and keep computed board classifications out of the caches.

## HTTP API

The server binds to localhost by default. These are the endpoints used by the UI;
see `src/server.ts` for request validation and additional routes.

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
| `POST /api/onboarding/detect` | Looks for Codex and Claude Code, which the setup screen asks when it opens; with one ready, the first question answers itself |
| `POST /api/onboarding/answer` | `{step, answer}`. Records a setup answer, or `{later: true}`; returns state. `409` with the reason when its settings would be refused |
| `POST /api/onboarding/revise` | `{step, text, draft}`. Tells the CLI looking into a setup question what to change; the new proposal streams in over SSE |
| `POST /api/onboarding/retry` | `{step}`. Looks into a setup question again, or checks again what it needs |
| `POST /api/onboarding/finish` | Saves every setup answer at once and asks for the first brief; the dashboard restarts to apply the settings |
| `GET /api/onboarding/sources` | The source list the finish would write, or that it keeps the one there is |
| `POST /api/agent/ask` | `{run, text}`. Asks a finished run a question in its own session; returns state with the answer coming. The reply streams in over SSE. `409` when it is off, busy, or the run can't be continued |
| `POST /api/agent/stop` | Kills whatever the morning agent is doing: a run, or a question about one |
| `GET /api/settings` | Every setting: its value, where it came from (saved, fixed by the demo, or the default), its default, and the page's label and help |
| `POST /api/settings` | `{values: {NAME: value or null}}`. Checks the change by building the config from it, saves `settings.json`, and restarts the dashboard in place once nothing is running. `400` names the setting it refused |
| `GET /api/text/focus`, `GET /api/text/sources` | The whole file for its editor, private part included, with its version and the template a new one starts from. Never part of `/api/state` |
| `POST /api/text/focus`, `POST /api/text/sources` | `{text, version}`. Saves only if the file is still at `version`; otherwise `409` with what is there now |
| `POST /api/focus/objective` | `{objective, blocker}`. Sets the two frontmatter fields and keeps the rest of `focus.md`; returns fresh state |
| `POST /api/calendars/list` | The calendars Calendar.app has, for the settings page to choose from. A `POST` because it launches the helper, which may ask for access |
| `GET /api/status` | The few facts the menu bar app shows: brief age, open items, the morning agent's last run, setup and restart, the version, and whether a restart would stop the agent or the assistant |
| `GET /api/health` | Server health check |

## Update the screenshot

Use `npm run demo`, which already has an invented objective and both boards filled.
Capture the Today tab from the running app, check that every visible name and detail
is fictional, and save the image as `docs/images/daily-focus.png`. Keep the README
caption clear that it is sample data.

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

The package carries the calendar helper too, at `tools/dfcal/build/`, where a
checkout's `npm run build:calendar` puts it (`OWN_CALENDAR_APP` in
`src/install.ts`), so nobody needs the Xcode command line tools for the live
agenda, with the app or without. A release puts there the copy it signed for the
app, after `npm pack`: the signing certificate reaches the keychain only once the
last npm package has run. A pack from a checkout carries whatever that checkout
last built, or no helper, and `daily-focus build-calendar` is for a package
without one.

## The menu bar app

`macos/` is a Swift app that keeps the dashboard running from the menu bar: it starts
the server as its child, restarts it when it stops, shows the brief's age and the
morning agent's state from `GET /api/status`, and posts a notification when a brief
arrives or a run fails. It is built with `swiftc` and a shell script, no Xcode
project:

```sh
npm run app -- --test
```

That packs the npm package and puts exactly what it ships inside the app, less any
calendar helper in it. It adds its own calendar helper, and Node.js at the version
in `macos/node-version`: the official Apple silicon release, checked against
nodejs.org's checksums and cached in `macos/build/`. The app is Apple silicon only,
except the helper, which is built for Intel Macs and macOS 11 too because the npm
package carries the same one. To move to a newer Node, change that file. It draws the icon and
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
the server stops with the app however the app goes. It runs a dashboard for each
profile the user has added, at most two, with `--profile` and a port each, and keeps
that list in UserDefaults for the data folder (`macos/DailyFocus/Dashboards.swift`).
To develop it against a checkout, run the built binary with
`DAILY_FOCUS_APP_SERVER_ENTRY=$PWD/src/cli.ts`, a throwaway `DAILY_FOCUS_DATA` and a
free `DAILY_FOCUS_PORT`: a throwaway folder starts a list of its own. Run it under
another bundle identifier on a Mac where the real app runs, since the two would
share the record of the server each left running.

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
there instead, as `<url>/daily-focus/<tag>` and `<url>/v<version>/<asset>`, to
try an update against a local server. A build without a Developer ID or Apple
Development signature can't check a download, so it only runs the dashboard it
carries.

The app replaces itself when a release changed its own code (`appSource`, below),
and only then: otherwise it downloads the dashboard alone. `macos/build.sh` zips
the signed app as `Daily-Focus-App.zip` and checks that the app would accept it
(`--check-app`): the app's own identifier and team, with nothing in it changed. The
app unpacks a download into a folder macOS gives it on the app's volume, checks it
there, swaps the two folders in one `renamex_np` call, checks it again in place,
and swaps back if that fails. Then it quits, and a shell it leaves behind opens
the new copy once the old one has exited, passing on the `DAILY_FOCUS_*`
variables. A build from a checkout or without a team signature, and an app that
runs from a disk image, from a translocated copy, or from a folder the account
can't write to, link to the release page instead (`replacementProblem`). To try
it, give two copies another `CFBundleIdentifier` and two versions, re-sign them,
and serve the newer one's zip: the identifier keeps them out of the installed
app's settings, where the dashboard's process id is kept.

**Update Automatically**, off until the user turns it on, lets an update start on
its own (`updateUnattended`) once `GET /api/status` says nothing is busy and its
`usedAt` is half an hour old (`mayUpdateUnattended`). `usedAt` is when a page last
said someone used it, kept in memory and starting at the dashboard's start: a
visible tab posts `/api/presence` on a click, key, scroll or touch, at most once
a minute (`client/presence.ts`), because the Mac the app runs on is often not the
one the dashboard is read from. A dashboard without `usedAt` never updates on its
own. One that fails isn't tried on its own again; it is offered by notification.

## Releases

`.github/workflows/release.yml` makes every release, from main, and main only
moves by pull request. Each one is a tag, a GitHub release holding the release
notes, `Daily-Focus.dmg`, `Daily-Focus-App.zip` and `Daily-Focus-Dashboard.zip`,
all signed, and the same version on npm, with the app's signed calendar helper in
it. The package it publishes carries `daily-focus.appSource`, the last commit to
change the app (`macos/` and `tools/dfcal/`), stamped at build time and never
committed. The app replaces itself with a newer release's only when that differs
from its own, since otherwise only the dashboard changed:

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
