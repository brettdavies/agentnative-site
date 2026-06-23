// POST /mcp dispatch tests for U4 — covers detectMcpFormat, the
// MCP_ENABLED kill switch, the method gate (405 Allow:POST), the
// Accept-header gate (406 text/plain), the MCP_LIMITER -32099
// envelope, the visitor-log gate_result emission, and the response-
// shaping invariants (no Access-Control-Allow-Origin, Cache-Control:
// no-store, bypass applyHeaders).
//
// U4 lands the dispatch in src/worker/index.ts above the asset-first
// branch. Tests go through the full Worker entry so the gate ordering
// (1: MCP_ENABLED, 2: method, 3: format, 4: limiter+log) is exercised
// end-to-end. The catalog read is stubbed via env.ASSETS in the same
// shape as tests/worker-mcp.test.ts so this file does not need a real
// dist/_internal/mcp-catalog.json on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectMcpFormat, detectMcpGetFormat } from '../src/worker/accept';
import worker, { type Env } from '../src/worker/index';
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const FIXTURE_CATALOG = {
  generated_at: '2026-06-05T18:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [
    {
      slug: 'curl',
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
  ],
  principles: [
    {
      n: 1,
      slug: 'non-interactive-by-default',
      title: 'P1: Non-Interactive by Default',
      body_markdown: '# P1\n\nFixture.\n',
      requirements: [],
    },
  ],
  spec_sections: [
    {
      slug: 'scoring',
      title: 'Scoring',
      level: 2,
      parent_slug: null,
      body_markdown: '# Scoring\n\nFixture.\n',
    },
  ],
};

interface RateStub {
  calls: number;
  shouldSucceed: boolean;
  lastKey?: string;
}

const FIXTURE_WELL_KNOWN_MCP = JSON.stringify({
  $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
  mcp_endpoint: 'https://anc.dev/mcp',
  version: '1.0',
  description: 'agent-native CLI standard registry: scorecards, principles, vendored spec',
  documentation: 'https://anc.dev/mcp-skill.md',
  serverInfo: { name: 'anc.dev agent-native CLI standard registry', version: '0.5.0' },
  protocolVersion: '2025-06-18',
  url: 'https://anc.dev/mcp',
  transport: { type: 'streamable-http', endpoint: 'https://anc.dev/mcp' },
  capabilities: {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  },
  authentication: { required: false, schemes: [], documentation: 'https://anc.dev/auth.md' },
});

const FIXTURE_MCP_HTML = '<!doctype html><html><body><h1>anc.dev MCP server</h1></body></html>';
const FIXTURE_MCP_MD = '# anc.dev MCP server\n\nFixture body.\n';

