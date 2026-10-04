import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import { hostnameOf, isTrustedHostname, refusal } from '../src/guard.ts';

const request = (headers: Record<string, string>, method = 'GET') => ({ method, headers }) as unknown as IncomingMessage;

test('hostnameOf takes the name out of a Host header, and nothing that only looks like one', () => {
  assert.equal(hostnameOf('127.0.0.1:4321'), '127.0.0.1');
  assert.equal(hostnameOf('LocalHost:4321'), 'localhost');
  assert.equal(hostnameOf('[::1]:4321'), '::1');
  assert.equal(hostnameOf('my-mac.example-tailnet.ts.net.'), 'my-mac.example-tailnet.ts.net');
  // A header shaped like a URL is not a host, whatever a URL parser would make of it.
  assert.equal(hostnameOf('evil.example@127.0.0.1'), null);
  assert.equal(hostnameOf('127.0.0.1/evil'), null);
  assert.equal(hostnameOf(''), null);
});

test('only names a stranger cannot point here are trusted', () => {
  for (const name of ['127.0.0.1', '::1', '100.64.0.7', 'localhost', 'app.localhost', 'my-mac.example-tailnet.ts.net']) {
    assert.ok(isTrustedHostname(name, '127.0.0.1'), name);
  }
  for (const name of ['evil.example', 'localhost.evil.example', 'ts.net.evil.example', 'my-mac.local']) {
    assert.ok(!isTrustedHostname(name, '127.0.0.1'), name);
  }
  // The name the server was told to listen on is its own.
  assert.ok(isTrustedHostname('my-mac.local', 'My-Mac.local'));
});

test('a rebound hostname is refused, whatever the method', () => {
  const refused = refusal(request({ host: 'evil.example:4321' }), '127.0.0.1');
  assert.equal(refused?.status, 403);
  assert.match(refused!.error, /evil\.example/);
  assert.equal(refusal(request({}), '127.0.0.1')?.status, 403);
});

test('a POST must be JSON; the content types a form can send are refused', () => {
  const host = '127.0.0.1:4321';
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    assert.equal(refusal(request({ host, 'content-type': type }, 'POST'), '127.0.0.1')?.status, 415, type || '(none)');
  }
  assert.equal(refusal(request({ host, 'content-type': 'application/json; charset=utf-8' }, 'POST'), '127.0.0.1'), null);
  assert.equal(refusal(request({ host }, 'GET'), '127.0.0.1'), null);
});
