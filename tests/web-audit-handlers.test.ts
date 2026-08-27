// Probe-handler tests (plan U4). Each handler reproduces the extracted
// pass/fail/na outcomes for representative inputs, and every egress is
// routed through the SSRF-guarded fetch (verified by asserting the stub
// fetch is the only network path).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import { deriveApiProbeUrl, runApiHygiene } from '../src/worker/audit-web/handlers/api-hygiene';
import { runAuthMd } from '../src/worker/audit-web/handlers/auth-md';
import { runContentWithoutJs } from '../src/worker/audit-web/handlers/content-without-js';
import { runCorsPreflight } from '../src/worker/audit-web/handlers/cors-preflight';
import { runDnsDoh } from '../src/worker/audit-web/handlers/dns-doh';
import { runHttp } from '../src/worker/audit-web/handlers/http';
import { runLlmsTxtQuality } from '../src/worker/audit-web/handlers/llms-txt-quality';
import { runMarkdownFrontmatter } from '../src/worker/audit-web/handlers/markdown-frontmatter';
import {
  CONFORMANCE_OPS,
  MODERN_LANE_DEPENDENT_OPS,
  modernProbeBody,
  runMcp,
} from '../src/worker/audit-web/handlers/mcp';
import type { HandlerContext, McpLaneEvidence } from '../src/worker/audit-web/handlers/types';
import { runWebMcp } from '../src/worker/audit-web/handlers/webmcp';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';
import { scoreWebAudit } from '../src/worker/audit-web/score';
import type { EngineResult } from '../src/worker/audit-web/scorecard';
import worker, { type Env } from '../src/worker/index';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { isModernProbe, MODERN_PROTOCOL } from './helpers/mcp-modern';
import { resetMcpTestState } from './helpers/mcp-rpc';

function ctx(overrides: Partial<HandlerContext> & { fetchImpl: typeof fetch }): HandlerContext {
  return {
    base: 'https://example.com/',
    host: 'example.com',
    mcpEndpoint: null,
    protocolVersion: '2025-06-18',
    defaultTimeoutMs: 5000,
    fetchOptions: { fetchImpl: overrides.fetchImpl },
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function check(partial: Partial<WebCheck>): WebCheck {
  return {
    id: 'x',
    category: 'content-for-agents',
    tier: 'recommended',
    keyword: 'should',
    principle: 'P2',
    site_types: ['all'],
    antecedent: 'none',
    weight: 1,
    title: 't',
    hint: 'h',
    handler: 'http',
    with: {},
    ...partial,
  };
}

/** Lane evidence with every field defaulted, so a new field lands in one place. */
function lanes(overrides: Partial<McpLaneEvidence> = {}): McpLaneEvidence {
  return { modern: 'unknown', legacyAdvertised: [], modernAdvertised: [], ...overrides };
}

const MCP = 'https://example.com/mcp';
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rpcError = (code: number, status = 200, data?: Record<string, unknown>) =>
  json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope', ...(data !== undefined ? { data } : {}) } }, status);
const toolsResult = () => json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } });

