/**
 * The slice of Markdown an agent actually reaches for, as elements.
 *
 * Built as elements and text rather than parsed from HTML, so agent output can
 * never inject markup: the detail field is untrusted by construction.
 */

import type { ComponentChild, JSX } from 'preact';

import { el } from './el.ts';

const MARKDOWN =
  /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\bhttps?:\/\/[^\s<]+)/g;

/** Inline Markdown: links, inline code, bold, and bare URLs. */
export function renderMarkdown(value: unknown): ComponentChild[] {
  const text = String(value);
  const out: ComponentChild[] = [];
  let last = 0;

  for (const match of text.matchAll(MARKDOWN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));

    if (match[1]) {
      out.push(anchor(match[3]!, match[2]!));
    } else if (match[4]) {
      out.push(el('code', null, match[5]));
    } else if (match[6]) {
      out.push(el('strong', null, match[7]));
    } else if (match[8]) {
      out.push(anchor(match[8], match[8]));
    }

    last = index + match[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function anchor(href: string, label: string): JSX.Element {
  // Belt and braces: the regex only matches http(s), and this re-checks after parsing.
  return el('a', { href: /^https?:\/\//i.test(href) ? href : '#', target: '_blank', rel: 'noopener noreferrer' }, label);
}

/**
 * Markdown with paragraphs, lists and fenced code, on top of the inline forms
 * `renderMarkdown` knows. The assistant writes whole answers; everything else on
 * the page is a sentence.
 */
export function renderMarkdownBlocks(value: unknown): JSX.Element[] {
  const out: JSX.Element[] = [];
  const lines = String(value).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(el('pre', null, code.join('\n')));
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // A quote: the assistant's habit for "the draft now says". Rendered by
    // recursion so a quoted list or paragraph break keeps its shape.
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push(el('blockquote', null, renderMarkdownBlocks(quoted.join('\n'))));
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      i++;
      out.push(el('hr'));
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: JSX.Element[] = [];
      while (i < lines.length && bullet.test(lines[i]!)) {
        let item = lines[i]!.replace(bullet, '');
        i++;
        // A wrapped bullet continues on indented lines.
        while (i < lines.length && /^\s+\S/.test(lines[i]!) && !bullet.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(el('li', null, renderMarkdown(item)));
      }
      out.push(el(ordered ? 'ol' : 'ul', null, items));
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !bullet.test(lines[i]!) && !/^\s*(```|>)/.test(lines[i]!)) {
      paragraph.push(lines[i++]!);
    }
    const joined = paragraph.join(' ');
    // A heading reads as a lead sentence: the panel is too narrow for hierarchy.
    const heading = /^#{1,6}\s+(.*)$/.exec(joined);
    out.push(heading ? el('p', null, el('strong', null, renderMarkdown(heading[1]))) : el('p', null, renderMarkdown(joined)));
  }
  return out;
}
