/**
 * Just enough DOM for `el()`, shared by the tests that render the client.
 *
 * The client is vanilla ES modules with no build step and no DOM in the test
 * runner, so the handful of `document` calls `el()` makes are stubbed rather than
 * a browser being brought in. That is enough to answer the questions worth asking
 * of a rendered row, and those are exactly the ones a rule expressed only in
 * `render.js` would otherwise never be held to.
 *
 * The globals are installed as this module loads, not by a function a test has to
 * remember to call. Static imports are evaluated before the importing module's
 * body, so importing this file is on its own enough to guarantee the stubs are in
 * place before a `await import('../public/render.js')` further down reaches for
 * `document` and `Node`.
 */

export class StubNode {
  childNodes: StubNode[] = [];
  append(...kids: StubNode[]): void {
    this.childNodes.push(...kids);
  }
  get textContent(): string {
    return this.childNodes.map((kid) => kid.textContent).join('');
  }
  set textContent(text: string) {
    this.childNodes = [new StubText(text)];
  }
}

export class StubText extends StubNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(text: string) {
    this.data = text;
  }
}

export class StubElement extends StubNode {
  readonly tagName: string;
  className = '';
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, unknown[]> = {};
  [key: string]: unknown;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  addEventListener(type: string, fn: unknown): void {
    (this.listeners[type] ??= []).push(fn);
  }
}

Object.assign(globalThis, {
  Node: StubNode,
  document: {
    createElement: (tag: string) => new StubElement(tag),
    createTextNode: (text: string) => new StubText(text),
  },
});

/* ---------- walking what came out ---------- */

export function* walk(node: StubNode): Generator<StubNode> {
  for (const kid of node.childNodes) {
    yield kid;
    yield* walk(kid);
  }
}

export const byTag = (root: StubNode, tag: string): StubElement[] =>
  [...walk(root)].filter((node): node is StubElement => (node as StubElement).tagName === tag);

export const byClass = (root: StubNode, name: string): StubElement[] =>
  [...walk(root)].filter((node) => (node as StubElement).className?.split(' ').includes(name)) as StubElement[];

export const buttonLabels = (root: StubNode): string[] =>
  byTag(root, 'BUTTON').map((button) => button.textContent);