function makeEnv(opts: { enabled?: boolean; limiter?: RateStub } = {}): Env {
  const enabled = opts.enabled ?? true;
  return {
    ASSETS: {
      fetch(req: Request) {
        const path = new URL(req.url).pathname;
        if (path === '/_internal/mcp-catalog.json') {
          return Promise.resolve(
            new Response(JSON.stringify(FIXTURE_CATALOG), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (path === '/about') {
          return Promise.resolve(
            new Response('<html><body>about</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
          );
        }
        if (path === '/_internal/mcp-server-card.json') {
          return Promise.resolve(
            new Response(FIXTURE_WELL_KNOWN_MCP, {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            }),
          );
        }
        if (path === '/mcp') {
          // Mirrors CF Static Assets html_handling=auto-trailing-slash:
          // GET /mcp resolves to dist/mcp.html at the asset layer.
          return Promise.resolve(
            new Response(FIXTURE_MCP_HTML, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
          );
        }
        if (path === '/mcp.md') {
          return Promise.resolve(
            new Response(FIXTURE_MCP_MD, {
              status: 200,
              headers: { 'content-type': 'text/markdown; charset=utf-8' },
            }),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
    } as unknown as Fetcher,
    MCP_ENABLED: enabled ? 'true' : 'false',
    MCP_LIVE_SCORING_ENABLED: enabled ? 'true' : 'false',
    MCP_LIMITER: opts.limiter
      ? {
          async limit({ key }) {
            const stub = opts.limiter as RateStub;
            stub.calls += 1;
            stub.lastKey = key;
            return { success: stub.shouldSucceed };
          },
        }
      : undefined,
  };
}

async function postMcp(env: Env, accept: string, body: object): Promise<Response> {
  return worker.fetch(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
}

function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    },
  };
}

beforeEach(() => {
  resetCatalogCacheForTests();
});

afterEach(() => {
  resetCatalogCacheForTests();
});

describe('detectMcpFormat', () => {
  function req(accept?: string): Request {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (accept !== undefined) headers.set('accept', accept);
    return new Request('https://anc.dev/mcp', { method: 'POST', headers });
  }

  test('absent Accept defaults to json', () => {
    expect(detectMcpFormat(req(undefined))).toBe('json');
  });

  test('empty Accept defaults to json', () => {
    expect(detectMcpFormat(req(''))).toBe('json');
  });

  test('*/* defaults to json', () => {
    expect(detectMcpFormat(req('*/*'))).toBe('json');
  });

  test('application/json alone returns json', () => {
    expect(detectMcpFormat(req('application/json'))).toBe('json');
  });

  test('text/event-stream alone returns sse', () => {
    expect(detectMcpFormat(req('text/event-stream'))).toBe('sse');
  });

  test('both with no q-values returns json (json wins ties)', () => {
    expect(detectMcpFormat(req('application/json, text/event-stream'))).toBe('json');
  });

  test('higher q on sse wins', () => {
    expect(detectMcpFormat(req('application/json;q=0.5, text/event-stream;q=0.9'))).toBe('sse');
  });

  test('higher q on json wins', () => {
    expect(detectMcpFormat(req('application/json;q=0.9, text/event-stream;q=0.5'))).toBe('json');
  });

  test('neither acceptable returns false', () => {
    expect(detectMcpFormat(req('text/csv'))).toBe(false);
  });

  test('text/plain alone returns false (neither MIME)', () => {
    expect(detectMcpFormat(req('text/plain'))).toBe(false);
  });
});

describe('POST /mcp — MCP_ENABLED kill switch', () => {
  test('returns 503 with Retry-After when disabled', async () => {
    const env = makeEnv({ enabled: false });
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect((res.headers.get('content-type') ?? '').includes('text/plain')).toBe(true);
  });

  test('503 body is plain text, NOT a JSON-RPC envelope', async () => {
    const env = makeEnv({ enabled: false });
    const res = await postMcp(env, 'application/json', initBody());
    const text = await res.text();
    expect(text).not.toContain('jsonrpc');
    expect(text.toLowerCase()).toContain('disabled');
  });
});

describe('POST /mcp — method gate', () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    test(`${method} returns 405 with Allow: GET, POST`, async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://anc.dev/mcp', { method, headers: { accept: 'application/json' } }),
        env,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, POST');
    });
  }
});

describe('detectMcpGetFormat', () => {
  function req(accept?: string): Request {
    return new Request('https://anc.dev/mcp', {
      headers: accept !== undefined ? { accept } : {},
    });
  }

  test('absent Accept defaults to html', () => {
    expect(detectMcpGetFormat(req())).toBe('html');
  });

  test('empty Accept defaults to html', () => {
    expect(detectMcpGetFormat(req(''))).toBe('html');
  });

  test('*/* defaults to html', () => {
    expect(detectMcpGetFormat(req('*/*'))).toBe('html');
  });

  test('text/html alone returns html', () => {
    expect(detectMcpGetFormat(req('text/html'))).toBe('html');
  });

  test('application/json alone returns json', () => {
    expect(detectMcpGetFormat(req('application/json'))).toBe('json');
  });

  test('text/markdown alone returns markdown', () => {
    expect(detectMcpGetFormat(req('text/markdown'))).toBe('markdown');
  });

  test('html + json with no q-values returns html (html wins ties)', () => {
    expect(detectMcpGetFormat(req('text/html,application/json'))).toBe('html');
  });

  test('higher q on json wins', () => {
    expect(detectMcpGetFormat(req('text/html;q=0.5,application/json;q=1.0'))).toBe('json');
  });

  test('higher q on markdown wins', () => {
    expect(detectMcpGetFormat(req('text/html;q=0.1,text/markdown;q=1.0'))).toBe('markdown');
  });

  test('text/plain alone falls back to html', () => {
    expect(detectMcpGetFormat(req('text/plain'))).toBe('html');
  });
});

describe('GET /mcp — content-negotiated descriptor', () => {
  async function getMcp(env: Env, accept?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (accept !== undefined) headers.accept = accept;
    return worker.fetch(new Request('https://anc.dev/mcp', { method: 'GET', headers }), env, {} as ExecutionContext);
  }

  test('default (no Accept) serves dist/mcp.html via asset-first fallthrough', async () => {
    const env = makeEnv();
    const res = await getMcp(env);
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('anc.dev MCP server');
  });

  test('Accept: text/html serves dist/mcp.html', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'text/html');
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/html');
  });

  test('Accept: text/markdown rewrites to dist/mcp.md via detectPreference', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'text/markdown');
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('# anc.dev MCP server');
  });

  test('Accept: application/json returns descriptor with request-origin URLs', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'application/json');
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as {
      mcp_endpoint: string;
      documentation: string;
      transport: { type: string; endpoint: string };
    };
    // Test request URL is https://anc.dev/mcp, so the rewritten URLs
    // should also be anc.dev. Non-anc.dev origin coverage lives in the
    // env-awareness test below.
    expect(body.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(body.documentation).toBe('https://anc.dev/mcp-skill.md');
    expect(body.transport.type).toBe('streamable-http');
    expect(body.transport.endpoint).toBe('https://anc.dev/mcp');
  });

  test('JSON descriptor rewrites URLs to the inbound request origin (env-aware)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('http://localhost:8788/mcp', {
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcp_endpoint: string; documentation: string };
    expect(body.mcp_endpoint).toBe('http://localhost:8788/mcp');
    expect(body.documentation).toBe('http://localhost:8788/mcp-skill.md');
  });

  test('JSON response uses cacheable Cache-Control (not no-store)', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'application/json');
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('max-age=300');
    expect(cc).not.toContain('no-store');
  });

  test('JSON descriptor served even when MCP_ENABLED is off (URL identity bypass)', async () => {
    const env = makeEnv({ enabled: false });
    const res = await getMcp(env, 'application/json');
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    const body = (await res.json()) as { mcp_endpoint: string };
    expect(body.mcp_endpoint).toBe('https://anc.dev/mcp');
  });
});

