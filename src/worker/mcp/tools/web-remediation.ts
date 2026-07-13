// get_web_remediation MCP tool (plan U13, KTD-12). Mirrors get_spec_section:
// a dumb reader that returns static catalog content by key with a typed
// found/not-found envelope (both isError:false). Lets an MCP-only agent
// with no HTML-site access fetch the canonical fix for a web-audit check.
//
// The catalog is dist/_internal/web-remediation.json (projected from
// remediation.yaml by the build), loaded per-isolate through env.ASSETS.
// For an MCP-shape check the caller may pass this run's evidence string,
// which is substituted into the {{evidence}} slot — no generated prose,
// just the audit's own evidence injected into a static template.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface WebRemediationEnv {
  ASSETS: Fetcher;
}

interface RemediationEntry {
  title: string;
  body: string;
  evidence_template: boolean;
}
type RemediationCatalog = Record<string, RemediationEntry>;

const CATALOG_PATH = '/_internal/web-remediation.json';
const EVIDENCE_SLOT = '{{evidence}}';

let cached: { env: WebRemediationEnv; catalog: RemediationCatalog } | null = null;

async function loadCatalog(env: WebRemediationEnv): Promise<RemediationCatalog> {
  if (cached && cached.env === env) return cached.catalog;
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${CATALOG_PATH}`));
  if (!res.ok) throw new Error(`web-remediation catalog fetch failed: ${res.status} ${res.statusText}`);
  const catalog = (await res.json()) as RemediationCatalog;
  cached = { env, catalog };
  return catalog;
}

export function resetWebRemediationCacheForTests(): void {
  cached = null;
}

function textContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerWebRemediationTool(server: McpServer, env: WebRemediationEnv): void {
  server.tool(
    'get_web_remediation',
    'Return the canonical remediation for a web-audit check by id (e.g. "llms-txt", "mcp-initialize"). Returns ' +
      'isError:false for both outcomes: found returns { found:true, remediation }, not-found returns { found:false, ' +
      "message }. For MCP-shape checks, pass the failing check's evidence string to inject it into the fix.",
    {
      check_id: z.string().describe('The check id from the web scorecard results, e.g. "llms-txt".'),
      evidence: z
        .string()
        .optional()
        .describe("Optional: this run's evidence for an MCP-shape check, injected into the remediation template."),
    },
    async ({ check_id, evidence }) => {
      let catalog: RemediationCatalog;
      try {
        catalog = await loadCatalog(env);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `infrastructure error: ${(err as Error).message}` }],
          isError: true,
        };
      }
      const entry = catalog[check_id];
      if (!entry) {
        return textContent({ found: false, message: `no remediation for check id: ${check_id}` });
      }
      const body = entry.evidence_template
        ? entry.body.replace(EVIDENCE_SLOT, evidence && evidence.length > 0 ? evidence : '(no evidence provided)')
        : entry.body;
      return textContent({
        found: true,
        remediation: { check_id, title: entry.title, body, evidence_template: entry.evidence_template },
      });
    },
  );
}
