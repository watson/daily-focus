/**
 * Audit a brief against the contract, independently of what the agent claims.
 *
 *   npm run audit
 *   npm run audit -- --against ~/some/previous-items.json
 *
 * The agent self-reports against its own verification checklist, which is exactly the
 * kind of check you shouldn't take on trust: the same reasoning that got a rule
 * wrong will happily report that it followed it. This re-derives the answers from
 * the files on disk.
 *
 * Exits non-zero if anything failed, so it can gate a run.
 */

import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { parseBrief } from '../src/validate.ts';
import { runContractChecks } from '../src/checks.ts';
import { readArchiveIndex } from '../src/archive.ts';
import { fingerprintId } from '../src/ids.ts';
import { workingMsBetween } from '../src/time.ts';
import { BRIEF_REFRESH_GRACE_HOURS, describeSchedule, nextRunDate, resolveSchedule, runsOn } from '../src/schedule.ts';
import { resolveItems } from '../src/store.ts';
import type { Brief } from '../src/types.ts';

const config = loadConfig();
const store = new Store(config);

let failures = 0;
let warnings = 0;

function pass(label: string, detail = ''): void {
  console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label: string, detail = ''): void {
  failures++;
  console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warnings++;
  console.log(`  [33m![0m ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

/** `--against <path>`, else the newest archived brief from a different run. */
async function findPrevious(current: Brief): Promise<{ brief: Brief; from: string } | null> {
  const flag = process.argv.indexOf('--against');
  if (flag !== -1 && process.argv[flag + 1]) {
    const path = resolve(process.argv[flag + 1]!.replace(/^~/, process.env.HOME ?? '~'));
    return { brief: JSON.parse(await readFile(path, 'utf8')) as Brief, from: path };
  }

  let names: string[];
  try {
    names = (await readdir(config.archiveDir)).filter((n) => /^items-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch {
    return null;
  }

  for (const name of names.sort().reverse()) {
    const path = resolve(config.archiveDir, name);
    try {
      const brief = JSON.parse(await readFile(path, 'utf8')) as Brief;
      // Skip the archive entry that is just a copy of the brief we're auditing.
      if (brief.generatedAt !== current.generatedAt) return { brief, from: path };
    } catch {
      continue;
    }
  }
  return null;
}

/* ---------- store ---------- */

// Checked before the brief, because a prompt link that dangles is why tomorrow's
// brief won't exist: the agent is told to read a file that isn't there. Renaming
// a prompt in the repo leaves exactly that behind until `npm run init` runs again.
section('Store');
try {
  const link = await lstat(config.promptFile);
  if (!link.isSymbolicLink()) {
    pass('prompt.md', 'a real file, not linked to the repo');
  } else {
    const target = resolve(config.dataDir, await readlink(config.promptFile));
    try {
      await stat(target);
      if (target === config.promptSource) pass('prompt.md', `linked to the ${config.profile} prompt`);
      else warn('prompt.md', `linked to ${target}, not the ${config.profile} prompt — run \`npm run init\``);
    } catch {
      fail('prompt.md', `links to ${target}, which does not exist — run \`npm run init\``);
    }
  }
} catch {
  fail('prompt.md', 'missing — run `npm run init`');
}

/* ---------- payload ---------- */

const raw = await readFile(config.itemsFile, 'utf8');
const parsed = parseBrief(raw);

section('Payload');
if (!parsed.brief) {
  fail('items.json parses', parsed.error ?? 'unknown error');
  process.exit(1);
}
const brief = parsed.brief;
pass('items.json parses', `${brief.items.length} items, by ${brief.generatedBy ?? 'unknown'}`);

for (const warning of parsed.warnings) warn('parser warning', warning);
if (parsed.warnings.length === 0) pass('no items were dropped or repaired');

