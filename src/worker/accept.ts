// Content-negotiation helpers — use RFC 7231 q-value parsing via the
// `accepts` npm package (NOT substring matching, per the
// `accept-header-q-value` learning).
//
// detectPreference — site-default ('html' | 'markdown'). Used by index.ts
//                    for the asset-first path; markdown is opt-in.
//
// detectScorePreference — /api/score endpoint ('json' | 'markdown'). JSON is
//                         default; markdown is opt-in. The handler combines
//                         this with URL-suffix detection
//                         (`/api/score.md`, `/api/score.json`) in
//                         `score/content-negotiation.ts`.
//
// detectMcpFormat — POST /mcp endpoint ('json' | 'sse' | false). The MCP
//                   streamable HTTP transport allows the server to return
//                   either a single application/json response or a SSE
//                   stream; JSON wins ties. Absent / empty / `*/*` Accept
//                   returns 'json'. The literal `false` return is the
//                   "neither MIME acceptable" signal that drives the 406
//                   text/plain rejection in src/worker/index.ts (no
//                   JSON-RPC envelope at the pre-JSON-RPC layer).
//
// detectMcpGetFormat — GET /mcp endpoint ('html' | 'json' | 'markdown').
//                      HTML wins ties because the canonical caller is a
//                      human clicking the literal MCP URL from the
//                      homepage. The worker short-circuits 'json' to
//                      proxy /.well-known/mcp (above the kill switch);
//                      'html' and 'markdown' fall through to the asset-
//                      first dispatch which renders dist/mcp.html and
//                      dist/mcp.md via the standard site shell.
//
// See docs/DESIGN.md §3.4 (Worker paragraph) + eng review A3. Site-side
// test matrix lives in tests/worker.test.ts; /api/score q-value tests live
// in the same file's /api/score describe block; /mcp q-value tests live
// in tests/worker-mcp-dispatch.test.ts.

import accepts from 'accepts';

export type Preference = 'html' | 'markdown';
export type ScorePreference = 'json' | 'markdown';
export type McpFormat = 'json' | 'sse' | false;
export type McpGetFormat = 'html' | 'json' | 'markdown';

const SITE_PREFERENCE_ORDER = ['text/html', 'text/markdown'];
const SCORE_PREFERENCE_ORDER = ['application/json', 'text/markdown', 'text/html'];
const MCP_FORMAT_ORDER = ['application/json', 'text/event-stream'];
const MCP_GET_ORDER = ['text/html', 'application/json', 'text/markdown'];

/**
 * Shim a Workers `Request` into the shape `accepts` expects: it only reads
 * `headers.accept`, not the full IncomingMessage surface.
 */
function shim(request: Request) {
  return {
    headers: {
      accept: request.headers.get('accept') ?? '',
    },
  };
}

export function detectPreference(request: Request): Preference {
  // @ts-expect-error — the accepts package types an IncomingMessage but only
  // reads `headers.accept`; the shim is sufficient.
  const match = accepts(shim(request)).type(SITE_PREFERENCE_ORDER);
  return match === 'text/markdown' ? 'markdown' : 'html';
}

export function detectScorePreference(request: Request): ScorePreference {
  // @ts-expect-error — see detectPreference above.
  const match = accepts(shim(request)).type(SCORE_PREFERENCE_ORDER);
  return match === 'text/markdown' ? 'markdown' : 'json';
}

export function detectMcpFormat(request: Request): McpFormat {
  const acceptHeader = request.headers.get('accept');
  // Per R2 of the MCP endpoint plan: absent / empty / `*/*` Accept
  // defaults to JSON. The accepts package would already pick the first
  // listed type for `*/*` but treats an absent header as "*/*" too —
  // both reduce to JSON here, but we early-return so the intent stays
  // explicit at the call site.
  if (!acceptHeader || acceptHeader.trim() === '' || acceptHeader.includes('*/*')) {
    return 'json';
  }
  // @ts-expect-error — see detectPreference above.
  const match = accepts(shim(request)).type(MCP_FORMAT_ORDER);
  if (!match) return false;
  return match === 'text/event-stream' ? 'sse' : 'json';
}

export function detectMcpGetFormat(request: Request): McpGetFormat {
  const acceptHeader = request.headers.get('accept');
  // Absent / empty / `*/*` reduces to 'html' so curl with no flags and
  // browsers both land on the rendered descriptor page. Callers who
  // want JSON or markdown ask for it explicitly.
  if (!acceptHeader || acceptHeader.trim() === '' || acceptHeader.includes('*/*')) {
    return 'html';
  }
  // @ts-expect-error — see detectPreference above.
  const match = accepts(shim(request)).type(MCP_GET_ORDER);
  if (match === 'application/json') return 'json';
  if (match === 'text/markdown') return 'markdown';
  return 'html';
}
