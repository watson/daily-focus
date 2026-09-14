import { watch } from 'node:fs';

export interface WatchOptions {
  debounceMs?: number;
  /**
   * Files whose changes aren't worth waking anything for.
   *
   * The focus timer re-stamps its own state file every half minute while it runs,
   * and without this that churn would re-archive the brief and push to every open
   * tab twice a minute — work triggered by the watcher's own housekeeping.
   */
  ignore?: readonly string[];
}

/**
 * Watch the data directory and call `onChange` shortly after it settles.
 *
 * Debounced because a single logical write produces several fs events (rename +
 * change), and because the agent may write items.json in pieces — re-reading
 * mid-write just makes the parser retry for nothing.
 */
export function watchDataDir(
  dir: string,
  onChange: () => void,
  { debounceMs = 120, ignore = [] }: WatchOptions = {},
): () => void {
  let timer: NodeJS.Timeout | null = null;

  const fire = (_event: string, filename: string | Buffer | null): void => {
    // A null filename means the platform didn't tell us what changed, so assume
    // it mattered rather than dropping a real update.
    if (filename !== null && ignore.includes(String(filename))) return;

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
    timer.unref?.();
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, { persistent: false }, fire);
    // A watcher on a directory that gets replaced wholesale can error; the dashboard
    // still works by polling on reload, so log and carry on rather than crashing.
    watcher.on('error', (err) => {
      console.warn(`[daily-focus] stopped watching ${dir}: ${(err as Error).message}`);
    });
  } catch (err) {
    console.warn(`[daily-focus] could not watch ${dir}: ${(err as Error).message}`);
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
