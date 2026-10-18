# Prompts

| File | What it is |
|---|---|
| [`morning-brief-work.md`](./morning-brief-work.md) | The prompt for the work briefing agent, run once every workday morning. |
| [`morning-brief-personal.md`](./morning-brief-personal.md) | The prompt for the personal briefing agent: email, family calendars, Apple Reminders, Apple Messages, e-Boks and the user's own GitHub projects. |
| [`assistant.md`](./assistant.md) | The instructions for the on-demand assistant, which the server runs headless when the user presses Ask on a row. One file for both profiles. Linked into the store as `assistant.md`. |
| [`onboarding.md`](./onboarding.md) | The instructions for the setup screen's CLI sessions, one per question, which propose the answer a new user most likely wants. Not linked into the store: the server reads it from the running copy and inlines it, as it does the assistant's. |

All four are **nothing but prompt** — each is read verbatim by its agent, so anything
else in there is either noise the agent has to skip or, worse, an instruction it
might try to act on. Notes about the prompts belong in this file instead.

The assistant's file differs from the briefing prompts in one way: the server does read it.
It is the server that starts the assistant, so it is the server that inlines these
instructions ahead of the row and the request on the first turn of a session. The
quick actions the panel offers are sentences in `src/assistant.ts`, not in the
prompt, so what the button sends is what the panel shows was sent.

The store's profile decides which one the dashboard links into it. Each profile
is its own instance, with its own store, server and agent, so a store only ever
holds one: `~/.daily-focus/work/` or `~/.daily-focus/personal/`, a folder per
profile in the data folder (see `src/stores.ts`). They are two complete files rather than a shared base with two
overlays, because the agent must be able to follow its prompt from a single read.
A rule both agents need goes into both.

## The agent's world is the store, not this repo

The briefing agent reads and writes one directory — the store, which it is started
in — and nothing else. The dashboard symlinks this prompt into it as `prompt.md`
each time it starts, alongside `items.schema.json`, so a run only ever names a path
inside the store:

```
~/.daily-focus/work/
  prompt.md           → prompts/morning-brief-work.md   (symlink, made by the dashboard at start)
  items.schema.json   → schema/items.schema.json   (symlink, made by the dashboard at start)
  focus.md            you write it, on the setup screen, in the dashboard or by hand
  sources.md          you write it, on the setup screen, in the dashboard or by hand
  settings.json       the dashboard writes: what you set on its settings page
  agent-settings.json the dashboard writes before every run: the settings the agent reads
  items.json          the agent writes it
  actions.jsonl       the dashboard appends
  agent.jsonl         the dashboard appends: every run, its report, and the questions asked of it
  archive/            the dashboard writes
  prs.json            the dashboard writes: its last fetch of the user's open pull requests
  onboarding.json     the dashboard writes: the setup screen's answers, and what was proposed for them
```

That boundary is the point, and it is worth being strict about. A prompt that reaches
into a source checkout picks up whatever else is lying there — and what is lying there
is `AGENTS.md`, imported by `CLAUDE.md`, which is addressed to a completely different
reader: someone changing the dashboard's code. An agent that reads both gets two
documents about the same contract in two voices and no way to tell which one it is
being asked to follow. Keeping the morning agent inside the store means the question
never comes up.

A symlink rather than a copy, because a second copy of a prompt this long drifts
silently, and the first symptom is a brief that carefully followed a rule we replaced
a month ago. The link keeps the content in git — reviewable, revertible — while the
path a run names stays inside the store. Linked at every start rather than once,
so the prompt the agent follows is always the running dashboard's own, however it
was installed. A real file in its place is left alone by the dashboard, `npm run
init` and the audit, for anyone who wants a private prompt of their own. Windows
makes a link only in Developer Mode, so there the dashboard copies the files
instead, and records each copy's hash in `copies.json`: a file with that hash is
its copy, refreshed at every start; anything else is someone's own.

