/**
 * The briefing prompt must describe the schema because its reader works inside
 * the store. Check payload fields against their definitions.
 *
 * AGENTS.md contains coding guardrails, so it need not repeat the payload reference.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const schema = JSON.parse(await readFile(resolve(root, 'schema/items.schema.json'), 'utf8')) as {
  properties: Record<string, unknown>;
  $defs: { item: { properties: Record<string, unknown>; required: string[] } };
};

/** One prompt per profile; each is read verbatim by its own agent, so each is checked. */
const docs = {
  'prompts/morning-brief-work.md': await readFile(resolve(root, 'prompts/morning-brief-work.md'), 'utf8'),
  'prompts/morning-brief-personal.md': await readFile(resolve(root, 'prompts/morning-brief-personal.md'), 'utf8'),
};

const topLevel = Object.keys(schema.properties);
const itemFields = Object.keys(schema.$defs.item.properties);

/**
 * Field names as the prompt mentions them, in either of the two forms it can
 * use: `` `name` `` in prose, or `"name":` as a key in a worked JSON payload.
 *
 * Deliberately not matching on table rows. The prompt introduces some fields in a
 * sentence and others in an example, and a check that insisted on one shape would be
 * a check about formatting rather than about the contract.
 */
function mentioned(markdown: string): Set<string> {
  const field = /`([a-zA-Z][a-zA-Z0-9]*)`|"([a-zA-Z][a-zA-Z0-9]*)"\s*:/g;
  return new Set([...markdown.matchAll(field)].map((m) => m[1] ?? m[2]!));
}

for (const [name, markdown] of Object.entries(docs)) {
  const names = mentioned(markdown);

  test(`${name} documents every item field in the schema`, () => {
    const missing = itemFields.filter((field) => !names.has(field));
    assert.deepEqual(
      missing,
      [],
      `${name} never mentions ${missing.join(', ')}. Add it, or drop it from the schema.`,
    );
  });

  test(`${name} documents every top-level brief field`, () => {
    const missing = topLevel.filter((field) => !names.has(field));
    assert.deepEqual(
      missing,
      [],
      `${name} never mentions ${missing.join(', ')}. Add it, or drop it from the schema.`,
    );
  });
}

test('the prompt lists the source and kind values from the schema', () => {
  const sources = (schema.$defs.item.properties as { source: { enum: string[] } }).source.enum;
  const kinds = (schema.$defs.item.properties as { kind: { enum: string[] } }).kind.enum;

  for (const [name, markdown] of Object.entries(docs)) {
    for (const value of [...sources, ...kinds]) {
      assert.ok(
        markdown.includes(`\`${value}\``),
        `${name} never lists the \`${value}\` value the schema allows.`,
      );
    }
  }
});

test('the prompt calls out the required item fields', () => {
  // Loose on wording, strict on the set: whatever sentence the prompt uses, all
  // four names have to be in it, because "which fields may I omit" is the question
  // an agent gets wrong in a way the forgiving parser then hides.
  for (const [name, markdown] of Object.entries(docs)) {
    const claims = [...markdown.matchAll(/required/gi)].map((m) => {
      const from = Math.max(0, m.index! - 220);
      return markdown.slice(from, m.index! + 220);
    });
    assert.ok(
      claims.some((claim) => schema.$defs.item.required.every((field) => claim.includes(field))),
      `${name} never states that ${schema.$defs.item.required.join(', ')} are the required fields.`,
    );
  }
});

/**
 * The board's courts are written down three times too: the `Court` union the server
 * sorts and counts by, the client's title and order lists, and the README's list of
 * buckets. A court the server can produce and the client can't name renders as a
 * missing section — the rows simply vanish, with nothing on screen to say so, which
 * is the same class of silent failure the checks above exist to catch.
 */
