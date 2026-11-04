// What must settle before a check can gate or probe: what its antecedent token
// reads, plus what its handler reads from the context. A new check takes its
// edges from its token and handler, so it never names them itself.

import { antecedentPrerequisites, MCP_SETTLED, type Prerequisite } from './antecedents';
import type { WebCheck } from './registry';

const HANDLER_PREREQUISITES: Record<WebCheck['handler'], readonly Prerequisite[]> = {
  http: [],
  'dns-doh': [],
  'auth-md': [],
  webmcp: [],
  'markdown-frontmatter': [],
  'server-card': [],
  mcp: [MCP_SETTLED],
  'cors-preflight': [MCP_SETTLED],
  'protected-resource': [MCP_SETTLED],
  'content-without-js': ['llms-txt'],
  'llms-txt-quality': ['llms-txt'],
  'scoped-llms': ['llms-txt', 'sitemap'],
  'api-hygiene': ['openapi'],
};

export function rowPrerequisites(check: WebCheck): Prerequisite[] {
  return [...new Set([...antecedentPrerequisites(check.antecedent), ...(HANDLER_PREREQUISITES[check.handler] ?? [])])];
}
