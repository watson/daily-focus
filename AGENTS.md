# AGENTS.md

Keep this file short. Add guidance only for mistakes an agent is likely to make or
facts that are costly to rediscover. Keep feature details in code comments and tests.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, and the code map.

The morning briefing agent never reads this file. Its instructions belong in
[`prompts/morning-brief.md`](prompts/morning-brief.md), installed as a symlink in
the private store. Payload fields belong in [`schema/items.schema.json`](schema/items.schema.json).
Update the prompt when changing what the briefing agent must produce or understand.

## Private data and store ownership

- Use invented names, accounts, ticket keys, and content in tracked files, fixtures,
  screenshots, and commit messages. A real brief is private data, even as a fixture.
  Personal configuration belongs in the store or gitignored `.env`.
- The default store is `~/.daily-focus`. For development, set `DAILY_FOCUS_DATA` to a
  temporary directory or gitignored `./data`. Do not put real briefs at the repo root.
- The server must never open `sources.md`. Send focus text to the browser only through
  `toPublicFocus`, which strips everything after `<!-- agent-only -->`.

Each store file has one writer. There is no locking, so preserve these boundaries:

| Writer | Files |
|---|---|
| Briefing agent | `items.json` |
| Dashboard | `actions.jsonl`, `sessions.jsonl`, `session.json`, `archive/`, `prs.json`, `tickets.json`, `calendar.json` |
| User | `focus.md`, `sources.md` |
| `npm run init` | `prompt.md`, `items.schema.json` symlinks |

Never compact or rewrite `actions.jsonl` or `sessions.jsonl`. Do not write dashboard
records on the briefing agent's behalf. Integration caches use a sibling temporary
file and rename; they store facts, not computed board classifications.

`npm run seed` overwrites the brief. Always give it a throwaway store:

```sh
DAILY_FOCUS_DATA=$(mktemp -d) npm run seed
```

## Behavior to preserve

- Keep new brief fields optional and parsing forgiving. One malformed item must not
  prevent the rest of the brief from rendering.
- Treat item IDs as opaque and stable. Match with `canonicalId`; `fingerprintId` is
  only for drift warnings. The action log decides whether a brief item is handled,
  never upstream read status or absence from a query. PR and Jira boards deliberately
  ignore `done` and `dismiss` because they show upstream state.
- A failed integration read is not an empty result. Preserve the last successful
  data or use the documented fallback, and surface the failure.
- `transitionTicket` is the only external write. It moves one Jira ticket to one
  status after a user click. Do not add automatic transitions or other external writes
  without an explicit scope change.

## Checks

Run `npm run typecheck` and `npm test` for code changes. Keep tests independent of
live accounts and calendar permission prompts.

`npm run audit` checks the brief in the selected store, not the code.
`test/docs-contract.test.ts` checks prompt/schema, configuration, and board-label
consistency. New settings must appear in `src/config.ts`, `.env.example`, and `SETUP.md`.
