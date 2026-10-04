import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { serviceEnvironment, serviceLabel, servicePath, servicePlist } from '../scripts/service.ts';

const run = promisify(execFile);
const home = '/Users/alice';

test('the default store gets the plain label, and every other store its own', () => {
  assert.equal(serviceLabel(`${home}/.daily-focus`, home), 'local.daily-focus');
  assert.equal(serviceLabel(`${home}/.daily-focus-personal`, home), 'local.daily-focus.daily-focus-personal');
  assert.equal(serviceLabel(`${home}/notes/focus store`, home), 'local.daily-focus.notes-focus-store');
  assert.equal(serviceLabel('/private/tmp/df.x1', home), 'local.daily-focus.private-tmp-df-x1');
});

test("the service's PATH drops what npm adds and keeps Node and the system on it", () => {
  const path = [
    '/Users/alice/src/daily-focus/node_modules/.bin',
    '/Users/alice/.nvm/versions/node/v24.0.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
    '/opt/homebrew/bin',
    '',
    '/usr/bin',
    '/opt/homebrew/bin',
  ].join(':');
  assert.equal(
    servicePath(path, '/Users/alice/.nvm/versions/node/v24.0.0/bin'),
    '/Users/alice/.nvm/versions/node/v24.0.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  );
  assert.equal(servicePath('/usr/local/bin:/usr/bin', '/usr/local/bin'), '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
});

test('the service keeps PATH and the DAILY_FOCUS_ settings, and nothing else from the shell', () => {
  const env = serviceEnvironment(
    {
      PATH: '/usr/bin',
      DAILY_FOCUS_PORT: '4322',
      DAILY_FOCUS_DATA: '~/.daily-focus-personal',
      npm_lifecycle_event: 'service',
      SOME_TOKEN: 'secret',
    },
    '/opt/node/bin',
  );
  assert.deepEqual(env, {
    PATH: '/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    DAILY_FOCUS_DATA: '~/.daily-focus-personal',
    DAILY_FOCUS_PORT: '4322',
  });
});

const spec = {
  label: 'local.daily-focus',
  node: '/Users/alice/.nvm/versions/node/v24.0.0/bin/node',
  repo: '/Users/alice/src/R&D <focus>',
  log: '/Users/alice/Library/Logs/local.daily-focus.log',
  env: { PATH: '/usr/bin:/bin', DAILY_FOCUS_GITHUB_SCOPE: 'acme & co' },
  packaged: false,
};

test('the plist escapes what XML would misread', () => {
  const plist = servicePlist(spec);
  assert.ok(plist.includes('<string>/Users/alice/src/R&amp;D &lt;focus&gt;</string>'));
  assert.ok(plist.includes('<string>acme &amp; co</string>'));
  assert.ok(!plist.includes('R&D'));
});

test('the plist is one launchd accepts, and says what the dashboard runs', { skip: platform() !== 'darwin' && 'plutil is macOS-only' }, async () => {
  const child = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']);
  child.child.stdin!.end(servicePlist(spec));
  const job = JSON.parse((await child).stdout) as Record<string, unknown>;
  assert.deepEqual(job, {
    Label: 'local.daily-focus',
    ProgramArguments: ['/bin/sh', '-c', '"$0" scripts/build.ts && exec "$0" src/server.ts', spec.node],
    WorkingDirectory: spec.repo,
    EnvironmentVariables: spec.env,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    StandardOutPath: spec.log,
    StandardErrorPath: spec.log,
  });
});

test('installed from npm, the service runs the bundled CLI and builds nothing', () => {
  const plist = servicePlist({ ...spec, repo: '/Users/alice/.npm-global/lib/node_modules/daily-focus', packaged: true });
  assert.ok(plist.includes('<string>/Users/alice/.npm-global/lib/node_modules/daily-focus/dist/cli.js</string>'));
  assert.ok(plist.includes('<string>--no-open</string>'));
  assert.ok(!plist.includes('scripts/build.ts'));
});
