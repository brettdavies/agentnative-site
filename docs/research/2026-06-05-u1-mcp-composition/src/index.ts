// Disposable spike — verifies that `createMcpHandler` from `agents/mcp`
// + `McpServer` from `@modelcontextprotocol/sdk` compose cleanly with
// anc's existing Worker entrypoint shape, which re-exports
// `ContainerProxy` from `@cloudflare/sandbox` and exports `Sandbox` as
// a Durable Object class. Deleted at U2.
//
// Verification per plan U1: registers TWO tools so the load-bearing
// `ContainerProxy is undefined` runtime risk is actually exercised. A
// handshake-only spike would silently pass that check (the DO surface
// isn't touched until a real tool call invokes it).

import { getRandom } from '@cloudflare/containers';
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';
import { z } from 'zod';

export { ContainerProxy } from '@cloudflare/sandbox';

// Minimal Sandbox DO subclass — extends BaseSandbox so the CF Sandbox
// SDK's `ctx.exports.ContainerProxy` resolution path is exercised at
// first-fetch time, but overrides `fetch()` to short-circuit before any
// container exec happens. The /health path is the load-bearing probe
// the spike's `spike_do_fetch` tool calls into.
export class Sandbox extends BaseSandbox<SpikeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', source: 'spike-stub' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }
}

interface SpikeEnv {
  ASSETS: Fetcher;
  SCORE: DurableObjectNamespace;
}

const MAX_INSTANCES = 2;

function buildMcpHandler(env: SpikeEnv) {
  // KTD-1: fresh McpServer per request. A module-level singleton throws
  // "Server is already connected to a transport" on the second request.
  const server = new McpServer({ name: 'anc-u1-spike', version: '0.0.0' });

  server.tool(
    'spike_handshake',
    'No-op composition probe. Returns a literal string so initialize and tools/call are both exercised.',
    { echo: z.string().optional() },
    async ({ echo }) => ({
      content: [{ type: 'text', text: `handshake_ok:${echo ?? ''}` }],
    }),
  );

  server.tool(
    'spike_do_fetch',
    'Calls the stub Sandbox DO via getRandom against /health. The load-bearing check: a runtime ContainerProxy is undefined error fires here, not at initialize.',
    {},
    async () => {
      const stub = (await getRandom(
        env.SCORE as unknown as DurableObjectNamespace<BaseSandbox<SpikeEnv>>,
        MAX_INSTANCES,
      )) as unknown as { fetch: (req: Request) => Promise<Response> };
      const res = await stub.fetch(new Request('https://do.internal/health'));
      const body = await res.text();
      return {
        content: [{ type: 'text', text: `do_status:${res.status} body:${body}` }],
      };
    },
  );

  return createMcpHandler(server);
}

export default {
  async fetch(request: Request, env: SpikeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return buildMcpHandler(env)(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<SpikeEnv>;
