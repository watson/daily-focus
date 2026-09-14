# Google Tasks → Drive

[`tasks-export.gs`](./tasks-export.gs) runs in Apps Script, as you, and writes your
open Google Tasks to `daily-focus-tasks.json` in the root of your Drive. The briefing
agent reads that file with the Drive connector it already has.

## Why it isn't a local script like everything else

Google Tasks is unreachable from the laptop without an OAuth client, an OAuth client
lives in a Google Cloud project, and creating a project needs
`resourcemanager.projects.create` — which plenty of corporate Google orgs grant in no
folder at all, leaving nowhere to host one. Apps Script sidesteps the whole problem:
its projects come with a hidden default Cloud project, and adding the Tasks advanced
service in the editor enables the API there without touching the Cloud console.

The cost is that the brief sees tasks as of the last trigger run rather than as of now,
and that one piece of this system lives in Google's cloud instead of in this repo. If a
Cloud project ever does become available, a local `tasks.readonly` CLI is strictly
better on both counts — and replacing this changes nothing about `items.json`, the
contract, or the dashboard.

## Setting it up

1. [script.google.com](https://script.google.com) → **New project**, named
   `daily-focus-tasks`.
2. Paste [`tasks-export.gs`](./tasks-export.gs) over the whole of `Code.gs`.
3. **Services** → **+** → **Google Tasks API** → identifier `Tasks` → **Add**. This is
   the step that enables the API; there is nothing to do in the Cloud console.
4. Run `exportTasks` once by hand and authorise it — it asks for Tasks and Drive
   access. Check that `daily-focus-tasks.json` appears in Drive and holds your tasks.
5. Run `installTrigger` once. It schedules `exportTasks` hourly and removes any
   trigger it previously installed, so running it again is safe.

## Keeping it honest

There is no deploy pipeline: step 2 is the deploy. Edit this file in git, then paste it
in again. A change made only in the Apps Script editor is a change nobody can review
and nobody will find.

Failures don't surface in the dashboard — Apps Script emails you a failure summary, and
the **Executions** tab in the editor lists every run. The agent's own report is the
other alarm: it's told to treat a missing file, or a `generatedAt` older than 24 hours,
as a source that was unavailable and to say so rather than brief as if the list were
empty.