test('the server, the client and the README agree on the board\'s courts', async () => {
  const types = await readFile(resolve(root, 'src/types.ts'), 'utf8');
  const client = await readFile(resolve(root, 'client/board.ts'), 'utf8');

  const union = /export type Court = ([^;]+);/.exec(types);
  assert.ok(union, 'Court is no longer declared where this test looks for it');
  const courts = [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(courts.length >= 4, 'expected a union of string literals');

  const titles = /const COURT_TITLE = \{([^}]+)\}/.exec(client);
  assert.ok(titles, 'the client no longer declares COURT_TITLE where this test looks');
  const titled = new Map([...titles[1]!.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1]!, m[2]!]));

  const order = /const COURT_ORDER = \[([^\]]+)\]/.exec(client);
  assert.ok(order, 'the client no longer declares COURT_ORDER where this test looks');
  const ordered = [...order[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);

  assert.deepEqual([...titled.keys()].sort(), [...courts].sort(), 'COURT_TITLE must name every court, and no others');
  assert.deepEqual([...ordered].sort(), [...courts].sort(), 'COURT_ORDER must place every court, and no others');

  // The README is what a person reads to know what a bucket claims, so every
  // heading the client can render has to appear there in the same words.
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  for (const title of titled.values()) {
    assert.ok(readme.includes(title), `the README never describes the "${title}" bucket`);
  }
  // The prose count goes stale silently, which is how "Four buckets" survived a
  // fifth being added in an earlier draft of this change.
  const spelled = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][courts.length];
  assert.match(
    readme,
    new RegExp(`\\b(${courts.length}|${spelled}) buckets\\b`, 'i'),
    `the README should say there are ${courts.length} buckets`,
  );
});

/**
 * And the ticket board's courts, which are written down in the same three places
 * for the same reason: a court the server can produce and the client can't name
 * renders as a missing section, and the rows simply vanish.
 */
test("the server, the client and the README agree on the ticket board's courts", async () => {
  const types = await readFile(resolve(root, 'src/types.ts'), 'utf8');
  const client = await readFile(resolve(root, 'client/tickets.ts'), 'utf8');

  const union = /export type TicketCourt = ([^;]+);/.exec(types);
  assert.ok(union, 'TicketCourt is no longer declared where this test looks for it');
  const courts = [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(courts.length >= 2, 'expected a union of string literals');

  const titles = /const TICKET_COURT_TITLE = \{([^}]+)\}/.exec(client);
  assert.ok(titles, 'the client no longer declares TICKET_COURT_TITLE where this test looks');
  const titled = new Map([...titles[1]!.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1]!, m[2]!]));

  const order = /const TICKET_COURT_ORDER = \[([^\]]+)\]/.exec(client);
  assert.ok(order, 'the client no longer declares TICKET_COURT_ORDER where this test looks');
  const ordered = [...order[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);

  assert.deepEqual([...titled.keys()].sort(), [...courts].sort(), 'TICKET_COURT_TITLE must name every court, and no others');
  assert.deepEqual([...ordered].sort(), [...courts].sort(), 'TICKET_COURT_ORDER must place every court, and no others');

  // Every court also needs the line saying what to do about it, since the
  // heading alone says only what is wrong.
  const hints = /const TICKET_COURT_HINT = \{([\s\S]+?)\n\};/.exec(client);
  assert.ok(hints, 'the client no longer declares TICKET_COURT_HINT where this test looks');
  for (const court of courts) {
    assert.match(hints[1]!, new RegExp(`\\b${court}:`), `TICKET_COURT_HINT says nothing about ${court}`);
  }

  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  for (const title of titled.values()) {
    assert.ok(readme.includes(title), `the README never describes the "${title}" bucket`);
  }
  const spelled = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][courts.length];
  assert.match(
    readme,
    new RegExp(`\\b(${courts.length}|${spelled}) buckets\\b`, 'i'),
    `the README should say there are ${courts.length} buckets`,
  );
});

/**
 * Keep file ownership in AGENTS.md so edits preserve the store's single writer rule.
 */
