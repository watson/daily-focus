/**
 * Item ids are the load-bearing part of this system: an action is only attached to
 * an item by its id, so an id that changes between runs silently orphans a "done".
 *
 * The agent is told to derive ids from upstream identity, but it re-derives the
 * format from a prompt every morning, so exact string equality is a stricter
 * contract than an LLM can be relied on to keep. These two normalisations make the
 * most likely drift harmless, and the rest visible.
 */

/**
 * The form used to match an action against an item.
 *
 * Deliberately conservative — trim and case only. Anything more aggressive would
 * start folding genuinely distinct ids together, and a false match is much worse
 * than a missed one: it would mark the wrong thing done.
 */
export function canonicalId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * A loose fingerprint used *only* to detect drift, never to match.
 *
 * Strips everything but letters and digits, so `github:pr:Acme/WebApp#3421`
 * and `github/pr/acme/webapp/3421` collapse together. Two ids sharing a
 * fingerprint but not a canonical form are almost certainly the same upstream
 * thing written two different ways — which is exactly the bug worth shouting about.
 */
export function fingerprintId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}
