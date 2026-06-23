// WebMCP imperative API — exposes spec-navigation tools to browser agents via
// navigator.modelContext (W3C WebMCP). No-ops when the API is absent.
// Loaded on spec surfaces only (homepage, principles, /mcp) — not scorecards.
// See https://webmachinelearning.github.io/webmcp/

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

type ModelContext = {
  registerTool?: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => Promise<void>;
  provideContext?: (context: { tools: ModelContextTool[] }, options?: { signal?: AbortSignal }) => Promise<void>;
};

function origin(): string {
  return window.location.origin;
}

function textResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

function registerSiteTools(mc: ModelContext, signal: AbortSignal): void {
  const tools: ModelContextTool[] = [
    {
      name: 'get_principle_url',
      description: 'Return the canonical URL for an agent-native CLI principle (1-8).',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'integer', minimum: 1, maximum: 8, description: 'Principle number (1-8).' },
        },
        required: ['n'],
      },
      async execute(input) {
        const n = Number(input.n);
        if (!Number.isInteger(n) || n < 1 || n > 8) {
          return textResult('Invalid principle number. Use an integer from 1 to 8.');
        }
        return textResult(`${origin()}/p${n}`);
      },
    },
    {
      name: 'get_llms_index',
      description: 'Return the llms.txt summary index URL for the agent-native CLI standard.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return textResult(`${origin()}/llms.txt`);
      },
    },
    {
      name: 'get_mcp_endpoint',
      description: 'Return the streamable-HTTP MCP endpoint and client integration guide for anc.dev.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return textResult(
          `MCP endpoint: ${origin()}/mcp\nClient guide: ${origin()}/mcp-skill.md\nServer card: ${origin()}/.well-known/mcp/server-card.json`,
        );
      },
    },
  ];

  if (typeof mc.provideContext === 'function') {
    void mc.provideContext({ tools }, { signal }).catch(() => {});
    return;
  }

  if (typeof mc.registerTool === 'function') {
    for (const tool of tools) {
      void mc.registerTool(tool, { signal }).catch(() => {});
    }
  }
}

function initWebMcp(): void {
  const nav = navigator as Navigator & { modelContext?: ModelContext };
  const mc = nav.modelContext;
  if (!mc) return;

  const controller = new AbortController();
  registerSiteTools(mc, controller.signal);

  window.addEventListener(
    'pagehide',
    () => {
      controller.abort();
    },
    { once: true },
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWebMcp, { once: true });
} else {
  initWebMcp();
}