## How a run starts

The dashboard starts the agent, and nothing else does: each scheduled morning at
`DAILY_FOCUS_AGENT_AT`, and from the refresh icon beside the brief's age. It runs
the CLI named by `DAILY_FOCUS_AGENT` headless, with the store as its working
directory, on a short wrapper prompt — `agentPrompt` in `src/agent.ts` — that
names `prompt.md` by its store path and tells the agent to read it now and follow
it. Nothing else is handed over: no extra instructions, no checkout, no copy of the
prompt. Everything that evolves lives in the prompt, in git, where a change to it is
reviewable, and the wrapper should never need editing.

A setting that changes how the agent gathers, such as searching deleted mail, reaches
it the same way everything else does: through the store. Before each run the dashboard
writes `agent-settings.json` with the values it is running with, as saved on the
settings page, and both prompts say what each key means.
The wrapper stays the same whatever the settings are.

The prompt has the agent hand the reading of its sources to subagents, which share
its working directory and what its CLI allows it, so the prompt also tells it to
tell them that they only read. The judging and the writing stay with the agent. The
run's panel shows each subagent under the step that started it: Claude Code reports
them in its output, and for Codex the dashboard reads Codex's own session files
(`src/codexsessions.ts`).

Which days it runs is `DAILY_FOCUS_AGENT_DAYS` — cron-numbered, so `1-5` is Mon–Fri
and `0-4` is the Sun–Thu week — and Mon–Fri when unset. The same schedule drives the
staleness banner, which turns red once the brief is more than 24 *working* hours old,
so a morning the run quietly failed surfaces that day rather than never — while the
Saturday and Sunday it was never going to run don't fire it. At a weekend the
dashboard says so instead, in place of the warning, so Friday's board doesn't read as
a failure. `npm run audit` prints the schedule it's using and where it got it.

## Where the rules live

The prompt must explain every rule the briefing agent needs because that agent
works inside the store. Coding agents can read the implementation and tests, so
`AGENTS.md` only keeps the constraints that are easy to miss.

| | |
|---|---|
| `morning-brief-*.md` | **Authoritative for the agent.** What to gather, how to judge it, and every rule the agent must apply. Imperative, addressed to the agent, read verbatim every morning. |
| [`../AGENTS.md`](../AGENTS.md) | Coding guardrails for privacy, data ownership, and behavior to preserve. Never read by the morning agent. |
| [`../schema/items.schema.json`](../schema/items.schema.json) | **Authoritative for the payload.** Field names, types and enums. `test/docs-contract.test.ts` checks that the prompt documents these fields. |
| `focus.md` in the store | The standing objective. Not in this repo — it's personal state, and its lower half is deliberately never rendered. |
| `sources.md` in the store | Which calendars, account and recurring documents are yours. Not in this repo, for the same reason: it's the half of the brief that names real things. |

When code changes what the briefing agent must produce or understand, update the
prompt too. The tests check field names, required fields and enum values. Review
changes to judgement rules directly.

## Why the personal specifics live outside the repo

The prompts are generic on purpose. Every real calendar name, account and
document id lives in the store's `sources.md`, which the prompt reads before it
gathers anything.

The tempting alternative — a tracked sample prompt plus a private copy with the real
names filled in — is the copy problem again, and this time on the file least able to
survive it. One prompt, one private data file, no copies.

If `sources.md` is missing the agent still runs: it briefs from the primary calendar
and connected accounts, and says so when it reports back.

## Editing the prompt

Keep the prompts free of anything that isn't addressed to the agent. In
particular: no setup instructions, no changelog, no commentary about why a rule
exists beyond what the agent needs to apply it well. The agent reads the whole file
every morning, and every line that isn't doing work is competing with the lines
that are.

You're editing a live file: the symlink means a save takes effect on the next
run, with no install step. That's the point, but it does mean a half-finished edit
at 06:59 is what runs at 07:00.
