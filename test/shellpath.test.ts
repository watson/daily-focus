import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hydratePath, mergePaths, pathBetweenMarkers, shellCandidates, type ExecFile } from '../src/shellpath.ts';

const answer = (path: string) =>
  `Welcome back!\n__DAILY_FOCUS_PATH_START__\n${path}\n__DAILY_FOCUS_PATH_END__\nlast login: yesterday\n`;

test('the shells are asked in order, without repeats', () => {
  assert.deepEqual(shellCandidates('/bin/zsh', '/bin/zsh', 'darwin'), ['/bin/zsh']);
  assert.deepEqual(shellCandidates('/opt/homebrew/bin/fish', '/bin/zsh', 'darwin'), ['/opt/homebrew/bin/fish', '/bin/zsh']);
  assert.deepEqual(shellCandidates(undefined, undefined, 'linux'), ['/bin/bash']);
});

test("whatever the shell's startup files print around the PATH is ignored", () => {
  assert.equal(pathBetweenMarkers(answer('/opt/homebrew/bin:/usr/bin')), '/opt/homebrew/bin:/usr/bin');
  assert.equal(pathBetweenMarkers('no markers at all'), null);
  assert.equal(pathBetweenMarkers('__DAILY_FOCUS_PATH_START__\n'), null, 'cut off before the end marker');
});

test("the shell's PATH goes first, and the inherited one stays as the fallback", () => {
  assert.equal(mergePaths('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:'), '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(mergePaths(null, '/usr/bin:/bin'), '/usr/bin:/bin');
});

test('a shell that fails is skipped for the next one', () => {
  const asked: string[] = [];
  const exec: ExecFile = (file) => {
    asked.push(file);
    if (file === '/broken/shell') throw new Error('timed out');
    return answer('/Users/someone/.local/bin:/usr/bin');
  };
  const env: NodeJS.ProcessEnv = { SHELL: '/broken/shell', PATH: '/usr/bin:/bin' };
  assert.equal(hydratePath(env, 'darwin', exec, '/bin/zsh'), '/bin/zsh');
  assert.deepEqual(asked, ['/broken/shell', '/bin/zsh']);
  assert.equal(env.PATH, '/Users/someone/.local/bin:/usr/bin:/bin');
});

test("on a Mac with no shell answering, launchd's PATH for apps is next best", () => {
  const exec: ExecFile = (file) => {
    if (file === '/bin/launchctl') return '/opt/homebrew/bin:/usr/bin\n';
    throw new Error('no shell');
  };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
  assert.equal(hydratePath(env, 'darwin', exec, undefined), 'launchctl');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
});

test('nothing answering leaves PATH as it was, and Windows is left alone', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
  assert.equal(
    hydratePath(env, 'linux', () => {
      throw new Error('no shell');
    }),
    null,
  );
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(hydratePath({ PATH: 'C:\\bin' }, 'win32', () => answer('/nope')), null);
});
