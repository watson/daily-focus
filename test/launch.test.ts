/**
 * Finding and starting a program, Windows included. Windows is passed in as the
 * platform, so these run anywhere: they read and write files, and start nothing.
 */

import assert from 'node:assert/strict';
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { findExecutable, launchFor, stopProcess, wrappedProgram } from '../src/launch.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-launch-'));
  dirs.push(dir);
  return dir;
}

const HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';

/** What npm's cmd-shim writes for a script with a `#!/usr/bin/env node` line, as Codex's is. */
const CODEX_WRAPPER =
  HEAD +
  '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

/** And for a program without one, as Claude Code's `claude.exe` is. */
const CLAUDE_WRAPPER = `${HEAD}"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;

test('a program is found where a shell would find it, and only if it can run', { skip: process.platform === 'win32' && 'Windows has no execute bit to check' }, async () => {
  const dir = await temp();
  await writeFile(join(dir, 'claude'), '#!/bin/sh\n');
  await chmod(join(dir, 'claude'), 0o755);
  await writeFile(join(dir, 'codex'), 'not executable\n');
  assert.equal(findExecutable('claude', `/nowhere:${dir}`, 'darwin'), join(dir, 'claude'));
  assert.equal(findExecutable('codex', dir, 'darwin'), null);
  assert.equal(findExecutable(join(dir, 'claude'), '', 'darwin'), join(dir, 'claude'), 'a path is checked as it is');
});

test("on Windows, a name is tried with each extension Windows runs, never as npm's extensionless shell script", async () => {
  const first = await temp();
  const npm = await temp();
  await writeFile(join(npm, 'codex'), '#!/bin/sh\n');
  await writeFile(join(npm, 'codex.cmd'), CODEX_WRAPPER);
  await writeFile(join(npm, 'codex.ps1'), '# PowerShell\n');
  assert.equal(findExecutable('codex', `${first};${npm}`, 'win32'), join(npm, 'codex.cmd'));

  await writeFile(join(npm, 'codex.exe'), 'MZ');
  assert.equal(findExecutable('codex', npm, 'win32'), join(npm, 'codex.exe'), '.exe before .cmd, as PATHEXT has them');
  await writeFile(join(first, 'codex.cmd'), CODEX_WRAPPER);
  assert.equal(findExecutable('codex', `${first};${npm}`, 'win32'), join(first, 'codex.cmd'), 'an earlier folder first');

  assert.equal(findExecutable(join(npm, 'codex'), '', 'win32'), join(npm, 'codex.exe'), 'a path without an extension gets one');
  assert.equal(findExecutable(join(npm, 'codex.cmd'), '', 'win32'), join(npm, 'codex.cmd'), 'a path with one is taken as it is');
});

test("the program an npm wrapper starts is the last %dp0% path in it, not the node.exe it looks for", () => {
  assert.equal(wrappedProgram(CODEX_WRAPPER), 'node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(wrappedProgram(CLAUDE_WRAPPER), 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(wrappedProgram('@echo off\r\ncall something.bat %*\r\n'), null);
});

test('on Windows, an npm wrapper is started as the program it wraps, with the arguments untouched', async () => {
  const npm = await temp();
  await writeFile(join(npm, 'codex.cmd'), CODEX_WRAPPER);
  await writeFile(join(npm, 'claude.cmd'), CLAUDE_WRAPPER);
  // What cmd.exe would read as commands, quotes it would strip, and a prompt's newlines.
  const args = ['exec', '-c', 'model="gpt-6"', 'Why? A & B | "C" %PATH% ^\nnext line'];

  assert.deepEqual(launchFor('codex', args, 'win32', npm), {
    file: process.execPath,
    args: [join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args],
  });
  assert.deepEqual(launchFor(join(npm, 'claude.cmd'), ['-p', 'hi'], 'win32'), {
    file: join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    args: ['-p', 'hi'],
  });
});

test('on Windows, an .exe is started as it is, and a batch file that is no npm wrapper is refused', async () => {
  const bin = await temp();
  await writeFile(join(bin, 'claude.exe'), 'MZ');
  await writeFile(join(bin, 'other.bat'), '@echo off\r\ncall something.bat %*\r\n');
  assert.deepEqual(launchFor('claude', ['--version'], 'win32', bin), { file: join(bin, 'claude.exe'), args: ['--version'] });
  assert.throws(() => launchFor('other', [], 'win32', bin), /won't pass arguments through cmd\.exe/);
  assert.deepEqual(launchFor('missing', ['x'], 'win32', bin), { file: 'missing', args: ['x'] }, 'not found: spawn says so');
});

test('anywhere but Windows, a program is started exactly as asked', async () => {
  const npm = await temp();
  await mkdir(join(npm, 'sub'));
  await writeFile(join(npm, 'codex.cmd'), CODEX_WRAPPER);
  assert.deepEqual(launchFor('codex', ['exec'], 'darwin', npm), { file: 'codex', args: ['exec'] });
  assert.deepEqual(launchFor(join(npm, 'codex.cmd'), [], 'linux'), { file: join(npm, 'codex.cmd'), args: [] });
});

/** A child that records the signals sent to it, and a spawn that records what it was asked to start. */
function fakes(pid: number | undefined) {
  const signals: string[] = [];
  const started: Array<{ file: string; args: readonly string[] }> = [];
  const child = { pid, kill: (signal: string) => (signals.push(signal), true) } as unknown as ChildProcess;
  const spawnFn = ((file: string, args: readonly string[]) => {
    started.push({ file, args });
    return new EventEmitter();
  }) as unknown as typeof spawn;
  return { child, spawnFn, signals, started };
}

test('a CLI is stopped with a signal, but on Windows with everything it started', () => {
  const mac = fakes(41);
  stopProcess(mac.child, 'SIGTERM', 'darwin', mac.spawnFn);
  assert.deepEqual(mac.signals, ['SIGTERM']);
  assert.deepEqual(mac.started, []);

  const windows = fakes(42);
  stopProcess(windows.child, 'SIGTERM', 'win32', windows.spawnFn);
  assert.deepEqual(windows.started, [{ file: 'taskkill', args: ['/pid', '42', '/T', '/F'] }]);
  assert.deepEqual(windows.signals, [], "kill() would end codex.exe and leave what it started running");

  const never = fakes(undefined);
  stopProcess(never.child, 'SIGTERM', 'win32', never.spawnFn);
  assert.deepEqual(never.signals, ['SIGTERM'], 'a child that never started has no tree to end');
});

test("on Windows, a stop falls back to kill() when taskkill can't be started or is refused", () => {
  const missing = fakes(43);
  const unstarted = new EventEmitter();
  stopProcess(missing.child, 'SIGKILL', 'win32', (() => unstarted) as unknown as typeof spawn);
  unstarted.emit('error', new Error('spawn taskkill ENOENT'));
  assert.deepEqual(missing.signals, ['SIGKILL']);

  // As over SSH, or from a service: "ERROR: Access denied", exit 1.
  const refused = fakes(44);
  const denied = new EventEmitter();
  stopProcess(refused.child, 'SIGTERM', 'win32', (() => denied) as unknown as typeof spawn);
  denied.emit('exit', 1);
  assert.deepEqual(refused.signals, ['SIGTERM']);

  const done = fakes(45);
  const succeeded = new EventEmitter();
  stopProcess(done.child, 'SIGTERM', 'win32', (() => succeeded) as unknown as typeof spawn);
  succeeded.emit('exit', 0);
  assert.deepEqual(done.signals, [], 'nothing more to do once the tree is gone');
});
