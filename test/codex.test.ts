/**
 * What the dashboard tells Codex beyond the sandbox, against a stand-in for
 * `codex mcp list` and `codex --version`. The servers listed here are the shapes
 * Codex 0.162.1 printed, cut down to the fields read.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_CONNECTOR_POLICY,
  CODEX_MINIMUM,
  codexVersionWarning,
  COMPUTER_USE_PLUGINS,
  computerUseOff,
  olderThan,
} from '../src/codex.ts';
import type { ExecFile } from '../src/shellpath.ts';

type Server = { name: string; enabled: boolean };

/**
 * A `codex mcp list --json` that lists `servers`, less any a `-c` override has
 * switched off by name, and records every call it gets.
 */
function fakeList(servers: Server[], calls: string[][] = []): ExecFile {
  return async (_file, args) => {
    calls.push([...args]);
    const off = new Set(
      args
        .filter((arg) => arg.startsWith('mcp_servers.'))
        .map((arg) => /^mcp_servers\.([^.]+)\.enabled=false$/.exec(arg)?.[1]),
    );
    return JSON.stringify(servers.map((server) => (off.has(server.name) ? { ...server, enabled: false } : server)));
  };
}

const PLUGINS_OFF = COMPUTER_USE_PLUGINS.map((plugin) => `plugins.${plugin}.enabled=false`);

test('the computer-use plugins are switched off by name, and nothing more when no server is left', async () => {
  const calls: string[][] = [];
  const overrides = await computerUseOff('codex', fakeList([{ name: 'google-drive-tws', enabled: true }], calls));
  assert.deepEqual(overrides, PLUGINS_OFF);
  assert.equal(calls.length, 1, 'one look is enough when nothing is left to switch off');
  assert.deepEqual(calls[0]!.slice(0, 3), ['mcp', 'list', '--json']);
  for (const override of PLUGINS_OFF) assert.ok(calls[0]!.includes(override), 'the list is asked with the plugins already off');
});

test('a computer-use server from your own config is switched off by name, and checked', async () => {
  const calls: string[][] = [];
  const overrides = await computerUseOff(
    'codex',
    fakeList(
      [
        { name: 'node_repl', enabled: true },
        // Already off in the user's config: switching it off again would be noise.
        { name: 'computer-use', enabled: false },
        { name: 'google-drive-tws', enabled: true },
      ],
      calls,
    ),
  );
  assert.deepEqual(overrides, [...PLUGINS_OFF, 'mcp_servers.node_repl.enabled=false']);
  assert.ok(overrides.every((override) => !override.includes('"')), 'Codex would take a quote as part of the name');
  assert.equal(calls.length, 2, 'the result is confirmed with a second look');
});

test("a server that won't switch off stops the run rather than leaving computer use on", async () => {
  const stubborn: ExecFile = async () => JSON.stringify([{ name: 'cua_repl', enabled: true }]);
  await assert.rejects(computerUseOff('codex', stubborn), /still starts cua_repl/);
});

test('a list Codex refuses, or prints in a shape not understood, is an error and not an all-clear', async () => {
  const refuses: ExecFile = async () => {
    throw new Error('Error: invalid transport in `mcp_servers.cua_repl`');
  };
  await assert.rejects(computerUseOff('codex', refuses), /invalid transport/);
  await assert.rejects(computerUseOff('codex', async () => 'not json'), /other than JSON/);
  await assert.rejects(computerUseOff('codex', async () => '{"servers":[]}'), /other than a list/);
});

test('versions compare by number, and anything unreadable is not called old', () => {
  assert.ok(olderThan('0.161.9', '0.162.1'));
  assert.ok(olderThan('0.9.0', '0.10.0'), 'not by string');
  assert.ok(!olderThan('0.162.1', '0.162.1'));
  assert.ok(!olderThan('1.0.0', '0.162.1'));
  assert.ok(!olderThan('codex-cli dev', '0.162.1'));
});

test('an older Codex gets a warning saying what goes wrong at its version; a current or missing one gets none', async () => {
  const says = (text: string): ExecFile => async () => text;

  // Before 0.144.0 the "writes" mode is unknown, and Codex drops the whole apps table over it.
  const tooOldForConnectors = await codexVersionWarning('codex', says('codex-cli 0.143.0\n'));
  assert.ok(tooOldForConnectors?.includes('Codex 0.143.0') && tooOldForConnectors.includes(CODEX_MINIMUM));
  assert.match(tooOldForConnectors!, /ignores the dashboard's refusal of connector writes/);

  // 0.144.0 to 0.148.x refuse connector writes but can't stop a plugin's server.
  const tooOldForComputerUse = await codexVersionWarning('codex', says(`codex-cli ${CODEX_CONNECTOR_POLICY}\n`));
  assert.match(tooOldForComputerUse!, /can't switch computer use off/);
  assert.match((await codexVersionWarning('codex', says('codex-cli 0.148.0\n')))!, /can't switch computer use off/);

  assert.equal(await codexVersionWarning('codex', says(`codex-cli ${CODEX_MINIMUM}\n`)), null);
  assert.equal(await codexVersionWarning('codex', says('codex-cli 0.162.1\n')), null);
  assert.equal(await codexVersionWarning('codex', says('codex-cli 1.0.0\n')), null);
  const missing: ExecFile = async () => {
    throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(await codexVersionWarning('codex', missing), null, 'the run that needs it reports a missing CLI');
});
