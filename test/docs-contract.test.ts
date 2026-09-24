/**
 * The briefing prompt must describe the schema because its reader works inside
 * the store. Check payload fields and session end reasons against their definitions.
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

/**
 * `sessions.jsonl` has no schema file, so the `SessionEnd` union in `src/types.ts` is
 * the source of truth for it. Worth checking even though it means scraping a type:
 * the `endedBy` trust table is the rule that went missing from the prompt, and the
 * consequence — citing a `limit` session as a long focused stretch — is a brief that
 * quietly flatters the user, which is the one thing the session log exists to prevent.
 */
test('the prompt explains every way a session can end', async () => {
  const types = await readFile(resolve(root, 'src/types.ts'), 'utf8');
  const union = /export type SessionEnd = ([^;]+);/.exec(types);
  assert.ok(union, 'SessionEnd is no longer declared where this test looks for it');

  const values = [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(values.length >= 2, 'expected a union of string literals');

  for (const [name, markdown] of Object.entries(docs)) {
    assert.ok(markdown.includes('endedBy'), `${name} never mentions endedBy at all.`);
    for (const value of values) {
      assert.ok(
        markdown.includes(`\`${value}\``),
        `${name} never explains how far to trust an \`${value}\` session.`,
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
  const client = await readFile(resolve(root, 'public/render.js'), 'utf8');

  const union = /export type Court = ([^;]+);/.exec(types);
  assert.ok(union, 'Court is no longer declared where this test looks for it');
  const courts = [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(courts.length >= 4, 'expected a union of string literals');

  const titles = /const COURT_TITLE = \{([^}]+)\}/.exec(client);
  assert.ok(titles, 'render.js no longer declares COURT_TITLE where this test looks');
  const titled = new Map([...titles[1]!.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1]!, m[2]!]));

  const order = /const COURT_ORDER = \[([^\]]+)\]/.exec(client);
  assert.ok(order, 'render.js no longer declares COURT_ORDER where this test looks');
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
  const client = await readFile(resolve(root, 'public/render.js'), 'utf8');

  const union = /export type TicketCourt = ([^;]+);/.exec(types);
  assert.ok(union, 'TicketCourt is no longer declared where this test looks for it');
  const courts = [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(courts.length >= 2, 'expected a union of string literals');

  const titles = /const TICKET_COURT_TITLE = \{([^}]+)\}/.exec(client);
  assert.ok(titles, 'render.js no longer declares TICKET_COURT_TITLE where this test looks');
  const titled = new Map([...titles[1]!.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1]!, m[2]!]));

  const order = /const TICKET_COURT_ORDER = \[([^\]]+)\]/.exec(client);
  assert.ok(order, 'render.js no longer declares TICKET_COURT_ORDER where this test looks');
  const ordered = [...order[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);

  assert.deepEqual([...titled.keys()].sort(), [...courts].sort(), 'TICKET_COURT_TITLE must name every court, and no others');
  assert.deepEqual([...ordered].sort(), [...courts].sort(), 'TICKET_COURT_ORDER must place every court, and no others');

  // Every court also needs the line saying what to do about it, since the
  // heading alone says only what is wrong.
  const hints = /const TICKET_COURT_HINT = \{([\s\S]+?)\n\};/.exec(client);
  assert.ok(hints, 'render.js no longer declares TICKET_COURT_HINT where this test looks');
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
  for (const file of ['items.json', 'actions.jsonl', 'assistant.jsonl', 'prs.json', 'calendar.json', 'tickets.json']) {
    assert.ok(agents.includes(file), `AGENTS.md never mentions ${file}`);
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
 * Configuration is documented twice — the setup guide and `.env.example` — and read
 * once, in `src/config.ts`. A knob in any one of the three but not the others is a
 * setting nobody can find or one nobody can set, so the three lists have to match.
 */
test('SETUP.md, .env.example and config.ts name the same variables', async () => {
  const names = (text: string) => new Set([...text.matchAll(/DAILY_FOCUS_[A-Z_]+/g)].map((m) => m[0]));

  // The whole setup guide, not a slice between headings: a check anchored on prose is
  // a check about formatting, and it goes quiet the day a heading is reworded.
  const documented = names(await readFile(resolve(root, 'SETUP.md'), 'utf8'));
  const exampled = names(await readFile(resolve(root, '.env.example'), 'utf8'));
  const read = names(await readFile(resolve(root, 'src/config.ts'), 'utf8'));

  assert.ok(read.size >= 10, 'config.ts reads fewer variables than expected; did the naming change?');
  for (const name of read) {
    assert.ok(documented.has(name), `SETUP.md never mentions ${name}`);
    assert.ok(exampled.has(name), `.env.example never mentions ${name}`);
  }
  for (const name of [...documented, ...exampled]) {
    assert.ok(read.has(name), `${name} is documented but config.ts never reads it`);
  }
});
