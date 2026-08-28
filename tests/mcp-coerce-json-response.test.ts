import { describe, expect, test } from 'bun:test';
import { coerceMcpJsonResponse, stripCorsHeaders } from '../src/worker/mcp/coerce-json-response';

describe('coerceMcpJsonResponse', () => {
  test('leaves non-SSE responses untouched when format is json', async () => {
    const input = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const out = await coerceMcpJsonResponse(input, 'json');
    expect(out.headers.get('content-type')).toContain('application/json');
    expect(await out.text()).toBe('{"ok":true}');
  });

  test('leaves SSE untouched when format is sse', async () => {
    const sse = 'event: message\ndata: {"result":1}\n\n';
    const input = new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const out = await coerceMcpJsonResponse(input, 'sse');
    expect(out.headers.get('content-type')).toContain('event-stream');
    expect(await out.text()).toBe(sse);
  });

  test('coerces SSE data line to application/json when format is json', async () => {
    const payload = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';
    const input = new Response(`event: message\ndata: ${payload}\n\n`, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'Content-Type',
      },
    });
    const out = await coerceMcpJsonResponse(input, 'json');
    expect((out.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
    expect(out.headers.get('access-control-allow-methods')).toBeNull();
    expect(out.headers.get('access-control-allow-headers')).toBeNull();
    expect(await out.text()).toBe(payload);
  });
});

describe('stripCorsHeaders', () => {
  test('removes every Access-Control-* header', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'access-control-max-age': '86400',
    });
    stripCorsHeaders(headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('access-control-allow-methods')).toBeNull();
    expect(headers.get('access-control-max-age')).toBeNull();
  });
});
