// Modern-era (2026-07-28) MCP probe helpers — SEP-2243 headers + _meta in params.

export const MODERN_PROTOCOL = '2026-07-28';

export const MODERN_META = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: 'anc-mcp-test', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  },
} as const;

export function modernToolsListBody(id = 10) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/list',
    params: { ...MODERN_META },
  };
}

export function modernToolCallBody(name: string, args: Record<string, unknown>, id = 11) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      ...MODERN_META,
    },
  };
}

export function modernToolsListHeaders(): Record<string, string> {
  return {
    'MCP-Protocol-Version': MODERN_PROTOCOL,
    'Mcp-Method': 'tools/list',
  };
}

export function modernToolCallHeaders(toolName: string): Record<string, string> {
  return {
    'MCP-Protocol-Version': MODERN_PROTOCOL,
    'Mcp-Method': 'tools/call',
    'Mcp-Name': toolName,
  };
}

/** Negative probe: _meta without clientCapabilities (AE7). */
export function modernToolCallBodyMissingCapabilities(name: string, args: Record<string, unknown>, id = 12) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'anc-mcp-test', version: '0' },
      },
    },
  };
}

export function deepFindFirst(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj)) {
    const found = deepFindFirst(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
