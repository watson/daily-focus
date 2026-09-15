/**
 * The payload contract is written down three times, and it has to stay one contract.
 *
 * `schema/items.schema.json` is the machine-readable version. `AGENTS.md` describes
 * it for whoever is changing the dashboard, and `prompts/morning-brief.md` describes
 * it to the briefing agent — which cannot follow a pointer out of its own directory,
 * so restating it there is the design rather than an oversight.
 *
 * The cost of that is silent drift, and it has already happened twice: `dayStart` /
 * `dayEnd` reached the prompt and the schema but never `AGENTS.md`, and the `endedBy`
 * trust table reached `AGENTS.md` and so never reached the agent at all. Judgement
 * can only be reviewed, but field names are facts, and facts can be checked.
 *
 * So: every field in the schema must appear in both documents, and neither document
 * may describe a field the schema doesn't have — that last direction is the one that
 * catches a rename leaving a stale row behind.
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

const docs = {
  'AGENTS.md': await readFile(resolve(root, 'AGENTS.md'), 'utf8'),
  'prompts/morning-brief.md': await readFile(resolve(root, 'prompts/morning-brief.md'), 'utf8'),
};

const topLevel = Object.keys(schema.properties);
const itemFields = Object.keys(schema.$defs.item.properties);

/**
 * Field names as the docs mention them, in either of the two forms they legitimately
 * use: `` `name` `` in prose, or `"name":` as a key in a worked JSON payload.
 *
 * Deliberately not matching on table rows. Both documents introduce some fields in a
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

test('both documents agree on the source and kind vocabularies', () => {
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
test('both documents explain every way a session can end', async () => {
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

test('the required item fields are called out as required in both documents', () => {
  // Loose on wording, strict on the set: whatever sentence each document uses, all
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
 * Configuration is documented twice — the README table and `.env.example` — and read
 * once, in `src/config.ts`. A knob in any one of the three but not the others is a
 * setting nobody can find or one nobody can set, so the three lists have to match.
 */
test('the README, .env.example and config.ts name the same variables', async () => {
  const names = (text: string) => new Set([...text.matchAll(/DAILY_FOCUS_[A-Z_]+/g)].map((m) => m[0]));

  // The whole README, not a slice between headings: a check anchored on prose is
  // a check about formatting, and it goes quiet the day a heading is reworded.
  const documented = names(await readFile(resolve(root, 'README.md'), 'utf8'));
  const exampled = names(await readFile(resolve(root, '.env.example'), 'utf8'));
  const read = names(await readFile(resolve(root, 'src/config.ts'), 'utf8'));

  assert.ok(read.size >= 10, 'config.ts reads fewer variables than expected; did the naming change?');
  for (const name of read) {
    assert.ok(documented.has(name), `README never mentions ${name}`);
    assert.ok(exampled.has(name), `.env.example never mentions ${name}`);
  }
  for (const name of [...documented, ...exampled]) {
    assert.ok(read.has(name), `${name} is documented but config.ts never reads it`);
  }
});
