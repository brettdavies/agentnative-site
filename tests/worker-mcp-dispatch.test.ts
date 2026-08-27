// POST /mcp dispatch tests for U4 — covers detectMcpFormat, the
// MCP_ENABLED kill switch, the method gate (405 Allow:POST), the
// Accept-header gate (406 text/plain), the MCP_LIMITER -32099
// envelope, the visitor-log gate_result emission, and the response-
// shaping invariants (no Access-Control-Allow-Origin, Cache-Control:
// no-store, bypass applyHeaders).
//
// U4 lands the dispatch in src/worker/index.ts above the asset-first
// branch. Tests go through the full Worker entry so the gate ordering
// (1: MCP_ENABLED, 2: method, 3: format, 4: legacy gate, 5: limiter+log)
// is exercised end-to-end. The catalog read is stubbed via env.ASSETS in the same
// shape as tests/worker-mcp.test.ts so this file does not need a real
// dist/_internal/mcp-catalog.json on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectMcpFormat, detectMcpGetFormat } from '../src/worker/accept';
import worker, { type Env } from '../src/worker/index';
import { extractTransportErrorCode } from '../src/worker/mcp/telemetry';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import {
  legacyToolsListBatchBody,
  modernElementBatchBody,
  modernResourcesReadBody,
  modernResourcesReadHeaders,
  modernToolCallBody,
  modernToolCallBodyWithClientName,
  modernToolCallHeaders,
  modernToolsListBody,
  modernToolsListHeaders,
  toolsListBodyClaimingVersion,
  toolsListHeadersClaimingVersion,
} from './helpers/mcp-modern';
import { parseMcpHttpBody, resetMcpTestState } from './helpers/mcp-rpc';

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
  registered_tool_names: ['get_scorecard', 'list_principles', 'score_cli'],
  registered_resource_templates: ['registry', 'tool', 'principle', 'spec', 'scorecard'],
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
  protocolVersion: '2026-07-28',
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

