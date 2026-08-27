import { capExecute, emptyObjectSchema, type WebMcpTool } from './webmcp-lib';

export function orientationTools(origin: string): WebMcpTool[] {
  return [
    {
      name: 'get_principle_url',
      description: 'Return the canonical URL for an agent-native CLI principle (1-8).',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'integer', minimum: 1, maximum: 8, description: 'Principle number (1-8).' },
        },
        required: ['n'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const n = Number(input.n);
        if (!Number.isInteger(n) || n < 1 || n > 8) {
          return 'Invalid principle number. Use an integer from 1 to 8.';
        }
        return capExecute(`${origin}/p${n}`);
      },
    },
    {
      name: 'get_llms_index',
      description: 'Return the llms.txt summary index URL for the agent-native CLI standard.',
      inputSchema: emptyObjectSchema(),
      annotations: { readOnlyHint: true },
      execute() {
        return capExecute(`${origin}/llms.txt`);
      },
    },
    {
      name: 'get_mcp_endpoint',
      description: 'Return the streamable-HTTP MCP endpoint and client integration guide.',
      inputSchema: emptyObjectSchema(),
      annotations: { readOnlyHint: true },
      execute() {
        return capExecute(
          `MCP endpoint: ${origin}/mcp\nClient guide: ${origin}/mcp-skill.md\nServer card: ${origin}/.well-known/mcp/server-card.json`,
        );
      },
    },
  ];
}
