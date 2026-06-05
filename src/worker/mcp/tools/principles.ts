// Principles-surface MCP tools.
//
// list_principles, get_principle — pure functions over the catalog's
// `principles` projection. Each principle carries n (1-based), slug,
// title, body_markdown, and the MUST/SHOULD/MAY requirements drawn
// from the coverage-matrix at build time.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Catalog, CatalogPrinciple } from '../catalog';

function textContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function summary(p: CatalogPrinciple) {
  return {
    n: p.n,
    slug: p.slug,
    title: p.title,
    level_summary: {
      must: p.requirements.filter((r) => r.level === 'must').length,
      should: p.requirements.filter((r) => r.level === 'should').length,
      may: p.requirements.filter((r) => r.level === 'may').length,
    },
  };
}

export function registerPrincipleTools(server: McpServer, catalog: Catalog): void {
  server.tool(
    'list_principles',
    'Return summaries of every agent-native CLI principle. Each entry carries n (1-based), slug, title, and a ' +
      'level_summary object with counts of MUST / SHOULD / MAY requirements at the principle level.',
    {},
    async () => textContent(catalog.principles.map(summary)),
  );

  server.tool(
    'get_principle',
    'Return the full record for a single principle by ordinal number. Fields: n, slug, title, body_markdown, and ' +
      'requirements (each carrying id, level: must/should/may, summary, and audit_ids — the verifier identifiers ' +
      'the anc CLI emits when auditing a binary).',
    { n: z.number().int().min(1).describe('Principle ordinal, 1-based.') },
    async ({ n }) => {
      const principle = catalog.principles.find((p) => p.n === n);
      if (!principle) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { found: false, message: `no principle for n=${n}; valid range is 1..${catalog.principles.length}` },
                null,
                2,
              ),
            },
          ],
        };
      }
      return textContent({ found: true, principle });
    },
  );
}
