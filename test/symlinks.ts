/**
 * Whether this run may make symlinks. Windows lets a process make one only in
 * Developer Mode or when it is elevated, as CI's runner is; a developer's own
 * shell often is neither. Tests that make links of their own skip there, with
 * this as the reason, rather than fail.
 */

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tryLink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'daily-focus-symlink-'));
  try {
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SYMLINKS = tryLink();

/** A `skip` for a test that makes symlinks: false where it can. */
export const NEEDS_SYMLINKS: string | false = !SYMLINKS && 'makes symlinks, which Windows allows only in Developer Mode or an elevated shell';