describe('GET /mcp.md — markdown twin', () => {
  test('serves dist/mcp.md asset directly', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp.md', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('# anc.dev MCP server');
  });
});

describe('GET /mcp.json — JSON twin', () => {
  test('serves the env-aware descriptor for the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('http://localhost:8788/mcp.json', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { mcp_endpoint: string; documentation: string };
    expect(body.mcp_endpoint).toBe('http://localhost:8788/mcp');
    expect(body.documentation).toBe('http://localhost:8788/mcp-skill.md');
  });

  test('non-GET returns 405 Allow: GET', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp.json', { method: 'PUT' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('served even when MCP_ENABLED is off (descriptor bypasses kill switch)', async () => {
    const env = makeEnv({ enabled: false });
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp.json', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
  });
});

describe('GET /.well-known/mcp — env-aware intercept', () => {
  test('serves the descriptor with URLs rewritten to the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc-staging.dev/.well-known/mcp', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    const body = (await res.json()) as { mcp_endpoint: string; documentation: string };
    expect(body.mcp_endpoint).toBe('https://anc-staging.dev/mcp');
    expect(body.documentation).toBe('https://anc-staging.dev/mcp-skill.md');
  });

  test('non-GET returns 405 Allow: GET', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/.well-known/mcp', { method: 'PUT' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('POST /mcp — Accept gate', () => {
  test('text/csv returns 406 text/plain with no JSON-RPC envelope', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'text/csv', initBody());
    expect(res.status).toBe(406);
    expect((res.headers.get('content-type') ?? '').includes('text/plain')).toBe(true);
    const text = await res.text();
    expect(text).not.toContain('jsonrpc');
  });

  test('absent Accept defaults to JSON and reaches the handler', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(initBody()),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /mcp — MCP_LIMITER gate', () => {
  test('rate-limit breach returns -32099 JSON-RPC envelope at HTTP 200', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: false };
    const env = makeEnv({ limiter });
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    const body = (await res.json()) as { jsonrpc: string; error?: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32099);
    expect(body.error?.message.toLowerCase()).toContain('rate limit');
    expect(limiter.calls).toBe(1);
  });

  test('keyed on cf-connecting-ip when header is present', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'cf-connecting-ip': '198.51.100.42',
        },
        body: JSON.stringify(initBody()),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(limiter.lastKey).toBe('198.51.100.42');
  });

  test('falls back to shared anon bucket when cf-connecting-ip is absent', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcp(env, 'application/json', initBody());
    expect(limiter.lastKey).toBe('anon');
  });

  test('absent MCP_LIMITER binding passes through to the handler', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('anc');
  });
});