// The same scheduled-hours clock the dashboard uses: hours on a day the agent was
// never going to run don't count, so Friday's brief audited on Sunday is the current
// one rather than a late one. The schedule itself is reported, because an inferred
// one being wrong is otherwise invisible — and it is the thing this check rests on.
const auditedAt = new Date();
const schedule = await resolveSchedule(config, auditedAt);
const isRunDay = (d: Date) => runsOn(schedule, d);
const provenance = {
  config: 'from DAILY_FOCUS_AGENT_DAYS',
  observed: 'observed from the archive',
  default: 'assumed — set DAILY_FOCUS_AGENT_DAYS or let the archive fill up',
}[schedule.source];
pass('agent schedule', `${describeSchedule(schedule)} (${provenance})`);

const ranAt = new Date(brief.generatedAt);
const ageHours = (auditedAt.getTime() - ranAt.getTime()) / 3_600_000;
const scheduledAgeHours = workingMsBetween(ranAt, auditedAt, isRunDay) / 3_600_000;
const age = `${Math.round(ageHours * 10) / 10}h old`;
if (scheduledAgeHours >= config.staleAfterHours + BRIEF_REFRESH_GRACE_HOURS) fail('brief is fresh', `${Math.round(ageHours)}h old`);
else {
  const next = nextRunDate(schedule, auditedAt);
  pass('brief is fresh', isRunDay(auditedAt) ? age : `${age}, and no run was due today (next: ${next})`);
}

/* ---------- contract ---------- */

section('Contract');

const ids = brief.items.map((i) => i.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length) fail('ids are unique', [...new Set(duplicates)].join(', '));
else pass('ids are unique');

const untyped = brief.items.filter((i) => !i.id || !i.title || !i.source || !i.kind);
if (untyped.length) fail('every item has id/title/source/kind', `${untyped.length} missing`);
else pass('every item has id/title/source/kind');

const priorities = brief.items.filter((i) => i.priority !== undefined).map((i) => i.priority!);
const sortedPriorities = [...priorities].sort((a, b) => a - b);
const gapless = sortedPriorities.every((p, i) => p === i + 1);
if (priorities.length > 3) fail('at most three priorities', `${priorities.length} set`);
else if (priorities.length && !gapless) warn('priorities are 1..n with no gaps', sortedPriorities.join(', '));
else pass('priorities', priorities.length ? sortedPriorities.join(', ') : 'none set');

