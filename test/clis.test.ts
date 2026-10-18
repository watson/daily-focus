/**
 * Finding a CLI that will run a brief, against scripts standing in for Codex
 * and Claude Code. They print what the real ones print: `codex-cli 0.162.1`,
 * `2.1.300 (Claude Code)`, `Logged in using ChatGPT`, and Claude Code's JSON.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { detectClis, identify, knownLocations, preferredCli, probeCli } from '../src/clis.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'daily-focus-clis-'));
  dirs.push(d);
  return d;
}

/** A fake CLI: what it prints for `--version`, and for its login check with the exit code. */
async function fake(at: string, version: string, login: { out: string; code: number }): Promise<string> {
  await mkdir(join(at, '..'), { recursive: true });
  const script = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
    `echo '${login.out}'`,
    `exit ${login.code}`,
  ].join('\n');
  await writeFile(at, `${script}\n`, 'utf8');
  await chmod(at, 0o755);
  return at;
}

const CODEX_IN = { out: 'Logged in using ChatGPT', code: 0 };
const CODEX_OUT = { out: 'Not logged in', code: 1 };
const CLAUDE_IN = { out: '{"loggedIn": true, "authMethod": "claude.ai"}', code: 0 };
const CLAUDE_OUT = { out: '{"loggedIn": false}', code: 1 };

test('each CLI is told by what its version says', () => {
  assert.equal(identify('codex-cli 0.162.1'), 'codex');
  assert.equal(identify('2.1.300 (Claude Code)'), 'claude');
  assert.equal(identify('git version 2.50.1'), null);
});

test('both ready: both are reported, and Codex is the one used', async () => {
  const bin = await dir();
  await fake(join(bin, 'codex'), 'codex-cli 0.162.1', CODEX_IN);
  await fake(join(bin, 'claude'), '2.1.300 (Claude Code)', CLAUDE_IN);
  const report = await detectClis({}, { path: bin, locations: () => [] });
  assert.deepEqual(
    [report.codex.ready, report.codex.version, report.codex.onPath, report.claude.ready, report.claude.version],
    [true, '0.162.1', true, true, '2.1.300'],
  );
  assert.equal(preferredCli(report), 'codex');
});

test('a logged-out Codex says how to log in, and Claude Code is used instead', async () => {
  const bin = await dir();
  await fake(join(bin, 'codex'), 'codex-cli 0.162.1', CODEX_OUT);
  await fake(join(bin, 'claude'), '2.1.300 (Claude Code)', CLAUDE_IN);
  const report = await detectClis({}, { path: bin, locations: () => [] });
  assert.equal(report.codex.ready, false);
  assert.match(report.codex.problem!, /not logged in/);
  assert.equal(report.codex.fix, 'codex login');
  assert.equal(preferredCli(report), 'claude');
});

test('a Codex too old to hold the connector rules is not ready, and says to update', async () => {
  const bin = await dir();
  await fake(join(bin, 'codex'), 'codex-cli 0.140.0', CODEX_IN);
  const report = await detectClis({}, { path: bin, locations: () => [] });
  assert.equal(report.codex.ready, false);
  assert.equal(report.codex.fix, 'codex update');
  assert.equal(report.claude.path, null);
  assert.match(report.claude.problem!, /isn't installed/);
  assert.equal(preferredCli(report), null);
});

test("off PATH, the installers' own places are looked in, and such a path is not on PATH", async () => {
  const home = await dir();
  const standalone = await fake(join(home, '.codex', 'bin', 'codex'), 'codex-cli 0.162.1', CODEX_IN);
  const report = await detectClis({}, { path: await dir(), locations: (cli) => (cli === 'codex' ? [standalone] : []) });
  assert.equal(report.codex.path, standalone);
  assert.equal(report.codex.onPath, false);
  assert.equal(report.codex.ready, true);
});

test('a path already set is looked at before PATH', async () => {
  const bin = await dir();
  await fake(join(bin, 'claude'), '2.1.300 (Claude Code)', CLAUDE_IN);
  const wrapper = await fake(join(await dir(), 'my-claude'), '2.1.301 (Claude Code)', CLAUDE_IN);
  const report = await detectClis({ claude: wrapper }, { path: bin, locations: () => [] });
  assert.equal(report.claude.path, wrapper);
  assert.equal(report.claude.version, '2.1.301');
});

test('a path the user types is taken for whichever CLI it is, or refused with why', async () => {
  const d = await dir();
  const claude = await fake(join(d, 'anything'), '2.1.300 (Claude Code)', CLAUDE_IN);
  assert.deepEqual((await probeCli(claude, null, false)).cli, 'claude');
  const loggedOut = await fake(join(d, 'out'), '2.1.300 (Claude Code)', CLAUDE_OUT);
  const out = await probeCli(loggedOut, null, false);
  assert.equal(out.found.ready, false);
  assert.equal(out.found.fix, 'claude auth login');
  const git = await fake(join(d, 'git'), 'git version 2.50.1', { out: '', code: 0 });
  assert.match((await probeCli(git, null, false)).found.problem!, /isn't Codex or Claude Code/);
  assert.match((await probeCli(join(d, 'nothing'), null, false)).found.problem!, /Nothing runs at/);
});

test('a login check that says nothing it understands does not hold a CLI back', async () => {
  const bin = await dir();
  await fake(join(bin, 'codex'), 'codex-cli 0.162.1', { out: 'something new', code: 0 });
  assert.equal((await detectClis({}, { path: bin, locations: () => [] })).codex.ready, true);
});

test("on Windows, both CLIs are also looked for where Claude Code's installer and npm put them", () => {
  const home = join('C:', 'Users', 'alex');
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  for (const cli of ['claude', 'codex'] as const) {
    assert.deepEqual(knownLocations(cli, home, 'win32'), [join(home, '.local', 'bin', cli), join(appData, 'npm', cli)]);
  }
});
