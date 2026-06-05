// MCP server factory. Per KTD-1 of the plan (and the U1 spike): the
// McpServer MUST be instantiated per-request because createMcpHandler
// binds the server to a single transport — a module-level singleton
// throws "Server is already connected to a transport" on the second
// request. This factory builds a fresh server + handler per call.
//
// Stateless capability surface per KTD-2: no sessionIdGenerator → the
// WorkerTransport runs in stateless mode (no Mcp-Session-Id header
// returned, no resources/subscribe, no progress notifications).
//
// Response format is chosen at dispatch time per the client's Accept
// header (index.ts pickMcpFormat — lands in U4). Pass jsonResponse:true
// for a single application/json Response; jsonResponse:false lets the
// transport return an SSE stream (text/event-stream framing).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';
import { loadCatalog } from './catalog';
import { buildInstructions } from './instructions';
import { registerResources } from './resources';
import { type RegisterToolsEnv, registerTools } from './tools';

const SERVER_NAME = 'anc';
const SERVER_VERSION = '0.1.0';

export interface BuildMcpHandlerOptions {
  jsonResponse: boolean;
}

export interface McpEnv extends RegisterToolsEnv {}

export async function buildMcpHandler(
  env: McpEnv,
  opts: BuildMcpHandlerOptions = { jsonResponse: true },
): Promise<(request: Request, env: McpEnv, ctx: ExecutionContext) => Promise<Response>> {
  const catalog = await loadCatalog(env);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: buildInstructions(env),
    },
  );

  registerTools(server, catalog, env);
  registerResources(server, catalog);

  return createMcpHandler(server, { enableJsonResponse: opts.jsonResponse }) as unknown as (
    request: Request,
    env: McpEnv,
    ctx: ExecutionContext,
  ) => Promise<Response>;
}
