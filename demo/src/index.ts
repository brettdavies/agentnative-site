/**
 * Sounding — a public depth-reading JSON API used as the WebMCP challenge
 * audit patient. Humans get a page and curl. Agents get llms.txt, a
 * well-known MCP card, and CORS that already works.
 *
 * Live (broken) defaults leave two families of MUST fails for the clip:
 *   - openapi absent (service-desc points at /openapi.json; the file is missing)
 *   - mcp-initialize + mcp-tools-list broken (card discovers /mcp; handshake
 *     is incomplete)
 *
 * Tests construct a passing handler with createSoundingHandler({ complete: true }).
 * Recording-day fixes flip those surfaces in this file; do not ship `complete: true`.
 */

export type SoundingOptions = {
  /** Serve /openapi.json and complete the MCP initialize + tools/list handshake. */
  complete: boolean;
};

const RATE_LIMIT = {
  'RateLimit-Limit': '60',
  'RateLimit-Remaining': '59',
  'RateLimit-Reset': '60',
} as const;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
} as const;

const READING = { meters: 14.2, station: 'keel-1', as_of: '2026-08-27T05:00:00Z' } as const;

export function createSoundingHandler(opts: SoundingOptions = { complete: false }): ExportedHandler {
  return {
    fetch(request) {
      return handleSounding(request, opts);
    },
  };
}

export default createSoundingHandler({ complete: false });

export function soundingFetch(request: Request, opts: SoundingOptions = { complete: false }): Promise<Response> {
  return handleSounding(request, opts);
}

async function handleSounding(request: Request, opts: SoundingOptions): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS' && path === '/mcp') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (path === '/openapi.json') {
    if (!opts.complete) return jsonError(404, 'openapi_not_published');
    return json(openapiDoc(origin), 200);
  }

  if (path === '/api/reading') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'method_not_allowed');
    }
    return json(READING, 200);
  }

  if (path === '/llms.txt') {
    return text(llmsTxt(origin), 'text/plain; charset=utf-8');
  }

  if (path === '/robots.txt') {
    return text(ROBOTS, 'text/plain; charset=utf-8');
  }

  if (path === '/.well-known/mcp/server-card.json') {
    return json(serverCard(origin), 200);
  }

  if (
    path === '/.well-known/mcp' ||
    path === '/.well-known/mcp.json' ||
    path === '/mcp.json' ||
    (path === '/mcp' && request.method === 'GET' && wantsJson(request))
  ) {
    return redirect301(`${origin}/.well-known/mcp/server-card.json`);
  }

  if (path === '/mcp') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return jsonError(405, 'method_not_allowed');
    return handleMcp(request, opts.complete);
  }

  if (path === '/') {
    if (wantsMarkdown(request)) {
      return markdown(homeMarkdown(origin));
    }
    return html(homeHtml(origin), homeHeaders());
  }

  if (wantsMarkdown(request)) {
    return markdown(`# Not found\n\nNo such path. Try [llms.txt](${origin}/llms.txt).\n`, 404);
  }
  if (path === '/anc-web-audit-no-such-api' || path.startsWith('/api/')) {
    return jsonError(404, 'not_found');
  }
  return jsonError(404, 'not_found');
}

async function handleMcp(request: Request, complete: boolean): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  const msg = asRecord(body);
  const id = msg?.id ?? null;
  const method = typeof msg?.method === 'string' ? msg.method : '';

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }
  if (method === 'initialize') {
    if (!complete) {
      return jsonRpc(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    }
    return jsonRpc(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sounding', version: '0.1.0' },
    });
  }
  if (method === 'tools/list') {
    if (!complete) {
      return jsonRpc(id, { status: 'coming soon' });
    }
    return jsonRpc(id, {
      tools: [
        {
          name: 'get_reading',
          description: 'Return the current depth reading in meters.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
  }
  return jsonRpcError(id, -32601, 'Method not found');
}

function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get('Accept') ?? '';
  return /text\/markdown/i.test(accept) || /^\s*text\/plain\b/i.test(accept);
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('Accept') ?? '';
  return /application\/json/i.test(accept);
}

function homeHeaders(): HeadersInit {
  return {
    Link: '</openapi.json>; rel="service-desc", </llms.txt>; rel="alternate"; type="text/plain", </.well-known/mcp/server-card.json>; rel="describedby"',
    Vary: 'Accept, User-Agent',
  };
}

function corsHeaders(): HeadersInit {
  return { ...CORS };
}

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...RATE_LIMIT,
    },
  });
}

function jsonError(status: number, error: string): Response {
  return json({ error, status }, status);
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      ...RATE_LIMIT,
    },
  });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return new Response(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      ...RATE_LIMIT,
    },
  });
}

