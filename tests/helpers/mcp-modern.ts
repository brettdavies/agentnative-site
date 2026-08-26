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

function modernRequestMeta(protocolVersion: string, clientName: string) {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: clientName, version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

export function modernToolCallBodyWithClientName(
  name: string,
  args: Record<string, unknown>,
  clientName: string,
  id = 15,
) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: modernRequestMeta(MODERN_PROTOCOL, clientName),
    },
  };
}

export function modernResourcesReadBody(uri: string, id = 13) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'resources/read',
    params: { uri, ...MODERN_META },
  };
}

/** SEP-2243: Mcp-Name on resources/read must mirror params.uri; any other value draws -32020. */
export function modernResourcesReadHeaders(resourceUri: string): Record<string, string> {
  return {
    'MCP-Protocol-Version': MODERN_PROTOCOL,
    'Mcp-Method': 'resources/read',
    'Mcp-Name': resourceUri,
  };
}

export function toolsListBodyClaimingVersion(version: string, id = 14) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/list',
    params: { _meta: modernRequestMeta(version, 'anc-mcp-test') },
  };
}

export function toolsListHeadersClaimingVersion(version: string): Record<string, string> {
  return {
    'MCP-Protocol-Version': version,
    'Mcp-Method': 'tools/list',
  };
}

/** An all-legacy batch: the pinned SDK's entry classifier routes it to legacy serving, not a reject. */
export function legacyToolsListBatchBody(ids: readonly [number, number] = [70, 71]) {
  return ids.map((id) => ({ jsonrpc: '2.0' as const, id, method: 'tools/list' }));
}

/** A batch body the pinned SDK rejects (-32600): modern-envelope elements may not ride in arrays. */
export function modernElementBatchBody(id = 74) {
  return [
    {
      jsonrpc: '2.0' as const,
      id,
      method: 'tools/list',
      params: { ...MODERN_META },
    },
  ];
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
