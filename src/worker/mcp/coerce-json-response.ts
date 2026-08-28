// Legacy-lane Accept negotiation shim.
//
// agents/mcp createMcpHandler routes legacy requests through
// WebStandardStreamableHTTPServerTransport, which requires
// `Accept: application/json, text/event-stream` and defaults to SSE when both
// are present. Our dispatch rewrite shim supplies that dual Accept so the
// transport accepts the request; responseMode:'json' only applies to the
// modern SDK handler. When detectMcpFormat resolved to JSON, coerce an SSE
// body back to a single JSON-RPC object so "JSON wins ties" holds for both
// eras.

export async function coerceMcpJsonResponse(response: Response, format: 'json' | 'sse'): Promise<Response> {
  if (format !== 'json') return response;

  const ct = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('text/event-stream')) return response;

  const raw = await response.text();
  let jsonBody = raw;
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      jsonBody = line.slice(6);
      break;
    }
  }

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  stripCorsHeaders(headers);
  headers.set('cache-control', 'no-store');

  return new Response(jsonBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Strip every Access-Control-* header (KTD-10: POST /mcp is server-to-agent). */
export function stripCorsHeaders(headers: Headers): void {
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith('access-control-')) {
      headers.delete(key);
    }
  }
}
