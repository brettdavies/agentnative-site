// Pure assertion + JSON-RPC parse tests (plan U2). The fixture block is
// vendored from the agent-web-audit skill's fixtures/assert-cases.json so
// the TypeScript port stays byte-faithful to the extracted contract.

import { describe, expect, test } from 'bun:test';
import { assertHttp, type ProbeResponse, parseJsonRpc } from '../src/worker/audit-web/assert';

function resp(partial: Partial<ProbeResponse>): ProbeResponse {
  return { status: 200, headers: {}, body: '', error: null, ...partial };
}

const FIXTURE_CASES: Array<{ name: string; expect: object; resp: ProbeResponse; want: boolean }> = [
  { name: 'status-ok', expect: { status: [200] }, resp: resp({}), want: true },
  { name: 'status-bad', expect: { status: [200] }, resp: resp({ status: 404 }), want: false },
  { name: 'status-below-documented-200', expect: { status_below: 500 }, resp: resp({ status: 200 }), want: true },
  { name: 'status-below-fast-fail-405', expect: { status_below: 500 }, resp: resp({ status: 405 }), want: true },
  { name: 'status-below-server-error-502', expect: { status_below: 500 }, resp: resp({ status: 502 }), want: false },
  {
    name: 'status-below-request-error',
    expect: { status_below: 500 },
    resp: resp({ status: null, error: 'TimeoutError: timed out' }),
    want: false,
  },
  {
    name: 'request-error',
    expect: { status: [200] },
    resp: resp({ status: null, error: 'TimeoutError: timed out' }),
    want: false,
  },
  {
    name: 'content-type-schema-json',
    expect: { content_type: 'json' },
    resp: resp({ headers: { 'content-type': 'application/schema+json' }, body: '{}' }),
    want: true,
  },
  {
    name: 'body-regex-link-rel-hit',
    expect: { body_regex: 'rel=["\'](service-desc|alternate)["\']' },
    resp: resp({ body: '<link rel="service-desc" href="/openapi.json">' }),
    want: true,
  },
  {
    name: 'body-regex-noscript-miss',
    expect: { body_regex: '<noscript' },
    resp: resp({ body: '<div id="root"></div>' }),
    want: false,
  },
  {
    name: 'header-present-acao',
    expect: { header_present: 'access-control-allow-origin' },
    resp: resp({ headers: { 'access-control-allow-origin': '*' } }),
    want: true,
  },
  {
    name: 'combined-and-pass',
    expect: { status: [200], content_type: 'json', body_regex: 'openapi' },
    resp: resp({ headers: { 'content-type': 'application/json' }, body: '{"openapi":"3.1.0"}' }),
    want: true,
  },
  {
    name: 'combined-and-fail-on-content-type',
    expect: { status: [200], content_type: 'json' },
    resp: resp({ headers: { 'content-type': 'text/html' } }),
    want: false,
  },
  {
    name: 'header-regex-link-hit',
    expect: { header_regex: { name: 'link', pattern: 'rel="?(service-desc|api-catalog)"?' } },
    resp: resp({ headers: { link: '</.well-known/api-catalog>; rel="api-catalog"' } }),
    want: true,
  },
  {
    name: 'header-regex-link-miss',
    expect: { header_regex: { name: 'link', pattern: 'rel="?service-desc"?' } },
    resp: resp({ headers: { link: '</style.css>; rel="preload"' } }),
    want: false,
  },
  {
    name: 'header-regex-absent-header',
    expect: { header_regex: { name: 'link', pattern: 'service-desc' } },
    resp: resp({}),
    want: false,
  },
];

describe('assertHttp — vendored fixture cases', () => {
  for (const c of FIXTURE_CASES) {
    test(c.name, () => {
      const { ok } = assertHttp(c.expect, c.resp);
      expect(ok).toBe(c.want);
    });
  }
});