function makeEnv(opts: { enabled?: boolean; limiter?: RateStub; legacyEnabled?: boolean } = {}): Env {
  const enabled = opts.enabled ?? true;
  return {
    ...(opts.legacyEnabled !== undefined && { MCP_LEGACY_ENABLED: opts.legacyEnabled ? 'true' : 'false' }),
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

async function readMcpJson(res: Response) {
  const raw = await res.text();
  return parseMcpHttpBody(raw, res.headers.get('content-type'));
}

function parseMcpRequestLogs(seen: Array<{ args: unknown[] }>) {
  return seen
    .map((s) => {
      if (typeof s.args[0] !== 'string') return null;
      try {
        const parsed = JSON.parse(s.args[0]) as { event?: string };
        return parsed.event === 'mcp.request' ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function captureMcpRequestLogs<T>(run: () => Promise<T>) {
  const seen: Array<{ args: unknown[] }> = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    seen.push({ args });
  };
  let result: T;
  try {
    result = await run();
  } finally {
    console.log = originalLog;
  }
  return { result, lines: parseMcpRequestLogs(seen) };
}

async function postMcp(env: Env, accept: string, body: object): Promise<Response> {
  return postMcpHeaders(env, body, { accept });
}

// `host` is defaulted rather than inherited from the URL: the Fetch API treats
// Host as a forbidden header, so a synthesized Request carries none and the
// SDK's allowlist would answer every case below with its missing-Host 403. A
// real request always carries one, so supplying it here is what makes the
// harness resemble the wire.
async function postMcpHeaders(env: Env, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', host: 'anc.dev', ...headers },
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
  resetMcpTestState();
});

afterEach(() => {
  resetMcpTestState();
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

  test('curl GET /mcp with */* serves the markdown twin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'curl/8.7.1' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/markdown');
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

  test('Accept: application/json 301s to the canonical server-card path', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'application/json');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://anc.dev/.well-known/mcp/server-card.json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toBe('Accept, User-Agent');
  });

  test('the JSON redirect targets the inbound request origin (env-aware)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('http://localhost:8788/mcp', {
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://localhost:8788/.well-known/mcp/server-card.json');
  });

  test('JSON redirect uses cacheable Cache-Control (not no-store)', async () => {
    const env = makeEnv();
    const res = await getMcp(env, 'application/json');
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('max-age=300');
    expect(cc).not.toContain('no-store');
  });

  test('JSON redirect served even when MCP_ENABLED is off (URL identity bypass)', async () => {
    const env = makeEnv({ enabled: false });
    const res = await getMcp(env, 'application/json');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://anc.dev/.well-known/mcp/server-card.json');
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

describe('GET /mcp.json — pointer alias', () => {
  test('301s to the canonical card on the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('http://localhost:8788/mcp.json', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://localhost:8788/.well-known/mcp/server-card.json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
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

  test('redirects even when MCP_ENABLED is off (descriptor bypasses kill switch)', async () => {
    const env = makeEnv({ enabled: false });
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp.json', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(301);
  });
});

describe('GET /.well-known/mcp — pointer alias', () => {
  test('301s to the canonical card on the inbound origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc-staging.dev/.well-known/mcp', { method: 'GET' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://anc-staging.dev/.well-known/mcp/server-card.json');
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
        headers: { 'content-type': 'application/json', host: 'anc.dev' },
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
    const body = (await readMcpJson(res)) as { jsonrpc: string; error?: { code: number; message: string } };
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
    expect(limiter.lastKey).toBe('legacy:198.51.100.42');
  });

  test('falls back to shared anon bucket when cf-connecting-ip is absent', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcp(env, 'application/json', initBody());
    expect(limiter.lastKey).toBe('legacy:anon');
  });

  test('absent MCP_LIMITER binding passes through to the handler', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('anc');
  });
});

describe('POST /mcp — Accept negotiation content-type', () => {
  test('Accept: application/json returns application/json (not SSE) for legacy initialize', async () => {
    // Regression: agents legacy transport requires dual Accept and defaults
    // to SSE; dispatch must coerce so smoke/clients that request JSON get JSON.
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect((res.headers.get('content-type') ?? '').toLowerCase()).not.toContain('event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    const body = (await readMcpJson(res)) as {
      result?: { serverInfo?: { name?: string }; instructions?: string };
    };
    expect(body.result?.serverInfo?.name).toBe('anc');
    expect(body.result?.instructions ?? '').toContain('2026-07-28');
  });

  test('Accept dual MIME (json wins) still returns application/json for legacy initialize', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json, text/event-stream', initBody());
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect((res.headers.get('content-type') ?? '').toLowerCase()).not.toContain('event-stream');
  });
});

describe('POST /mcp — mcp.request telemetry fires after the gate decision', () => {
  test('emits exactly one mcp.request line per request with era and outcome', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    const { lines: mcpLines } = await captureMcpRequestLogs(() => postMcp(env, 'application/json', initBody()));
    expect(mcpLines.length).toBe(1);
    const payload = mcpLines[0] as { era?: string; outcome?: string; response_format?: string; ip?: string };
    expect(payload.era).toBe('legacy');
    expect(payload.outcome).toBe('ok');
    expect(payload.response_format).toBe('json');
    expect(payload.ip).toBeUndefined();
  });

  test('log emits outcome rate_limited when the limiter denies', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: false };
    const env = makeEnv({ limiter });
    const { lines: mcpLines } = await captureMcpRequestLogs(() => postMcp(env, 'application/json', initBody()));
    expect(mcpLines.length).toBe(1);
    const payload = mcpLines[0] as { outcome?: string; error_code?: number };
    expect(payload.outcome).toBe('rate_limited');
    expect(payload.error_code).toBe(-32099);
  });
});