describe('runHttp', () => {
  test('passes on a 200 /llms.txt with url + status evidence', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://example.com/llms.txt');
      return new Response('# Site\n\n- [x](https://example.com/x)', { status: 200 });
    });
    const outcome = await runHttp(
      check({ with: { path: '/llms.txt', expect: { status: [200], body_regex: '^#|\\]\\(https?://' } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].url).toBe('https://example.com/llms.txt');
    expect(outcome.evidence[0].status).toBe(200);
    expect(outcome.evidence[0].ok).toBe(true);
  });

  test('path_any passes on the second candidate', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/openapi.json')) return new Response('nope', { status: 404 });
      return new Response('{"openapi":"3.1.0"}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const outcome = await runHttp(
      check({
        with: {
          path_any: ['/openapi.json', '/openapi.yaml'],
          expect: { status: [200], body_regex: 'openapi|swagger' },
        },
      }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence.length).toBe(2);
    expect(outcome.evidence[1].ok).toBe(true);
  });

  test('a 404 on the only candidate is absent', async () => {
    const fetchImpl = stubFetch(() => new Response('missing', { status: 404 }));
    const outcome = await runHttp(
      check({ with: { path: '/robots.txt', expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('absent');
    expect(outcome.evidence[0].ok).toBe(false);
  });

  test('a 200 with a content-type mismatch is broken (present but invalid)', async () => {
    const fetchImpl = stubFetch(
      () => new Response('not json', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const outcome = await runHttp(
      check({ with: { path: '/schema.json', expect: { status: [200], content_type: 'json' } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('a 5xx where a document is expected is broken', async () => {
    const fetchImpl = stubFetch(() => new Response('oops', { status: 503 }));
    const outcome = await runHttp(
      check({ with: { path: '/llms.txt', expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('a failed affordance assertion without a status expectation is absent', async () => {
    const fetchImpl = stubFetch(() => new Response('<html><body>no meta</body></html>', { status: 200 }));
    const outcome = await runHttp(
      check({ with: { path: '/', expect: { body_regex: '<noscript' } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('absent');
  });

  test('mixed candidates: a broken candidate outranks absent ones', async () => {
    const fetchImpl = stubFetch((url) =>
      url.endsWith('/openapi.json') ? new Response('oops', { status: 500 }) : new Response('no', { status: 404 }),
    );
    const outcome = await runHttp(
      check({ with: { path_any: ['/openapi.json', '/openapi.yaml'], expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('a timeout is broken only when the check opted into an explicit hang budget', async () => {
    const timeoutFetch = (() => {
      const err = new Error('deadline exceeded');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const withBudget = await runHttp(
      check({ with: { path: '/mcp', method: 'GET', timeout: 1, expect: { status: [405] } } }),
      ctx({ fetchImpl: timeoutFetch }),
    );
    expect(withBudget.status).toBe('broken');
    const withoutBudget = await runHttp(
      check({ with: { path: '/llms.txt', expect: { status: [200] } } }),
      ctx({ fetchImpl: timeoutFetch }),
    );
    expect(withoutBudget.status).toBe('error');
  });

  test('retain_body keeps the passing body on the evidence row', async () => {
    const fetchImpl = stubFetch(() => new Response('# Site\n\n- [x](https://example.com/x)', { status: 200 }));
    const outcome = await runHttp(
      check({ with: { path: '/llms.txt', retain_body: true, expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].body).toContain('# Site');
  });

  test('mcp-get-fast-fail: a documented GET surface (fast 200) passes', async () => {
    const fetchImpl = stubFetch(() => new Response('<html>MCP docs</html>', { status: 200 }));
    const outcome = await runHttp(
      check({
        with: { path: '{mcp_endpoint}', method: 'GET', timeout: 8, expect: { status_below: 500 } },
      }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].status).toBe(200);
  });

  test('mcp-get-fast-fail: a fast-fail 405 passes', async () => {
    const fetchImpl = stubFetch(() => new Response('method not allowed', { status: 405 }));
    const outcome = await runHttp(
      check({ with: { path: '{mcp_endpoint}', method: 'GET', timeout: 8, expect: { status_below: 500 } } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
  });

  test('mcp-get-fast-fail: a 5xx on GET is broken (present but misbehaves)', async () => {
    const fetchImpl = stubFetch(() => new Response('oops', { status: 502 }));
    const outcome = await runHttp(
      check({ with: { path: '{mcp_endpoint}', method: 'GET', timeout: 8, expect: { status_below: 500 } } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('mcp-get-fast-fail: a held-open hang (timeout) is broken', async () => {
    const timeoutFetch = (() => {
      const err = new Error('deadline exceeded');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const outcome = await runHttp(
      check({ with: { path: '{mcp_endpoint}', method: 'GET', timeout: 8, expect: { status_below: 500 } } }),
      ctx({ fetchImpl: timeoutFetch, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('substitutes {mcp_endpoint} in the path', async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((url) => {
      seen.push(url);
      return new Response('', { status: 405 });
    });
    const outcome = await runHttp(
      check({ with: { path: '{mcp_endpoint}', method: 'GET', expect: { status: [405, 400, 404, 406] } } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(seen).toEqual(['https://example.com/mcp']);
    expect(outcome.status).toBe('pass');
  });

  test('honors an absolute path_any URL without rejoining the base', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://cdn.example.com/schema.json');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const outcome = await runHttp(
      check({ with: { path_any: ['https://cdn.example.com/schema.json'], expect: { status: [200] } } }),
      ctx({ fetchImpl }),
    );
    expect(outcome.status).toBe('pass');
  });
});

describe('runCorsPreflight posture pair', () => {
  const RPC_TOOLS = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } });

  function corsCheck(surface: 'preflight' | 'actual'): WebCheck {
    return check({
      id: surface === 'preflight' ? 'mcp-cors-preflight' : 'mcp-cors-actual',
      handler: 'cors-preflight',
      with: {
        path: '{mcp_endpoint}',
        origin: 'https://example.com',
        request_method: 'POST',
        request_headers: 'content-type',
        surface,
      },
    });
  }

  function pairFetch(preflight: () => Response, post: () => Response): typeof fetch {
    return stubFetch((_url, init) => (init?.method === 'OPTIONS' ? preflight() : post()));
  }

  const preflightBare =
    (status = 204) =>
    () =>
      new Response(status === 204 ? null : 'x', { status });
  const preflightAcao =
    (status = 204) =>
    () =>
      new Response(status === 204 ? null : 'x', {
        status,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
  const postBare = () => () =>
    new Response(RPC_TOOLS, { status: 200, headers: { 'content-type': 'application/json' } });
  const postAcao = () => () =>
    new Response(RPC_TOOLS, {
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });

  async function classify(surface: 'preflight' | 'actual', fetchImpl: typeof fetch) {
    return runCorsPreflight(corsCheck(surface), ctx({ fetchImpl, mcpEndpoint: MCP }));
  }

  test('no ACAO on OPTIONS or POST is a consistent no-CORS posture: both ids n_a (AE4)', async () => {
    const fetchImpl = pairFetch(preflightBare(), postBare());
    const pre = await classify('preflight', fetchImpl);
    const act = await classify('actual', fetchImpl);
    expect(pre.status).toBe('na');
    expect(pre.na_reason).toBe('posture-consistent');
    expect(act.status).toBe('na');
    expect(act.na_reason).toBe('posture-consistent');
  });

  test('a bare 405 preflight beside a bare POST still reads posture-consistent (anc-shaped surface)', async () => {
    const fetchImpl = pairFetch(preflightBare(405), postBare());
    const pre = await classify('preflight', fetchImpl);
    const act = await classify('actual', fetchImpl);
    expect(pre.status).toBe('na');
    expect(pre.na_reason).toBe('posture-consistent');
    expect(act.status).toBe('na');
    expect(act.na_reason).toBe('posture-consistent');
  });

  test('the n_a pair leaves the relative score unchanged (AE4)', () => {
    const others: Array<Pick<EngineResult, 'keyword' | 'status'>> = [
      { keyword: 'must', status: 'pass' },
      { keyword: 'should', status: 'pass' },
      { keyword: 'should', status: 'absent' },
    ];
    const pair: Array<Pick<EngineResult, 'keyword' | 'status'>> = [
      { keyword: 'should', status: 'n_a' },
      { keyword: 'should', status: 'n_a' },
    ];
    expect(scoreWebAudit([...others, ...pair], 100)).toEqual(scoreWebAudit(others, 100));
  });

  test('full CORS passes both ids', async () => {
    const fetchImpl = pairFetch(preflightAcao(), postAcao());
    const pre = await classify('preflight', fetchImpl);
    const act = await classify('actual', fetchImpl);
    expect(pre.status).toBe('pass');
    expect(act.status).toBe('pass');
    expect(pre.evidence.map((e) => e.probe)).toEqual(['preflight', 'post']);
    expect(act.evidence.map((e) => e.probe)).toEqual(['post', 'preflight']);
    expect(pre.evidence[0].allow_origin).toBe('*');
    expect(pre.evidence[0].allow_methods).toBe('POST, OPTIONS');
    expect(act.evidence[0].allow_origin).toBe('*');
  });

  test('preflight declares CORS but the POST is bare: actual broken, preflight pass', async () => {
    const fetchImpl = pairFetch(preflightAcao(), postBare());
    expect((await classify('preflight', fetchImpl)).status).toBe('pass');
    expect((await classify('actual', fetchImpl)).status).toBe('broken');
  });

  test('POST carries ACAO but the preflight is bare: preflight broken, actual pass', async () => {
    const fetchImpl = pairFetch(preflightBare(), postAcao());
    expect((await classify('preflight', fetchImpl)).status).toBe('broken');
    expect((await classify('actual', fetchImpl)).status).toBe('pass');
  });

  test('ACAO on a failing preflight: preflight broken, actual classifies from its own POST probe', async () => {
    const withPost = pairFetch(preflightAcao(500), postAcao());
    expect((await classify('preflight', withPost)).status).toBe('broken');
    expect((await classify('actual', withPost)).status).toBe('pass');
    const withBarePost = pairFetch(preflightAcao(500), postBare());
    expect((await classify('preflight', withBarePost)).status).toBe('broken');
    const act = await classify('actual', withBarePost);
    expect(act.status).toBe('broken');
    expect(act.na_reason).toBeUndefined();
  });

  const failingProbe = (): Response => {
    throw new Error('connect timeout');
  };

  test('a transport failure suppresses only the id whose own probe failed', async () => {
    const preflightDown = pairFetch(failingProbe, postAcao());
    expect((await classify('preflight', preflightDown)).status).toBe('error');
    expect((await classify('actual', preflightDown)).status).toBe('pass');

    const postDown = pairFetch(preflightAcao(), failingProbe);
    expect((await classify('preflight', postDown)).status).toBe('pass');
    expect((await classify('actual', postDown)).status).toBe('error');
  });

  test('a no-CORS surface whose sibling probe failed is error, not a declared posture', async () => {
    const preflightDown = pairFetch(failingProbe, postBare());
    const act = await classify('actual', preflightDown);
    expect(act.status).toBe('error');
    expect(act.na_reason).toBeUndefined();

    const postDown = pairFetch(preflightBare(), failingProbe);
    const pre = await classify('preflight', postDown);
    expect(pre.status).toBe('error');
    expect(pre.na_reason).toBeUndefined();
  });

  test('one run issues exactly the OPTIONS preflight and the Origin-bearing POST', async () => {
    const captured: Array<{ method: string; headers: Headers; body: string | null }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body ? String(init.body) : null,
      });
      return init?.method === 'OPTIONS'
        ? new Response(null, { status: 204 })
        : new Response(RPC_TOOLS, { status: 200 });
    });
    await runCorsPreflight(corsCheck('preflight'), ctx({ fetchImpl, mcpEndpoint: MCP, mcpSessionId: 'sess-1' }));
    expect(captured.length).toBe(2);
    const opts = captured.find((r) => r.method === 'OPTIONS');
    const post = captured.find((r) => r.method === 'POST');
    expect(opts?.headers.get('origin')).toBe('https://example.com');
    expect(opts?.headers.get('access-control-request-method')).toBe('POST');
    expect(opts?.headers.get('access-control-request-headers')).toBe('content-type');
    expect(post?.headers.get('origin')).toBe('https://example.com');
    expect(post?.headers.get('content-type')).toBe('application/json');
    expect(post?.headers.get('mcp-session-id')).toBe('sess-1');
    expect(JSON.parse(post?.body ?? '{}').method).toBe('tools/list');
  });

  test('returns a reasonless n_a when the path has no endpoint to resolve, probing nothing', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    const outcome = await runCorsPreflight(
      check({ handler: 'cors-preflight', with: { path: '{mcp_endpoint}', surface: 'preflight' } }),
      ctx({ fetchImpl, mcpEndpoint: null }),
    );
    expect(outcome.status).toBe('na');
    expect(outcome.na_reason).toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('runMcp', () => {
  test('initialize passes and records serverInfo / protocolVersion / capabilities', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('initialize');
      expect(body.params.protocolVersion).toBe('2025-06-18');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            serverInfo: { name: 'anc', version: '0.1.0' },
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {} },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].serverInfo).toEqual({ name: 'anc', version: '0.1.0' });
    expect(outcome.evidence[0].protocolVersion).toBe('2025-06-18');
    expect(outcome.evidence[0].capabilities).toEqual(['tools', 'resources']);
    expect(outcome.evidence[0].session_id).toBeNull();
  });

  test('initialize records Mcp-Session-Id when the server issues one', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { serverInfo: { name: 'anc' }, capabilities: { tools: {} } },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } },
        ),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].session_id).toBe('sess-1');
  });

  test('capabilities assertion is broken on an empty capabilities object', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'anc' }, capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize', assert: 'capabilities' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('tools-list parses an SSE (text/event-stream) response and counts input schemas', async () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{}},{"name":"b"}]}}\n\n';
    const fetchImpl = stubFetch(
      () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].tools).toEqual(['a', 'b']);
    expect(outcome.evidence[0].with_input_schema).toBe(1);
  });

  test('error op passes when the error code matches expect_code', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'error', method: 'nonexistent/method', expect_code: -32601 } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].error_code).toBe(-32601);
  });

  test('returns n_a when no endpoint was discovered', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: null }),
    );
    expect(outcome.status).toBe('na');
    expect(called).toBe(0);
  });

  test('a discovered endpoint with no parseable JSON-RPC is broken', async () => {
    const fetchImpl = stubFetch(() => new Response('<html>error</html>', { status: 500 }));
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('broken');
  });

  test('captures the WWW-Authenticate challenge for the mcp-auth antecedent', async () => {
    const fetchImpl = stubFetch(
      () => new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer realm="mcp"' } }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('broken');
    expect(outcome.evidence[0].status).toBe(401);
    expect(outcome.evidence[0].www_authenticate).toBe('Bearer realm="mcp"');
  });

  test('resources-list passes on a non-empty resources array and is broken when empty', async () => {
    const nonempty = stubFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resources: [{ uri: 'anc://registry' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const pass = await runMcp(
      check({ handler: 'mcp', with: { op: 'resources-list' } }),
      ctx({ fetchImpl: nonempty, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(pass.status).toBe('pass');
    expect(pass.evidence[0].resources).toEqual(['anc://registry']);
    const empty = stubFetch(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resources: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const miss = await runMcp(
      check({ handler: 'mcp', with: { op: 'resources-list' } }),
      ctx({ fetchImpl: empty, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(miss.status).toBe('broken');
  });

  test('resources-list sends Mcp-Session-Id when the context carries a session', async () => {
    const seen: Array<{ method: string; session: string | null }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      seen.push({ method: body.method, session: headers.get('mcp-session-id') });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resources: [{ uri: 'anc://x' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'resources-list' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp', mcpSessionId: 'sess-1' }),
    );
    expect(outcome.status).toBe('pass');
    expect(seen).toEqual([{ method: 'resources/list', session: 'sess-1' }]);
  });
});

describe('runMcp modern era', () => {
  test('modern-only server: initialize maps to absent, header-routed tools/list passes (AE3)', async () => {
    for (const rejectCode of [-32022, -32601]) {
      const fetchImpl = stubFetch((_url, init) => (isModernProbe(init) ? toolsResult() : rpcError(rejectCode)));
      const legacy = await runMcp(
        check({ handler: 'mcp', with: { op: 'initialize' } }),
        ctx({ fetchImpl, mcpEndpoint: MCP }),
      );
      expect(legacy.status).toBe('absent');
      expect(legacy.evidence[0].error_code).toBe(rejectCode);
      const modern = await runMcp(
        check({ handler: 'mcp', with: { op: 'modern-tools-list' } }),
        ctx({ fetchImpl, mcpEndpoint: MCP }),
      );
      expect(modern.status).toBe('pass');
      expect(modern.evidence[0].tools).toEqual(['a']);
      expect(modern.evidence[0].with_input_schema).toBe(1);
    }
  });

  test('legacy-only server: modern probe maps to absent, legacy checks still pass', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      if (isModernProbe(init)) return rpcError(-32601);
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return json({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'anc' }, protocolVersion: '2025-06-18', capabilities: { tools: {} } },
        });
      }
      return toolsResult();
    });
    const modern = await runMcp(
      check({ handler: 'mcp', with: { op: 'modern-tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(modern.status).toBe('absent');
    expect(modern.evidence[0].error_code).toBe(-32601);
    const init = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(init.status).toBe('pass');
    const tools = await runMcp(
      check({ handler: 'mcp', with: { op: 'tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(tools.status).toBe('pass');
  });

  test('dual-stack server: both lanes pass', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      if (isModernProbe(init)) return toolsResult();
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'anc' }, protocolVersion: '2025-06-18' } });
      }
      return toolsResult();
    });
    const legacy = await runMcp(
      check({ handler: 'mcp', with: { op: 'initialize' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    const modern = await runMcp(
      check({ handler: 'mcp', with: { op: 'modern-tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(legacy.status).toBe('pass');
    expect(modern.status).toBe('pass');
  });

  test('modern tools/list probe sends the SEP-2243 wire shape with no initialize and no session attach', async () => {
    const captured: Array<{
      headers: Headers;
      body: { method: string; params?: { _meta?: Record<string, unknown> } };
    }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return toolsResult();
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'modern-tools-list' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP, mcpSessionId: 'sess-1' }),
    );
    expect(outcome.status).toBe('pass');
    expect(captured.length).toBe(1);
    const req = captured[0];
    expect(req.body.method).toBe('tools/list');
    expect(req.headers.get('mcp-protocol-version')).toBe(MODERN_PROTOCOL);
    expect(req.headers.get('mcp-method')).toBe('tools/list');
    expect(req.headers.get('mcp-session-id')).toBeNull();
    expect(req.headers.get('mcp-name')).toBeNull();
    const meta = req.body.params?._meta ?? {};
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(MODERN_PROTOCOL);
    expect((meta['io.modelcontextprotocol/clientInfo'] as { name?: string }).name).toBeTruthy();
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
  });

  test('server/discover probe sends Mcp-Method server/discover, no Mcp-Name, no session attach', async () => {
    const captured: Array<{
      headers: Headers;
      body: { method: string; params?: { _meta?: Record<string, unknown> } };
    }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          supportedVersions: [MODERN_PROTOCOL],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'anc', version: '0.1.0' } },
        },
      });
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP, mcpSessionId: 'sess-1' }),
    );
    expect(outcome.status).toBe('pass');
    expect(captured.length).toBe(1);
    const req = captured[0];
    expect(req.body.method).toBe('server/discover');
    expect(req.headers.get('mcp-method')).toBe('server/discover');
    expect(req.headers.get('mcp-name')).toBeNull();
    expect(req.headers.get('mcp-session-id')).toBeNull();
    expect(req.body.params?._meta?.['io.modelcontextprotocol/clientCapabilities']).toEqual({});
  });

  test('server/discover passes on a well-formed result with server identity and records evidence', async () => {
    const fetchImpl = stubFetch(() =>
      json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          supportedVersions: [MODERN_PROTOCOL],
          capabilities: { tools: { listChanged: true } },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'anc', version: '0.1.0' } },
        },
      }),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].supported_versions).toEqual([MODERN_PROTOCOL]);
    expect(outcome.evidence[0].serverInfo).toEqual({ name: 'anc', version: '0.1.0' });
  });

  test('server/discover maps a JSON-RPC unavailability error to absent', async () => {
    const fetchImpl = stubFetch(() => rpcError(-32601));
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(outcome.status).toBe('absent');
  });

  test('server/discover is broken on a well-formed result without supportedVersions or identity', async () => {
    const noVersions = stubFetch(() =>
      json({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'anc' } } },
      }),
    );
    const noIdentity = stubFetch(() =>
      json({ jsonrpc: '2.0', id: 1, result: { supportedVersions: [MODERN_PROTOCOL], capabilities: {} } }),
    );
    const missingVersions = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl: noVersions, mcpEndpoint: MCP }),
    );
    const missingIdentity = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl: noIdentity, mcpEndpoint: MCP }),
    );
    expect(missingVersions.status).toBe('broken');
    expect(missingIdentity.status).toBe('broken');
  });

  test('a non-unavailability error code stays broken on either era probe', async () => {
    const fetchImpl = stubFetch(() => rpcError(-32603));
    for (const op of ['initialize', 'tools-list', 'modern-tools-list', 'server-discover']) {
      const outcome = await runMcp(check({ handler: 'mcp', with: { op } }), ctx({ fetchImpl, mcpEndpoint: MCP }));
      expect(outcome.status).toBe('broken');
      expect(outcome.evidence[0].error_code).toBe(-32603);
    }
  });

  test('a garbage non-JSON response stays broken on either era probe', async () => {
    const fetchImpl = stubFetch(() => new Response('<html>oops</html>', { status: 200 }));
    for (const op of ['initialize', 'modern-tools-list', 'server-discover']) {
      const outcome = await runMcp(check({ handler: 'mcp', with: { op } }), ctx({ fetchImpl, mcpEndpoint: MCP }));
      expect(outcome.status).toBe('broken');
    }
  });

  test('the unknown-method error op keeps its expectation semantics under the era mapping', async () => {
    const fetchImpl = stubFetch(() => rpcError(-32601));
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'error', method: 'nonexistent/method', expect_code: -32601 } }),
      ctx({ fetchImpl, mcpEndpoint: MCP }),
    );
    expect(outcome.status).toBe('pass');
  });

  test('modern ops return n_a when no endpoint was discovered', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    for (const op of ['modern-tools-list', 'server-discover']) {
      const outcome = await runMcp(check({ handler: 'mcp', with: { op } }), ctx({ fetchImpl, mcpEndpoint: null }));
      expect(outcome.status).toBe('na');
    }
    expect(called).toBe(0);
  });

  test('server/discover records the advertised capability groups as evidence', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              supportedVersions: [MODERN_PROTOCOL],
              capabilities: { tools: {}, resources: {} },
              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'anc', version: '0.1.0' } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl, mcpEndpoint: 'https://example.com/mcp' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].capabilities).toEqual(['tools', 'resources']);
  });
});

describe('runMcp era-lane classification', () => {
  const run = (w: Record<string, unknown>, fetchImpl: typeof fetch, lanes?: HandlerContext['mcpLanes']) =>
    runMcp(check({ handler: 'mcp', with: w }), ctx({ fetchImpl, mcpEndpoint: MCP, mcpLanes: lanes }));

  test('an era probe reads an unavailability code as an absent lane', async () => {
    for (const code of [-32601, -32022]) {
      for (const op of ['initialize', 'tools-list', 'modern-tools-list', 'server-discover']) {
        const outcome = await run(
          { op },
          stubFetch(() => rpcError(code)),
        );
        expect(`${op}/${code}:${outcome.status}`).toBe(`${op}/${code}:absent`);
        expect(outcome.evidence[0].error_code).toBe(code);
      }
    }
  });

  test('the unknown-method probe is an era probe: expected code passes, sunset code is absent', async () => {
    const w = { op: 'error', method: 'nonexistent/method', expect_code: -32601 };
    const expected = await run(
      w,
      stubFetch(() => rpcError(-32601)),
    );
    expect(expected.status).toBe('pass');
    const sunset = await run(
      w,
      stubFetch(() => rpcError(-32022, 400)),
    );
    expect(sunset.status).toBe('absent');
    expect(sunset.evidence[0].error_code).toBe(-32022);
    // The row asks for a refusal and got one under the wrong code, which
    // an agent can act on, so it is a taxonomy defect and not a trap.
    const other = await run(
      w,
      stubFetch(() => rpcError(-32603)),
    );
    expect(other.status).toBe('noncompliant');
    expect(other.evidence[0].why).toEqual(['expected error code -32601, got -32603']);
  });

  test('the unknown-method probe answered with a result is broken, not noncompliant', async () => {
    // A result to a method that does not exist tells the caller the call
    // succeeded, which is the harm `broken` prices.
    const outcome = await run(
      { op: 'error', method: 'nonexistent/method', expect_code: -32601 },
      stubFetch(() => json({ jsonrpc: '2.0', id: 1, result: {} })),
    );
    expect(outcome.status).toBe('broken');
  });

  test('a sunset legacy lane reports one status across every one of its era probes', async () => {
    const sunset = stubFetch(() => rpcError(-32022, 400));
    for (const w of [
      { op: 'initialize' },
      { op: 'tools-list' },
      { op: 'error', method: 'nonexistent/method', expect_code: -32601 },
    ]) {
      expect(`${String(w.op)}:${(await run(w, sunset)).status}`).toBe(`${String(w.op)}:absent`);
    }
  });

  test('resources-list is broken on -32601 once the legacy lane advertised resources', async () => {
    const refuses = stubFetch(() => rpcError(-32601));
    const advertised = await run({ op: 'resources-list' }, refuses, lanes({ legacyAdvertised: ['resources'] }));
    expect(advertised.status).toBe('broken');
    expect(advertised.evidence[0].error_code).toBe(-32601);
    const notAdvertised = await run({ op: 'resources-list' }, refuses, lanes());
    expect(notAdvertised.status).toBe('absent');
  });

  test('server/discover reads every legacy-only refusal as an absent modern lane', async () => {
    const refusals: Array<[string, () => Response]> = [
      ['session-required at 400', () => rpcError(-32000, 400)],
      ['session-required at 200', () => rpcError(-32000)],
      ['bare 400', () => new Response('Bad Request', { status: 400 })],
      ['bare 415', () => new Response(null, { status: 415 })],
      ['400 carrying a framework JSON body', () => json({ detail: 'unsupported protocol version' }, 400)],
    ];
    for (const [label, response] of refusals) {
      const outcome = await run({ op: 'server-discover' }, stubFetch(response));
      expect(`${label}:${outcome.status}`).toBe(`${label}:absent`);
      expect(`${label}:${(outcome.evidence[0].why as string[])[0]}`).toContain('no modern lane');
    }
  });

  test('a session-required code is an era signal only at a status that can carry one', async () => {
    // -32000 is JSON-RPC's reserved generic server error, so a target
    // under load or shedding requests can answer with it while serving
    // the modern lane perfectly.
    const notEraSignals: Array<[string, () => Response]> = [
      ['500', () => rpcError(-32000, 500)],
      ['502', () => rpcError(-32000, 502)],
      ['503', () => rpcError(-32000, 503)],
      ['429', () => rpcError(-32000, 429)],
      ['408', () => rpcError(-32000, 408)],
    ];
    for (const [label, response] of notEraSignals) {
      const outcome = await run({ op: 'server-discover' }, stubFetch(response));
      expect(`-32000 at ${label}:${outcome.status}`).toBe(`-32000 at ${label}:broken`);
    }
    for (const status of [200, 400, 401, 415]) {
      const outcome = await run(
        { op: 'server-discover' },
        stubFetch(() => rpcError(-32000, status)),
      );
      expect(`-32000 at ${status}:${outcome.status}`).toBe(`-32000 at ${status}:absent`);
    }
  });

  test('modern-tools-list is broken on -32601 once server/discover advertised tools', async () => {
    const refuses = stubFetch(() => rpcError(-32601));
    const advertised = await run({ op: 'modern-tools-list' }, refuses, {
      modern: 'present',
      legacyAdvertised: [],
      modernAdvertised: ['tools'],
    });
    expect(advertised.status).toBe('broken');
    expect(advertised.evidence[0].error_code).toBe(-32601);
    const notAdvertised = await run({ op: 'modern-tools-list' }, refuses, lanes({ modern: 'present' }));
    expect(notAdvertised.status).toBe('absent');
  });

  test('tools-list is broken on -32601 once the legacy lane advertised tools', async () => {
    const refuses = stubFetch(() => rpcError(-32601));
    const advertised = await run({ op: 'tools-list' }, refuses, lanes({ legacyAdvertised: ['tools'] }));
    expect(advertised.status).toBe('broken');
    const notAdvertised = await run({ op: 'tools-list' }, refuses, lanes());
    expect(notAdvertised.status).toBe('absent');
  });

  test("an advertisement on one lane never reaches the other lane's row", async () => {
    // A modern-only server advertising tools must not be charged broken
    // for a legacy tools/list it never claimed, and the mirror case.
    const refuses = stubFetch(() => rpcError(-32601));
    const modernOnly = await run({ op: 'tools-list' }, refuses, {
      modern: 'present',
      legacyAdvertised: [],
      modernAdvertised: ['tools'],
    });
    expect(modernOnly.status).toBe('absent');
    const legacyOnly = await run({ op: 'modern-tools-list' }, refuses, {
      modern: 'present',
      legacyAdvertised: ['tools'],
      modernAdvertised: [],
    });
    expect(legacyOnly.status).toBe('absent');
  });

  test('server/discover stays broken when the server tried to serve the method and failed', async () => {
    const faults: Array<[string, () => Response]> = [
      ['internal error', () => rpcError(-32603)],
      ['internal error at 500', () => rpcError(-32603, 500)],
      // The only case that separates judging the code first from judging
      // the status first: a non-unavailability code riding a status the
      // envelope-free arm would accept as a typed refusal.
      ['internal error at 400', () => rpcError(-32603, 400)],
      ['invalid params at 415', () => rpcError(-32602, 415)],
      ['bare 500', () => new Response('boom', { status: 500 })],
      ['bare 503', () => new Response('unavailable', { status: 503 })],
      ['200 with garbage', () => new Response('<html>oops</html>', { status: 200 })],
      ['200 result missing supportedVersions', () => json({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } })],
      ['bare 404', () => new Response('not found', { status: 404 })],
    ];
    for (const [label, response] of faults) {
      const outcome = await run({ op: 'server-discover' }, stubFetch(response));
      expect(`${label}:${outcome.status}`).toBe(`${label}:broken`);
    }
  });

  test('the widened discover signals reach no other era probe', async () => {
    const answers: Array<[string, () => Response]> = [
      ['session-required', () => rpcError(-32000, 400)],
      ['bare 400', () => new Response('Bad Request', { status: 400 })],
    ];
    for (const [label, response] of answers) {
      for (const op of ['initialize', 'tools-list', 'resources-list', 'modern-tools-list']) {
        const outcome = await run({ op }, stubFetch(response));
        expect(`${op}/${label}:${outcome.status}`).toBe(`${op}/${label}:broken`);
      }
    }
  });

  test('resources-list stays broken on a non-unavailability code either way', async () => {
    const fails = stubFetch(() => rpcError(-32603));
    for (const advertised of [['resources'], []]) {
      const outcome = await run({ op: 'resources-list' }, fails, lanes({ legacyAdvertised: advertised }));
      const label = advertised.length > 0 ? 'advertised' : 'not advertised';
      expect(`${label}:${outcome.status}`).toBe(`${label}:broken`);
    }
  });
});

