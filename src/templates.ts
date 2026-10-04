/**
 * What `focus.md` and `sources.md` start as.
 *
 * Both are the user's words, and the dashboard writes them only when the user
 * saves them in its editors (or runs `npm run init`). These are the starting
 * text: the editor shows one when its file doesn't exist yet, and init writes
 * them so a hand-editor has something to fill in. Neither is written on the
 * user's behalf, because a source list still holding `Your Name` is worse than
 * none: the agent would go looking for it.
 */

import type { Profile } from './config.ts';

export const FOCUS_TEMPLATE = `---
objective:
blocker:
---

<!--
Fill in the two lines above: the one thing you are actually trying to achieve right
now, and what is in the way today, if anything. Leaving \`objective\` blank is fine:
the dashboard shows a quiet reminder instead. Delete this file to turn the feature
off entirely.

The dashboard renders them at the top of the board, and the briefing agent ranks the
whole day against them — so an objective phrased as a project ("ship the thing")
gives it less to work with than one phrased as a next move ("get the staging path
working again").

Prose below the frontmatter is shown under the objective. Comments like this one are
not. Keep it short and keep it current. This file is the only input describing what
you are trying to do, as opposed to what other people sent you overnight.
-->

<!-- agent-only -->
Everything below this marker is read by the agent and never shown on the board. The
dashboard shows it only in the editor you open to change it.

Put context here that should steer the ranking but shouldn't be on screen during a
screen share: why this objective matters right now, who is watching it, what is
riding on it. The agent weighs it, and is told never to quote it into a title or
detail.
`;

const WORK_SOURCES_TEMPLATE = `# Sources

The personal half of your morning brief. The prompt next to this file
(\`prompt.md\`) says *what* to gather and how to judge it; this file says *who* and
*where*. The briefing agent reads it; the dashboard shows it only in its editor.

Replace the placeholders below and delete whatever doesn't apply. A section you leave
out is fine — the agent falls back to your primary calendar and connected accounts,
and reports the gap. A section that is *wrong* is worse than one that is missing.

## Identity

Meeting notes, Doc assignments and tickets attribute work by name rather than by
account, so the agent needs to know which name is yours before it can tell your action
items from everyone else's. Leaving this out doesn't fail loudly — it just quietly
stops raising anything from those sources.

- Name, as meeting notes and Doc assignments write it: \`Your Name\`
- Work email: \`you@example.com\`
- GitHub login: \`your-github-login\` — review requests and authorship are judged
  against it

## Calendars

Query:

- the primary work calendar
- \`Some Shared Calendar\` — a second calendar whose events should still block time

Never query or include: \`Some Noisy Calendar\`.

## Holiday calendars

- \`Holidays in <where your colleagues are>\` — a holiday there means slow replies, and
  it is worth saying so.
- \`Holidays in <where you are>\` — call one out today, or within the next 14 days.

## Recurring meeting notes

Documents to re-read on every run. Name the tab where it matters, since these tend to
be long and only one part is current:

- https://docs.google.com/document/d/<document id>/edit?tab=t.0 — what meeting it is
`;

const PERSONAL_SOURCES_TEMPLATE = `# Sources

The private half of your morning brief. The prompt next to this file
(\`prompt.md\`) says *what* to gather and how to judge it; this file says *who* and
*where*. The briefing agent reads it; the dashboard shows it only in its editor.

Replace the placeholders below and delete whatever doesn't apply. A section you leave
out is fine — the agent reports the gap. A section that is *wrong* is worse than one
that is missing.

## Identity

- Name: \`Your Name\`
- Personal email: \`you@personal.example\`
- GitHub login: \`your-github-login\` — review requests and authorship are judged
  against it

## My weeks

What decides how much of a day is yours, so the agent can set the day's bounds: when
work ends, regular pickups, a rhythm that alternates week to week and how to tell
which week it is.

- Workdays end at 16:00; personal time is from then until 22:00.

## Calendars

- \`Personal\`
- \`Family\` — shared; its events block time too

Never query or include: \`Some Noisy Calendar\`.

## Holiday calendars

- \`Holidays in <where you live>\` — including school holidays, if there is one

## Email

Which tool reaches the account, and any senders to always raise or always skip.

## e-Boks

Which tool or CLI reaches it.

## Reminders

Which tool reaches Apple Reminders, and which lists to read. Unset means all of them.

## Messages

Which tool reaches Apple Messages, and any conversations to skip.

## GitHub

Which repositories or organisations are your own projects. Unset means everything
the login above has open.
`;

/** The source list a new store starts from, which differs by what the instance briefs. */
export function sourcesTemplate(profile: Profile): string {
  return profile === 'personal' ? PERSONAL_SOURCES_TEMPLATE : WORK_SOURCES_TEMPLATE;
}