describe('POST /mcp — response_format records the served format', () => {
  // An Accept that ranks text/event-stream above application/json, so
  // detectMcpFormat resolves 'sse' and an intent-derived field would log 'sse'
  // on every lane below regardless of what went on the wire.
  const SSE_PREFERRING = 'application/json;q=0.5, text/event-stream;q=0.9';

  function formatOf(lines: unknown[]): string | undefined {
    return (lines[0] as { response_format?: string }).response_format;
  }

  test('the line keeps its frozen key set and order', async () => {
    // The sibling meum-sites mcp.request line is queried by the same operator
    // filter; key count, key order, and the json|sse domain are shared shape.
    const env = makeEnv();
    const { lines } = await captureMcpRequestLogs(() => postMcp(env, 'application/json', initBody()));
    expect(Object.keys(lines[0] as object)).toEqual([
      'event',
      'era',
      'method',
      'name',
      'client_name',
      'protocol_version',
      'host',
      'response_format',
      'outcome',
      'error_code',
      'ms_bucket',
    ]);
  });

  test('a modern request answering JSON logs json even when Accept prefers SSE', async () => {
    // responseMode 'auto' answers a single JSON body because no anc tool emits
    // a related message before its result; the field must follow the wire.
    const env = makeEnv();
    const { result: res, lines } = await captureMcpRequestLogs(() =>
      postMcpHeaders(env, modernToolsListBody(), { ...modernToolsListHeaders(), accept: SSE_PREFERRING }),
    );
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect((res.headers.get('content-type') ?? '').toLowerCase()).not.toContain('event-stream');
    expect(lines.length).toBe(1);
    expect(formatOf(lines)).toBe('json');
  });

  test('a genuinely streaming response logs sse', async () => {
    const env = makeEnv();
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, 'text/event-stream', initBody()));
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('text/event-stream');
    expect(await res.text()).toContain('data: ');
    expect(lines.length).toBe(1);
    expect(formatOf(lines)).toBe('sse');
  });

  test('a legacy SSE body coerced to JSON logs json, matching what the client receives', async () => {
    const env = makeEnv();
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, 'application/json', initBody()));
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(lines.length).toBe(1);
    expect(formatOf(lines)).toBe('json');
  });

  test('the MCP_ENABLED kill switch logs json even when Accept prefers SSE', async () => {
    const env = makeEnv({ enabled: false });
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, SSE_PREFERRING, initBody()));
    expect(res.status).toBe(503);
    expect(lines.length).toBe(1);
    expect(formatOf(lines)).toBe('json');
  });

  test('the Accept rejection logs json', async () => {
    const env = makeEnv();
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, 'text/csv', initBody()));
    expect(res.status).toBe(406);
    expect(lines.length).toBe(1);
    expect(formatOf(lines)).toBe('json');
  });

  test('the legacy reject logs json even when Accept prefers SSE', async () => {
    const env = makeEnv({ legacyEnabled: false });
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, SSE_PREFERRING, initBody()));
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(lines.length).toBe(1);
    expect((lines[0] as { outcome?: string }).outcome).toBe('legacy_rejected');
    expect(formatOf(lines)).toBe('json');
  });

  test('the rate-limit reject logs json even when Accept prefers SSE', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: false };
    const env = makeEnv({ limiter });
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, SSE_PREFERRING, initBody()));
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(lines.length).toBe(1);
    expect((lines[0] as { outcome?: string }).outcome).toBe('rate_limited');
    expect(formatOf(lines)).toBe('json');
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

