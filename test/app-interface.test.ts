/**
 * What the dashboard asks of the Mac app. The app reads it from the package before
 * it offers or runs a downloaded dashboard (`macos/DailyFocus/Updates.swift`), so a
 * dashboard that asks for more than the app built from the same commit gives would
 * be one no app could run.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  engines: { node: string };
  'daily-focus': { appInterface: number; appSource?: string };
};

test('the dashboard asks no more of the app than the app in this commit gives', async () => {
  const swift = await readFile(resolve(root, 'macos/DailyFocus/Updates.swift'), 'utf8');
  const given = Number(/^let appInterface = (\d+)$/m.exec(swift)?.[1]);
  const asked = pkg['daily-focus'].appInterface;
  assert.ok(Number.isInteger(given) && given >= 1, 'Updates.swift no longer says `let appInterface = N`');
  assert.ok(Number.isInteger(asked) && asked >= 1, 'package.json needs "daily-focus": { "appInterface": N }');
  assert.ok(asked <= given, `package.json asks for app interface ${asked}, and the app gives ${given}: raise both together`);
  assert.equal(pkg['daily-focus'].appSource, undefined, 'appSource is stamped by the Release workflow, never committed');
});

test('engines.node is a range the app can read, and the Node it carries satisfies it', async () => {
  const range = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(pkg.engines.node.trim());
  assert.ok(range, `the app reads only ">=X.Y" ranges, and engines.node is "${pkg.engines.node}"`);
  const need = range[1]!.split('.').map(Number);
  const carried = (await readFile(resolve(root, 'macos/node-version'), 'utf8')).trim().split('.').map(Number);
  const places = Math.max(need.length, carried.length);
  const pad = (numbers: number[]) => [...numbers, ...Array<number>(places - numbers.length).fill(0)];
  const [have, want] = [pad(carried), pad(need)];
  const index = have.findIndex((value, i) => value !== want[i]);
  assert.ok(index === -1 || have[index]! > want[index]!, `the app carries Node ${carried.join('.')}, below engines.node ${pkg.engines.node}`);
});
