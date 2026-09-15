import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write JSON so a reader never sees half of it: a sibling temp file, then a
 * rename, which is atomic within one directory. The same discipline the prompt
 * asks of the agent, kept in one place for the archive, the session file and the
 * pull request cache.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempPathFor(path);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** Where `writeJsonAtomic` stages a write, so a watcher can be told to ignore it. */
export function tempPathFor(path: string): string {
  return `${path}.tmp`;
}