describe('POST /mcp — Host allowlist', () => {
  async function postFrom(env: Env, url: string, host: string): Promise<Response> {
    return worker.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', host },
        body: JSON.stringify(initBody()),
      }),
      env,
      {} as ExecutionContext,
    );
  }

  test('a rebinding Host is rejected 403 with -32000 and no access-control headers', async () => {
    const env = makeEnv();
    const { result: res, lines } = await captureMcpRequestLogs(() =>
      postFrom(env, 'https://anc.dev/mcp', 'evil.example'),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { jsonrpc?: string; error?: { code?: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
    for (const [name] of res.headers) expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
    expect(lines.length).toBe(1);
    const line = lines[0] as { outcome?: string; error_code?: number };
    expect(line.outcome).toBe('error');
    expect(line.error_code).toBe(-32000);
  });

  test('a Host carrying a port matches the bare allowlist entry', async () => {
    // The SDK compares hostnames with the port stripped. Local dev, the
    // Playwright webServer, and the local preflight script all bind a port,
    // so a port-sensitive list would lock every one of them out.
    const env = makeEnv();
    const res = await postFrom(env, 'http://localhost:8787/mcp', 'localhost:8787');
    expect(res.status).toBe(200);
  });

  test('the production and staging hosts are served', async () => {
    const env = makeEnv();
    for (const [url, host] of [
      ['https://anc.dev/mcp', 'anc.dev'],
      [
        'https://agentnative-site-staging.brettdavies.workers.dev/mcp',
        'agentnative-site-staging.brettdavies.workers.dev',
      ],
    ] as const) {
      const res = await postFrom(env, url, host);
      expect(`${host}:${res.status}`).toBe(`${host}:200`);
    }
  });

  test('a browser Origin is rejected with the same -32000 the Host gate uses', async () => {
    // `allowedOriginHostnames` is left unset, which is a localhost-only Origin
    // gate rather than no Origin checking. It shares the transport code with
    // the Host rejection, so telemetry alone cannot tell the two apart.
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          host: 'anc.dev',
          origin: 'https://evil.example',
        },
        body: JSON.stringify(initBody()),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });
});

describe('extractTransportErrorCode', () => {
  test('reads a JSON-RPC code out of a non-200 body', async () => {
    const res = Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid Host' }, id: null },
      {
        status: 403,
      },
    );
    expect(await extractTransportErrorCode(res)).toBe(-32000);
  });

  test('a non-JSON 500 has no code', async () => {
    const res = new Response('upstream exploded', { status: 500 });
    expect(await extractTransportErrorCode(res)).toBeNull();
  });

  test('a body over the 4 KB cap is not parsed', async () => {
    const res = Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'x'.repeat(4096) }, id: null },
      { status: 403 },
    );
    expect(await extractTransportErrorCode(res)).toBeNull();
  });

  test('the body survives extraction for the response the client receives', async () => {
    const res = Response.json({ jsonrpc: '2.0', error: { code: -32000 }, id: null }, { status: 403 });
    expect(await extractTransportErrorCode(res)).toBe(-32000);
    expect(await res.text()).toContain('-32000');
  });
});

