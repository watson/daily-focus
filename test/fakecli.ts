/**
 * A stand-in for Codex, Claude Code, `gh` or `acli`: a Node script, started the
 * way the dashboard starts the real one. Elsewhere an executable shell script runs
 * it with this Node. On Windows, which runs no shell scripts, an npm-style `.cmd`
 * wrapper does, which `launchFor` reads for the script just as it reads Codex's.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Write the stand-in at `path`, `path.cmd` on Windows, running `script`, and
 * return the path to start it by. The script is plain JavaScript, run as a
 * CommonJS module with `fs`, `args` (its arguments), `say(line)`, `fail(line,
 * code)` and `sleep(ms)` in scope.
 */
export async function fakeCli(path: string, script: string): Promise<string> {
  await writeFile(
    `${path}.cjs`,
    [
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const say = (line) => process.stdout.write(`${line}\\n`);",
      'const fail = (line, code = 1) => { process.stderr.write(`${line}\\n`); process.exit(code); };',
      'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      script,
      '',
    ].join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    // As npm's cmd-shim writes a wrapper for a Node script.
    const wrapper = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'SET "_prog=node"',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${basename(path)}.cjs" %*`,
      '',
    ];
    await writeFile(`${path}.cmd`, wrapper.join('\r\n'), 'utf8');
    return `${path}.cmd`;
  }
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${path}.cjs" "$@"\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

/** `line` as a JavaScript string literal, for building a script. */
export function quoted(line: string): string {
  return JSON.stringify(line);
}