describe('POST /mcp — visitor log fires after the gate decision', () => {
  test('emits exactly one log line per request with the gate_result field', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    const seen: Array<{ args: unknown[] }> = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      seen.push({ args });
    };
    try {
      await postMcp(env, 'application/json', initBody());
    } finally {
      console.log = originalLog;
    }
    const mcpLines = seen.filter((s) => s.args[0] === '[mcp-call]');
    expect(mcpLines.length).toBe(1);
    const payload = mcpLines[0].args[1] as { gate_result?: string; format?: string };
    expect(payload.gate_result).toBe('passed');
    expect(payload.format).toBe('json');
  });

  test('log emits gate_result: rate_limited when the limiter denies', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: false };
    const env = makeEnv({ limiter });
    const seen: Array<{ args: unknown[] }> = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      seen.push({ args });
    };
    try {
      await postMcp(env, 'application/json', initBody());
    } finally {
      console.log = originalLog;
    }
    const mcpLines = seen.filter((s) => s.args[0] === '[mcp-call]');
    expect(mcpLines.length).toBe(1);
    const payload = mcpLines[0].args[1] as { gate_result?: string };
    expect(payload.gate_result).toBe('rate_limited');
  });
});

describe('POST /mcp — response posture', () => {
  test('response carries Cache-Control: no-store and bypasses applyHeaders', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    expect((res.headers.get('cache-control') ?? '').toLowerCase()).toContain('no-store');
    // applyHeaders adds Link: rel=alternate on asset responses; the /mcp
    // branch bypasses applyHeaders, so the header should be absent.
    expect(res.headers.get('link')).toBeNull();
  });

  test('response carries no Access-Control-Allow-Origin header (KTD-10 server-to-agent posture)', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('OPTIONS /mcp falls through to asset-first dispatch with NO Access-Control-Allow-Origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', { method: 'OPTIONS' }),
      env,
      {} as ExecutionContext,
    );
    // OPTIONS doesn't match the /mcp dispatch (which carves out methods
    // !== 'OPTIONS'); control flows past the branch into the asset-first
    // dispatch. dist/mcp.html now exists as a regular content page so
    // the asset returns it, but the response intentionally lacks the
    // Access-Control-Allow-Origin header. A browser CORS preflight
    // sees no ACAO and rejects the cross-origin POST — the deliberate
    // browser-blocked posture for the JSON-RPC surface (KTD-10 / R15).
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /mcp — malformed JSON-RPC body', () => {
  test('non-JSON body surfaces a transport-level error (SDK 400 with a parse-error body)', async () => {
    // The agents SDK owns the JSON-RPC parse step. A non-JSON body
    // surfaces as an HTTP 400 with a transport-level error body (the
    // SDK does not wrap pre-parse failures in a JSON-RPC -32700
    // envelope). This is reasonable behavior: the request never became
    // a JSON-RPC envelope, so there's no id to echo back. The test
    // pins the actual transport surface so a future SDK upgrade that
    // changes the shape (e.g., to a 200 + JSON-RPC envelope) is
    // visible.
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: 'not-json{{',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('asset-first invariant preserved', () => {
  test('GET /about still serves the asset (non-/mcp paths unchanged)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/about', { headers: { accept: 'text/html' } }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('about');
  });

  test('GET /_internal/mcp-catalog.json is 404 from the public path (interceptor)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/_internal/mcp-catalog.json', { headers: { accept: 'application/json' } }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });
});
