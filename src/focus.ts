/**
 * `focus.md` — the standing objective. The third file the server reads, and the only
 * hand-written one it reads at all. (`sources.md` is hand-written too, but it is the
 * agent's input alone and the server never opens it.)
 *
 * It exists because everything else feeding this dashboard is reactive: items.json
 * is assembled from things other people did overnight. A brief built only from
 * inbound signals can never say "nothing today moves the thing you're measured on",
 * because nobody sends a notification about work that didn't happen. This file is
 * where that intent lives so the agent can check the day against it.
 *
 * Format — frontmatter for the machine-readable bits, prose for nuance:
 *
 *     ---
 *     objective: Ship the Langdbroker browser SDK
 *     blocker: Functionality is broken after the staging changes
 *     ---
 *
 *     Restore functionality first; dogfooding is blocked until it works.
 *
 *     <!-- agent-only -->
 *     Anything below this marker never reaches the browser.
 */

/** The part of focus.md that is safe to render. */
export interface PublicFocus {
  objective: string | null;
  blocker: string | null;
  /** Prose above the agent-only marker. Rendered as inline Markdown. */
  note: string | null;
}

export interface Focus extends PublicFocus {
  /**
   * Prose below `<!-- agent-only -->`. Read by the agent straight off disk, and
   * deliberately never included in the dashboard's state payload — see
   * `toPublicFocus`. This is where context lives that shouldn't be on screen
   * during a screen share.
   */
  agentOnly: string | null;
}

/** Everything after this marker is withheld from the browser. */
const AGENT_ONLY_MARKER = /^[ \t]*<!--[ \t]*agent-only[ \t]*-->[ \t]*$/im;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * HTML comments in the public prose are notes to self — the `npm run init`
 * template keeps its instructions in one — so they are dropped rather than
 * rendered or promoted to an objective.
 */
const COMMENT = /<!--[\s\S]*?-->/g;

/** Keys we lift out of the frontmatter. Anything else is ignored, not an error. */
const KNOWN_KEYS = new Set(['objective', 'blocker']);

function clean(value: string): string | null {
  // Tolerate the quotes a YAML habit produces, since this is hand-edited.
  const trimmed = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parse focus.md. Hand-edited, so this is deliberately forgiving: a missing
 * frontmatter block, unknown keys, or prose-only content all parse fine rather
 * than erroring. The file is a note to self, not a config format.
 */
export function parseFocus(text: string): Focus {
  const focus: Focus = { objective: null, blocker: null, note: null, agentOnly: null };

  let body = text;
  const frontmatter = FRONTMATTER.exec(text);
  if (frontmatter) {
    body = text.slice(frontmatter[0].length);
    for (const line of (frontmatter[1] ?? '').split('\n')) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      if (KNOWN_KEYS.has(key)) {
        focus[key as 'objective' | 'blocker'] = clean(line.slice(separator + 1));
      }
    }
  }

  const marker = AGENT_ONLY_MARKER.exec(body);
  if (marker) {
    focus.agentOnly = clean(body.slice(marker.index + marker[0].length));
    body = body.slice(0, marker.index);
  }

  focus.note = clean(body.replace(COMMENT, ''));

  // Prose-only file: treat the first non-empty line as the objective so that
  // scribbling one sentence into focus.md still does something useful.
  if (!focus.objective && focus.note) {
    const [first, ...rest] = focus.note.split('\n');
    focus.objective = clean(first ?? '');
    focus.note = clean(rest.join('\n'));
  }

  return focus;
}

/**
 * Strip the agent-only section before the state ever leaves the server.
 *
 * The whole point of the marker is that it doesn't reach the DOM, so the
 * narrowing happens here, once, rather than being each renderer's problem.
 */
export function toPublicFocus(focus: Focus): PublicFocus {
  return { objective: focus.objective, blocker: focus.blocker, note: focus.note };
}
