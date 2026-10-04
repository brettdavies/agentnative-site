// A sentence written once and rendered two ways: HTML for the result page,
// markdown for its twin and the MCP reads.
// Hosts and URLs a site declares ride as code parts, so every renderer
// handles the target's strings in one place.

import { escHtml } from '../../shared/esc-html';

type RichPart = string | { code: string } | { text: string; href: string };
export type Rich = readonly RichPart[];

/** Break opportunities after "." and "/" so a long host or URL wraps only at a boundary. */
function withBreaks(escaped: string): string {
  return escaped.replace(/([./])/g, '$1<wbr>');
}

export function richHtml(rich: Rich, opts: { wbr?: boolean } = {}): string {
  return rich
    .map((part) => {
      if (typeof part === 'string') return escHtml(part);
      if ('code' in part) {
        const code = escHtml(part.code);
        return `<code>${opts.wbr ? withBreaks(code) : code}</code>`;
      }
      return `<a href="${escHtml(part.href)}">${escHtml(part.text)}</a>`;
    })
    .join('');
}

function flatten(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/** A code span no backtick inside it can close early. */
function mdCode(text: string): string {
  const flat = flatten(text);
  if (!flat.includes('`')) return `\`${flat}\``;
  const longest = Math.max(...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}

export function richMarkdown(rich: Rich): string {
  return rich
    .map((part) => {
      if (typeof part === 'string') return flatten(part).replace(/[`<]/g, '\\$&');
      if ('code' in part) return mdCode(part.code);
      return flatten(part.text);
    })
    .join('');
}
