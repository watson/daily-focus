import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseIdleSeconds, readIdleSeconds } from '../src/presence.ts';

/** Trimmed from real `ioreg -c IOHIDSystem -d 1 -r` output. */
const IOREG = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000456, registered, matched, active>
    {
      "IOClass" = "IOHIDSystem"
      "HIDIdleTime" = 164247344708
      "IOProviderClass" = "IOResources"
    }
`;

test('idle time is reported in nanoseconds, not seconds', async () => {
  // The whole point of parsing this separately: 164 seconds and 164 billion of
  // them are the difference between "they just paused" and "they left in March".
  assert.equal(parseIdleSeconds(IOREG), 164.247344708);
});

test('a freshly touched machine reads as zero', async () => {
  assert.equal(parseIdleSeconds('"HIDIdleTime" = 0'), 0);
});

test('output without the key means no answer, not zero idle', async () => {
  assert.equal(parseIdleSeconds('+-o IOHIDSystem\n  { "IOClass" = "IOHIDSystem" }'), null);
  assert.equal(parseIdleSeconds(''), null);
  assert.equal(parseIdleSeconds('"HIDIdleTime" = not-a-number'), null);
});

test('the probe answers with a number or with nothing, and never throws', async () => {
  // Runs against whatever machine the suite is on, so it can only assert the
  // contract: seconds, or null where the question can't be asked.
  const idle = await readIdleSeconds();
  assert.ok(idle === null || (typeof idle === 'number' && idle >= 0), `got ${idle}`);
});
