import type { Brief, ResolvedItem } from './types.ts';
import type { Focus } from './focus.ts';
import type { ArchivedItem } from './archive.ts';
import { fingerprintId } from './ids.ts';

/**
 * Contract checks that run on every brief and surface as banners on the page.
 *
 * These are the failures you cannot see by looking at the dashboard, which is
 * precisely why they need saying out loud:
 *
 *   - nothing today advances the objective, so the page looks busy and productive
 *     while the thing being measured stands still;
 *   - the objective flag has been applied so freely that the progress counter is
 *     flattering rather than reporting;
 *   - `firstSeen` reset, so the ageing pills quietly stop appearing — and an
 *     absent nag is invisible by construction;
 *   - an id drifted, orphaning a completed item so it returns tomorrow;
 *   - the private half of focus.md was echoed into something rendered.
 *
 * The parser already reports malformed payloads, so nothing here re-checks shape.
 * A manual `npm run audit` covers the deeper cross-run diffing; this is the subset
 * cheap enough to run continuously, because a check you have to remember to run
 * stops catching anything after the second week.
 */

/** More than this many objective-aligned items suggests the flag has stopped meaning much. */
const GENEROUS_FLAG_THRESHOLD = 5;

export interface CheckInput {
  brief: Brief;
  items: readonly ResolvedItem[];
  focus: Focus | null;
  /** Everything the archive knows about ids we've seen before. */
  history: ReadonlyMap<string, ArchivedItem>;
}

export function runContractChecks({ brief, items, focus, history }: CheckInput): string[] {
  const problems: string[] = [];

  if (focus?.objective) {
    const aligned = items.filter((item) => item.advancesObjective);
    const openAligned = aligned.filter((item) => item.status === 'open');

    if (aligned.length === 0) {
      problems.push(
        `Nothing in today's brief advances the objective (${focus.objective}). ` +
          `Either the agent missed it, or today genuinely has no path to it — both are worth knowing.`,
      );
    } else if (openAligned.length === 0) {
      problems.push(`Everything advancing the objective is already handled. Worth queuing the next step.`);
    }

    if (aligned.length > GENEROUS_FLAG_THRESHOLD) {
      problems.push(
        `${aligned.length} items are flagged as advancing the objective. ` +
          `That's generous enough that "days since progress" is probably flattering you.`,
      );
    }
  }

  // firstSeen must survive across runs or the ageing display silently restarts.
  const reset = brief.items.filter((item) => {
    const previous = history.get(item.id)?.firstSeen;
    return previous && item.firstSeen && previous < item.firstSeen;
  });
  if (reset.length > 0) {
    problems.push(
      `${reset.length} item(s) had their "first seen" date moved forward, which resets how old they look. ` +
        `Oldest affected: ${reset[0]!.title}`,
    );
  }

  // An id whose fingerprint matches a known id but whose exact form differs is the
  // same upstream thing written two ways — the failure that orphans a completed item.
  const byFingerprint = new Map<string, string>();
  for (const id of history.keys()) byFingerprint.set(fingerprintId(id), id);

  for (const item of brief.items) {
    if (history.has(item.id)) continue;
    const previous = byFingerprint.get(fingerprintId(item.id));
    if (previous) {
      problems.push(
        `Item id changed shape: "${previous}" is now "${item.id}". ` +
          `Anything you already completed under the old id will come back.`,
      );
    }
  }

  const leak = findLeakedPhrase(brief, focus);
  if (leak) {
    problems.push(
      `Private text from focus.md appears in the brief ("${leak}…"), so it is on screen. ` +
        `That section is meant to stay out of the rendered page.`,
    );
  }

  return problems;
}

/**
 * Look for the agent quoting focus.md's agent-only section back into rendered text.
 *
 * Compares six-word runs rather than vocabulary: both halves legitimately share
 * words like "progress", "calendar" and the ticket keys, so any overlap measure
 * based on single words is nothing but false positives.
 */
function findLeakedPhrase(brief: Brief, focus: Focus | null): string | null {
  if (!focus?.agentOnly) return null;

  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const rendered = words(JSON.stringify(brief)).join(' ');
  const secret = words(focus.agentOnly);

  for (let i = 0; i + 6 <= secret.length; i++) {
    const phrase = secret.slice(i, i + 6).join(' ');
    if (rendered.includes(phrase)) return phrase;
  }
  return null;
}
