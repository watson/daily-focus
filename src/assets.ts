import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A fingerprint of the files in `public/`, so a long-lived tab can notice that the
 * UI it is running has been replaced.
 *
 * The SSE stream carries state, not code. Without this, editing a renderer and
 * restarting the server leaves the open tab showing fresh data through stale
 * markup — which looks exactly like the change not working, and can persist for
 * days on a dashboard nobody reloads.
 */
export async function computeAssetVersion(dir: string): Promise<string> {
  const parts: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        const info = await stat(path);
        // mtime plus size is enough to catch every edit that matters here, and
        // avoids reading and hashing file contents on every check.
        parts.push(`${entry.name}:${info.size}:${info.mtimeMs}`);
      }
    }
  }

  await walk(dir);

  // Small, stable, and cheap — this only ever needs to differ, not be secure.
  let hash = 0;
  const joined = parts.join('|');
  for (let i = 0; i < joined.length; i++) {
    hash = (Math.imul(31, hash) + joined.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