describe('runMcp modern-lane gate', () => {
  const MODERN_DEPENDENT = [...MODERN_LANE_DEPENDENT_OPS];

  test('an unevidenced modern lane settles every dependent row absent and unprobed', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls++;
      return toolsResult();
    });
    for (const op of MODERN_DEPENDENT) {
      const outcome = await runMcp(
        check({ handler: 'mcp', with: { op } }),
        ctx({ fetchImpl, mcpEndpoint: MCP, mcpLanes: lanes({ modern: 'unevidenced' }) }),
      );
      expect(`${op}:${outcome.status}`).toBe(`${op}:absent`);
      // The unprobed marker is what keeps the six remediation prompts for
      // a lane no request reached off the scorecard.
      expect(`${op}:${String(outcome.unprobed)}`).toBe(`${op}:true`);
      expect(outcome.evidence[0].why).toEqual(['no modern lane: server/discover returned no result']);
    }
    expect(calls).toBe(0);
  });

  test('server/discover itself is never gated on its own answer', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls++;
      return rpcError(-32601);
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'server-discover' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP, mcpLanes: lanes({ modern: 'unevidenced' }) }),
    );
    expect(outcome.status).toBe('absent');
    expect(calls).toBe(1);
  });

  test('a present or unresolved lane probes normally', async () => {
    for (const modern of ['present', 'unknown'] as const) {
      let calls = 0;
      const fetchImpl = stubFetch(() => {
        calls++;
        return toolsResult();
      });
      const outcome = await runMcp(
        check({ handler: 'mcp', with: { op: 'modern-tools-list' } }),
        ctx({ fetchImpl, mcpEndpoint: MCP, mcpLanes: lanes({ modern }) }),
      );
      expect(`${modern}:${outcome.status}`).toBe(`${modern}:pass`);
      expect(`${modern}:${calls}`).toBe(`${modern}:1`);
    }
  });
});

