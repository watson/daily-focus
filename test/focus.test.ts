import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFocus, toPublicFocus } from '../src/focus.ts';

test('parses frontmatter and prose', () => {
  const focus = parseFocus(
    [
      '---',
      'objective: Ship the Langdbroker browser SDK',
      'blocker: Functionality is broken after the staging changes',
      '---',
      '',
      'Restore functionality first; dogfooding is blocked until it works.',
      '',
    ].join('\n'),
  );

  assert.equal(focus.objective, 'Ship the Langdbroker browser SDK');
  assert.equal(focus.blocker, 'Functionality is broken after the staging changes');
  assert.equal(focus.note, 'Restore functionality first; dogfooding is blocked until it works.');
  assert.equal(focus.agentOnly, null);
});

test('splits the agent-only section off', () => {
  const focus = parseFocus(
    [
      '---',
      'objective: Ship it',
      '---',
      '',
      'Public context.',
      '',
      '<!-- agent-only -->',
      '',
      'This is what I am measured on. Never render this.',
    ].join('\n'),
  );

  assert.equal(focus.note, 'Public context.');
  assert.equal(focus.agentOnly, 'This is what I am measured on. Never render this.');
});

test('toPublicFocus drops the agent-only section', () => {
  const focus = parseFocus('---\nobjective: Ship it\n---\n\n<!-- agent-only -->\nsecret');
  const published = toPublicFocus(focus);

  assert.equal('agentOnly' in published, false);
  assert.equal(JSON.stringify(published).includes('secret'), false);
});

test('the marker is recognised regardless of case and spacing', () => {
  for (const marker of ['<!-- agent-only -->', '<!--agent-only-->', '<!--  AGENT-ONLY  -->']) {
    const focus = parseFocus(`---\nobjective: x\n---\npublic\n${marker}\nhidden`);
    assert.equal(focus.agentOnly, 'hidden', `failed for ${marker}`);
    assert.equal(focus.note, 'public');
  }
});

test('a prose-only file still yields an objective', () => {
  const focus = parseFocus('Ship the Langdbroker browser SDK\n\nRestore it first.');
  assert.equal(focus.objective, 'Ship the Langdbroker browser SDK');
  assert.equal(focus.note, 'Restore it first.');
});

test('tolerates quotes, unknown keys and a missing blocker', () => {
  const focus = parseFocus('---\nobjective: "Ship it"\nmood: grim\n---\n');
  assert.equal(focus.objective, 'Ship it');
  assert.equal(focus.blocker, null);
  assert.equal(focus.note, null);
});

test('an empty file yields nothing rather than throwing', () => {
  const focus = parseFocus('');
  assert.deepEqual(focus, { objective: null, blocker: null, note: null, agentOnly: null });
});
