// Era-aware MCP_LIMITER read-tier key construction (R6, KTD7).

import type { Catalog } from './catalog';

export function buildMcpRateLimitKey(opts: {
  era: 'legacy' | 'modern';
  ip: string;
  mcpName: string | null;
  catalog: Catalog;
}): string {
  const { era, ip, mcpName, catalog } = opts;
  if (era === 'legacy') {
    return `legacy:${ip}`;
  }

  if (mcpName) {
    const tools = catalog.registered_tool_names ?? [];
    const templates = catalog.registered_resource_templates ?? [];
    if (tools.includes(mcpName) || templates.includes(mcpName)) {
      return `modern:${mcpName}:${ip}`;
    }
  }

  return `modern:${ip}`;
}

export function headerMcpName(request: Request): string | null {
  return request.headers.get('Mcp-Name') ?? request.headers.get('mcp-name');
}

export function headerMcpMethod(request: Request): string | null {
  return request.headers.get('Mcp-Method') ?? request.headers.get('mcp-method');
}
