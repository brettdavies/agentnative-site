// RFC-keyword annotation plugin (DESIGN.md §4.7, eng review A6/C2).
//
// Walks mdast `text` nodes and turns bare-word MUST / MUST NOT / SHOULD /
// SHOULD NOT / MAY into `<strong class="rfc-must|should|may">` markup.
// Critical constraints, all covered by tests/build.test.ts:
//
//   - Regex: /\b(MUST(?: NOT)?|SHOULD(?: NOT)?|MAY)\b/g
//   - Skip when an ancestor is code, inlineCode, or link.
//   - `MUST NOT` and `SHOULD NOT` render as a single span, not two.
//   - If the keyword is already wrapped in `**…**` (mdast `strong` parent
//     with a single `text` child), annotate the parent strong in place
//     rather than nesting a second `<strong>`.
//   - Word-boundary strict: `MUSTARD` does not match; trailing commas /
//     periods do match.
//   - Markdown source stays uppercase and untouched — /p3.md serves the
//     original bytes.

import { visitParents } from 'unist-util-visit-parents';

const KEYWORD_RE = /\b(MUST(?: NOT)?|SHOULD(?: NOT)?|MAY)\b/g;

const CLASS_FOR = {
  MUST: 'rfc-must',
  'MUST NOT': 'rfc-must',
  SHOULD: 'rfc-should',
  'SHOULD NOT': 'rfc-should',
  MAY: 'rfc-may',
};

const EXCLUDED_ANCESTORS = new Set(['code', 'inlineCode', 'link']);

function makeStrongNode(word) {
  return {
    type: 'strong',
    data: {
      hName: 'strong',
      hProperties: { className: [CLASS_FOR[word]] },
    },
    children: [{ type: 'text', value: word }],
  };
}

function annotateExistingStrong(strongNode, word) {
  strongNode.data = strongNode.data || {};
  strongNode.data.hName = 'strong';
  strongNode.data.hProperties = { className: [CLASS_FOR[word]] };
}

export default function rfcKeywords() {
  return (tree) => {
    const replacements = [];

    visitParents(tree, 'text', (node, ancestors) => {
      if (ancestors.some((a) => EXCLUDED_ANCESTORS.has(a.type))) return;

      const value = node.value;
      if (!KEYWORD_RE.test(value)) return;
      KEYWORD_RE.lastIndex = 0;

      const parent = ancestors[ancestors.length - 1];
      if (!parent || !Array.isArray(parent.children)) return;

      // Nested-strong case (A6): any ancestor is `strong`. Annotate the
      // outermost strong with the first keyword's class and leave its text
      // children unchanged — nesting a second <strong> would produce invalid
      // `<strong><strong>` markup and double the semantic weight.
      const strongAncestor = ancestors.find((a) => a.type === 'strong');
      if (strongAncestor) {
        const firstMatch = value.match(KEYWORD_RE);
        KEYWORD_RE.lastIndex = 0;
        if (firstMatch) {
          annotateExistingStrong(strongAncestor, firstMatch[0]);
        }
        return;
      }

      // General case: replace this text node with a sequence of text + strong
      // nodes on the parent's children array.
      const matches = [...value.matchAll(KEYWORD_RE)];
      if (matches.length === 0) return;

      const newChildren = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) {
          newChildren.push({ type: 'text', value: value.slice(cursor, match.index) });
        }
        newChildren.push(makeStrongNode(match[0]));
        cursor = match.index + match[0].length;
      }
      if (cursor < value.length) {
        newChildren.push({ type: 'text', value: value.slice(cursor) });
      }

      const index = parent.children.indexOf(node);
      if (index === -1) return;
      replacements.push({ parent, index, newChildren });
    });

    // Apply replacements back-to-front so indices stay valid.
    replacements.sort((a, b) => b.index - a.index);
    for (const { parent, index, newChildren } of replacements) {
      parent.children.splice(index, 1, ...newChildren);
    }

    return tree;
  };
}
