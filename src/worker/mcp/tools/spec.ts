// Spec-surface MCP tools.
//
// list_spec_sections, get_spec_section — pure functions over the
// catalog's `spec_sections` projection. The catalog carries the
// vendored agentnative spec at src/data/spec/ (README, CHANGELOG, each
// principle file, plus scoring.md). Spec_version is included on every
// section response so the agent can cross-check the version it's
// reading.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Catalog, CatalogSpecSection } from '../catalog';

function textContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function tocEntry(s: CatalogSpecSection) {
  return {
    slug: s.slug,
    title: s.title,
    level: s.level,
    parent_slug: s.parent_slug,
  };
}

export function registerSpecTools(server: McpServer, catalog: Catalog): void {
  server.tool(
    'list_spec_sections',
    'Return the table of contents for the vendored agentnative spec at the current spec_version. Each entry carries ' +
      'slug, title, level (1 for top-level files, 2 for sub-folder files such as principles/p*.md), and parent_slug ' +
      '(null for top-level sections).',
    {},
    async () => textContent({ spec_version: catalog.spec_version, sections: catalog.spec_sections.map(tocEntry) }),
  );

  server.tool(
    'get_spec_section',
    'Return the full body of a single spec section by slug. Fields: slug, title, body_markdown, spec_version. ' +
      'Look-not-found returns isError: false with a typed { found: false, message } body.',
    { slug: z.string().describe('The section slug, e.g. "p1-non-interactive-by-default" or "scoring".') },
    async ({ slug }) => {
      const section = catalog.spec_sections.find((s) => s.slug === slug);
      if (!section) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ found: false, message: `no spec section with slug: ${slug}` }, null, 2),
            },
          ],
        };
      }
      return textContent({
        found: true,
        section: {
          slug: section.slug,
          title: section.title,
          body_markdown: section.body_markdown,
          spec_version: catalog.spec_version,
        },
      });
    },
  );
}