function text(body: string, contentType: string, extra?: HeadersInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, ...RATE_LIMIT, ...extra },
  });
}

function html(body: string, extra?: HeadersInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...homeHeaders(), ...extra },
  });
}

function markdown(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept, User-Agent',
    },
  });
}

function redirect301(location: string): Response {
  return new Response(null, { status: 301, headers: { Location: location } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serverCard(origin: string): Record<string, unknown> {
  return {
    name: 'sounding',
    description: 'Current depth reading as JSON.',
    mcp_endpoint: `${origin}/mcp`,
    serverInfo: { name: 'sounding', version: '0.1.0' },
    transport: { type: 'streamable-http', endpoint: `${origin}/mcp` },
  };
}

function openapiDoc(origin: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sounding',
      version: '0.1.0',
      description: 'Public depth-reading API. One GET, one current value.',
    },
    servers: [{ url: origin }],
    paths: {
      '/api/reading': {
        get: {
          operationId: 'getReading',
          summary: 'Current depth reading',
          responses: {
            '200': {
              description: 'The current reading',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '404': { description: 'Unknown path' },
          },
        },
      },
    },
  };
}

function llmsTxt(origin: string): string {
  return `# Sounding

> Public depth reading as JSON. One GET, current meters at keel-1.

## API

- [Current reading](${origin}/api/reading)

## Programmatic access

Use GET /api/reading for the JSON body. MCP is at ${origin}/mcp once the handshake is complete.

## When to use

Call the API when you need the current depth. Prefer /llms.txt over scraping the homepage.
`;
}

const ROBOTS = `User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

Content-Signal: ai-train=yes, search=yes, ai-input=yes
`;

function homeMarkdown(origin: string): string {
  return `---
title: Sounding
description: Public depth-reading JSON API. Agent entry points are /llms.txt, /api/reading, and the MCP server card.
url: ${origin}/
---

# Sounding

Public depth-reading JSON API. The current value is ${READING.meters} meters at ${READING.station}.

- [llms.txt](${origin}/llms.txt)
- [OpenAPI](${origin}/openapi.json)
- [MCP server card](${origin}/.well-known/mcp/server-card.json)
- [Current reading](${origin}/api/reading)
`;
}

function homeHtml(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sounding — depth as JSON</title>
  <meta name="description" content="Public depth-reading JSON API. Agent entry points: /llms.txt, /api/reading, /openapi.json, and /.well-known/mcp/server-card.json.">
  <link rel="service-desc" href="/openapi.json">
  <link rel="alternate" type="text/plain" href="/llms.txt">
  <link rel="describedby" href="/.well-known/mcp/server-card.json">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"WebAPI","name":"Sounding","description":"Public depth-reading JSON API","url":"${origin}/","documentation":"${origin}/llms.txt"}
  </script>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 18px/1.5 ui-serif, Georgia, serif; background: #f4efe6; color: #1c1914; }
    @media (prefers-color-scheme: dark) {
      body { background: #161410; color: #efe8dc; }
      a { color: #d4b896; }
    }
    main { max-width: 36rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
    h1 { font-size: 2.25rem; font-weight: 600; letter-spacing: -0.03em; margin: 0 0 0.25rem; }
    .lede { font-size: 1.05rem; margin: 0 0 2rem; }
    .reading { font-size: 4rem; font-weight: 600; letter-spacing: -0.04em; line-height: 1; margin: 0; }
    .unit { font-size: 1rem; letter-spacing: 0.08em; text-transform: uppercase; margin: 0.35rem 0 2rem; }
    a { color: #6b4a1b; }
    ul { padding-left: 1.1rem; }
    noscript { display: block; margin-top: 2rem; }
  </style>
</head>
<body>
  <main>
    <h1>Sounding</h1>
    <p class="lede">A public JSON API for a single depth reading. Humans can read this page. Agents should use the machine surfaces, not scrape the layout.</p>
    <p class="reading">${READING.meters}</p>
    <p class="unit">meters · ${READING.station}</p>
    <section>
      <p>GET <a href="/api/reading"><code>/api/reading</code></a> returns the current value. The OpenAPI description is advertised from this page and is the remaining publish step. MCP lives at <code>/mcp</code> behind the well-known card.</p>
    </section>
    <noscript>
      <p>Machine entry points:</p>
      <ul>
        <li><a href="/llms.txt">/llms.txt</a></li>
        <li><a href="/openapi.json">/openapi.json</a></li>
        <li><a href="/.well-known/mcp/server-card.json">MCP server card</a></li>
        <li><a href="/api/reading">/api/reading</a></li>
      </ul>
    </noscript>
  </main>
</body>
</html>
`;
}
