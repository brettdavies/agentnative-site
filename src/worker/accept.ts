// Content-negotiation helpers — use RFC 7231 q-value parsing via the
// `accepts` npm package (NOT substring matching, per the
// `accept-header-q-value` learning).
//
// detectPreference — site-default ('html' | 'markdown') for the asset-first
//                    path. HTML is the default. Markdown is served when the
//                    client negotiates for it (Accept: text/markdown or
//                    text/plain, q-value parsed) OR, when the client states
//                    no content-type preference (Accept absent or `*/*`),
//                    presents a User-Agent on the MARKDOWN_UA_TOKENS
//                    allowlist. An explicit Accept always wins over the UA
//                    heuristic, so browsers, Googlebot, and AI
//                    training/search crawlers stay on HTML.
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

const SITE_PREFERENCE_ORDER = ['text/html', 'text/markdown', 'text/plain'];

// User-Agent tokens that receive the markdown twin when the client states no
// content-type preference (Accept absent or exactly `*/*`). Matched as
// case-insensitive substrings; the trailing `/` anchors tokens that would
// otherwise be ambiguous (e.g. `java/` not `java`). Two groups:
//   - CLI / library HTTP clients: a human or script poking the site from a
//     shell gets clean markdown instead of HTML chrome.
//   - AI on-demand user-fetchers (ChatGPT-User, Claude-User, Perplexity-User):
//     a live agent retrieving the page to answer a human, the canonical
//     agent-native read path.
// Strict allowlist — any unrecognized UA defaults to HTML. That deliberately
// keeps browsers, classic search crawlers (Googlebot, bingbot — SEO), and AI
// training/search-index crawlers (GPTBot, ClaudeBot, OAI-SearchBot,
// Claude-SearchBot, PerplexityBot) on HTML.
const MARKDOWN_UA_TOKENS = [
  'curl/',
  'wget/',
  'httpie/',
  'python-requests/',
  'python-httpx/',
  'go-http-client/',
  'node-fetch',
  'undici',
  'okhttp/',
  'java/',
  'libwww-perl',
  'postmanruntime/',
  'axios/',
  'chatgpt-user',
  'claude-user',
  'perplexity-user',
];

function isMarkdownEligibleAgent(request: Request): boolean {
  const ua = request.headers.get('user-agent');
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return MARKDOWN_UA_TOKENS.some((token) => lower.includes(token));
}

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
  const accept = request.headers.get('accept');
  const statesNoPreference = !accept || accept.trim() === '' || accept.trim() === '*/*';

  if (!statesNoPreference) {
    // The client named a type: honor its q-value-ranked choice. text/plain
    // is treated as a markdown request — markdown is valid text/plain, and a
    // client asking for plain text wants the source, not HTML chrome.
    // @ts-expect-error — the accepts package types an IncomingMessage but only
    // reads `headers.accept`; the shim is sufficient.
    const match = accepts(shim(request)).type(SITE_PREFERENCE_ORDER);
    return match === 'text/markdown' || match === 'text/plain' ? 'markdown' : 'html';
  }

  // No stated preference (Accept absent or exactly `*/*`): default to HTML,
  // but hand the markdown twin to recognized CLI tools and AI user-fetchers.
  return isMarkdownEligibleAgent(request) ? 'markdown' : 'html';
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

/** Canonical Accept the inner Worker sees after gateway classification. */
const SITE_CLASS_ACCEPT: Record<Preference, string> = {
  html: 'text/html',
  markdown: 'text/markdown',
};

const MCP_GET_CLASS_ACCEPT: Record<McpGetFormat, string> = {
  html: 'text/html',
  json: 'application/json',
  markdown: 'text/markdown',
};

// UA class uses tokens detectPreference already understands: `curl/` is on
// MARKDOWN_UA_TOKENS; empty UA is the HTML default. Do not invent a label
// that is not already in that allowlist (KTD8).
const MARKDOWN_CLASS_UA = 'curl/';

function isGetOrHead(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD';
}

function mcpGetPathname(pathname: string): boolean {
  return pathname === '/mcp' || pathname === '/mcp/';
}

function applyUaClass(headers: Headers, siteClass: Preference): void {
  if (siteClass === 'markdown') {
    headers.set('user-agent', MARKDOWN_CLASS_UA);
    return;
  }
  headers.delete('user-agent');
}

/**
 * Uncached-gateway rewrite (KTD1 / KTD8): classify HTML vs markdown the way
 * detectPreference already does, then canonicalize Accept and UA so Workers
 * Caching keys on the class rather than raw header strings. GET /mcp uses
 * detectMcpGetFormat so the JSON 301 cannot share a cache object with the
 * HTML/markdown page. www.anc.dev coalesces to anc.dev on production only.
 */
export function classifyGatewayRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.hostname === 'www.anc.dev') {
    url.hostname = 'anc.dev';
  }

  if (!isGetOrHead(request.method)) {
    if (url.href === request.url) return request;
    return new Request(url, request);
  }

  const headers = new Headers(request.headers);
  const siteClass = detectPreference(request);
  applyUaClass(headers, siteClass);

  if (mcpGetPathname(url.pathname)) {
    headers.set('accept', MCP_GET_CLASS_ACCEPT[detectMcpGetFormat(request)]);
  } else if (!url.pathname.startsWith('/api/')) {
    // Negotiated HTML/markdown site surface only. /api/score and friends
    // keep the inbound Accept so q-value JSON vs markdown still works (KTD8).
    headers.set('accept', SITE_CLASS_ACCEPT[siteClass]);
  }

  return new Request(url, {
    method: request.method,
    headers,
    redirect: request.redirect,
  });
}
