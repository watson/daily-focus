/** What the two panels — a row's and a run's — do with their scroll and their cursor. */

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import type { FocusField, UiState } from './types.ts';

export type PanelFields = Partial<Record<FocusField, RefObject<HTMLInputElement | HTMLTextAreaElement>>>;

/**
 * State arrives on a heartbeat, and each push renders the panel again. The
 * elements survive that now — Preact changes what differs and leaves the rest —
 * so the caret, the focus and the text in a field are simply still there.
 *
 * Two things are not the element's to keep. A panel just opened starts at the
 * end of its conversation, where the next thing happens; and one reading the
 * newest reply follows it as it grows, while one scrolled up to read something
 * older is left where it is. And a panel opened by hand puts the cursor in the
 * field that was asked for, which is `ui.focusField`'s to say and this hook's
 * to do, once.
 */
export function usePanel(ui: UiState, fields: PanelFields): { body: RefObject<HTMLDivElement>; onScroll: () => void } {
  const body = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Read rather than peeked: a request to focus a field must rerun this panel
  // even when nothing else about it has changed, or the effect never sees it.
  const asked = ui.focusField.value;

  useLayoutEffect(() => {
    const node = body.current;
    if (node && atBottom.current) node.scrollTop = node.scrollHeight;

    // Opened by hand, the field asked for takes the cursor. Opened by a reload
    // that remembered it, nothing does — nobody asked.
    if (!asked) return;
    ui.focusField.value = null;
    const input = fields[asked]?.current;
    if (input && !input.disabled) input.focus();
  });

  const onScroll = (): void => {
    const node = body.current;
    if (node) atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
  };

  return { body, onScroll };
}