describe('assertHttp — semantics', () => {
  test('llms.txt body regex passes with reasons recorded', () => {
    const { ok, reasons } = assertHttp(
      { status: [200], body_regex: '^#|\\]\\(https?://' },
      resp({ body: '# My Site\n\n> Summary\n\n- [Docs](https://example.com/docs)' }),
    );
    expect(ok).toBe(true);
    expect(reasons.length).toBe(2);
    expect(reasons[0]).toContain('status 200 in');
    expect(reasons[1]).toContain('body matches');
  });

  test('body_regex is multiline: ^ anchors per line, not whole-body', () => {
    const { ok } = assertHttp(
      { body_regex: '^\\s*Content-Signal:\\s*(ai-train|search|ai-input)' },
      resp({ body: 'User-agent: *\nAllow: /\nContent-Signal: ai-train=no' }),
    );
    expect(ok).toBe(true);
  });

  test('body_regex is case-insensitive', () => {
    const { ok } = assertHttp({ body_regex: '<noscript' }, resp({ body: '<NOSCRIPT>fallback</NOSCRIPT>' }));
    expect(ok).toBe(true);
  });

  test('multi-value Accept-style header matches by regex, not substring', () => {
    const { ok } = assertHttp(
      { header_regex: { name: 'Link', pattern: 'rel="?(service-desc|describedby)"?' } },
      resp({ headers: { link: '</openapi.json>; rel=service-desc, </style.css>; rel="preload"' } }),
    );
    expect(ok).toBe(true);
  });

  test('header_regex looks the header name up case-insensitively', () => {
    const { ok } = assertHttp(
      { header_regex: { name: 'LINK', pattern: 'api-catalog' } },
      resp({ headers: { link: 'rel="api-catalog"' } }),
    );
    expect(ok).toBe(true);
  });

  test('network-error response fails immediately with the error reason', () => {
    const { ok, reasons } = assertHttp(
      { status: [200], body_regex: 'anything' },
      resp({ status: null, error: 'TypeError: fetch failed' }),
    );
    expect(ok).toBe(false);
    expect(reasons).toEqual(['request failed: TypeError: fetch failed']);
  });

  test('first failing assertion short-circuits (later keys unevaluated)', () => {
    const { reasons } = assertHttp(
      { status: [200], content_type: 'json', body_regex: 'openapi' },
      resp({ status: 404 }),
    );
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain('not in');
  });

  test('content_type matches against an empty header when absent', () => {
    const { ok } = assertHttp({ content_type: 'json' }, resp({}));
    expect(ok).toBe(false);
  });

  test('empty expect block passes with no reasons', () => {
    const { ok, reasons } = assertHttp({}, resp({}));
    expect(ok).toBe(true);
    expect(reasons).toEqual([]);
  });

  test('status_below records a below/not-below reason', () => {
    const pass = assertHttp({ status_below: 500 }, resp({ status: 301 }));
    expect(pass.ok).toBe(true);
    expect(pass.reasons).toEqual(['status 301 below 500']);
    const fail = assertHttp({ status_below: 500 }, resp({ status: 503 }));
    expect(fail.ok).toBe(false);
    expect(fail.reasons).toEqual(['status 503 not below 500']);
  });
});

describe('parseJsonRpc', () => {
  test('plain application/json body parses', () => {
    const rpc = parseJsonRpc(
      resp({
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"anc"}}}',
      }),
    );
    expect(rpc).toEqual({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'anc' } } });
  });

  test('text/event-stream body extracts the first data: line', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const rpc = parseJsonRpc(resp({ headers: { 'content-type': 'text/event-stream' }, body }));
    expect(rpc).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  test('SSE-shaped body without the content-type header still parses', () => {
    const body = 'data: {"jsonrpc":"2.0","id":2,"result":{}}\n';
    const rpc = parseJsonRpc(resp({ body }));
    expect(rpc).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  test('skips unparseable data: lines and takes the first valid one', () => {
    const body = 'data: not-json\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n';
    const rpc = parseJsonRpc(resp({ headers: { 'content-type': 'text/event-stream' }, body }));
    expect(rpc).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  test('malformed JSON body returns null', () => {
    expect(parseJsonRpc(resp({ headers: { 'content-type': 'application/json' }, body: '{nope' }))).toBeNull();
  });

  test('event-stream with no parseable data line returns null', () => {
    const body = 'event: message\ndata: still-not-json\n';
    expect(parseJsonRpc(resp({ headers: { 'content-type': 'text/event-stream' }, body }))).toBeNull();
  });

  test('empty body returns null', () => {
    expect(parseJsonRpc(resp({}))).toBeNull();
  });

  test('non-object JSON body returns null', () => {
    expect(parseJsonRpc(resp({ body: '[1,2,3]' }))).toBeNull();
  });
});
