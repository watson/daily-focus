# Prompts

| File | What it is |
|---|---|
| [`morning-brief-work.md`](./morning-brief-work.md) | The scheduled prompt for the work briefing agent, run once every workday morning. |
| [`morning-brief-personal.md`](./morning-brief-personal.md) | The scheduled prompt for the personal briefing agent: email, family calendars, Apple Reminders, Apple Messages, e-Boks and the user's own GitHub projects. |

Both are **nothing but prompt** — the scheduled task reads one verbatim, so anything
else in there is either noise the agent has to skip or, worse, an instruction it
might try to act on. Notes about the prompts belong in this file instead.

`DAILY_FOCUS_PROFILE` decides which one `npm run init` links into a store. Each
profile is its own instance, with its own store, server and agent, so a store only
ever holds one. They are two complete files rather than a shared base with two
overlays, because the agent must be able to follow its prompt from a single read.
A rule both agents need goes into both.

## The agent's world is the store, not this repo

The briefing agent reads and writes one directory — `~/.daily-focus/` — and nothing
else. `npm run init` symlinks this prompt into it as `prompt.md`, alongside
`items.schema.json`, so the scheduled task only ever names a path inside the store:

```
~/.daily-focus/
  prompt.md           → prompts/morning-brief-work.md   (symlink, installed by npm run init)
  items.schema.json   → schema/items.schema.json   (symlink, installed by npm run init)
  focus.md            you write it
  sources.md          you write it
  items.json          the agent writes it
  actions.jsonl       the dashboard appends
  sessions.jsonl      the dashboard appends
  archive/            the dashboard writes
  prs.json            the dashboard writes: its last fetch of the user's open pull requests
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
a month ago.
The link keeps the content in git — reviewable, revertible — while the path the
scheduler names stays inside the store.

## Wiring the morning brief into the scheduled task

**Point the task at the store's path; don't paste the prompt's contents in.** The
prompt changes as the dashboard learns things, and a copy living in the scheduler goes
stale with no warning. Put only this stable wrapper in the scheduled task:

```
Run my morning brief for today.

Your full instructions are in this file — read it now and follow it exactly,
including every step it lists and the verification checks it ends with:

  ~/.daily-focus/prompt.md

That file is the source of truth and it changes over time. Re-read it on every
run; never work from your memory of a previous run.

Finish by reporting back as that file asks you to.
```

Those seven lines should never need editing again — the path is the only thing in them
that is specific to anything, and they name the prompt by role rather than by position
so renumbering its steps can't strand them. Everything that evolves lives in
the prompt, in git, where a change to it is reviewable. A scheduler has no
history and no review, so a rule that ends up there is one nobody can change or check.

Two things to sanity-check on the first scheduled run after switching:

- The agent can actually read `~/.daily-focus/prompt.md` from inside whatever sandbox
  the task runs in, and can follow the symlink out of it. If following links is
  blocked, replace it with a copy and add a step to your own routine to refresh it —
  but check first, because a copy is the failure mode above.
- It re-reads the file each run rather than caching it.

If the brief stops appearing, the dashboard's staleness banner is the alarm: it
turns red once the brief is more than 24 *working* hours old, so a silently broken
scheduled task surfaces the next morning rather than never — while the Saturday and
Sunday the task was never going to run don't fire it. At a weekend the dashboard says
so instead, in place of the warning, so Friday's board doesn't read as a failure.

Which days those are is the one thing the dashboard has to know about your task. It
reads `DAILY_FOCUS_AGENT_DAYS` if you set it — cron-numbered, so `1-5` is Mon–Fri and
`0-4` is the Sun–Thu week — and otherwise infers it from the days briefs have landed
on, falling back to Mon–Fri for the first three weeks. **Set it to match the task's
own day spec** when you change the schedule: if the two disagree, the banner is
confidently wrong in whichever direction the dashboard guessed. `npm run audit`
prints the schedule it's using and where it got it.

## Where the rules live

The prompt must explain every rule the briefing agent needs because that agent
works inside the store. Coding agents can read the implementation and tests, so
`AGENTS.md` only keeps the constraints that are easy to miss.

| | |
|---|---|
| `morning-brief-*.md` | **Authoritative for the agent.** What to gather, how to judge it, and every rule the agent must apply. Imperative, addressed to the agent, read verbatim every morning. |
| [`../AGENTS.md`](../AGENTS.md) | Coding guardrails for privacy, data ownership, and behavior to preserve. Never read by the morning agent. |
| [`../schema/items.schema.json`](../schema/items.schema.json) | **Authoritative for the payload.** Field names, types and enums. `test/docs-contract.test.ts` checks that the prompt documents these fields. |
| `~/.daily-focus/focus.md` | The standing objective. Not in this repo — it's personal state, and its lower half is deliberately never rendered. |
| `~/.daily-focus/sources.md` | Which calendars, account and recurring documents are yours. Not in this repo, for the same reason: it's the half of the brief that names real things. |

When code changes what the briefing agent must produce or understand, update the
prompt too. The tests check field names, required fields, enum values, and session
end reasons. Review changes to judgement rules directly.

## Why the personal specifics live outside the repo

The prompts are generic on purpose. Every real calendar name, account and
document id lives in `~/.daily-focus/sources.md`, which the prompt reads before it
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
scheduled run, with no install step. That's the point, but it does mean a
half-finished edit at 06:00 is what runs.
