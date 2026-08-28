// get_web_remediation MCP tool (plan U13, reshaped per plan-003 R14).
// Mirrors get_spec_section: a reader that returns the static remediation
// for any check id with a typed found/not-found envelope (both
// isError:false). The response carries the CF-style remediation object
// (goal / fix / skill_url / resources / prompt). The catalog text is
// site-owned; a caller-supplied evidence string is appended as a
// delimited, length-bounded data block so the reader can tell the run's
// observation from its own instructions. Assembly and the per-isolate
// catalog load live in src/worker/audit-web/remediation.ts.

import type { McpServer } from '@modelcontextprotocol/server';
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
  server.registerTool(
    'get_web_remediation',
    {
      title: 'Get web-audit remediation guidance',
      description:
        'Return the canonical remediation for a web-audit check by id (e.g. "llms-txt", "mcp-initialize"). Returns ' +
        'isError:false for both outcomes: found returns { found:true, remediation: { check_id, title, goal, fix, ' +
        "skill_url, resources, prompt } }, not-found returns { found:false, message }. Pass the failing row's " +
        'evidence to append it to the prompt as a delimited, length-bounded data block; omit it for the catalog ' +
        'text alone.',
      inputSchema: {
        check_id: z.string().describe('The check id from the web scorecard results, e.g. "llms-txt".'),
        evidence: z
          .string()
          .optional()
          .describe(
            "Optional: this run's evidence line for the check. It is embedded as untrusted data in a delimited " +
              'block, flattened to one line and truncated past 200 characters.',
          ),
      },
      annotations: { readOnlyHint: true },
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