describe('runMcp error-code conformance', () => {
  const run = (w: Record<string, unknown>, fetchImpl: typeof fetch, sessionId?: string) =>
    runMcp(check({ handler: 'mcp', with: w }), ctx({ fetchImpl, mcpEndpoint: MCP, mcpSessionId: sessionId ?? null }));

  test('each probe passes against a conforming stub (nine cases incl. legacy unknown-method)', async () => {
    const cases: Array<{ w: Record<string, unknown>; response: () => Response; code: number }> = [
      {
        w: { op: 'error', method: 'nonexistent/method', expect_code: -32601 },
        response: () => rpcError(-32601),
        code: -32601,
      },
      { w: { op: 'malformed-body' }, response: () => rpcError(-32700, 400), code: -32700 },
      { w: { op: 'batch-reject' }, response: () => rpcError(-32600, 400), code: -32600 },
      { w: { op: 'unknown-tool' }, response: () => rpcError(-32602), code: -32602 },
      { w: { op: 'modern-unknown-method' }, response: () => rpcError(-32601), code: -32601 },
      { w: { op: 'modern-clientcaps' }, response: () => rpcError(-32602, 400), code: -32602 },
      { w: { op: 'modern-header-mismatch' }, response: () => rpcError(-32020, 400), code: -32020 },
      {
        w: { op: 'modern-version-reject' },
        response: () => rpcError(-32022, 400, { supported: [MODERN_PROTOCOL], requested: '2025-03-26' }),
        code: -32022,
      },
      { w: { op: 'modern-resources-miss' }, response: () => rpcError(-32602), code: -32602 },
    ];
    expect(cases.length).toBe(9);
    for (const c of cases) {
      const outcome = await run(c.w, stubFetch(c.response));
      expect(outcome.status).toBe('pass');
      expect(outcome.evidence[0].error_code).toBe(c.code);
    }
  });

  test('malformed-body sends the raw non-JSON body with legacy headers and no session attach', async () => {
    const captured: Array<{ headers: Headers; body: string }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      return rpcError(-32700, 400);
    });
    const outcome = await run({ op: 'malformed-body' }, fetchImpl, 'sess-1');
    expect(outcome.status).toBe('pass');
    expect(captured.length).toBe(1);
    expect(captured[0].body).toBe('not-json{{');
    expect(() => JSON.parse(captured[0].body)).toThrow();
    expect(captured[0].headers.get('mcp-protocol-version')).toBeNull();
    expect(captured[0].headers.get('mcp-session-id')).toBeNull();
  });

  test('batch-reject sends a single-element array carrying the modern envelope', async () => {
    const captured: string[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push(String(init?.body));
      return rpcError(-32600, 400);
    });
    const outcome = await run({ op: 'batch-reject' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    const body = JSON.parse(captured[0]) as Array<{ method: string; params: { _meta: Record<string, unknown> } }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].method).toBe('tools/list');
    const element = JSON.parse(modernProbeBody('tools/list')) as { params: { _meta: Record<string, unknown> } };
    expect(body[0].params._meta).toEqual(element.params._meta);
  });

  test('unknown-tool sends a legacy tools/call with a name outside any real catalog', async () => {
    const captured: Array<{ headers: Headers; body: { method: string; params?: { name?: string } } }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return rpcError(-32602);
    });
    const outcome = await run({ op: 'unknown-tool' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    expect(captured[0].body.method).toBe('tools/call');
    expect(captured[0].body.params?.name?.length).toBeGreaterThan(0);
    expect(captured[0].headers.get('mcp-protocol-version')).toBeNull();
  });

  test('modern probes carry era headers, the _meta envelope, and no session attach', async () => {
    const captured: Array<{
      headers: Headers;
      body: { method: string; params?: { _meta?: Record<string, unknown> } };
    }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return rpcError(-32601);
    });
    await run({ op: 'modern-unknown-method' }, fetchImpl, 'sess-1');
    expect(captured.length).toBe(1);
    const req = captured[0];
    expect(req.headers.get('mcp-protocol-version')).toBe(MODERN_PROTOCOL);
    expect(req.headers.get('mcp-method')).toBe(req.body.method);
    expect(req.headers.get('mcp-session-id')).toBeNull();
    const meta = req.body.params?._meta ?? {};
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
  });

  test('modern-clientcaps omits clientCapabilities while keeping the other two _meta keys', async () => {
    const captured: Array<{ body: { params?: { _meta?: Record<string, unknown> } } }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ body: JSON.parse(String(init?.body)) });
      return rpcError(-32602, 400);
    });
    const outcome = await run({ op: 'modern-clientcaps' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    const meta = captured[0].body.params?._meta ?? {};
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toBeUndefined();
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(MODERN_PROTOCOL);
    expect(meta['io.modelcontextprotocol/clientInfo']).toBeDefined();
  });

  test('modern-header-mismatch sends an Mcp-Method header disagreeing with the body method', async () => {
    const captured: Array<{ headers: Headers; body: { method: string } }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return rpcError(-32020, 400);
    });
    const outcome = await run({ op: 'modern-header-mismatch' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    const req = captured[0];
    expect(req.headers.get('mcp-method')).not.toBe(req.body.method);
    expect(req.headers.get('mcp-protocol-version')).toBe(MODERN_PROTOCOL);
  });

  test('modern-version-reject claims the same unsupported version in header and _meta', async () => {
    const captured: Array<{ headers: Headers; body: { params?: { _meta?: Record<string, unknown> } } }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return rpcError(-32022, 400, { supported: [MODERN_PROTOCOL] });
    });
    const outcome = await run({ op: 'modern-version-reject' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    const req = captured[0];
    const claimed = req.headers.get('mcp-protocol-version');
    expect(claimed).not.toBe(MODERN_PROTOCOL);
    expect(req.body.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe(claimed);
  });

  test('modern-resources-miss mirrors the unknown resource URI in Mcp-Name', async () => {
    const captured: Array<{ headers: Headers; body: { method: string; params?: { uri?: string } } }> = [];
    const fetchImpl = stubFetch((_url, init) => {
      captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return rpcError(-32602);
    });
    const outcome = await run({ op: 'modern-resources-miss' }, fetchImpl);
    expect(outcome.status).toBe('pass');
    const req = captured[0];
    expect(req.body.method).toBe('resources/read');
    expect(req.headers.get('mcp-method')).toBe('resources/read');
    expect(req.body.params?.uri?.length).toBeGreaterThan(0);
    expect(req.headers.get('mcp-name')).toBe(req.body.params?.uri ?? '');
  });

  test('malformed-body accepts a bare typed HTTP 400/415 refusal but not other bare statuses', async () => {
    for (const [status, expected] of [
      [400, 'pass'],
      [415, 'pass'],
      [404, 'broken'],
      [500, 'broken'],
    ] as const) {
      const outcome = await run(
        { op: 'malformed-body' },
        stubFetch(() => new Response('nope', { status })),
      );
      expect(outcome.status).toBe(expected);
    }
  });

  test('malformed-body answered 200 with garbage is broken', async () => {
    const outcome = await run(
      { op: 'malformed-body' },
      stubFetch(() => new Response('<html>ok</html>', { status: 200 })),
    );
    expect(outcome.status).toBe('broken');
  });

  test('modern-unknown-method accepts HTTP 404 delivery only when the body carries the -32601 envelope', async () => {
    const withEnvelope = await run(
      { op: 'modern-unknown-method' },
      stubFetch(() => rpcError(-32601, 404)),
    );
    expect(withEnvelope.status).toBe('pass');
    const bare = await run(
      { op: 'modern-unknown-method' },
      stubFetch(() => new Response('not found', { status: 404 })),
    );
    expect(bare.status).toBe('broken');
  });

  test('a bare HTTP 404 with no envelope is broken on every conformance probe (dead-endpoint guard)', async () => {
    for (const op of CONFORMANCE_OPS) {
      if (op === 'malformed-body') continue;
      const outcome = await run(
        { op },
        stubFetch(() => new Response('not found', { status: 404 })),
      );
      expect(outcome.status).toBe('broken');
    }
    const malformed = await run(
      { op: 'malformed-body' },
      stubFetch(() => new Response('not found', { status: 404 })),
    );
    expect(malformed.status).toBe('broken');
  });

  test('a typed refusal conforms whether or not it carries a non-JSON-RPC explanation body', async () => {
    const refusals: Array<() => Response> = [
      () => new Response(null, { status: 400 }),
      () => new Response('Invalid JSON', { status: 400, headers: { 'content-type': 'text/plain' } }),
      () => json({ detail: 'Invalid JSON' }, 400),
      () => json({ error: 'Invalid JSON' }, 415),
    ];
    for (const response of refusals) {
      expect((await run({ op: 'malformed-body' }, stubFetch(response))).status).toBe('pass');
    }
    const dead = await run(
      { op: 'malformed-body' },
      stubFetch(() => json({ detail: 'gone' }, 404)),
    );
    expect(dead.status).toBe('broken');
  });

  test('a rate-limited refusal is an operational error on every op, never a penalty', async () => {
    const ops: Array<Record<string, unknown>> = [
      { op: 'error', method: 'nonexistent/method', expect_code: -32601 },
      { op: 'tools-list' },
      { op: 'server-discover' },
      ...CONFORMANCE_OPS.map((op) => ({ op })),
    ];
    for (const w of ops) {
      const outcome = await run(
        w,
        stubFetch(() => rpcError(-32099)),
      );
      expect(`${String(w.op)}:${outcome.status}`).toBe(`${String(w.op)}:error`);
      expect(outcome.evidence[0].error_code).toBe(-32099);
    }
  });

  test('a bare non-200 without an envelope is broken outside the typed-HTTP arm', async () => {
    for (const op of CONFORMANCE_OPS) {
      if (op === 'malformed-body') continue;
      const outcome = await run(
        { op },
        stubFetch(() => new Response('bad request', { status: 400 })),
      );
      expect(outcome.status).toBe('broken');
    }
  });

  test('modern-clientcaps also passes on -32600 (invalid-request family)', async () => {
    const outcome = await run(
      { op: 'modern-clientcaps' },
      stubFetch(() => rpcError(-32600, 400)),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].error_code).toBe(-32600);
  });

  test('modern-version-reject is noncompliant when the envelope omits data.supported', async () => {
    // The refusal itself is correct and well-formed, so the caller learns
    // the version was rejected; only the renegotiation hint is missing.
    const noData = await run(
      { op: 'modern-version-reject' },
      stubFetch(() => rpcError(-32022, 400)),
    );
    expect(noData.status).toBe('noncompliant');
    expect(noData.evidence[0].why).toEqual(['error.data.supported missing from the version-reject envelope']);
    const wrongData = await run(
      { op: 'modern-version-reject' },
      stubFetch(() => rpcError(-32022, 400, { requested: '2025-03-26' })),
    );
    expect(wrongData.status).toBe('noncompliant');
  });

  test('an unavailability-coded refusal is noncompliant on a conformance row, never softened to absent', async () => {
    const cases: Array<[string, number]> = [
      ['malformed-body', -32601],
      ['malformed-body', -32022],
      ['batch-reject', -32601],
      ['batch-reject', -32022],
      ['unknown-tool', -32601],
      ['unknown-tool', -32022],
      ['modern-header-mismatch', -32601],
      ['modern-version-reject', -32601],
      ['modern-resources-miss', -32601],
      ['modern-clientcaps', -32022],
    ];
    for (const [op, code] of cases) {
      const outcome = await run(
        { op },
        stubFetch(() => rpcError(code)),
      );
      expect(`${op}/${code}:${outcome.status}`).toBe(`${op}/${code}:noncompliant`);
      expect(outcome.evidence[0].error_code).toBe(code);
    }
  });

  test('a session-required refusal is noncompliant on every conformance row that cannot re-ask', async () => {
    for (const op of CONFORMANCE_OPS) {
      const outcome = await run(
        { op },
        stubFetch(() => rpcError(-32000, 400)),
      );
      expect(`${op}:${outcome.status}`).toBe(`${op}:noncompliant`);
    }
  });

  test('an endpoint answering -32601 to everything cannot outscore one that answers honestly', async () => {
    const always32601 = stubFetch(() => rpcError(-32601));
    // The three legacy conformance rows carry no method the lane could be
    // missing, so -32601 is as wrong there as any other mismatched code
    // and lands in the same bucket, never softened to an absent lane.
    for (const op of ['malformed-body', 'batch-reject', 'unknown-tool']) {
      expect(`${op}:${(await run({ op }, always32601)).status}`).toBe(`${op}:noncompliant`);
    }
    // The era probes do name one, so the same code reads as an absent lane.
    for (const op of ['initialize', 'tools-list', 'modern-tools-list', 'server-discover']) {
      expect(`${op}:${(await run({ op }, always32601)).status}`).toBe(`${op}:absent`);
    }
  });

  test('a stateful target that demands a session is re-asked and scored on its own error codes', async () => {
    for (const [op, code] of [
      ['malformed-body', -32700],
      ['batch-reject', -32600],
      ['unknown-tool', -32602],
    ] as const) {
      const seen: Array<string | null> = [];
      const fetchImpl = stubFetch((_url, init) => {
        const session = new Headers(init?.headers).get('mcp-session-id');
        seen.push(session);
        return session === 'sess-1' ? rpcError(code) : rpcError(-32000, 400);
      });
      const outcome = await run({ op }, fetchImpl, 'sess-1');
      expect(`${op}:${outcome.status}`).toBe(`${op}:pass`);
      expect(seen).toEqual([null, 'sess-1']);
    }
  });

  test('the re-ask sends byte-identical bodies and only fires on the legacy conformance rows', async () => {
    const bodies: string[] = [];
    const legacy = stubFetch((_url, init) => {
      bodies.push(String(init?.body));
      return new Headers(init?.headers).get('mcp-session-id') === 'sess-1' ? rpcError(-32602) : rpcError(-32000, 400);
    });
    await run({ op: 'unknown-tool' }, legacy, 'sess-1');
    expect(bodies.length).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);

    for (const op of CONFORMANCE_OPS.filter((o) => o.startsWith('modern-'))) {
      let calls = 0;
      const modern = stubFetch(() => {
        calls++;
        return rpcError(-32000, 400);
      });
      const outcome = await run({ op }, modern, 'sess-1');
      expect(`${op}:${calls}`).toBe(`${op}:1`);
      expect(`${op}:${outcome.status}`).toBe(`${op}:noncompliant`);
    }
  });

  test('an MCP probe stops reading at the shared audit body cap', async () => {
    // An uncapped read lets a hostile endpoint make the auditor buffer
    // whatever it sends, once per probe.
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'x'.repeat(70 * 1024) },
    });
    const outcome = await run(
      { op: 'unknown-tool' },
      stubFetch(() => new Response(oversized, { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    expect(outcome.status).toBe('broken');
    expect((outcome.evidence[0].why as string[])[0]).toBe('no parseable JSON-RPC response');
  });

  test('the re-ask is bounded by the row budget, not granted a second full timeout', async () => {
    // probeOne tests the per-audit deadline only between checks, so a
    // second hop inside one row has to slice that row's own budget or the
    // audit can overrun by a full per-check timeout.
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls++;
      return rpcError(-32000, 400);
    });
    const outcome = await runMcp(
      check({ handler: 'mcp', with: { op: 'unknown-tool' } }),
      ctx({ fetchImpl, mcpEndpoint: MCP, mcpSessionId: 'sess-1', defaultTimeoutMs: 0 }),
    );
    expect(calls).toBe(1);
    expect(outcome.status).toBe('noncompliant');
  });

  test('a malformed error envelope is reported as malformed, not as a result', async () => {
    // The string becomes the Issue line on the owner's remediation
    // prompt, so naming the wrong defect sends them after the wrong bug.
    const noCode = await run(
      { op: 'unknown-tool' },
      stubFetch(() => json({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } })),
    );
    expect(noCode.status).toBe('broken');
    expect((noCode.evidence[0].why as string[])[0]).toBe('the JSON-RPC error envelope carries no numeric error.code');
    const aResult = await run(
      { op: 'unknown-tool' },
      stubFetch(() => toolsResult()),
    );
    expect((aResult.evidence[0].why as string[])[0]).toBe('expected a JSON-RPC error envelope, got a result');
  });

  test('a stateless target keeps every conformance probe to a single request', async () => {
    for (const op of CONFORMANCE_OPS) {
      let calls = 0;
      const fetchImpl = stubFetch(() => {
        calls++;
        return rpcError(-32000, 400);
      });
      await run({ op }, fetchImpl);
      expect(`${op}:${calls}`).toBe(`${op}:1`);
    }
  });

  test('any other well-formed error code is noncompliant, and names the code it expected', async () => {
    const cases: Array<[string, number, string]> = [
      ['malformed-body', -32600, 'expected error code -32700, got -32600'],
      ['modern-unknown-method', -32602, 'expected error code -32601, got -32602'],
      ['modern-clientcaps', -32603, 'expected error code -32602 or -32600, got -32603'],
      ['modern-resources-miss', -32020, 'expected error code -32602 or -32002, got -32020'],
    ];
    for (const [op, code, why] of cases) {
      const outcome = await run(
        { op },
        stubFetch(() => rpcError(code)),
      );
      expect(`${op}:${outcome.status}`).toBe(`${op}:noncompliant`);
      expect(outcome.evidence[0].why).toEqual([why]);
    }
  });

  test('a result envelope answering a conformance probe is broken (the request should have been refused)', async () => {
    // A result where a refusal was required tells the caller the call
    // succeeded, so it keeps the full misleading-surface penalty rather
    // than the partial credit a wrongly-coded refusal earns.
    for (const op of ['unknown-tool', 'batch-reject', 'modern-unknown-method', 'modern-resources-miss']) {
      const outcome = await run(
        { op },
        stubFetch(() => json({ jsonrpc: '2.0', id: 1, result: { content: [] } })),
      );
      expect(`${op}:${outcome.status}`).toBe(`${op}:broken`);
    }
  });

  test('modern-resources-miss tolerates the legacy-compat -32002 miss code', async () => {
    const outcome = await run(
      { op: 'modern-resources-miss' },
      stubFetch(() => rpcError(-32002)),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].error_code).toBe(-32002);
  });

  test('conformance ops return n_a without a fetch when no endpoint was discovered', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    for (const op of CONFORMANCE_OPS) {
      const outcome = await runMcp(check({ handler: 'mcp', with: { op } }), ctx({ fetchImpl, mcpEndpoint: null }));
      expect(outcome.status).toBe('na');
    }
    expect(called).toBe(0);
  });
});

