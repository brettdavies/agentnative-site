// get_web_remediation MCP tool (plan U13, reshaped per plan-003 R14).
// Mirrors get_spec_section: a reader that returns the static remediation
// for any check id with a typed found/not-found envelope (both
// isError:false). The response carries the CF-style remediation object
// (goal / fix / skill_url / resources / prompt); when the caller passes
// this run's evidence string it becomes the prompt's Issue line,
// otherwise a generic line stands in. Assembly and the per-isolate
// catalog load live in src/worker/audit-web/remediation.ts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  assembleRemediation,
  loadWebRemediationCatalog,
  resetWebRemediationCatalogCacheForTests,
  type WebRemediationCatalog,
  type WebRemediationCatalogEnv,
} from '../../audit-web/remediation';

export type WebRemediationEnv = WebRemediationCatalogEnv;

const SITE_URL = 'https://anc.dev';

export function resetWebRemediationCacheForTests(): void {
  resetWebRemediationCatalogCacheForTests();
}

function textContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerWebRemediationTool(server: McpServer, env: WebRemediationEnv): void {
  server.tool(
    'get_web_remediation',
    'Return the canonical remediation for a web-audit check by id (e.g. "llms-txt", "mcp-initialize"). Returns ' +
      'isError:false for both outcomes: found returns { found:true, remediation: { check_id, title, goal, fix, ' +
      "skill_url, resources, prompt } }, not-found returns { found:false, message }. Pass the failing check's " +
      "evidence string to make the prompt's Issue line this run's finding.",
    {
      check_id: z.string().describe('The check id from the web scorecard results, e.g. "llms-txt".'),
      evidence: z
        .string()
        .optional()
        .describe("Optional: this run's evidence line for the check; becomes the prompt's Issue line."),
    },
    async ({ check_id, evidence }) => {
      let catalog: WebRemediationCatalog;
      try {
        catalog = await loadWebRemediationCatalog(env);
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
      const assembled = assembleRemediation(entry, { checkId: check_id, origin: SITE_URL, evidence });
      return textContent({
        found: true,
        remediation: { check_id, title: entry.title, ...assembled },
      });
    },
  );
}
