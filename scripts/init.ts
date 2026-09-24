/**
 * `npm run init` — create the private half of the store.
 *
 *   npm run init
 *
 * The dashboard needs two things it cannot invent: an objective, and the list of
 * places worth looking. Both are personal, so neither is in this repo — which
 * leaves a new user staring at an empty board with nothing telling them why. This
 * writes both as commented templates and says what to do next.
 *
 * It never overwrites. Everything in the store is either hand-written or the only
 * record of something (the action log is append-only and unreproducible), so a
 * second run reports what is already there and touches nothing. That makes it safe
 * to run when you can't remember whether you have.
 *
 * The three files this deliberately does *not* create are `items.json`,
 * `actions.jsonl` and `sessions.jsonl`. Each has exactly one writer — the agent for
 * the first, the dashboard for the other two — and all three read as empty when
 * absent, so creating them here would only blur the ownership rule the store
 * depends on.
 */

import { lstat, mkdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { relative, resolve } from 'node:path';

import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const repoRoot = resolve(import.meta.dirname, '..');

let created = 0;
let linked = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function kept(label: string, detail = ''): void {
  console.log(`  \x1b[2m·\x1b[0m \x1b[2m${label}${detail ? ` — ${detail}` : ''}\x1b[0m`);
}
function bad(label: string, detail = ''): void {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/**
 * Write `path` only if it isn't there.
 *
 * `wx` makes the check and the write one operation, so two runs at once can't both
 * decide the file is missing and race to create it. Checking first and writing
 * second would be a window in which a real focus.md could be clobbered.
 */
async function writeIfAbsent(path: string, contents: string, what: string): Promise<boolean> {
  try {
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
    created++;
    ok(`wrote ${what}`, relative(config.dataDir, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      kept(`${what} already exists, left alone`, relative(config.dataDir, path));
      return false;
    }
    bad(`could not write ${what}`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Point `target` in the store at `source` in this repo.
 *
 * A symlink rather than a copy, because the alternative is two versions of a long
 * prompt drifting apart silently — and the first symptom is a brief that carefully
 * followed a rule we replaced a month ago. The link means the scheduled task can
 * name a path inside the store while the content stays in git, reviewable.
 *
 * Unlike the files the user owns, this one *should* be refreshed: a stale link is a
 * stale prompt. So a link pointing somewhere else gets repointed — but a real file
 * is left strictly alone, since that is someone having deliberately put their own
 * prompt there and it is not ours to overwrite.
 */
async function linkIntoStore(target: string, source: string, what: string): Promise<void> {
  const where = relative(config.dataDir, target);
  const shown = `${where} → ${relative(repoRoot, source)}`;

  try {
    const stats = await lstat(target);
    if (!stats.isSymbolicLink()) {
      kept(`${what} is a real file, left alone`, `${where} — delete it to track the repo again`);
      return;
    }
    if (resolve(config.dataDir, await readlink(target)) === source) {
      kept(`${what} already linked`, shown);
      return;
    }
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      bad(`could not check ${what}`, error instanceof Error ? error.message : String(error));
      return;
    }
  }

  try {
    await symlink(source, target);
    linked++;
    ok(`linked ${what}`, shown);
  } catch (error) {
    // Windows needs Developer Mode or an elevated shell for this. Copying would
    // work, so say so rather than leaving the store half set up with no hint why.
    const code = (error as NodeJS.ErrnoException).code;
    const hint = code === 'EPERM' || code === 'EACCES' ? ' — copy it there by hand instead' : '';
    bad(`could not link ${what}`, `${error instanceof Error ? error.message : String(error)}${hint}`);
  }
}

const FOCUS_TEMPLATE = `---
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
Everything below this marker is read by the agent and never reaches the browser —
\`toPublicFocus\` strips it server-side, and a test asserts it can't survive
serialisation.

Put context here that should steer the ranking but shouldn't be on screen during a
screen share: why this objective matters right now, who is watching it, what is
riding on it. The agent weighs it, and is told never to quote it into a title or
detail.
`;

const WORK_SOURCES_TEMPLATE = `# Sources

The personal half of your morning brief. The prompt next to this file
(\`prompt.md\`) says *what* to gather and how to judge it; this file says *who* and
*where*. The briefing agent reads it; the dashboard never opens it.

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
*where*. The briefing agent reads it; the dashboard never opens it.

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

console.log(`\n\x1b[1mDaily Focus — store setup\x1b[0m`);
console.log(`\x1b[2m${config.dataDir} (${config.profile} profile)\x1b[0m`);

section('Directories');
try {
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.archiveDir, { recursive: true });
  ok('store and archive directory ready');
} catch (error) {
  bad('could not create the store', error instanceof Error ? error.message : String(error));
}

section('Files you own');
const wroteFocus = await writeIfAbsent(config.focusFile, FOCUS_TEMPLATE, 'the standing objective');
const wroteSources = await writeIfAbsent(
  config.sourcesFile,
  config.profile === 'personal' ? PERSONAL_SOURCES_TEMPLATE : WORK_SOURCES_TEMPLATE,
  'the source list the agent reads',
);

// Linked in so the briefing agent never needs to reach into this repo: everything
// it reads lives in one directory. Keeping it a link keeps the content in git.
section('Files linked from the repo');
// Which prompt follows DAILY_FOCUS_PROFILE, and a link to the other one — or to the
// work prompt's old name, before there were two — is stale and gets repointed.
await linkIntoStore(config.promptFile, config.promptSource, `the ${config.profile} morning prompt`);
await linkIntoStore(config.schemaFile, resolve(repoRoot, 'schema/items.schema.json'), 'the payload schema');

section('Files you do not own');
kept('items.json', 'the briefing agent writes it; absent reads as no brief yet');
kept('actions.jsonl', 'the dashboard appends to it as you action things');
kept('sessions.jsonl', 'the dashboard appends to it as you run focus sessions');

if (platform() !== 'darwin') {
  section('Note');
  kept(
    'idle detection is macOS-only',
    'focus sessions still work; they just fall back to the two-hour backstop instead of closing when you walk away',
  );
}

// Only ever ask for what is actually outstanding. Telling someone to go and write an
// objective they filled in months ago is how the last line of this output stops being
// read at all — and on an existing store the new link is usually the only news.
const next: string[] = [];
if (wroteFocus) next.push(`Edit ${config.focusFile} — say what you are trying to achieve.`);
if (wroteSources) next.push(`Edit ${config.sourcesFile} — say where to look.`);
if (linked > 0) next.push(`Point your scheduler at ${config.promptFile}. See prompts/README.md.`);

section(next.length > 0 ? 'Next' : 'Nothing to do');
if (next.length === 0) {
  console.log('  The store was already set up. Nothing was changed.');
  console.log(`  \`npm start\` to open the board, \`npm run audit\` to check the current brief.`);
} else {
  next.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  if (created > 0) {
    console.log(`  ${next.length + 1}. \`npm run seed\` for sample data, or \`npm start\` to open the board.`);
    console.log(
      `\n  \x1b[2mNo hurry on the scheduler — \`npm run seed\` writes a sample brief so you can\n  see the dashboard before an agent has ever run. It refuses to replace\n  items.json once a real brief exists.\x1b[0m`,
    );
  } else {
    console.log(
      `\n  \x1b[2mThe prompt is a link, so editing it in the repo takes effect on the next run\n  with no install step.\x1b[0m`,
    );
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
