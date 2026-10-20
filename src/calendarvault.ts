/**
 * Where a connected calendar account's refresh token is kept: sealed by the
 * operating system for the user signed in to it, never in a file as it is. The
 * privacy policy promises this, so a platform with no such protection offers no
 * calendar sign-in at all rather than a weaker one.
 *
 * - Windows: DPAPI, through PowerShell, which every Windows has. The sealed
 *   token goes in the accounts file; only the same Windows user can open it.
 * - Linux: the desktop's keyring, through the Secret Service and libsecret's
 *   `secret-tool`. The token lives in the keyring; the file only says so.
 *
 * A Mac reads Calendar.app instead and needs none of this.
 *
 * The token travels on stdin both ways, never in an argument, which any other
 * process could read in the process list.
 */

import { spawn } from 'node:child_process';

import { findExecutable } from './launch.ts';

export interface Vault {
  /** Seal `secret` for `account`; what comes back is kept in the accounts file. */
  seal(account: string, secret: string): Promise<string>;
  /** The secret `seal` was given, from what it returned. */
  open(account: string, sealed: string): Promise<string>;
  /** Throw the secret away, where the vault keeps it itself. */
  forget(account: string, sealed: string): Promise<void>;
}

/** Runs a program with `input` on stdin and resolves with what it printed. */
export type RunWithInput = (file: string, args: readonly string[], input: string) => Promise<string>;

const TIMEOUT_MS = 30_000;

export const runWithInput: RunWithInput = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${file} exited with ${code}`));
    });
    child.stdin.end(input);
  });

/** PowerShell, given a script it can't misread: UTF-16, base64, as `-EncodedCommand` takes it. */
function powershell(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

const DPAPI_SEAL = powershell(
  [
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())',
    "$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($sealed))',
  ].join('\n'),
);

const DPAPI_OPEN = powershell(
  [
    'Add-Type -AssemblyName System.Security',
    '$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')",
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
  ].join('\n'),
);

/** Windows: sealed with DPAPI for the current user, and kept in the file as `dpapi:<base64>`. */
export function dpapiVault(run: RunWithInput = runWithInput): Vault {
  return {
    async seal(_account, secret) {
      return `dpapi:${(await run('powershell.exe', DPAPI_SEAL, secret)).trim()}`;
    },
    async open(_account, sealed) {
      if (!sealed.startsWith('dpapi:')) throw new Error('this sign-in was saved on another kind of computer');
      return (await run('powershell.exe', DPAPI_OPEN, sealed.slice('dpapi:'.length))).trim();
    },
    async forget() {},
  };
}

const KEYRING_MARK = 'secret-service';

/**
 * Linux: the token in the keyring, found by the store and the account, so the
 * same account connected in a work and a personal dashboard is two entries,
 * and disconnecting one leaves the other.
 */
export function keyringVault(store: string, tool = 'secret-tool', run: RunWithInput = runWithInput): Vault {
  const attributes = (account: string) => ['application', 'daily-focus', 'store', store, 'account', account];
  return {
    async seal(account, secret) {
      await run(tool, ['store', '--label', `Daily Focus calendar sign-in (${account})`, ...attributes(account)], secret);
      return KEYRING_MARK;
    },
    async open(account, sealed) {
      if (sealed !== KEYRING_MARK) throw new Error('this sign-in was saved on another kind of computer');
      const secret = (await run(tool, ['lookup', ...attributes(account)], '')).trim();
      if (!secret) throw new Error('the keyring no longer has this sign-in');
      return secret;
    },
    async forget(account) {
      await run(tool, ['clear', ...attributes(account)], '');
    },
  };
}

/**
 * The vault for this computer, or why there is none. On Linux without
 * `secret-tool` there's nowhere safe to keep a token, so connecting is refused
 * with what to install.
 */
export function systemVault(store: string, platform: NodeJS.Platform = process.platform): Vault | { unavailable: string } {
  if (platform === 'win32') return dpapiVault();
  if (platform === 'darwin') return { unavailable: 'On a Mac, the agenda reads Calendar.app instead.' };
  const tool = findExecutable('secret-tool');
  if (!tool) {
    return {
      unavailable:
        'Daily Focus keeps calendar sign-ins in your desktop’s keyring, through secret-tool, which isn’t installed. ' +
        'Install it (on Debian and Ubuntu, the libsecret-tools package), then try again.',
    };
  }
  return keyringVault(store, tool);
}