describe('mcp-resources antecedent resolves era-neutrally (engine)', () => {
  const BASE = 'https://example.com/';

  const registry: WebAuditRegistry = {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['mcp'],
    categories: { mcp: 'MCP' },
    checks: [
      check({
        id: 'mcp-initialize',
        category: 'mcp',
        antecedent: 'mcp-present',
        handler: 'mcp',
        with: { op: 'initialize' },
      }),
      check({
        id: 'mcp-server-discover',
        category: 'mcp',
        antecedent: 'mcp-present',
        handler: 'mcp',
        with: { op: 'server-discover' },
      }),
      check({
        id: 'mcp-modern-resources-miss',
        category: 'mcp',
        antecedent: 'mcp-resources',
        handler: 'mcp',
        with: { op: 'modern-resources-miss' },
      }),
    ],
  };

  function siteStub(opts: { legacyResources: boolean; modernResources: boolean; legacyServes: boolean }): typeof fetch {
    return stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      if (method !== 'POST') {
        return url === BASE
          ? new Response('<html><body><h1>x</h1></body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
          : new Response('not found', { status: 404 });
      }
      if (headers.get('mcp-protocol-version') === MODERN_PROTOCOL) {
        const mcpMethod = headers.get('mcp-method');
        if (mcpMethod === 'tools/list') {
          return json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } });
        }
        if (mcpMethod === 'server/discover') {
          const capabilities = opts.modernResources ? { tools: {}, resources: {} } : { tools: {} };
          return json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              supportedVersions: [MODERN_PROTOCOL],
              capabilities,
              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'anc', version: '0.1.0' } },
            },
          });
        }
        if (mcpMethod === 'resources/read') return rpcError(-32602);
        return rpcError(-32601);
      }
      if (!opts.legacyServes) return rpcError(-32601);
      const capabilities = opts.legacyResources ? { tools: {}, resources: {} } : { tools: {} };
      return json({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'anc' }, protocolVersion: '2025-06-18', capabilities },
      });
    });
  }

  async function auditRows(fetchImpl: typeof fetch) {
    const rows: EngineResult[] = [];
    for await (const event of runWebAudit({
      url: BASE,
      registry,
      fetchOptions: { fetchImpl },
    }) as AsyncGenerator<AuditEvent>) {
      if (event.type === 'result') rows.push(event.result);
    }
    return rows;
  }

  test('resources advertised on neither lane gates the miss probe to n_a antecedent-unmet', async () => {
    const rows = await auditRows(siteStub({ legacyResources: false, modernResources: false, legacyServes: true }));
    const miss = rows.find((r) => r.id === 'mcp-modern-resources-miss');
    expect(miss?.status).toBe('n_a');
    expect(miss?.na_reason).toBe('antecedent-unmet');
  });

  test('a modern-only server advertising resources via server/discover probes and classifies', async () => {
    const rows = await auditRows(siteStub({ legacyResources: false, modernResources: true, legacyServes: false }));
    expect(rows.find((r) => r.id === 'mcp-initialize')?.status).toBe('absent');
    const miss = rows.find((r) => r.id === 'mcp-modern-resources-miss');
    expect(miss?.status).toBe('pass');
    expect(miss?.na_reason).toBeUndefined();
  });

  test('legacy capabilities evidence still satisfies the antecedent', async () => {
    const rows = await auditRows(siteStub({ legacyResources: true, modernResources: false, legacyServes: true }));
    expect(rows.find((r) => r.id === 'mcp-modern-resources-miss')?.status).toBe('pass');
  });

  test('a server-discover row reports its supported versions and serverInfo identity', async () => {
    const rows = await auditRows(siteStub({ legacyResources: false, modernResources: true, legacyServes: false }));
    const row = rows.find((r) => r.id === 'mcp-server-discover');
    expect(row?.status).toBe('pass');
    expect(row?.evidence).toBe(`supports ${MODERN_PROTOCOL}, serverInfo anc`);
  });

  test('a broken server-discover row renders a different evidence line from a passing one', async () => {
    const base = siteStub({ legacyResources: false, modernResources: true, legacyServes: false });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get('mcp-method') === 'server/discover') {
        return json({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } });
      }
      return base(input, init);
    }) as typeof fetch;
    const row = (await auditRows(fetchImpl)).find((r) => r.id === 'mcp-server-discover');
    expect(row?.status).toBe('broken');
    expect(row?.evidence).toBe('no supportedVersions in the server/discover result');
  });
});

