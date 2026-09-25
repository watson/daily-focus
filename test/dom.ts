/**
 * A document for the tests that render the client, and the way in.
 *
 * The client is Preact, which diffs against a real enough DOM, so happy-dom
 * provides one. The globals are installed as this module loads, not by a
 * function a test has to remember to call: import it ahead of the client
 * modules and `document` is there when Preact reaches for it.
 *
 * What a test gets back is an element, so the questions worth asking of a
 * rendered row — is the button offered, is the link clickable, is the field
 * still holding its text — are asked of the same DOM the browser would build.
 */

import assert from 'node:assert/strict';

import { Window } from 'happy-dom';
import { render, type ComponentChild } from 'preact';

import { createUi } from '../client/state.ts';
import type { Handlers, UiState, UiValues } from '../client/types.ts';

const window = new Window({ url: 'http://localhost/' });

const GLOBALS = [
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLDetailsElement',
  'HTMLDialogElement',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'InputEvent',
  'DocumentFragment',
  'Text',
  'localStorage',
  'sessionStorage',
] as const;

for (const name of [...GLOBALS, 'window'] as const) {
  const value = name === 'window' ? window : (window as unknown as Record<string, unknown>)[name];
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    (globalThis as unknown as Record<string, unknown>)[name] = value;
  }
}

/** Render `node` into a fresh container on the page, and hand the container back. */
export function mount(node: ComponentChild): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(node, root);
  return root;
}

/** Render `node`, and hand back the one element it produced. */
export function mountOne(node: ComponentChild): HTMLElement {
  const first = mount(node).firstElementChild;
  assert.ok(first, 'expected the render to produce an element');
  return first as HTMLElement;
}

/** Let a rerender that a signal write scheduled land. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export const byTag = (root: Element, tag: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(tag)];

export const byClass = (root: Element, name: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`.${name}`)];

export const buttonLabels = (root: Element): string[] => byTag(root, 'button').map((button) => button.textContent ?? '');

/** View state for one render, every fact at its default unless said otherwise. */
export const uiWith = (overrides: Partial<UiValues> = {}): UiState => createUi(overrides);

/** Handlers that do nothing, except for the ones a test gives. */
export function handlersWith(overrides: Partial<Handlers> = {}): Handlers {
  return new Proxy(overrides, {
    get: (target, name) => (name in target ? target[name as keyof Handlers] : () => {}),
  }) as Handlers;
}
