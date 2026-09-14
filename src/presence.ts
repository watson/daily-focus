import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

/**
 * Is anyone actually at the machine?
 *
 * This is the focus timer's one real blind spot. Nothing inside a browser tab can
 * tell deep work in an editor apart from a desk that has been empty since lunch —
 * both look identical from here, which is to say no clicks either way. So the tab
 * is the wrong thing to ask. The OS knows precisely when a key was last pressed or
 * a mouse last moved, anywhere on the machine, and that is the question that
 * matters: was someone at the machine, not were they looking at this page.
 *
 * macOS only, and that's a fair trade rather than a gap. This is a localhost
 * dashboard whose server runs on the very laptop being watched; that co-location is
 * the only reason the question is answerable at all. Anywhere else the probe returns
 * `null`, meaning "no idea", and the timer keeps the blunter safety net it has always
 * had. Nothing here is load-bearing for correctness — it only makes the record more
 * honest when it can.
 */

const run = promisify(execFile);

/** Long enough to be reliable, short enough that a wedged ioreg can't stall a poll. */
const PROBE_TIMEOUT_MS = 4_000;

const HID_IDLE = /"HIDIdleTime"\s*=\s*(\d+)/;

/** Asks how long the machine has been untouched, in seconds. `null` means it can't say. */
export type IdleProbe = () => Promise<number | null>;

/**
 * Seconds since the last input event anywhere on this machine.
 *
 * Note this keeps climbing while the screen is locked or asleep, which is exactly
 * what's wanted — a locked laptop is the clearest evidence of absence there is.
 */
export const readIdleSeconds: IdleProbe = async () => {
  if (platform() !== 'darwin') return null;

  try {
    // `-d 1 -r` roots the dump at the HID node itself: 4KB rather than the ~500KB
    // the whole registry costs, and this runs every half minute for as long as a
    // session is open.
    const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '1', '-r'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return parseIdleSeconds(stdout);
  } catch {
    // No ioreg, no permission, timed out — all the same answer, and never fatal.
    return null;
  }
};

/**
 * Pull the idle time out of `ioreg` output.
 *
 * Split from the probe so the nanosecond arithmetic — the one part with a plausible
 * off-by-a-billion in it — is testable without a Mac.
 */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const match = HID_IDLE.exec(ioregOutput);
  if (!match) return null;

  const nanoseconds = Number(match[1]);
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return null;
  return nanoseconds / 1e9;
}