describe('era lanes resolved across a whole audit (engine)', () => {
  const BASE = 'https://example.com/';

  const registry: WebAuditRegistry = {
    version: 1,
    mcp_discovery: { well_known: ['/.well-known/mcp.json'], common_paths: ['/mcp'], protocol_version: '2025-06-18' },
    category_order: ['mcp'],
    categories: { mcp: 'MCP' },
    checks: (
      [
        ['mcp-initialize', { op: 'initialize' }],
        ['mcp-server-discover', { op: 'server-discover' }],
        ['mcp-modern-tools-list', { op: 'modern-tools-list' }],
        ['mcp-modern-clientcaps', { op: 'modern-clientcaps' }],
        ['mcp-unknown-tool', { op: 'unknown-tool' }],
        ['mcp-resources-list', { op: 'resources-list' }],
      ] as const
    ).map(([id, w]) =>
      check({
        id,
        category: 'mcp',
        antecedent: id === 'mcp-resources-list' ? 'mcp-resources' : 'mcp-present',
        handler: 'mcp',
        with: { ...w },
      }),
    ),
  };

  /** Wraps an MCP-endpoint POST handler with the card + root a discovery pass needs. */
  function site(mcp: (headers: Headers, body: string) => Response): typeof fetch {
    return stubFetch((url, init) => {
      if (url === `${BASE}.well-known/mcp.json`) return json({ mcp_endpoint: `${BASE}mcp` });
      if (url === BASE) {
        return new Response('<html><body><h1>x</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url !== `${BASE}mcp`) return new Response('not found', { status: 404 });
      return mcp(new Headers(init?.headers), init?.body === undefined ? '' : String(init.body));
    });
  }

  function legacyMethod(body: string): string | null {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? ((parsed as { method?: string }).method ?? null)
        : null;
    } catch {
      return null;
    }
  }

  const legacyResult = (method: string | null, caps: Record<string, unknown>, sessionId?: string): Response => {
    if (method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'legacy' }, protocolVersion: '2025-06-18', capabilities: caps },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
          },
        },
      );
    }
    if (method === 'tools/list') return toolsResult();
    if (method === 'tools/call') return rpcError(-32602);
    if (method === null) return rpcError(-32700, 400);
    return rpcError(-32601);
  };

  // A: stateless and lenient, so it answers the modern probes as if they
  // were legacy ones. B: stateful, refusing sessionless POSTs. C: a
  // spec-compliant 2025-06-18 server refusing an unknown version claim.
  const shapes: Record<string, typeof fetch> = {
    A: site((_headers, body) => legacyResult(legacyMethod(body), { tools: {} })),
    B: site((headers, body) => {
      const method = legacyMethod(body);
      if (method === 'initialize') return legacyResult(method, { tools: {} }, 'sess-b');
      if (headers.get('mcp-session-id') !== 'sess-b') return rpcError(-32000, 400);
      return legacyResult(method, { tools: {} });
    }),
    C: site((headers, body) => {
      const version = headers.get('mcp-protocol-version');
      if (version !== null && version !== '2025-06-18') return new Response('Bad Request', { status: 400 });
      return legacyResult(legacyMethod(body), { tools: {} });
    }),
  };

  async function auditRows(fetchImpl: typeof fetch): Promise<EngineResult[]> {
    const rows: EngineResult[] = [];
    for await (const event of runWebAudit({
      url: BASE,
      registry,
      fetchOptions: { fetchImpl },
    }) as AsyncGenerator<AuditEvent>) {
      if (event.type === 'result') rows.push(event.result);
    }
    return rows;
  }

  test('every legacy-only shape lands the modern MUST absent and unprobed, never a free pass', async () => {
    for (const [label, fetchImpl] of Object.entries(shapes)) {
      const rows = await auditRows(fetchImpl);
      const modern = rows.find((r) => r.id === 'mcp-modern-tools-list');
      expect(`${label}:${modern?.status}`).toBe(`${label}:absent`);
      expect(`${label}:${String(modern?.unprobed)}`).toBe(`${label}:true`);
      expect(`${label}:${modern?.evidence}`).toBe(`${label}:no modern lane: server/discover returned no result`);
      const clientcaps = rows.find((r) => r.id === 'mcp-modern-clientcaps');
      expect(`${label}:${clientcaps?.status}/${String(clientcaps?.unprobed)}`).toBe(`${label}:absent/true`);
      expect(`${label}:${rows.find((r) => r.id === 'mcp-initialize')?.status}`).toBe(`${label}:pass`);
    }
  });

  test('the discover row reads absent on every legacy-only shape, so it is not charged for what it proved', async () => {
    const expected: Record<string, string> = {
      A: 'no modern lane: server/discover refused with code -32601',
      B: 'no modern lane: server/discover refused with code -32000',
      C: 'no modern lane: server/discover refused with HTTP 400',
    };
    for (const [label, fetchImpl] of Object.entries(shapes)) {
      const discover = (await auditRows(fetchImpl)).find((r) => r.id === 'mcp-server-discover');
      expect(`${label}:${discover?.status}`).toBe(`${label}:absent`);
      expect(`${label}:${discover?.evidence}`).toBe(`${label}:${expected[label]}`);
    }
  });

  test('a stateful legacy server is scored on its error codes, not on its statefulness', async () => {
    const rows = await auditRows(shapes.B);
    expect(rows.find((r) => r.id === 'mcp-unknown-tool')?.status).toBe('pass');
  });

  test('a dual-stack server keeps every modern row live', async () => {
    const dual = site((headers, body) => {
      if (headers.get('mcp-protocol-version') === MODERN_PROTOCOL) {
        if (headers.get('mcp-method') === 'server/discover') {
          return json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              supportedVersions: [MODERN_PROTOCOL],
              capabilities: { tools: {} },
              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'dual', version: '1.0' } },
            },
          });
        }
        const meta = (JSON.parse(body).params?._meta ?? {}) as Record<string, unknown>;
        if (!('io.modelcontextprotocol/clientCapabilities' in meta)) return rpcError(-32602, 400);
        return toolsResult();
      }
      return legacyResult(legacyMethod(body), { tools: {} });
    });
    const rows = await auditRows(dual);
    expect(rows.find((r) => r.id === 'mcp-server-discover')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'mcp-modern-tools-list')?.status).toBe('pass');
    expect(rows.find((r) => r.id === 'mcp-modern-clientcaps')?.status).toBe('pass');
  });

  test('a legacy lane advertising resources is broken, not absent, when it refuses the read', async () => {
    const advertises = site((_headers, body) => legacyResult(legacyMethod(body), { tools: {}, resources: {} }));
    const rows = await auditRows(advertises);
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.status).toBe('broken');
    expect(rows.find((r) => r.id === 'mcp-resources-list')?.evidence).toBe('error code -32601');
  });
});

