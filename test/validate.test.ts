import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseActionLine, parseBrief } from '../src/validate.ts';

test('parses a minimal brief', () => {
  const { brief, error, warnings } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [{ id: 'a', source: 'github', kind: 'task', title: 'Review something' }],
    }),
  );

  assert.equal(error, null);
  assert.deepEqual(warnings, []);
  assert.equal(brief?.items.length, 1);
  assert.equal(brief?.items[0]?.title, 'Review something');
});

test('reports a hard error for unusable payloads, not a crash', () => {
  assert.match(parseBrief('{ not json').error ?? '', /not valid JSON/);
  assert.match(parseBrief('[]').error ?? '', /must contain a JSON object/);
  assert.match(parseBrief('{"version":1}').error ?? '', /"items" array/);
});

test('keeps the good items when one is malformed', () => {
  const { brief, warnings } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [
        { id: 'ok', title: 'Fine', source: 'github', kind: 'task' },
        { title: 'No id at all', source: 'github' },
        'not even an object',
        { id: 'no-title', source: 'email' },
      ],
    }),
  );

  assert.deepEqual(
    brief?.items.map((item) => item.id),
    ['ok'],
  );
  assert.equal(warnings.length, 3);
  assert.match(warnings.join(' '), /no "id"/);
});

test('drops a duplicate id rather than letting one action hit two rows', () => {
  const { brief, warnings } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [
        { id: 'dupe', title: 'First', source: 'github', kind: 'task' },
        { id: 'dupe', title: 'Second', source: 'github', kind: 'task' },
      ],
    }),
  );

  assert.equal(brief?.items.length, 1);
  assert.equal(brief?.items[0]?.title, 'First');
  assert.match(warnings.join(' '), /repeats id/);
});

test('normalises the source aliases an agent is likely to emit', () => {
  const { brief } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [
        { id: '1', source: 'gmail', title: 'a', kind: 'task' },
        { id: '2', source: 'GitHub', title: 'b', kind: 'task' },
        { id: '3', source: 'confluence', title: 'c', kind: 'task' },
        { id: '4', source: 'something-else', title: 'd', kind: 'task' },
        { id: '5', source: 'google-tasks', title: 'e', kind: 'task' },
      ],
    }),
  );

  assert.deepEqual(
    brief?.items.map((item) => item.source),
    ['email', 'github', 'atlassian', 'other', 'tasks'],
  );
});

test('infers kind from the presence of a start time', () => {
  const { brief } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [
        { id: '1', title: 'no kind, no start' },
        { id: '2', title: 'no kind, has start', start: '2026-09-10T09:00:00Z' },
      ],
    }),
  );

  assert.equal(brief?.items[0]?.kind, 'task');
  assert.equal(brief?.items[1]?.kind, 'event');
});

test('refuses a non-http url so it can never reach the DOM', () => {
  const { brief, warnings } = parseBrief(
    JSON.stringify({
      version: 1,
      generatedAt: '2026-09-10T06:00:00Z',
      items: [{ id: '1', title: 'x', url: 'javascript:alert(1)' }],
    }),
  );

  assert.equal(brief?.items[0]?.url, undefined);
  assert.match(warnings.join(' '), /non-http url/);
});

test('parses action lines and rejects junk', () => {
  assert.deepEqual(parseActionLine('{"id":"a","action":"done","at":"2026-09-10T08:00:00Z"}'), {
    id: 'a',
    action: 'done',
    at: '2026-09-10T08:00:00Z',
  });

  assert.equal(parseActionLine(''), null);
  assert.equal(parseActionLine('   '), null);
  assert.equal(parseActionLine('not json'), null);
  assert.equal(parseActionLine('{"id":"a"}'), null);
  assert.equal(parseActionLine('{"id":"a","action":"explode"}'), null);
});
