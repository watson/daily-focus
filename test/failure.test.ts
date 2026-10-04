/**
 * How a failed read is put into words, and what is kept for whoever asks.
 *
 * The errors are built the shape Node builds them — undici's "fetch failed" with
 * the system error as its `cause` — since that shape is the whole reason the page
 * used to say nothing useful.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errorDetail, extend, toReadFailure, unexpectedDetail, unreachable } from '../src/failure.ts';

function systemError(message: string, facts: Record<string, string | number>): Error {
  return Object.assign(new Error(message), facts);
}

function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

const NOT_FOUND = systemError('getaddrinfo ENOTFOUND api.github.com', {
  code: 'ENOTFOUND',
  syscall: 'getaddrinfo',
  hostname: 'api.github.com',
});

test('"fetch failed" is read through to its cause', () => {
  assert.equal(
    unreachable(fetchFailed(NOT_FOUND), 'api.github.com'),
    "couldn't reach api.github.com (the DNS lookup failed — is this machine online?)",
  );
  assert.match(
    unreachable(fetchFailed(systemError('connect ECONNREFUSED 140.82.112.6:443', { code: 'ECONNREFUSED' })), 'api.github.com'),
    /connection was refused/,
  );
});

test('a refused certificate names its code and the usual culprit', () => {
  const reason = unreachable(
    fetchFailed(systemError('self-signed certificate in certificate chain', { code: 'SELF_SIGNED_CERT_IN_CHAIN' })),
    'api.github.com',
  );
  assert.match(reason, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.match(reason, /proxy/);
});

test('a connection that tried every address is read by the first one', () => {
  const all = new AggregateError([systemError('connect ETIMEDOUT 140.82.112.6:443', { code: 'ETIMEDOUT' })], '');
  assert.match(unreachable(fetchFailed(all), 'api.github.com'), /timed out/);
});

test('our own timeout is a slow answer, not a broken network', () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(unreachable(timeout, 'api.github.com'), 'api.github.com did not answer in time');
});

test('a cause with no code worth naming is quoted as it is', () => {
  assert.equal(unreachable(fetchFailed(new Error('bad port')), 'example.test'), "couldn't reach example.test (bad port)");
});

test('the detail carries the chain of causes with their codes', () => {
  const err = new Error("couldn't reach api.github.com", { cause: fetchFailed(NOT_FOUND) });
  assert.equal(
    errorDetail(err),
    [
      'caused by TypeError: fetch failed',
      'caused by Error: getaddrinfo ENOTFOUND api.github.com (code ENOTFOUND, syscall getaddrinfo, hostname api.github.com)',
    ].join('\n'),
  );
});

test("a thrower's own detail comes first, and an error with nothing more has no detail", () => {
  const err = Object.assign(new Error('Jira said no'), { detail: '$ acli jira workitem search\n✗ Error: Jira said no\nand more' });
  assert.match(errorDetail(err), /^\$ acli jira workitem search\n/);
  assert.equal(errorDetail(new Error('plain')), '');
});

test('every address a connection tried is listed', () => {
  const all = new AggregateError(
    [systemError('connect ETIMEDOUT 1.2.3.4:443', { code: 'ETIMEDOUT' }), systemError('connect ENETUNREACH ::1:443', { code: 'ENETUNREACH' })],
    '',
  );
  const detail = errorDetail(fetchFailed(all));
  assert.match(detail, /- Error: connect ETIMEDOUT 1\.2\.3\.4:443 \(code ETIMEDOUT\)/);
  assert.match(detail, /- Error: connect ENETUNREACH/);
});

test('a chain that loops is cut off rather than followed forever', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  (a as { cause?: unknown }).cause = b;
  assert.equal(errorDetail(a).split('\n').length, 5);
});

test('an unexpected error is sent whole, stack included, and a long one is clipped', () => {
  const err = new Error('boom');
  assert.match(unexpectedDetail(err), /^Error: boom\n\s+at /);
  const long = Object.assign(new Error('x'), { detail: 'y'.repeat(10_000) });
  assert.ok(errorDetail(long).length < 4100);
  assert.ok(errorDetail(long).endsWith('…'));
});

test('a streak starts at the first failure and only counts after that', () => {
  const first = extend(null, 1000);
  assert.deepEqual(first, { since: 1000, attempts: 1 });
  assert.deepEqual(extend(first, 5000), { since: 1000, attempts: 2 });
});

test('nothing is promised for later while an attempt is under way', () => {
  const failure = toReadFailure({ message: 'm', detail: '' }, { since: 0, attempts: 2 }, 60_000, true);
  assert.equal(failure.retryAt, null);
  assert.equal(failure.retrying, true);
  assert.equal(toReadFailure({ message: 'm', detail: '' }, null, 60_000, false).retryAt, new Date(60_000).toISOString());
});
