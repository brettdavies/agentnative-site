// The server instructions, returned in InitializeResult.instructions and
// DiscoverResult.instructions.
//
// They are written lead-first: what the server is for and where the full
// guide lives, then which tool answers which question, then what a website
// audit sends to third-party hosts, then the details. A client that cuts the
// string still delivers what comes first. tests/mcp-client-limits.test.ts holds
// the string inside the limits recorded in client-limits.ts.
//
// The numeric facts below (13 tools, 5 resources, the rate limits, the spec
// revision, the guide URL) also appear in content/mcp-skill.md. The tests in
// tests/worker-mcp.test.ts assert each literal, so a change in one source
// forces a change in the other.
//
// The URLs are minted per session from the origin the request arrived on, so
// an agent that connects to staging is told to keep talking to staging.

import { FOLLOW_DISCLOSURE_SHORT } from '../audit-web/follow-disclosure';
import { siteOrigin } from './site-origin';

export const SPEC_REVISION = '2026-07-28';
const TOOL_COUNT = 13;
const RESOURCE_TOTAL = 5;
const READ_LIMIT_REQUESTS = 60;
const READ_LIMIT_WINDOW_SECONDS = 60;
const AUDIT_LIMIT_REQUESTS = 5;
const AUDIT_LIMIT_WINDOW_MINUTES = 60;
const WEB_AUDIT_HOURLY_REQUESTS = 30;

export interface InstructionsEnv {
  ASSETS: Fetcher;
}

function buildInstructionsText(siteUrl: string): string {
  return [
    'anc.dev scores CLI tools, websites, and the MCP servers websites declare against the agent-native standard: ' +
      'eight principles for software that AI agents operate. Use these tools when asked how well a CLI or a ' +
      'website works for agents, its agent-readiness score or fixes, or what the principles and spec require. ' +
      `No authentication. Full guide: ${siteUrl}/mcp-skill.md.`,
    'Read the cache first; it costs no audit. get_scorecard (a CLI) and get_website_audit (a website) return ' +
      '{ found: false, next_tool } on a miss. Only then run a metered audit: ' +
      `score_cli (${AUDIT_LIMIT_REQUESTS} fresh audits per ${AUDIT_LIMIT_WINDOW_MINUTES} minutes per IP) or ` +
      `audit_website (${WEB_AUDIT_HOURLY_REQUESTS} fresh audits per ${AUDIT_LIMIT_WINDOW_MINUTES} minutes per IP). ` +
      'Browse the CLI registry with list_tools, search_tools, and get_tool, and the web leaderboard with ' +
      'list_website_audits; read the standard with ' +
      'list_principles, get_principle, list_spec_sections, and get_spec_section; get_web_remediation returns the ' +
      'fix for a failed check.',
    FOLLOW_DISCLOSURE_SHORT,
    `${TOOL_COUNT} tools and ${RESOURCE_TOTAL} resources (anc://registry plus 4 templates); full schemas are on ` +
      'tools/list and resources/templates/list.',
    'Scorecard tools return one envelope { kind, tier, target, scorecard_url, markdown_url, json_url, freshness, ' +
      'spec_version, scorecard }; json_url serves it as JSON. Web scorecard fields are at ' +
      `${siteUrl}/web-scorecard-schema. Check isError first: a cache miss is isError: false with next_tool.`,
    `Every call shares ${READ_LIMIT_REQUESTS} requests per ${READ_LIMIT_WINDOW_SECONDS} seconds per IP; a breach ` +
      `returns JSON-RPC -32099. Spec revision ${SPEC_REVISION}. Connect now at ${siteUrl}/mcp.`,
  ].join(' ');
}

export function buildInstructions(_env: InstructionsEnv): string {
  return buildInstructionsText(siteOrigin());
}