describe('runMcp conformance dogfood against the in-process handler', () => {
  const DOGFOOD_CATALOG = {
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
      { slug: 'scoring', title: 'Scoring', level: 2, parent_slug: null, body_markdown: '# Scoring\n\nFixture.\n' },
    ],
    registered_tool_names: ['get_scorecard', 'list_principles', 'score_cli'],
    registered_resource_templates: ['registry', 'tool', 'principle', 'spec', 'scorecard'],
  };

  // Production binds the limiter and serves both eras, and both gates
  // sit upstream of the SDK on the path this matrix drives, so the stub
  // env binds them too: an unbound limiter or legacy gate would let the
  // matrix pass against a shorter pipeline than the one that ships.
  function dogfoodEnv(opts: { limiterSucceeds?: boolean; legacyEnabled?: boolean } = {}): Env {
    return {
      ASSETS: {
        fetch(req: Request) {
          const path = new URL(req.url).pathname;
          if (path === '/_internal/mcp-catalog.json') {
            return Promise.resolve(
              new Response(JSON.stringify(DOGFOOD_CATALOG), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return Promise.resolve(new Response('not found', { status: 404 }));
        },
      } as unknown as Fetcher,
      MCP_ENABLED: 'true',
      MCP_LIVE_SCORING_ENABLED: 'true',
      MCP_LEGACY_ENABLED: (opts.legacyEnabled ?? true) ? 'true' : 'false',
      MCP_LIMITER: {
        limit: () => Promise.resolve({ success: opts.limiterSucceeds ?? true }),
      },
    };
  }

  beforeEach(() => {
    resetMcpTestState();
  });
  afterEach(() => {
    resetMcpTestState();
  });

  async function runMatrix(env: Env): Promise<Array<{ op: unknown; status: string; code: unknown }>> {
    const inProcess: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input as string | URL, init), env, {} as ExecutionContext)) as typeof fetch;
    const probes: Array<Record<string, unknown>> = [
      { op: 'error', method: 'nonexistent/method', expect_code: -32601 },
      ...CONFORMANCE_OPS.map((op) => ({ op })),
    ];
    const originalLog = console.log;
    console.log = () => {};
    const matrix: Array<{ op: unknown; status: string; code: unknown }> = [];
    try {
      for (const w of probes) {
        const outcome = await runMcp(
          check({ handler: 'mcp', with: w }),
          ctx({ fetchImpl: inProcess, mcpEndpoint: 'https://anc.dev/mcp' }),
        );
        matrix.push({ op: w.op, status: outcome.status, code: outcome.evidence[0]?.error_code });
      }
    } finally {
      console.log = originalLog;
    }
    return matrix;
  }

  test('the full conformance matrix passes against the in-process worker', async () => {
    for (const row of await runMatrix(dogfoodEnv())) {
      expect(`${String(row.op)}:${row.status}`).toBe(`${String(row.op)}:pass`);
    }
  });

  test('a breaching limiter answers -32099 and every row is excluded from scoring', async () => {
    for (const row of await runMatrix(dogfoodEnv({ limiterSucceeds: false }))) {
      expect(`${String(row.op)}:${row.status}:${String(row.code)}`).toBe(`${String(row.op)}:error:-32099`);
    }
  });

  test('with the legacy lane disabled the modern rows pass and the closed lane reads absent', async () => {
    const matrix = await runMatrix(dogfoodEnv({ legacyEnabled: false }));
    const row = (op: string) => matrix.find((r) => r.op === op);
    for (const op of CONFORMANCE_OPS.filter((o) => o.startsWith('modern-'))) {
      expect(`${op}:${row(op)?.status}`).toBe(`${op}:pass`);
    }
    // The unknown-method probe is the legacy lane's own era probe, so the
    // closed lane's -32022 reads absent there, matching what its
    // lane-mates report. On the conformance rows no era softening applies:
    // a tools/call answered -32022 is the wrong code for the question that
    // row asks, whatever the reason, and a well-formed refusal under the
    // wrong code is a taxonomy defect rather than a trap.
    expect(row('error')?.status).toBe('absent');
    expect(row('error')?.code).toBe(-32022);
    expect(row('unknown-tool')?.status).toBe('noncompliant');
    expect(row('unknown-tool')?.code).toBe(-32022);
    // The other two legacy rows never reach the gate: an unparseable body
    // draws the shell's -32700 first, and a batch carrying a modern
    // element classifies as modern-era.
    expect(row('malformed-body')?.status).toBe('pass');
    expect(row('batch-reject')?.status).toBe('pass');
  });
});

describe('runDnsDoh', () => {
  const dohCheck = check({
    id: 'dns-aid',
    handler: 'dns-doh',
    category: 'agent-discovery',
    principle: 'P8',
    tier: 'optional',
    keyword: 'may',
    with: { names: ['_index._agents.{host}', '_mcp._agents.{host}'], type: 'SVCB' },
  });

  test('passes on Status:0 with a non-empty Answer array', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toContain('name=_index._agents.example.com');
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: '_index._agents.example.com' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence[0].answers).toBe(1);
  });

  test('first name NXDOMAIN is definitive; second name Status:0 passes', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.includes('_index._agents')) {
        return new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        });
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: '_mcp._agents.example.com' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });

  test('falls back to the second resolver only on resolver-level failure', async () => {
    const resolversHit: string[] = [];
    const fetchImpl = stubFetch((url) => {
      resolversHit.push(new URL(url).host);
      if (url.startsWith('https://cloudflare-dns.com')) return new Response('gateway error', { status: 502 });
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: 'x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
    expect(resolversHit).toContain('cloudflare-dns.com');
    expect(resolversHit).toContain('dns.google');
  });

  test('errors (not absent) when all resolvers network-fail', async () => {
    const fetchImpl = stubFetch(() => new Response('boom', { status: 500 }));
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('error');
  });

  test('is absent when every name resolves NXDOMAIN', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        }),
    );
    const outcome = await runDnsDoh(dohCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('absent');
  });
});

