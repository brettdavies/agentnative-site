// Unified render pipeline: markdown → HTML.
//
// Steps:
//   remark-parse → remark-gfm → rfc-keywords → remark-rehype → rehype-slug
//   → rehype-autolink-headings (append, inline-SVG permalink) → rehype-shiki
//   (dual-theme, defaultColor: false) → rehype-stringify.
//
// Pin notes (DESIGN.md §3.4.1 + Pinned scaffolding choices):
//   - `rehype-autolink-headings` behavior: 'append', class ['anchor'],
//     properties { ariaLabel: 'Permalink', tabIndex: -1 }, inline SVG content.
//   - Shiki themes: light 'github-light', dark 'github-dark-dimmed',
//     defaultColor: false (emits CSS custom props for the theme bridge in
//     site.css — see DESIGN.md §4.6 A7).
//   - rfc-keywords runs BEFORE remark-rehype so it walks the mdast tree
//     (which has distinct `inlineCode` / `code` / `link` node types) and
//     can enforce ancestor exclusions.

import rehypeShiki from '@shikijs/rehype';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import rfcKeywords from './plugins/rfc-keywords.mjs';

// Inline SVG for autolink anchor icons — keeps the build zero-JS and zero-
// external-asset for anchors. 16x16, currentColor so CSS controls color.
const anchorIconSvg = {
  type: 'element',
  tagName: 'svg',
  properties: {
    ariaHidden: 'true',
    focusable: 'false',
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    className: ['anchor-icon'],
  },
  children: [
    {
      type: 'element',
      tagName: 'path',
      properties: {
        fill: 'currentColor',
        d: 'M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z',
      },
      children: [],
    },
  ],
};

const autolinkConfig = {
  behavior: 'append',
  properties: {
    ariaLabel: 'Permalink',
    tabIndex: -1,
    className: ['anchor'],
  },
  content: () => [anchorIconSvg],
};

const shikiConfig = {
  themes: {
    light: 'github-light',
    dark: 'github-dark-dimmed',
  },
  defaultColor: false,
};

/**
 * Render a markdown string to HTML. Returns the HTML body fragment
 * (no shell, no styling — M5 adds the shell and CSS).
 * @param {string} markdown
 * @returns {Promise<string>}
 */
export async function renderMarkdown(markdown) {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(rfcKeywords)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, autolinkConfig)
    .use(rehypeShiki, shikiConfig)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(markdown);

  return String(file);
}
