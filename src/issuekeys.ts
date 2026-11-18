/**
 * Finding ticket keys in a pull request's text. Pure, and free of Node's
 * modules, so the page can tell from a pull request's branch and title which
 * ticket it is the work of (`client/stages.ts`), as `linked.ts` tells from all
 * of its text which tickets it names.
 */

const KEYISH = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*)-(\d+)/g;

/**
 * Every ticket key a piece of text could be naming, upper-cased.
 *
 * Case-insensitive, because branches are usually lower case — `proj-8842-drop-
 * retry` — and the connector reads them regardless. A key can't continue a word
 * (`XPROJ-1` names nothing) and its number is read whole, so `PROJ-12` is never
 * found inside `PROJ-123`.
 *
 * An underscore is ambiguous: project keys may contain one, and so may a branch
 * prefix. So `mara_proj-8842` offers both MARA_PROJ-8842 and PROJ-8842. That
 * generosity costs nothing, because only keys that are on the board are ever
 * looked up — which is also why "UTF-8" here is harmless. `ownTicket` in
 * `client/stages.ts` also asks whether a branch or title names any key at all,
 * and takes "UTF-8" in a title for one: that costs the pull request its stack
 * between tickets, never a wrong one.
 */
export function issueKeysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(KEYISH)) {
    const parts = match[1]!.split('_');
    for (let i = 0; i < parts.length; i++) {
      const project = parts.slice(i).join('_');
      if (/^[A-Za-z]/.test(project)) keys.add(`${project.toUpperCase()}-${match[2]}`);
    }
  }
  return keys;
}