describe('POST /mcp — malformed JSON-RPC body', () => {
  test('non-JSON body answers a -32700 JSON-RPC envelope at HTTP 400 with id null', async () => {
    // The agents SDK owns the JSON-RPC parse step and wraps parse
    // failures in a -32700 envelope delivered at HTTP 400; the id is
    // null because the request never parsed. Pinning the body shape,
    // not just the status range, keeps the documented contract honest.
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', host: 'anc.dev' },
        body: 'not-json{{',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: unknown;
      error?: { code?: number };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  test('malformed JSON under MCP_LEGACY_ENABLED=false still answers -32700 at 400, never the era reject', async () => {
    // Unparseable bodies classify as legacy-era by default; the sunset
    // gate requires a parsed body precisely so a corrupted request from
    // any client keeps its parse-error diagnosis instead of being told
    // to switch eras.
    const env = makeEnv({ legacyEnabled: false });
    const res = await worker.fetch(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', host: 'anc.dev' },
        body: 'not-json{{',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32700);
  });
});

describe('POST /mcp — era-aware rate keys, sunset switch, and telemetry PII posture', () => {
  test('modern tools/call with a registered Mcp-Name keys modern:{name}:anon', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcpHeaders(
      env,
      modernToolCallBody('get_scorecard', { slug: 'curl' }),
      modernToolCallHeaders('get_scorecard'),
    );
    expect(limiter.lastKey).toBe('modern:get_scorecard:anon');
  });

  test('modern tools/call keys modern:{name}:{ip} when cf-connecting-ip is present', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcpHeaders(env, modernToolCallBody('get_scorecard', { slug: 'curl' }), {
      ...modernToolCallHeaders('get_scorecard'),
      'cf-connecting-ip': '198.51.100.42',
    });
    expect(limiter.lastKey).toBe('modern:get_scorecard:198.51.100.42');
  });

  test('a spoofed Mcp-Name outside the registered names falls back to modern:{ip}', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcpHeaders(env, modernToolCallBody('not_a_real_tool', {}), modernToolCallHeaders('not_a_real_tool'));
    expect(limiter.lastKey).toBe('modern:anon');
  });

  test('modern tools/list without Mcp-Name keys modern:{ip}', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: true };
    const env = makeEnv({ limiter });
    await postMcpHeaders(env, modernToolsListBody(), modernToolsListHeaders());
    expect(limiter.lastKey).toBe('modern:anon');
  });

  test('MCP_LEGACY_ENABLED=false rejects legacy initialize with -32022 + data.supported at HTTP 200', async () => {
    const env = makeEnv({ legacyEnabled: false });
    const { result: res, lines } = await captureMcpRequestLogs(() => postMcp(env, 'application/json', initBody()));
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      id?: unknown;
      error?: { code: number; message: string; data?: { supported?: string[] } };
    };
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toEqual(['2026-07-28']);
    expect(body.error?.message ?? '').toContain('2026-07-28');
    expect(body.id).toBe(1);
    expect(lines.length).toBe(1);
    const line = lines[0] as { outcome?: string; era?: string; error_code?: number };
    expect(line.outcome).toBe('legacy_rejected');
    expect(line.era).toBe('legacy');
    expect(line.error_code).toBe(-32022);
  });

  test('the reject log carries the classified method for a legacy tools/call', async () => {
    const env = makeEnv({ legacyEnabled: false });
    const { lines } = await captureMcpRequestLogs(() =>
      postMcp(env, 'application/json', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_scorecard', arguments: { slug: 'curl' } },
      }),
    );
    expect(lines.length).toBe(1);
    const line = lines[0] as { method?: string; outcome?: string };
    expect(line.method).toBe('tools/call');
    expect(line.outcome).toBe('legacy_rejected');
  });

  test('MCP_LEGACY_ENABLED=false still serves modern tools/list', async () => {
    const env = makeEnv({ legacyEnabled: false });
    const { result: res, lines } = await captureMcpRequestLogs(() =>
      postMcpHeaders(env, modernToolsListBody(), modernToolsListHeaders()),
    );
    expect(res.status).toBe(200);
    expect(lines.length).toBe(1);
    const line = lines[0] as { era?: string; outcome?: string };
    expect(line.era).toBe('modern');
    expect(line.outcome).toBe('ok');
  });

  test('MCP_LEGACY_ENABLED=false rejects an all-legacy batch at the shell with a null id', async () => {
    const env = makeEnv({ legacyEnabled: false });
    const res = await postMcp(env, 'application/json', legacyToolsListBatchBody());
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: { code: number } };
    expect(body.error?.code).toBe(-32022);
    expect(body.id).toBeNull();
  });

  test('legacy tools/call emits one mcp.request line with no IP, no arguments, null client_name', async () => {
    const env = makeEnv();
    const { lines } = await captureMcpRequestLogs(() =>
      postMcpHeaders(
        env,
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'get_scorecard', arguments: { slug: 'ripgrep' } },
        },
        { 'cf-connecting-ip': '198.51.100.42' },
      ),
    );
    expect(lines.length).toBe(1);
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('cf-connecting-ip');
    expect(serialized).not.toContain('198.51.100.42');
    expect(serialized).not.toContain('ripgrep');
    expect((lines[0] as { client_name?: unknown }).client_name).toBeNull();
  });

  test('client_name populates from modern _meta clientInfo, truncated to 64 chars', async () => {
    const env = makeEnv();
    const { lines } = await captureMcpRequestLogs(() =>
      postMcpHeaders(
        env,
        modernToolCallBodyWithClientName('get_scorecard', { slug: 'curl' }, 'x'.repeat(80)),
        modernToolCallHeaders('get_scorecard'),
      ),
    );
    expect(lines.length).toBe(1);
    const clientName = (lines[0] as { client_name?: string }).client_name ?? '';
    expect(clientName.length).toBe(64);
    expect(clientName).toBe(`${'x'.repeat(63)}…`);
  });

  test('the rate-limit envelope keeps -32099 with the request id echoed', async () => {
    const limiter: RateStub = { calls: 0, shouldSucceed: false };
    const env = makeEnv({ limiter });
    const res = await postMcp(env, 'application/json', initBody());
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: { code: number } };
    expect(body.error?.code).toBe(-32099);
    expect(body.id).toBe(1);
  });

  test('modern resources/read with a mirroring Mcp-Name answers an unknown resource with -32602', async () => {
    // The resource handler throws a -32002-tagged error, but the wire code is
    // -32602: the SDK's era encode seam rewrites -32002 on both lanes.
    const env = makeEnv();
    const res = await postMcpHeaders(
      env,
      modernResourcesReadBody('anc://tool/does-not-exist'),
      modernResourcesReadHeaders('anc://tool/does-not-exist'),
    );
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: { code: number } };
    expect(body.error?.code).toBe(-32602);
    expect(body.id).toBe(13);
  });

  test('modern resources/read with a non-mirroring Mcp-Name is rejected -32020 at HTTP 400', async () => {
    const env = makeEnv();
    const res = await postMcpHeaders(
      env,
      modernResourcesReadBody('anc://tool/does-not-exist', 62),
      modernResourcesReadHeaders('anc://registry'),
    );
    expect(res.status).toBe(400);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: { code: number } };
    expect(body.error?.code).toBe(-32020);
    expect(body.id).toBe(62);
  });

  test('an all-legacy batch array is served by the legacy lane, not rejected', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'text/event-stream', legacyToolsListBatchBody([72, 73]));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain('"id":72');
    expect(raw).toContain('"id":73');
    expect(raw).not.toContain('-32600');
  });

  test('a JSON-negotiated batch is served at HTTP 200, coerced to the first SSE event', async () => {
    // The legacy transport streams one SSE event per batched response;
    // coerceMcpJsonResponse keeps only the first data line, so a JSON client
    // sees a single envelope rather than a JSON array.
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', legacyToolsListBatchBody([72, 73]));
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: unknown; result?: { tools?: unknown[] } };
    expect(body.error).toBeUndefined();
    expect(body.id).toBe(72);
    expect((body.result?.tools ?? []).length).toBeGreaterThan(0);
  });

  test('a batch carrying a modern-envelope element is rejected -32600', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', modernElementBatchBody());
    expect(res.status).toBe(400);
    const body = (await readMcpJson(res)) as { id?: unknown; error?: { code: number } };
    expect(body.error?.code).toBe(-32600);
    expect(body.id).toBeNull();
  });

  test('an empty batch array is rejected -32600', async () => {
    const env = makeEnv();
    const res = await postMcp(env, 'application/json', []);
    expect(res.status).toBe(400);
    const body = (await readMcpJson(res)) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32600);
  });

  test('a modern claim of an unsupported protocol version draws the SDK -32022 at HTTP 400', async () => {
    // Status split: the SDK's version reject is HTTP 400, distinct from the
    // shell's legacy reject, which stays in-band at HTTP 200.
    const env = makeEnv();
    const res = await postMcpHeaders(
      env,
      toolsListBodyClaimingVersion('2025-03-26'),
      toolsListHeadersClaimingVersion('2025-03-26'),
    );
    expect(res.status).toBe(400);
    const body = (await readMcpJson(res)) as {
      id?: unknown;
      error?: { code: number; data?: { supported?: string[]; requested?: string } };
    };
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toEqual(['2026-07-28']);
    expect(body.error?.data?.requested).toBe('2025-03-26');
    expect(body.id).toBe(14);
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
