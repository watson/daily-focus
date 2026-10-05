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
 * second run reports what is already there and touches nothing but the links into
 * this repo, which it points at this checkout. That makes it safe to run when you
 * can't remember whether you have.
 *
 * The three files this deliberately does *not* create are `items.json`,
 * `actions.jsonl` and `sessions.jsonl`. Each has exactly one writer — the agent for
 * the first, the dashboard for the other two — and all three read as empty when
 * absent, so creating them here would only blur the ownership rule the store
 * depends on.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { relative } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { describeLink, linkStore } from '../src/links.ts';
import { FOCUS_TEMPLATE, sourcesTemplate } from '../src/templates.ts';

const config = loadConfig();

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
const wroteSources = await writeIfAbsent(config.sourcesFile, sourcesTemplate(config.profile), 'the source list the agent reads');

// The same links the dashboard makes each time it starts, made here too so a
// store set up by hand is complete before the dashboard has ever run. Which prompt
// follows DAILY_FOCUS_PROFILE, and a link to the other one is repointed.
section('Files linked from the repo');
for (const outcome of await linkStore(config)) {
  const shown = describeLink(config, outcome);
  if (outcome.result === 'linked') {
    linked++;
    ok(`linked ${outcome.name}`, shown);
  } else if (outcome.result === 'kept') kept(`${outcome.name} already linked`, shown);
  else if (outcome.result === 'own') kept(`${outcome.name} is a real file, left alone`, 'delete it to track the repo again');
  else bad(`could not link ${outcome.name}`, outcome.detail ?? '');
}

section('Files you do not own');
kept('items.json', 'the briefing agent writes it; absent reads as no brief yet');
kept('actions.jsonl', 'the dashboard appends to it as you action things');
kept('sessions.jsonl', 'the dashboard appends to it as you run focus sessions');
kept('assistant.jsonl', 'the dashboard appends to it as you ask the assistant for help');

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
if (!config.agent.cli) next.push('Set DAILY_FOCUS_AGENT=codex or claude in .env, so the dashboard runs the morning agent. See SETUP.md.');

// A Mac can keep the board running as a LaunchAgent, which outlives the terminal
// and a restart. Anywhere else, `npm start` is the way in.
const start = platform() === 'darwin' ? '`npm run service` to run the board in the background' : '`npm start` to open the board';

section(next.length > 0 ? 'Next' : 'Nothing to do');
if (next.length === 0) {
  // A repointed link is the one change a second run makes, and the one worth hearing about:
  // it means the briefs before it followed another checkout's prompt.
  console.log(
    linked > 0
      ? `  The store was already set up. Linked ${linked} ${linked === 1 ? 'file' : 'files'} to this checkout; nothing else changed.`
      : '  The store was already set up. Nothing was changed.',
  );
  console.log(`  ${start}, \`npm run audit\` to check the current brief.`);
} else {
  next.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  if (created > 0) {
    console.log(`  ${next.length + 1}. ${start}.`);
    // Never `npm run seed` here. This is the real store, and the agent's first run
    // carries every open task in the previous items.json forward, so sample tasks
    // would become the user's work. The README's demo seeds a throwaway store.
    console.log(
      `\n  \x1b[2mTo look around before an agent has run, try the demo in the README. It\n  shows sample data from a throwaway store, so nothing lands in this one.\x1b[0m`,
    );
  } else {
    console.log(
      `\n  \x1b[2mThe prompt is a link, so editing it in the repo takes effect on the next run\n  with no install step.\x1b[0m`,
    );
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
