// score_cli MCP tool — U3 stub.
//
// Registered here so the handshake's tool count is honest at every
// commit boundary (R3 of the plan: nine tools advertised) and so the
// drift-gate tests on the instructions string don't false-fail. The
// real implementation lands in U5, which:
//
//   1. Adds the MCP_LIVE_SCORING_ENABLED kill switch (per R14 / KTD-11).
//   2. Runs validateInput as the security gate (per KTD-7).
//   3. Composes the shared orchestrator with intent run_fresh_on_miss.
//   4. Enforces MCP_AUDIT_LIMITER with no anon fallback on the audit
//      tier (per R7 / KTD-4) before any container exec.
//   5. Delegates the fresh audit to the orchestrator, which dispatches
//      via getRandom(env.SCORE, MAX_INSTANCES) — never idFromName —
//      and lets the DO write the cache via writeCacheBestEffort.
//
// For U3 every invocation returns the stub message below. isError stays
// false because "score_cli not yet implemented" is intentional state,
// not a tool failure.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Catalog } from '../catalog';

export function registerScorecardAuditTool(server: McpServer, _catalog: Catalog): void {
  server.tool(
    'score_cli',
    'Run a fresh container audit for a CLI when no cached scorecard exists. Provide ONE of: slug, binary, install, ' +
      'github_url (same validator as get_scorecard). On registry or R2-cache hit, returns isError: false with ' +
      'next_tool: get_scorecard (cache state is data, not failure). On cache miss, runs a metered container audit ' +
      'gated by MCP_AUDIT_LIMITER (5 per 60 minutes per IP, no anon fallback) and the MCP_LIVE_SCORING_ENABLED ' +
      'env-var kill switch. U3 stub: returns audited: false with a "not yet implemented" message; the audit path ' +
      'lands in U5 of the MCP endpoint plan.',
    {
      slug: z.string().optional().describe('Registry slug, e.g. "ripgrep".'),
      binary: z.string().optional().describe('CLI binary name.'),
      install: z.string().optional().describe('Full install command, e.g. "brew install ripgrep".'),
      github_url: z.string().optional().describe('GitHub URL (https://github.com/owner/repo).'),
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              audited: false,
              message:
                'score_cli is registered for tool-count parity at the handshake; the audit path lands in U5 of the ' +
                'MCP endpoint plan. Use get_scorecard for the cached read tier in the meantime.',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
