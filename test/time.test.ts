import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWorkingDay, workingMsBetween } from '../src/time.ts';

const HOUR = 3_600_000;

// Thu 10 -> Fri 11 -> Sat 12 -> Sun 13 -> Mon 14 September 2026. Dates are built with
// the local-time constructor, so these hold in whatever zone the tests run in.
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute);

test('every weekday counts, and neither weekend day does', () => {
  assert.deepEqual(
    [10, 11, 12, 13, 14].map((day) => isWorkingDay(at(day))),
    [true, true, false, false, true],
  );
});

test('working hours inside one day are just the elapsed hours', () => {
  assert.equal(workingMsBetween(at(10, 6, 30), at(10, 9, 30)), 3 * HOUR);
});

test('a span crossing midnight into a working day keeps both parts', () => {
  assert.equal(workingMsBetween(at(10, 23, 0), at(11, 2, 0)), 3 * HOUR);
});

test('a weekend contributes nothing, however long you wait', () => {
  const fridayRun = at(11, 6, 30);
  // Friday 06:30 to Saturday 09:00 is 26.5 hours, of which only Friday's 17.5 count.
  assert.equal(workingMsBetween(fridayRun, at(12, 9, 0)), 17.5 * HOUR);
  // Still 17.5 a day later: nothing accrued over Sunday either.
  assert.equal(workingMsBetween(fridayRun, at(13, 9, 0)), 17.5 * HOUR);
  // Monday resumes the clock where Friday left it.
  assert.equal(workingMsBetween(fridayRun, at(14, 6, 30)), 17.5 * HOUR + 6.5 * HOUR);
});

test('a span wholly inside the weekend is zero', () => {
  assert.equal(workingMsBetween(at(12, 8, 0), at(13, 20, 0)), 0);
});

test('a backwards or empty span is zero, not negative', () => {
  assert.equal(workingMsBetween(at(11, 9, 0), at(11, 9, 0)), 0);
  assert.equal(workingMsBetween(at(11, 9, 0), at(10, 9, 0)), 0);
});