const badUrls = brief.items.filter((i) => i.url && !/^https?:\/\//.test(i.url));
if (badUrls.length) fail('all urls are http(s)', `${badUrls.length} bad`);
else pass('all urls are http(s)');

const timedEvents = brief.items.filter((i) => i.kind === 'event' && i.start && !/^\d{4}-\d{2}-\d{2}$/.test(i.start));
const noOffset = timedEvents.filter((i) => !/(Z|[+-]\d{2}:?\d{2})$/.test(i.start!));
if (noOffset.length) fail('timed events carry a timezone offset', `${noOffset.length} without`);
else pass('timed events carry a timezone offset', `${timedEvents.length} checked`);

if (!config.freeWindows) {
  pass('free windows off', brief.dayStart || brief.dayEnd ? 'dayStart / dayEnd present but unused' : 'no day bounds, none needed');
} else if (brief.dayStart || brief.dayEnd) {
  pass('working day set from the calendar', `${brief.dayStart ?? 'default'} → ${brief.dayEnd ?? 'default'}`);
} else {
  warn('working day not set', 'falling back to config; fine only if today is standard');
}

/* ---------- the objective, and the checks the server runs continuously ---------- */

section('Contract checks');

const focus = await store.readFocus();
const history = await readArchiveIndex(config);
const issues = runContractChecks({
  brief,
  items: resolveItems(brief.items, await store.readActions(), new Date()),
  focus,
  history,
});

// Exactly the checks that surface as banners on the page — shared implementation,
// so this can never drift from what the dashboard is telling you.
if (issues.length === 0) pass('no contract issues', focus?.objective ? `objective: ${focus.objective}` : 'no objective set');
for (const issue of issues) fail('contract', issue);

const aligned = brief.items.filter((i) => i.advancesObjective);
if (aligned.length) {
  console.log(`  ${aligned.length} item(s) advance the objective:`);
  for (const item of aligned) console.log(`      · ${item.priority ? `#${item.priority} ` : ''}${item.title}`);
}

/* ---------- the action log ---------- */

section('Action log');

const actions = await store.readActions();
const generatedAt = new Date(brief.generatedAt);

// Only actions that existed when the agent ran could have been honoured. Clicking
// "done" after the brief was written leaves the item in items.json by design —
// that's how the dashboard renders the cleared drawer — and is not a contract
// breach. Folding the whole log here would fail the audit on every click.
const priorActions = actions.filter((a) => new Date(a.at).getTime() < generatedAt.getTime());
const asGenerated = resolveItems(brief.items, priorActions, generatedAt);

const resurrected = asGenerated.filter((i) => i.status === 'done' || i.status === 'dismissed');
const stillSnoozed = asGenerated.filter((i) => i.status === 'snoozed');

if (resurrected.length) {
  fail('nothing already handled was re-raised', `${resurrected.length} item(s)`);
  for (const item of resurrected) console.log(`      · ${item.status}: ${item.title}`);
} else {
  pass(
    'nothing already handled was re-raised',
    `${priorActions.length} of ${actions.length} action(s) predated this brief`,
  );
}
if (stillSnoozed.length) warn('snoozed items present', `${stillSnoozed.length} — fine only if their date has arrived`);

/* ---------- continuity ---------- */

section('Continuity');

const previous = await findPrevious(brief);
if (!previous) {
  warn('no earlier brief to compare against', 'id stability unverified');
} else {
  console.log(`  comparing against ${previous.from}`);
  const previousIds = new Set(previous.brief.items.map((i) => i.id));
  const currentIds = new Set(ids);

  const reproduced = [...previousIds].filter((id) => currentIds.has(id));
  const dropped = [...previousIds].filter((id) => !currentIds.has(id));
  const added = [...currentIds].filter((id) => !previousIds.has(id));

  const actedOn = new Set(actions.filter((a) => a.action !== 'note').map((a) => a.id));
  const addedFingerprints = new Map(added.map((id) => [fingerprintId(id), id]));

  // Three reasons an id can disappear, and only one of them is a bug.
  const handled = dropped.filter((id) => actedOn.has(id));
  const drifted = dropped.filter((id) => !actedOn.has(id) && addedFingerprints.has(fingerprintId(id)));
  const cut = dropped.filter((id) => !actedOn.has(id) && !addedFingerprints.has(fingerprintId(id)));

  pass(`${reproduced.length} id(s) reproduced exactly`);
  if (handled.length) pass(`${handled.length} id(s) gone because you actioned them`);

  if (drifted.length) {
    fail(`${drifted.length} id(s) changed shape`, 'completed items under the old id will return');
    for (const id of drifted) console.log(`      · ${id} → ${addedFingerprints.get(fingerprintId(id))}`);
  } else {
    pass('no id changed shape', `${added.length} new id(s) are genuinely new`);
  }

  if (cut.length) {
    console.log(`  ${cut.length} id(s) dropped by editorial choice — expected when the agent cuts to fit:`);
    for (const id of cut.slice(0, 10)) console.log(`      · ${id}`);
  }

  // firstSeen must survive, or the ageing display silently resets every morning.
  const previousFirstSeen = new Map(previous.brief.items.map((i) => [i.id, i.firstSeen]));
  const lost = brief.items.filter(
    (i) => previousFirstSeen.get(i.id) && previousFirstSeen.get(i.id) !== i.firstSeen,
  );
  if (lost.length) {
    fail('firstSeen carried forward', `${lost.length} id(s) changed`);
    for (const item of lost.slice(0, 5)) {
      console.log(`      · ${item.id}: ${previousFirstSeen.get(item.id)} → ${item.firstSeen}`);
    }
  } else {
    pass('firstSeen carried forward', `${reproduced.length} id(s) checked`);
  }
}

/* ---------- verdict ---------- */

console.log(
  `\n${failures === 0 ? '[32mPASS[0m' : '[31mFAIL[0m'} — ` +
    `${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
