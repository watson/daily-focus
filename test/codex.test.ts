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
  CodexGate,
  codexLatestModel,
  codexVersionWarning,
  COMPUTER_USE_PLUGINS,
  computerUseOff,
  namesWindowsSandbox,
  olderThan,
  refusalFor,
  windowsSandbox,
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
  assert.match(tooOldForConnectors!, /won't start the agent or the assistant/);

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

test('a run is refused only below the version that knows the connector rules', () => {
  assert.match(refusalFor('0.143.0')!, /Codex 0\.143\.0 is older than 0\.144\.0/);
  assert.equal(refusalFor(CODEX_CONNECTOR_POLICY), null, 'connector writes are refused from here on');
  assert.equal(refusalFor('0.148.0'), null, 'computer use refuses its own turns below 0.149.0, not every run');
  assert.equal(refusalFor(null), null, 'a CLI that cannot be read fails when it is started instead');
});

test('the gate asks until Codex passes, then stops asking', async () => {
  let asked = 0;
  let version = 'codex-cli 0.143.0\n';
  const gate = new CodexGate('codex', async () => {
    asked += 1;
    return version;
  });
  assert.ok(await gate.refusal());
  assert.ok(await gate.refusal(), 'still refused while still old');
  version = 'codex-cli 0.149.0\n';
  assert.equal(await gate.refusal(), null, 'an update counts without a restart');
  assert.equal(await gate.refusal(), null);
  assert.equal(asked, 3, 'not asked again once it has passed');

  let unreadable = 0;
  const silent = new CodexGate('codex', async () => {
    unreadable += 1;
    throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  });
  assert.equal(await silent.refusal(), null);
  assert.equal(await silent.refusal(), null);
  assert.equal(unreadable, 2, "a Codex that couldn't be read is asked again");
});

test("setup's Codex model is the flagship Codex lists first, and nothing when the catalog can't be read", async () => {
  const catalog = JSON.stringify({
    models: [
      { slug: 'gpt-hidden', priority: 0, visibility: 'hide' },
      { slug: 'gpt-light', priority: 4, visibility: 'list' },
      { slug: 'gpt-flagship', priority: 1, visibility: 'list' },
    ],
  });
  assert.equal(await codexLatestModel('codex', async () => catalog), 'gpt-flagship');
  assert.equal(await codexLatestModel('codex', async () => 'not json'), null);
  assert.equal(await codexLatestModel('codex', async () => JSON.stringify({ models: [] })), null);
  assert.equal(
    await codexLatestModel('codex', async () => {
      throw new Error('no such command');
    }),
    null,
  );
});

test("on Windows, Codex is asked for the sandbox that needs no administrator, unless the user's config names one", () => {
  assert.deepEqual(windowsSandbox('win32', null), ['windows.sandbox="unelevated"'], 'no config at all');
  assert.deepEqual(windowsSandbox('win32', 'model = "gpt-6"\n[features]\nfoo = true\n'), ['windows.sandbox="unelevated"']);
  assert.deepEqual(windowsSandbox('win32', '[windows]\nsandbox = "elevated"\n'), [], 'a [windows] table');
  assert.deepEqual(windowsSandbox('win32', 'windows.sandbox = "unelevated"\n'), [], 'a dotted key');
  assert.deepEqual(windowsSandbox('darwin', null), [], 'only Windows needs one chosen');
  assert.deepEqual(windowsSandbox('linux', null), []);
});

test("a sandbox in another table, or a commented one, isn't the user's Windows choice", () => {
  assert.equal(namesWindowsSandbox('[windows]\nallow_mxc = false\n\n[profiles.x]\nsandbox = "elevated"\n'), false);
  assert.equal(namesWindowsSandbox('# windows.sandbox = "elevated"\nsandbox_mode = "read-only"\n'), false);
  assert.equal(namesWindowsSandbox('[tui]\ntheme = "x"\n\n[windows]\n  sandbox="elevated"\n'), true, 'the last table, indented');
});
