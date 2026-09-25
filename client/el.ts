/**
 * The element factory the renderers are written in.
 *
 * `el(tag, props, ...children)` is Preact's `h` with a looser props type: the
 * renderers set `data-*` and `aria-*` attributes by name, which Preact's own
 * typings only allow from JSX. Everything else is Preact's. `class`, `hidden`,
 * `value`, `open` and the rest reach the element as properties or attributes
 * as the DOM says; `onClick` and friends become listeners; `ref` hands the
 * element back; and `key` decides which element a rebuilt list keeps.
 *
 * What Preact adds, and the reason the client is written on it: a render
 * describes the page and Preact changes only what differs. An element that
 * stays the same keeps its focus, its caret, its scroll position, its hover and
 * its open state through every state push.
 */

import { h, type ComponentChildren, type JSX } from 'preact';

export type Props = Record<string, unknown>;

export function el(tag: string, props: Props | null = null, ...children: ComponentChildren[]): JSX.Element {
  return h(tag, props as never, ...children);
}
