// Registry-surface MCP tools.
//
// list_tools, get_tool, search_tools — pure functions over the catalog's
// `registry` projection. Backed by build-time data, so no DO / R2 /
// network calls. The catalog ships with the same fields the registry
// surface advertises; nothing else is fetched at tool-call time.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Catalog, CatalogRegistryEntry } from '../catalog';

function textContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function summary(entry: CatalogRegistryEntry) {
  return {
    slug: entry.slug,
    name: entry.name,
    binary: entry.binary,
    install: entry.install,
    version: entry.version ?? null,
    score_pct: entry.score_pct ?? null,
    scorecard_url: entry.scorecard_url ?? null,
    audit_profile: entry.audit_profile ?? null,
  };
}

export function registerRegistryTools(server: McpServer, catalog: Catalog): void {
  server.tool(
    'list_tools',
    'Return summaries of every scored CLI in the anc.dev registry. Each entry carries slug, name, binary, install ' +
      'command, version (when a scorecard has been committed), score_pct (percentage pass rate of the latest audit), ' +
      'scorecard_url (path under anc.dev), and audit_profile (when the tool opts out of the default profile).',
    {},
    async () => textContent(catalog.registry.map(summary)),
  );

  server.tool(
    'get_tool',
    'Return the full registry record for a single CLI by slug. Fields: slug, name, binary, install, audit_profile ' +
      '(when set), repo (when a GitHub owner/repo is parseable), version, anc_version, scorecard_url, score_pct. ' +
      'Look-not-found returns isError: false with a typed { found: false, message } body because absence is data, ' +
      'not failure.',
    { slug: z.string().describe('The CLI slug, e.g. "ripgrep" or "curl".') },
    async ({ slug }) => {
      const entry = catalog.registry.find((e) => e.slug === slug);
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ found: false, message: `no registry entry for slug: ${slug}` }, null, 2),
            },
          ],
        };
      }
      return textContent({ found: true, entry });
    },
  );

  server.tool(
    'search_tools',
    'Filter the registry by one or more criteria. All filters AND together. score_min / score_max are inclusive ' +
      'bounds on score_pct (rows without a committed scorecard are excluded when either bound is set). ' +
      'audit_profile is an exact match. principle_min_score is reserved for a future per-principle score filter and ' +
      'is currently a no-op (the catalog projection does not yet carry per-principle scores).',
    {
      score_min: z.number().min(0).max(100).optional().describe('Inclusive lower bound on score_pct.'),
      score_max: z.number().min(0).max(100).optional().describe('Inclusive upper bound on score_pct.'),
      audit_profile: z.string().optional().describe('Exact audit_profile match.'),
      principle_min_score: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Reserved for a future per-principle filter; no-op today.'),
    },
    async ({ score_min, score_max, audit_profile }) => {
      const matches = catalog.registry.filter((entry) => {
        if (audit_profile !== undefined && entry.audit_profile !== audit_profile) return false;
        if (score_min !== undefined) {
          if (entry.score_pct === undefined || entry.score_pct < score_min) return false;
        }
        if (score_max !== undefined) {
          if (entry.score_pct === undefined || entry.score_pct > score_max) return false;
        }
        return true;
      });
      return textContent(matches.map(summary));
    },
  );
}
