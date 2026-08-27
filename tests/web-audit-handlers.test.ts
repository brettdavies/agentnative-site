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
import { runMcp } from '../src/worker/audit-web/handlers/mcp';
import type { HandlerContext } from '../src/worker/audit-web/handlers/types';
import { runWebMcp } from '../src/worker/audit-web/handlers/webmcp';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';
import { scoreWebAudit } from '../src/worker/audit-web/score';
import type { EngineResult } from '../src/worker/audit-web/scorecard';
import worker, { type Env } from '../src/worker/index';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { MODERN_PROTOCOL, modernElementBatchBody } from './helpers/mcp-modern';
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
  const MCP = 'https://example.com/mcp';
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

  test('a transport failure on either probe yields error for both ids', async () => {
    const failing = (): Response => {
      throw new Error('connect timeout');
    };
    for (const fetchImpl of [pairFetch(failing, postAcao()), pairFetch(preflightAcao(), failing)]) {
      expect((await classify('preflight', fetchImpl)).status).toBe('error');
      expect((await classify('actual', fetchImpl)).status).toBe('error');
    }
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
  const MCP = 'https://example.com/mcp';
  const json = (body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const toolsResult = () => json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } });
  const rpcError = (code: number) => json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope' } });
  const isModern = (init?: RequestInit) => new Headers(init?.headers).get('mcp-protocol-version') === MODERN_PROTOCOL;

  test('modern-only server: initialize maps to absent, header-routed tools/list passes (AE3)', async () => {
    for (const rejectCode of [-32022, -32601]) {
      const fetchImpl = stubFetch((_url, init) => (isModern(init) ? toolsResult() : rpcError(rejectCode)));
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
      if (isModern(init)) return rpcError(-32601);
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
      if (isModern(init)) return toolsResult();
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

const CONFORMANCE_OPS = [
  'malformed-body',
  'batch-reject',
  'unknown-tool',
  'modern-unknown-method',
  'modern-clientcaps',
  'modern-header-mismatch',
  'modern-version-reject',
  'modern-resources-miss',
] as const;

describe('runMcp error-code conformance', () => {
  const MCP = 'https://example.com/mcp';
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const rpcError = (code: number, status = 200, data?: Record<string, unknown>) =>
    json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope', ...(data !== undefined ? { data } : {}) } }, status);
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
    const helperElement = modernElementBatchBody()[0];
    expect(Object.keys(body[0].params._meta).sort()).toEqual(Object.keys(helperElement.params._meta).sort());
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

  test('modern-version-reject is broken when the envelope omits data.supported', async () => {
    const noData = await run(
      { op: 'modern-version-reject' },
      stubFetch(() => rpcError(-32022, 400)),
    );
    expect(noData.status).toBe('broken');
    const wrongData = await run(
      { op: 'modern-version-reject' },
      stubFetch(() => rpcError(-32022, 400, { requested: '2025-03-26' })),
    );
    expect(wrongData.status).toBe('broken');
  });

  test('an unavailability-coded refusal that is not the expected code maps to absent', async () => {
    const cases: Array<[string, number]> = [
      ['unknown-tool', -32022],
      ['batch-reject', -32022],
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
      expect(outcome.status).toBe('absent');
      expect(outcome.evidence[0].error_code).toBe(code);
    }
  });

  test('any other well-formed error code stays broken', async () => {
    const cases: Array<[string, number]> = [
      ['malformed-body', -32600],
      ['modern-unknown-method', -32602],
      ['modern-clientcaps', -32603],
      ['modern-resources-miss', -32020],
    ];
    for (const [op, code] of cases) {
      const outcome = await run(
        { op },
        stubFetch(() => rpcError(code)),
      );
      expect(outcome.status).toBe('broken');
    }
  });

  test('a result envelope answering a conformance probe is broken (the request should have been refused)', async () => {
    const outcome = await run(
      { op: 'unknown-tool' },
      stubFetch(() => json({ jsonrpc: '2.0', id: 1, result: { content: [] } })),
    );
    expect(outcome.status).toBe('broken');
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
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const rpcError = (code: number, status = 200) =>
    json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope' } }, status);

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

  function dogfoodEnv(): Env {
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
    };
  }

  beforeEach(() => {
    resetMcpTestState();
  });
  afterEach(() => {
    resetMcpTestState();
  });

  test('the full conformance matrix passes against the in-process worker', async () => {
    const env = dogfoodEnv();
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
    for (const row of matrix) {
      expect(`${String(row.op)}:${row.status}`).toBe(`${String(row.op)}:pass`);
    }
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