test('AGENTS.md names the brief, action log, and integration caches', async () => {
  const agents = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
  for (const file of ['items.json', 'actions.jsonl', 'assistant.jsonl', 'agent.jsonl', 'agent-settings.json', 'prs.json', 'calendar.json', 'tickets.json']) {
    assert.ok(agents.includes(file), `AGENTS.md never mentions ${file}`);
  }
});

/**
 * A setting reaches the agent only as a key in `agent-settings.json`, and the key
 * means nothing until the prompt says what it does. Each prompt is read on its own,
 * so each has to name the file and every key in it.
 */
test('both prompts explain every key the dashboard hands the agent', async () => {
  const { agentSettings } = await import('../src/agent.ts');
  const { loadConfig } = await import('../src/config.ts');
  const keys = Object.keys(agentSettings(loadConfig({})));
  assert.ok(keys.length > 0, 'agentSettings hands over nothing; did it move?');
  for (const [name, markdown] of Object.entries(docs)) {
    assert.ok(markdown.includes('`agent-settings.json`'), `${name} never tells the agent to read agent-settings.json`);
    for (const key of keys) assert.ok(markdown.includes(`\`${key}\``), `${name} never explains \`${key}\` in agent-settings.json`);
  }
});

/**
 * The assistant's prompt carries the rules that keep it read-only and inside its
 * chat. They live nowhere else the runner could enforce them, so the least the
 * tests can do is notice when one goes missing.
 */
test("the assistant's prompt keeps its never-rules and stays in the chat", async () => {
  const prompt = await readFile(resolve(root, 'prompts/assistant.md'), 'utf8');
  for (const rule of ['Never send', 'Never post', 'Never change', 'Do not leave notes']) {
    assert.ok(prompt.includes(rule), `prompts/assistant.md has lost the "${rule}" rule`);
  }
});

/**
 * The launch settings can't be on the settings page, which lives in the store they
 * locate, so the setup page on the site is where anyone finds them, with the
 * profile, which can be given at launch too. It names no other setting:
 * everything else is explained where it is changed, on the settings page, and a
 * second copy there would go stale.
 */
test('the setup page documents the launch settings and the profile, and only those', async () => {
  const { LAUNCH_SETTINGS, PROFILE_SETTING } = await import('../src/env.ts');
  const page = await readFile(resolve(root, 'site/setup/index.html'), 'utf8');
  const named = new Set([...page.matchAll(/DAILY_FOCUS_[A-Z_]+/g)].map((m) => m[0]));
  const documented = [...LAUNCH_SETTINGS, PROFILE_SETTING];
  for (const name of documented) assert.ok(named.has(name), `site/setup/index.html never mentions ${name}`);
  for (const name of named) {
    assert.ok(documented.includes(name), `site/setup/index.html names ${name}, which belongs on the settings page`);
  }
});

/**
 * The settings page is generated from `src/settings.ts`, so a setting `config.ts`
 * reads but the table doesn't list is a setting nobody can change at all.
 * The launch settings are the deliberate exception: they say where the store is,
 * so they can't be kept in it.
 */
test('the settings page lists every setting config.ts reads, except the launch settings', async () => {
  const { SETTINGS } = await import('../src/settings.ts');
  const { LAUNCH_SETTINGS } = await import('../src/env.ts');
  const read = new Set([...(await readFile(resolve(root, 'src/config.ts'), 'utf8')).matchAll(/DAILY_FOCUS_[A-Z_]+/g)].map((m) => m[0]));
  const listed = new Set(SETTINGS.map((setting) => setting.key));
  for (const name of read) {
    if (LAUNCH_SETTINGS.includes(name)) {
      assert.ok(!listed.has(name), `${name} is a launch setting, so it can't be on the settings page`);
    } else {
      assert.ok(listed.has(name), `${name} is read by config.ts but missing from the settings page in src/settings.ts`);
    }
  }
  for (const name of listed) assert.ok(read.has(name), `${name} is on the settings page but config.ts never reads it`);
});
