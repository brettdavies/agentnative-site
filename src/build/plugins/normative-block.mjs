// Block-level normative treatment plugin (docs/DESIGN.md §4.7, plan
// docs/plans/2026-04-29-001-feat-brand-og-and-block-normative-plan.md Unit 1).
//
// Promotes the `**KEYWORD:**`-paragraph-immediately-followed-by-list shape
// into a single `<aside class="normative normative--{must,should,may}">`
// container. Mid-paragraph keywords and colon-less keywords are untouched —
// the inline `rfc-keywords` plugin keeps owning those.
//
// Pipeline order (src/build/render.mjs): runs AFTER `rfcKeywords` so the
// inner `<strong class="rfc-must">MUST:</strong>` is already in place when
// the wrapper is added. Inner inline span survives by construction; the
// nested-strong fix from
// docs/solutions/ui-bugs/rfc-keyword-remark-plugin-nested-strong-2026-04-14.md
// is preserved because this plugin only wraps, never re-emits the strong.
//
// Detection rule (conservative):
//   IF paragraph.children is exactly one strong node whose hProperties.className
//      includes one of rfc-must / rfc-should / rfc-may
//   AND that strong's text content ends with `:`
//   AND the paragraph's right-sibling in its parent is a `list` node
//   THEN wrap [paragraph, list] in an aside-shaped node and replace both
//        originals with it.
//   ELSE leave both nodes untouched.

import { visit } from 'unist-util-visit';

const KEYWORD_CLASSES = new Set(['rfc-must', 'rfc-should', 'rfc-may']);

const VARIANT_FOR_CLASS = {
  'rfc-must': 'must',
  'rfc-should': 'should',
  'rfc-may': 'may',
};

function classNamesOf(strongNode) {
  const className = strongNode?.data?.hProperties?.className;
  if (Array.isArray(className)) return className;
  if (typeof className === 'string') return [className];
  return [];
}

function detectKeywordVariant(strongNode) {
  for (const cls of classNamesOf(strongNode)) {
    if (KEYWORD_CLASSES.has(cls)) return VARIANT_FOR_CLASS[cls];
  }
  return null;
}

function strongText(strongNode) {
  if (!Array.isArray(strongNode.children)) return '';
  return strongNode.children
    .filter((c) => c.type === 'text')
    .map((c) => c.value)
    .join('');
}

function isPromotableParagraph(node) {
  if (node?.type !== 'paragraph') return null;
  if (!Array.isArray(node.children) || node.children.length !== 1) return null;
  const child = node.children[0];
  if (child?.type !== 'strong') return null;
  const variant = detectKeywordVariant(child);
  if (!variant) return null;
  if (!strongText(child).endsWith(':')) return null;
  return variant;
}

function makeAsideNode(variant, paragraph, list) {
  return {
    type: 'normativeBlock',
    data: {
      hName: 'aside',
      hProperties: {
        className: ['normative', `normative--${variant}`],
      },
    },
    children: [paragraph, list],
  };
}

export default function normativeBlock() {
  return (tree) => {
    const replacements = [];

    visit(tree, (node) => {
      if (!Array.isArray(node?.children)) return;
      for (let i = 0; i < node.children.length - 1; i++) {
        const variant = isPromotableParagraph(node.children[i]);
        if (!variant) continue;
        const next = node.children[i + 1];
        if (next?.type !== 'list') continue;
        replacements.push({
          parent: node,
          startIndex: i,
          paragraph: node.children[i],
          list: next,
          variant,
        });
      }
    });

    // Apply replacements back-to-front so indices stay valid (mirrors
    // src/build/plugins/rfc-keywords.mjs lines 100-104).
    replacements.sort((a, b) => b.startIndex - a.startIndex);
    for (const { parent, startIndex, paragraph, list, variant } of replacements) {
      parent.children.splice(startIndex, 2, makeAsideNode(variant, paragraph, list));
    }

    return tree;
  };
}