describe('runAuthMd', () => {
  const authCheck = check({
    id: 'auth-md',
    handler: 'auth-md',
    category: 'agent-discovery-auth',
    tier: 'optional',
    keyword: 'may',
    site_types: ['api', 'mcp'],
    antecedent: 'auth-present',
    with: { path_any: ['/.well-known/auth.md', '/auth.md'] },
  });

  test('a markdown auth doc passes', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/.well-known/auth.md')) {
        return new Response('# Agent auth\n\nRegister at /register.', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        });
      }
      return new Response('no', { status: 404 });
    });
    const outcome = await runAuthMd(authCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });

  test('an HTML page at the auth.md path is broken (present-malformed)', async () => {
    const fetchImpl = stubFetch(
      () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const outcome = await runAuthMd(authCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('broken');
  });

  test('missing at every candidate path is absent', async () => {
    const fetchImpl = stubFetch(() => new Response('no', { status: 404 }));
    const outcome = await runAuthMd(authCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('absent');
  });

  test('a bare markdown heading without a content-type still passes', async () => {
    const fetchImpl = stubFetch((url) =>
      url.endsWith('/auth.md') ? new Response('# Auth for agents') : new Response('no', { status: 404 }),
    );
    const outcome = await runAuthMd(authCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });
});

describe('runWebMcp', () => {
  const webmcpCheck = check({ id: 'webmcp', handler: 'webmcp', antecedent: 'html-root', with: {} });
  const htmlRoot = (body: string) => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body,
    error: null,
  });

  test('detects a webmcp script asset in the root HTML without any fetch', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('');
    });
    const outcome = await runWebMcp(
      webmcpCheck,
      ctx({ fetchImpl, root: htmlRoot('<script src="/assets/webmcp-abc123.js" defer></script>') }),
    );
    expect(outcome.status).toBe('pass');
    expect(called).toBe(0);
  });

  test('detects an inline navigator.modelContext registration', async () => {
    const fetchImpl = stubFetch(() => new Response(''));
    const outcome = await runWebMcp(
      webmcpCheck,
      ctx({ fetchImpl, root: htmlRoot('<script>if (navigator.modelContext) { /* register */ }</script>') }),
    );
    expect(outcome.status).toBe('pass');
  });

  test('no markers is absent', async () => {
    const fetchImpl = stubFetch(() => new Response(''));
    const outcome = await runWebMcp(webmcpCheck, ctx({ fetchImpl, root: htmlRoot('<html><body>hi</body></html>') }));
    expect(outcome.status).toBe('absent');
  });

  test('a failed root fetch is an operational error', async () => {
    const fetchImpl = stubFetch(() => new Response(''));
    const outcome = await runWebMcp(webmcpCheck, ctx({ fetchImpl, root: undefined }));
    expect(outcome.status).toBe('error');
  });
});

describe('runMarkdownFrontmatter', () => {
  const fmCheck = check({
    id: 'markdown-frontmatter',
    handler: 'markdown-frontmatter',
    tier: 'optional',
    keyword: 'may',
    antecedent: 'markdown-twin',
    with: { path: '/', headers: { Accept: 'text/markdown' } },
  });
  const md = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/markdown' } });

  test('a twin opening with a terminated frontmatter block passes', async () => {
    const fetchImpl = stubFetch((url, init) => {
      expect(url).toBe('https://example.com/');
      expect((init?.headers as Record<string, string>).Accept).toBe('text/markdown');
      return md('---\ntitle: X\ndescription: Y\nurl: https://z/\n---\n\n# H\n');
    });
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
    expect((outcome.evidence[0].why as string[])[0]).toContain('3 key lines');
  });

  test('a leading fence with a key line but no terminator is broken', async () => {
    const fetchImpl = stubFetch(() => md('---\ntitle: X\ndescription: Y\n\n# H\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('broken');
  });

  test('a fence pair with no key line is broken', async () => {
    const fetchImpl = stubFetch(() => md('---\n---\n\n# H\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('broken');
  });

  test('a fence pair whose only inter-fence line is a comment is broken', async () => {
    const fetchImpl = stubFetch(() => md('---\n# just a comment\n---\n\n# H\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('broken');
  });

  test('a twin opening with prose is absent', async () => {
    const fetchImpl = stubFetch(() => md('# Heading\n\nSome prose.\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('absent');
  });

  test('a mid-document thematic break is not a false frontmatter pass', async () => {
    const fetchImpl = stubFetch(() => md('# Heading\n\nIntro paragraph.\n\n---\n\nMore prose.\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('absent');
  });

  test('a leading UTF-8 BOM before the fence is tolerated', async () => {
    const fetchImpl = stubFetch(() => md('\uFEFF---\ntitle: X\n---\n\n# H\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });

  test('an HTML response containing --- is guarded to absent', async () => {
    const fetchImpl = stubFetch(
      () => new Response('<html>---<body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('absent');
  });

  test('a failed fetch is an operational error', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('boom');
    });
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('error');
  });

  test('CRLF line endings pass', async () => {
    const fetchImpl = stubFetch(() => md('---\r\ntitle: X\r\n---\r\n\r\n# H\r\n'));
    const outcome = await runMarkdownFrontmatter(fmCheck, ctx({ fetchImpl }));
    expect(outcome.status).toBe('pass');
  });
});

describe('runContentWithoutJs', () => {
  const rich = `<html><body><h1>Title</h1><p>${'Readable prose. '.repeat(20)}</p></body></html>`;
  const thin = '<html><body><div id="app"></div></body></html>';

  test('rich HTML with an H1 passes without probing llms.txt links', async () => {
    let extra = 0;
    const fetchImpl = stubFetch(() => {
      extra += 1;
      return new Response('nope', { status: 404 });
    });
    const outcome = await runContentWithoutJs(
      check({ id: 'content-without-js', handler: 'content-without-js' }),
      ctx({
        fetchImpl,
        root: { status: 200, headers: { 'content-type': 'text/html' }, body: rich, error: null },
      }),
    );
    expect(outcome.status).toBe('pass');
    expect(extra).toBe(0);
  });

  test('rich HTML on a non-2xx root is broken, not a pass', async () => {
    const fetchImpl = stubFetch(() => new Response('nope', { status: 404 }));
    const notFound = await runContentWithoutJs(
      check({ id: 'content-without-js', handler: 'content-without-js' }),
      ctx({
        fetchImpl,
        root: { status: 404, headers: { 'content-type': 'text/html' }, body: rich, error: null },
      }),
    );
    const serverError = await runContentWithoutJs(
      check({ id: 'content-without-js', handler: 'content-without-js' }),
      ctx({
        fetchImpl,
        root: { status: 500, headers: { 'content-type': 'text/html' }, body: rich, error: null },
      }),
    );
    expect(notFound.status).toBe('broken');
    expect(serverError.status).toBe('broken');
  });

  test('thin HTML with a live llms.txt content link is na', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://example.com/guide.md');
      return new Response('# Guide\n\nSubstantial twin body for the soften path to count as content.\n', {
        status: 200,
      });
    });
    const outcome = await runContentWithoutJs(
      check({ id: 'content-without-js', handler: 'content-without-js' }),
      ctx({
        fetchImpl,
        root: { status: 200, headers: { 'content-type': 'text/html' }, body: thin, error: null },
        retainedBodies: new Map([['llms-txt', '# Site\n\n- [Guide](https://example.com/guide.md)\n']]),
      }),
    );
    expect(outcome.status).toBe('na');
  });
});

describe('runLlmsTxtQuality', () => {
  test('format requires h1, blockquote summary, and a link index', async () => {
    const fetchImpl = stubFetch(() => new Response('unused', { status: 404 }));
    const pass = await runLlmsTxtQuality(
      check({ id: 'llms-txt-format', handler: 'llms-txt-quality', with: { op: 'format' } }),
      ctx({
        fetchImpl,
        retainedBodies: new Map([['llms-txt', '# Site\n\n> Summary\n\n- [A](https://example.com/a)\n']]),
      }),
    );
    expect(pass.status).toBe('pass');
    const miss = await runLlmsTxtQuality(
      check({ id: 'llms-txt-format', handler: 'llms-txt-quality', with: { op: 'format' } }),
      ctx({ fetchImpl, retainedBodies: new Map([['llms-txt', '# Site\n']]) }),
    );
    expect(miss.status).toBe('absent');
  });
});

describe('runApiHygiene', () => {
  const spec = JSON.stringify({
    openapi: '3.1.0',
    paths: {
      '/v1/items/{id}': {
        get: { responses: { '404': { description: 'missing' } } },
      },
    },
  });

  test('deriveApiProbeUrl prefers a documented 4xx GET and falls back when the body is unusable', () => {
    const derived = deriveApiProbeUrl(spec, 'https://example.com/');
    expect(derived.source).toBe('openapi-4xx');
    expect(derived.url).toBe('https://example.com/v1/items/anc-web-audit-no-such');
    expect(deriveApiProbeUrl('not json', 'https://example.com/').source).toBe('fallback');
  });

  test('json-errors passes on a JSON 404 and is broken on HTML', async () => {
    const jsonFetch = stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const pass = await runApiHygiene(
      check({ handler: 'api-hygiene', with: { op: 'json-errors' } }),
      ctx({ fetchImpl: jsonFetch, retainedBodies: new Map([['openapi', spec]]) }),
    );
    expect(pass.status).toBe('pass');
    const htmlFetch = stubFetch(
      () => new Response('<html>nope</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    const miss = await runApiHygiene(
      check({ handler: 'api-hygiene', with: { op: 'json-errors' } }),
      ctx({ fetchImpl: htmlFetch, retainedBodies: new Map([['openapi', spec]]) }),
    );
    expect(miss.status).toBe('broken');
  });

  test('rate-limit passes when RateLimit-Limit is present', async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'ratelimit-limit': '60' },
        }),
    );
    const outcome = await runApiHygiene(
      check({ handler: 'api-hygiene', with: { op: 'rate-limit' } }),
      ctx({ fetchImpl, retainedBodies: new Map([['openapi', spec]]) }),
    );
    expect(outcome.status).toBe('pass');
  });
});
