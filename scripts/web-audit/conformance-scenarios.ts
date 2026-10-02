// The conformance scenarios: each names the exchanges a stub fetch answers
// and the checks it is the subject of. The generator turns each into a
// scenario.json / scorecard.json pair under tests/fixtures/web-audit-conformance.
// Bodies and headers here are contract bytes: a change regenerates goldens
// on both sides of the CLI port.

import { OPENAPI_MAX_BODY_BYTES } from '../../src/worker/audit-web/ssrf';
import type { Exchange, ExchangeResponse, Scenario } from './conformance-corpus';

const BASE = 'https://example.com/';
const SPEC_VERSION = '0.0.0-corpus';
const MCP_PATH = '/mcp';
const LEGACY_PROTOCOL = '2025-06-18';
const MODERN_PROTOCOL = '2026-07-28';
const UNSUPPORTED_PROTOCOL = '2025-03-26';
const CLI_UA = 'curl/8.7.1';
const AI_UA = 'ChatGPT-User/1.0 (+https://openai.com/bot)';
const CORS_ORIGIN = 'https://example.com';

const u = (path: string): string => new URL(path, BASE).toString();

const res = (status: number, headers: Record<string, string>, body: string): ExchangeResponse => ({
  status,
  headers,
  body,
});
const html = (body: string, extra: Record<string, string> = {}, status = 200): ExchangeResponse =>
  res(status, { 'content-type': 'text/html; charset=utf-8', ...extra }, body);
const text = (body: string, extra: Record<string, string> = {}, status = 200): ExchangeResponse =>
  res(status, { 'content-type': 'text/plain; charset=utf-8', ...extra }, body);
const md = (body: string, extra: Record<string, string> = {}, status = 200): ExchangeResponse =>
  res(status, { 'content-type': 'text/markdown; charset=utf-8', ...extra }, body);
const json = (value: unknown, status = 200, extra: Record<string, string> = {}): ExchangeResponse =>
  res(status, { 'content-type': 'application/json', ...extra }, JSON.stringify(value));
const redirect = (location: string, status = 301): ExchangeResponse => res(status, { location }, '');
const failure = (error: string): ExchangeResponse => ({ error });
const TIMEOUT = failure('TimeoutError: deadline exceeded');
const REFUSED = failure('TypeError: connection refused');

const NOT_FOUND = html('<html><body><h1>Not found</h1><p>No such page.</p></body></html>', {}, 404);
const SERVER_ERROR = html('<html><body><h1>Internal error</h1></body></html>', {}, 500);

const rpcResult = (result: unknown, extra: Record<string, string> = {}): ExchangeResponse =>
  json({ jsonrpc: '2.0', id: 1, result }, 200, extra);
const rpcError = (code: number, status = 200, data?: Record<string, unknown>): ExchangeResponse =>
  json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope', ...(data === undefined ? {} : { data }) } }, status);

const get = (path: string, response: ExchangeResponse, headers?: Record<string, string>): Exchange => ({
  request: { method: 'GET', url: u(path), ...(headers === undefined ? {} : { headers }) },
  response,
});
type PostMatch = { headers?: Record<string, string>; body_json_method?: string; body_contains?: string };
const post = (path: string, response: ExchangeResponse, match: PostMatch = {}): Exchange => ({
  request: { method: 'POST', url: u(path), ...match },
  response,
});
const options = (path: string, response: ExchangeResponse): Exchange => ({
  request: { method: 'OPTIONS', url: u(path) },
  response,
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

type RootOptions = {
  description?: boolean;
  jsonld?: boolean;
  semantic?: boolean;
  noscript?: boolean;
  linkRel?: boolean;
  webmcp?: boolean;
  rich?: boolean;
};

function rootHtml(opts: RootOptions = {}): string {
  const o = { description: true, jsonld: true, semantic: true, noscript: true, linkRel: true, webmcp: true, rich: true, ...opts };
  const head = [
    '<meta charset="utf-8">',
    o.description ? '<meta name="description" content="Example: a site with agent entry points.">' : '',
    o.linkRel ? '<link rel="service-desc" href="/openapi.json">' : '',
    o.linkRel ? '<link rel="alternate" type="text/markdown" href="/index.md">' : '',
    o.jsonld ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>' : '',
    o.webmcp ? '<script src="/js/webmcp.js"></script>' : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  const prose = o.rich
    ? `<h1>Example</h1>\n<p>${'Readable prose about the example service and its agent surfaces. '.repeat(4)}</p>`
    : '<div id="app"></div>';
  const body = o.semantic ? `<main>\n${prose}\n</main>` : prose;
  const noscript = o.noscript ? '<noscript><a href="/llms.txt">llms.txt</a> <a href="/openapi.json">OpenAPI</a></noscript>' : '';
  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${body}\n${noscript}\n</body>\n</html>\n`;
}

const ROOT_HEADERS = {
  link: '<https://example.com/openapi.json>; rel="service-desc", <https://example.com/llms.txt>; rel="describedby"',
  vary: 'Accept, User-Agent',
};

const TWIN_WITH_FRONTMATTER = [
  '---',
  'title: Example',
  'description: An example site',
  'url: https://example.com/',
  '---',
  '',
  '# Example',
  '',
  'Welcome. [Docs](https://example.com/docs/guide.md)',
  '',
].join('\n');

const TWIN_PLAIN = '# Example\n\nWelcome. [Docs](https://example.com/docs/guide.md)\n';

/** The negotiated root: markdown for markdown-shaped requests, HTML otherwise. */
function negotiatedRoot(opts: { twin?: string; twinHeaders?: Record<string, string>; root?: RootOptions; rootHeaders?: Record<string, string> } = {}): Exchange[] {
  const twin = md(opts.twin ?? TWIN_WITH_FRONTMATTER, { vary: 'Accept, User-Agent', ...(opts.twinHeaders ?? {}) });
  return [
    get('/', twin, { accept: 'text/markdown' }),
    get('/', twin, { accept: 'text/plain' }),
    get('/', twin, { 'user-agent': CLI_UA }),
    get('/', twin, { 'user-agent': AI_UA }),
    get('/', html(rootHtml(opts.root), opts.rootHeaders ?? ROOT_HEADERS)),
  ];
}

const ROBOTS_FULL = 'User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nAllow: /\n\nContent-Signal: ai-train=yes, search=yes\n';
const ROBOTS_NO_SIGNAL = 'User-agent: *\nDisallow: /private\n';
const ROBOTS_NO_AI = 'Sitemap: https://example.com/sitemap.xml\n';

const SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>https://example.com/</loc></url>',
  '  <url><loc>https://example.com/docs/guide</loc></url>',
  '  <url><loc>https://example.com/blog/hello</loc></url>',
  '</urlset>',
  '',
].join('\n');

const LLMS_TXT_FULL = [
  '# Example',
  '',
  '> An example service with docs, an API and an MCP server.',
  '',
  '## Docs',
  '',
  '- [Guide](https://example.com/docs/guide.md): how the service works',
  '- [API reference](https://example.com/docs/api.md): every endpoint',
  '',
  '## When to use',
  '',
  'Call the MCP server for live data; read the docs for concepts.',
  '',
].join('\n');

const LLMS_TXT_H1_ONLY = '# Example\n';
const HTTP_LINK = 'http://example.com/docs/plain.md';
const LLMS_TXT_HTTP_LINK = LLMS_TXT_FULL.replace(
  '\n\n## When to use',
  `\n- [Plain](${HTTP_LINK}): the same docs over plaintext\n\n## When to use`,
);

const LLMS_FULL_TXT = '# Example\n\n## Guide\n\nEverything in one fetch.\n';
const SCOPED_LLMS = '# Docs\n\n- [Guide](/docs/guide.md)\n';
const GUIDE_MD = '# Guide\n\nA substantial guide body that runs well past the forty-character floor.\n';

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Example API', version: '1.0.0' },
  paths: {
    '/v1/items/{id}': { get: { responses: { '200': { description: 'ok' }, '404': { description: 'missing' } } } },
  },
};
const API_PROBE_PATH = '/v1/items/anc-web-audit-no-such';
const API_FALLBACK_PATH = '/anc-web-audit-no-such-api';
const OPENAPI_YAML = 'openapi: 3.1.0\ninfo:\n  title: Example files API\n  version: 1.0.0\npaths: {}\n';
const API_ERROR = { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } };
// Stripe-shaped: the `openapi` key follows a components object that alone
// runs past the bytes the description read takes.
const OPENAPI_PAST_THE_CAP = JSON.stringify({ components: { schemas: { padding: 'x'.repeat(OPENAPI_MAX_BODY_BYTES) } }, ...OPENAPI });
const linkset = (...contexts: unknown[]): ExchangeResponse =>
  res(200, { 'content-type': 'application/linkset+json' }, JSON.stringify({ linkset: contexts }));

const SERVER_CARD = {
  name: 'example',
  version: '1.0.0',
  mcp_endpoint: 'https://example.com/mcp',
  documentation: 'https://example.com/mcp-skill.md',
};
const SERVER_CARD_WITH_AUTH = { ...SERVER_CARD, authentication: { type: 'oauth2' } };
const CARD_PATH = '/.well-known/mcp/server-card.json';
const CARD_ALIASES = ['/.well-known/mcp', '/.well-known/mcp.json', '/mcp.json'];
const CARD_SUFFIX_PATH = `${MCP_PATH}/server-card`;

const MCP_CARD_TYPE = 'application/mcp-server-card+json';
const SEP_2127_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'com.example/example',
  version: '1.0.0',
  description: 'Example MCP server',
  remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
};
const cardDocument = (card: unknown): ExchangeResponse => res(200, { 'content-type': MCP_CARD_TYPE }, JSON.stringify(card));
const aiCatalog = (...entries: unknown[]): ExchangeResponse => json({ specVersion: '1.0', entries });
const cardEntry = (fields: Record<string, unknown>) => ({
  identifier: 'urn:air:example.com:mcp:example',
  type: MCP_CARD_TYPE,
  ...fields,
});

const TOOLS_RESULT = { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }, { name: 'ping' }] };
const RESOURCES_RESULT = { resources: [{ uri: 'anc://registry', name: 'registry' }] };
const INITIALIZE_RESULT = {
  serverInfo: { name: 'example', version: '1.0.0' },
  protocolVersion: LEGACY_PROTOCOL,
  capabilities: { tools: {}, resources: {} },
};
const DISCOVER_RESULT = {
  supportedVersions: [MODERN_PROTOCOL],
  capabilities: { tools: {}, resources: {} },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'example', version: '1.0.0' } },
};

const ACAO = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

type McpOptions = {
  /** Where the server answers; the audited site's /mcp unless a declared host serves it. */
  endpoint?: string;
  session?: string;
  cors?: 'full' | 'none' | 'preflight-only' | 'post-only';
  toolsFraming?: 'json' | 'sse';
  initializeResult?: unknown;
};

/** Modern-lane (SEP-2243) rules; every probe carries the protocol header. */
function modernMcp(): Exchange[] {
  const modern = { 'mcp-protocol-version': MODERN_PROTOCOL };
  return [
    post(MCP_PATH, rpcError(-32022, 400, { supported: [MODERN_PROTOCOL] }), {
      headers: { 'mcp-protocol-version': UNSUPPORTED_PROTOCOL },
    }),
    post(MCP_PATH, rpcError(-32020, 400), {
      headers: { ...modern, 'mcp-method': 'resources/list' },
      body_json_method: 'tools/list',
    }),
    post(MCP_PATH, rpcResult(DISCOVER_RESULT), { headers: { ...modern, 'mcp-method': 'server/discover' } }),
    post(MCP_PATH, rpcResult(TOOLS_RESULT), {
      headers: { ...modern, 'mcp-method': 'tools/list' },
      body_contains: 'clientCapabilities',
    }),
    post(MCP_PATH, rpcError(-32602, 400), { headers: { ...modern, 'mcp-method': 'tools/list' } }),
    post(MCP_PATH, rpcError(-32601, 404), { headers: { ...modern, 'mcp-method': 'nonexistent/method' } }),
    post(MCP_PATH, rpcError(-32602), { headers: { ...modern, 'mcp-method': 'resources/read' } }),
  ];
}

/** A server that does not serve the modern lane refuses every header-routed probe. */
function noModernLane(opts: McpOptions = {}): Exchange[] {
  const at = opts.endpoint ?? MCP_PATH;
  return [
    post(at, rpcError(-32601), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL } }),
    post(at, rpcError(-32601), { headers: { 'mcp-protocol-version': UNSUPPORTED_PROTOCOL } }),
  ];
}

/** Legacy-lane (initialize + JSON-RPC) rules. */
function legacyMcp(opts: McpOptions = {}): Exchange[] {
  const at = opts.endpoint ?? MCP_PATH;
  const sessionHeaders: Record<string, string> =
    opts.session === undefined ? {} : { 'mcp-session-id': opts.session };
  const postAcao = opts.cors === 'full' || opts.cors === 'post-only' ? ACAO : {};
  const toolsResponse =
    opts.toolsFraming === 'sse'
      ? res(
          200,
          { 'content-type': 'text/event-stream' },
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: TOOLS_RESULT })}\n\n`,
        )
      : rpcResult(TOOLS_RESULT);
  return [
    post(at, rpcError(-32700, 400), { body_contains: 'not-json{{' }),
    post(at, rpcError(-32600, 400), { body_contains: '[{' }),
    post(at, rpcResult(TOOLS_RESULT), { headers: { accept: 'application/json' }, body_json_method: 'tools/list' }),
    post(at, text('Not Acceptable', {}, 406), { headers: { accept: 'application/xml' } }),
    post(at, rpcResult(opts.initializeResult ?? INITIALIZE_RESULT, sessionHeaders), {
      body_json_method: 'initialize',
    }),
    post(at, res(202, {}, ''), { body_json_method: 'notifications/initialized' }),
    post(at, rpcResult(TOOLS_RESULT, postAcao), { headers: { origin: CORS_ORIGIN }, body_json_method: 'tools/list' }),
    post(at, toolsResponse, { body_json_method: 'tools/list' }),
    post(at, rpcResult(RESOURCES_RESULT), { body_json_method: 'resources/list' }),
    post(at, rpcError(-32602), { body_json_method: 'tools/call' }),
    post(at, rpcError(-32601), { body_json_method: 'nonexistent/method' }),
  ];
}

/** The non-POST surfaces of an MCP endpoint: the preflight and the GET. */
function mcpEdges(opts: McpOptions = {}): Exchange[] {
  const at = opts.endpoint ?? MCP_PATH;
  const preflight =
    opts.cors === 'full' || opts.cors === 'preflight-only' ? res(204, ACAO, '') : res(204, {}, '');
  return [options(at, preflight), get(at, text('Method Not Allowed', { allow: 'POST' }, 405))];
}

function dualStackMcp(opts: McpOptions = {}): Exchange[] {
  return [...mcpEdges(opts), ...modernMcp(), ...legacyMcp(opts)];
}

function legacyOnlyMcp(opts: McpOptions = {}): Exchange[] {
  return [...mcpEdges(opts), ...noModernLane(opts), ...legacyMcp(opts)];
}

function modernOnlyMcp(opts: McpOptions = {}): Exchange[] {
  return [...mcpEdges(opts), ...modernMcp(), post(MCP_PATH, rpcError(-32601))];
}

function cardSurface(card: unknown = SERVER_CARD): Exchange[] {
  return [
    get(CARD_PATH, json(card)),
    ...CARD_ALIASES.map((alias) => get(alias, redirect(u(CARD_PATH)))),
    get('/mcp-skill.md', md('# MCP usage\n\ncurl -X POST https://example.com/mcp\n')),
  ];
}

const DOH_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const DOH_NAMES = ['_index._agents.example.com', '_a2a._agents.example.com', '_mcp._agents.example.com'];
const dohUrl = (resolver: string, name: string): string => `${resolver}?name=${encodeURIComponent(name)}&type=SVCB`;
const dohGet = (resolver: string, name: string, response: ExchangeResponse): Exchange => ({
  request: { method: 'GET', url: dohUrl(resolver, name) },
  response,
});
const dohAnswer = (name: string): ExchangeResponse =>
  json({ Status: 0, Answer: [{ name, type: 64, TTL: 300, data: '1 .' }] }, 200, { 'content-type': 'application/dns-json' });
const DOH_NXDOMAIN = json({ Status: 3, Answer: [] }, 200, { 'content-type': 'application/dns-json' });

function dnsAll(response: (name: string) => ExchangeResponse): Exchange[] {
  return DOH_RESOLVERS.flatMap((resolver) => DOH_NAMES.map((name) => dohGet(resolver, name, response(name))));
}

function apiSurface(opts: { errorBody?: ExchangeResponse } = {}): Exchange[] {
  return [
    get('/openapi.json', json(OPENAPI)),
    get(API_PROBE_PATH, opts.errorBody ?? json({ error: 'not_found', message: 'no such item' }, 404, { 'ratelimit-limit': '60' })),
    get('/api/schema/input.json', json({ $schema: 'https://json-schema.org/draft/2020-12/schema' }, 200, {
      'content-type': 'application/schema+json',
    })),
    get('/.well-known/api-catalog', res(200, { 'content-type': 'application/linkset+json' }, JSON.stringify({ linkset: [] }))),
  ];
}

function discoveryAndAuthSurface(): Exchange[] {
  return [
    get('/.well-known/security.txt', text('Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00Z\n')),
    get('/.well-known/http-message-signatures-directory', json({ keys: [] })),
    get('/.well-known/agent-card.json', json({ name: 'example', version: '1.0.0', supportedInterfaces: [] })),
    get('/.well-known/ai-catalog.json', json({ specVersion: '1.0', entries: [] })),
    get('/.well-known/agent-skills/index.json', json({ skills: [] })),
    get('/.well-known/openid-configuration', json({ issuer: 'https://example.com', token_endpoint: 'https://example.com/token' })),
    get('/.well-known/oauth-protected-resource', json({ resource: 'https://example.com/mcp', authorization_servers: [] })),
    get('/.well-known/auth.md', md('# Auth\n\nRegister at /signup, then send a bearer token.\n')),
  ];
}

function contentSurface(opts: { llms?: string; robots?: string } = {}): Exchange[] {
  return [
    get('/robots.txt', text(opts.robots ?? ROBOTS_FULL)),
    get('/sitemap.xml', res(200, { 'content-type': 'application/xml' }, SITEMAP)),
    get('/llms.txt', text(opts.llms ?? LLMS_TXT_FULL)),
    get('/llms-full.txt', text(LLMS_FULL_TXT)),
    get('/docs/llms.txt', text(SCOPED_LLMS)),
    get('/docs/llms-full.txt', text(LLMS_FULL_TXT)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md('# API\n\nEvery endpoint, documented at length so the twin counts as content.\n')),
    get('/anc-web-audit-no-such-page', md('# Not found\n\nTry the [sitemap](/sitemap.xml) or [llms.txt](/llms.txt).\n', {}, 404), {
      accept: 'text/markdown',
    }),
    get('/anc-web-audit-no-such-page', NOT_FOUND),
  ];
}

/** Every surface answering as the registry wants it to. */
function fullSite(): Exchange[] {
  return [
    ...negotiatedRoot(),
    ...contentSurface(),
    ...apiSurface(),
    ...cardSurface(SERVER_CARD_WITH_AUTH),
    get(CARD_SUFFIX_PATH, NOT_FOUND),
    ...dualStackMcp({ cors: 'full' }),
    ...discoveryAndAuthSurface(),
    ...dnsAll((name) => (name.startsWith('_index') ? dohAnswer(name) : DOH_NXDOMAIN)),
  ];
}

function scenario(
  description: string,
  covers: string[],
  exchanges: Exchange[],
  opts: {
    site_type?: 'content' | 'api' | null;
    unmatched?: ExchangeResponse;
    allow_unmatched?: boolean;
    follow_declarations?: boolean;
  } = {},
): Scenario {
  return {
    description,
    covers,
    target: BASE,
    site_type: opts.site_type ?? null,
    spec_version: SPEC_VERSION,
    ...(opts.follow_declarations !== undefined ? { follow_declarations: opts.follow_declarations } : {}),
    unmatched: opts.unmatched ?? NOT_FOUND,
    allow_unmatched: opts.allow_unmatched ?? true,
    exchanges,
  };
}

const baseline = (): Exchange[] => [get('/', html(rootHtml()))];

// A declared host serving a legacy-lane MCP server at /mcp.
const DECLARED_ENDPOINT = 'https://mcp.example.net/mcp';

const REDIRECTED_ENDPOINT = 'https://mcp.example.org/mcp';
const HTTP_DECLARED_ENDPOINT = 'http://mcp.example.net/mcp';
const HTTP_REDIRECT_HOP = 'http://mcp.example.org/mcp';
const declaringCard = (endpoint: string): Exchange => get(CARD_PATH, json({ ...SERVER_CARD, mcp_endpoint: endpoint }));
const selfNamingCard = (endpoint: string): Exchange => get(`${endpoint}/server-card`, cardDocument({ ...SEP_2127_CARD, remotes: [{ type: 'streamable-http', url: endpoint }] }));
const FOLLOWED_IDS = ['mcp-initialize', 'mcp-tools-list', 'mcp-cors-preflight', 'mcp-cors-actual', 'mcp-get-fast-fail'];

const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const AUTH_SERVER = 'https://auth.example.com';
const challenge401 = (metadataUrl: string | null, extra: Record<string, string> = {}): ExchangeResponse =>
  res(
    401,
    {
      'content-type': 'application/json',
      ...(metadataUrl === null ? {} : { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` }),
      ...extra,
    },
    '{"error":"unauthorized"}',
  );

/**
 * An MCP server behind OAuth at `endpoint`: every POST draws a 401 whose
 * challenge names `metadataUrl`, apart from an unparseable body and an
 * unsupported version claim, which it refuses before reading a token.
 */
function protectedMcp(endpoint: string, metadataUrl: string): Exchange[] {
  return [
    post(endpoint, rpcError(-32700, 400), { body_contains: 'not-json{{' }),
    post(endpoint, rpcError(-32022, 400, { supported: [MODERN_PROTOCOL] }), {
      headers: { 'mcp-protocol-version': UNSUPPORTED_PROTOCOL },
    }),
    post(endpoint, challenge401(metadataUrl, ACAO), { headers: { origin: CORS_ORIGIN } }),
    post(endpoint, challenge401(metadataUrl)),
    options(endpoint, res(204, ACAO, '')),
    get(endpoint, challenge401(metadataUrl)),
  ];
}

const ENFORCEMENT_IDS = ['mcp-auth-challenge', 'mcp-auth-servers', 'mcp-auth-enforced'];

const SIGN_IN_IDS = [
  'mcp-initialize',
  'mcp-capabilities',
  'mcp-tools-list',
  'mcp-resources-list',
  'mcp-server-discover',
  'mcp-malformed-body',
  'mcp-modern-version-reject',
  'mcp-get-fast-fail',
  'mcp-cors-preflight',
  'mcp-cors-actual',
];

const MCP_IDS = [
  'mcp-initialize',
  'mcp-capabilities',
  'mcp-tools-list',
  'mcp-resources-list',
  'mcp-modern-tools-list',
  'mcp-server-discover',
  'mcp-unknown-method',
  'mcp-malformed-body',
  'mcp-batch-reject',
  'mcp-unknown-tool',
  'mcp-modern-unknown-method',
  'mcp-modern-clientcaps',
  'mcp-modern-header-mismatch',
  'mcp-modern-version-reject',
  'mcp-modern-resources-miss',
  'mcp-accept-json',
  'mcp-accept-unsatisfiable',
  'mcp-get-fast-fail',
];

const ALL_IDS = [
  'openapi',
  'json-schemas',
  'api-catalog',
  'json-errors',
  'rate-limit-headers',
  ...MCP_IDS,
  'mcp-cors-preflight',
  'mcp-cors-actual',
  'well-known-mcp-card',
  'mcp-card-legacy-aliases',
  'mcp-usage-doc',
  'webmcp',
  'llms-txt',
  'llms-txt-format',
  'llms-txt-links',
  'llms-txt-when-to-use',
  'llms-full-txt',
  'llms-txt-scoped',
  'llms-full-txt-scoped',
  'accept-markdown',
  'markdown-cli-ua',
  'markdown-agent-ua',
  'agent-ua-reachable',
  'markdown-accept-plain',
  'markdown-vary',
  'markdown-frontmatter',
  'root-meta-description',
  'schema-org-jsonld',
  'content-without-js',
  'semantic-html',
  'noscript-fallback',
  'robots',
  'sitemap',
  'agent-friendly-404',
  'agent-friendly-404-md',
  'link-headers',
  'root-link-rel',
  'dns-aid',
  'robots-ai-rules',
  'content-signals',
  'web-bot-auth',
  'security-txt',
  'a2a-agent-card',
  'ai-catalog',
  'agent-skills',
  'oauth-discovery',
  'oauth-protected-resource',
  'auth-md',
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const HUGE_TOOLS = { tools: Array.from({ length: 1200 }, (_, i) => ({ name: `tool-${i}`, description: 'x'.repeat(48), inputSchema: {} })) };

export const SCENARIOS: Record<string, Scenario> = {
  // ---- whole runs -----------------------------------------------------------
  'run-all-pass': scenario('every surface answers as the registry wants it to', ALL_IDS, fullSite(), {
    allow_unmatched: false,
  }),
  'run-healthy': scenario(
    'a healthy site with a handful of misses across tiers',
    ['content-signals', 'security-txt', 'web-bot-auth', 'noscript-fallback', 'mcp-cors-preflight', 'mcp-cors-actual', 'rate-limit-headers'],
    [
      ...negotiatedRoot({ root: { noscript: false } }),
      ...contentSurface({ robots: ROBOTS_NO_SIGNAL }),
      ...apiSurface({ errorBody: json({ error: 'not_found' }, 404) }),
      ...cardSurface(SERVER_CARD_WITH_AUTH),
      ...dualStackMcp({ cors: 'none' }),
      get('/.well-known/security.txt', SERVER_ERROR),
      get('/.well-known/agent-card.json', json({ name: 'example', version: '1.0.0', supportedInterfaces: [] })),
      get('/.well-known/ai-catalog.json', json({ specVersion: '1.0', entries: [] })),
      get('/.well-known/agent-skills/index.json', json({ skills: [] })),
      get('/.well-known/openid-configuration', json({ issuer: 'https://example.com' })),
      get('/.well-known/oauth-protected-resource', json({ resource: 'https://example.com/mcp' })),
      get('/.well-known/auth.md', md('# Auth\n\nSend a bearer token.\n')),
      ...dnsAll(() => DOH_NXDOMAIN),
    ],
  ),
  'run-unreachable': scenario('nothing answers at the network level', ['robots', 'llms-txt'], [], { unmatched: REFUSED }),
  'run-edge-530': scenario(
    'every probe comes back as a Cloudflare edge error, which is not the target answering',
    ['robots', 'llms-txt'],
    [],
    { unmatched: html('<html><body>Origin DNS error</body></html>', {}, 530) },
  ),
  'run-antecedent-unmet': scenario(
    'a bare HTML site: no llms.txt, no API surface, no MCP endpoint, so every gated check is `n_a`',
    ['llms-txt-format', 'llms-txt-links', 'llms-txt-when-to-use', 'llms-txt-scoped', 'llms-full-txt-scoped', 'json-schemas', 'api-catalog', 'json-errors', 'rate-limit-headers', 'mcp-cors-preflight', 'mcp-cors-actual', 'well-known-mcp-card', 'mcp-card-legacy-aliases', 'mcp-usage-doc', 'oauth-protected-resource', 'robots-ai-rules', 'content-signals', 'auth-md', ...MCP_IDS],
    [get('/', html(rootHtml({ linkRel: false, webmcp: false })))],
  ),
  'run-root-not-html': scenario(
    'the root is JSON, so every HTML-root check and the markdown twin family are `n_a`',
    ['webmcp', 'accept-markdown', 'markdown-vary', 'markdown-frontmatter', 'root-meta-description', 'schema-org-jsonld', 'content-without-js', 'semantic-html', 'noscript-fallback', 'root-link-rel'],
    [get('/', json({ service: 'example' }))],
  ),
  'run-root-401': scenario(
    'a root that challenges for auth still audits, and the challenge satisfies the auth antecedent',
    ['auth-md', 'oauth-discovery', 'agent-ua-reachable'],
    [
      get('/', html('<html><body>Sign in</body></html>', { 'www-authenticate': 'Bearer realm="example"' }, 401)),
      get('/.well-known/auth.md', md('# Auth\n\nRegister first.\n')),
    ],
  ),
  'run-site-type-api': scenario(
    'the full site declared as an API: content-only checks are `n_a` at the type filter',
    ['llms-full-txt', 'llms-txt-scoped', 'llms-full-txt-scoped', 'openapi', 'json-errors'],
    fullSite(),
    { site_type: 'api', allow_unmatched: false },
  ),
  'run-site-type-content': scenario(
    'the full site declared as content: API-only checks are `n_a` at the type filter, MCP still applies on discovery',
    ['openapi', 'json-schemas', 'api-catalog', 'json-errors', 'rate-limit-headers', 'llms-full-txt', 'mcp-initialize'],
    fullSite(),
    { site_type: 'content', allow_unmatched: false },
  ),
  'run-redirects': scenario(
    'redirect chains: a two-hop public chain is followed, a hop into the metadata range is refused, a cross-origin hop lands on a 404, and a five-hop chain exceeds the cap',
    ['llms-txt', 'robots', 'sitemap', 'security-txt'],
    [
      ...baseline(),
      get('/llms.txt', redirect(u('/docs/llms.txt'))),
      get('/docs/llms.txt', redirect(u('/docs/llms-v2.txt'), 302)),
      get('/docs/llms-v2.txt', text(LLMS_TXT_FULL)),
      get('/docs/guide.md', md(GUIDE_MD)),
      get('/docs/api.md', md(GUIDE_MD)),
      get('/robots.txt', redirect('http://169.254.169.254/robots.txt', 302)),
      get('/sitemap.xml', redirect('https://cdn.example.net/sitemap.xml')),
      get('/.well-known/security.txt', redirect(u('/s1'))),
      get('/s1', redirect(u('/s2'))),
      get('/s2', redirect(u('/s3'))),
      get('/s3', redirect(u('/s4'))),
      get('/s4', redirect(u('/s5'))),
      get('/s5', text('Contact: mailto:security@example.com\n')),
    ],
  ),
  'run-document-redirects-to-http': scenario(
    'the audited site answers /llms.txt and its API catalog with a redirect to the same path over http, where each would answer: neither hop is taken, and each document reads as missing (llms.txt absent, the optional API catalog n_a), its evidence naming the redirect to http',
    ['llms-txt', 'api-catalog'],
    [
      ...baseline(),
      get('/llms.txt', redirect('http://example.com/llms.txt')),
      get('http://example.com/llms.txt', text(LLMS_TXT_FULL)),
      get('/.well-known/api-catalog', redirect('http://example.com/.well-known/api-catalog')),
      get('http://example.com/.well-known/api-catalog', linkset()),
    ],
  ),
  'run-root-redirects-to-http': scenario(
    'every https request, the root included, redirects to the http root, which would answer: the run ends unreachable after the root request alone, and nothing is requested over http',
    ['agent-ua-reachable', 'content-without-js'],
    [get('/', redirect('http://example.com/')), get('http://example.com/', html(rootHtml()))],
    { unmatched: redirect('http://example.com/') },
  ),
  'run-body-over-cap': scenario(
    'bodies past the 64 KiB probe cap are truncated: a huge tools/list no longer parses and a huge JSON error body reads as non-JSON',
    ['mcp-tools-list', 'json-errors'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, rpcResult(INITIALIZE_RESULT), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcResult(HUGE_TOOLS), { body_json_method: 'tools/list' }),
      post(MCP_PATH, rpcError(-32601)),
      get('/openapi.json', json(OPENAPI)),
      get(API_PROBE_PATH, json({ error: 'not_found', padding: 'x'.repeat(70_000) }, 404)),
    ],
  ),

  // ---- http handler ----------------------------------------------------------
  'http-llms-txt-pass': scenario('a 200 llms.txt with a link index passes and retains its body', ['llms-txt'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ]),
  'http-llms-txt-absent': scenario('a 404 on the only candidate is absent', ['llms-txt'], baseline()),
  'http-robots-broken': scenario('a 5xx where a document is expected is broken', ['robots'], [
    ...baseline(),
    get('/robots.txt', SERVER_ERROR),
  ]),
  'http-path-any-second-candidate': scenario('`openapi` passes on its second `path_any` candidate', ['openapi'], [
    ...baseline(),
    get('/openapi.yaml', res(200, { 'content-type': 'application/yaml' }, 'openapi: 3.1.0\ninfo:\n  title: Example\n')),
  ]),
  'http-content-type-mismatch': scenario('a 200 with the wrong content type is broken (present but invalid)', ['json-schemas'], [
    ...baseline(),
    get('/openapi.json', json(OPENAPI)),
    get('/api/schema/input.json', html('<html>not a schema</html>')),
  ]),
  'http-affordance-absent': scenario(
    'a failed body assertion without a status expectation is absent, not broken',
    ['root-meta-description', 'noscript-fallback', 'semantic-html', 'schema-org-jsonld', 'root-link-rel'],
    [get('/', html(rootHtml({ description: false, noscript: false, semantic: false, jsonld: false, linkRel: false })))],
  ),
  'http-mixed-candidates-broken': scenario('across `path_any` candidates a broken candidate outranks absent ones', ['agent-skills'], [
    ...baseline(),
    get('/.well-known/agent-skills/index.json', SERVER_ERROR),
  ]),
  'http-transport-timeout-error': scenario('a timeout on a check without an explicit hang budget is an operational error', ['llms-txt'], [
    ...baseline(),
    get('/llms.txt', TIMEOUT),
  ]),
  'http-get-fast-fail-timeout-broken': scenario(
    'a held-open GET on the MCP endpoint times out against its explicit budget and is broken',
    ['mcp-get-fast-fail'],
    [...baseline(), ...cardSurface(), get(MCP_PATH, TIMEOUT), ...noModernLane(), ...legacyMcp()],
  ),
  'http-header-regex-pass': scenario('Link and Vary header assertions pass on the root headers', ['link-headers', 'markdown-vary'], [
    ...negotiatedRoot(),
  ]),
  'http-header-regex-absent': scenario('Link and Vary header assertions miss when the headers are absent', ['link-headers', 'markdown-vary'], [
    ...negotiatedRoot({ rootHeaders: {}, twinHeaders: {} }),
  ]),
  'http-challenge-interstitial': scenario(
    'an AI user-fetcher that receives a bot challenge page fails the reachability check',
    ['agent-ua-reachable', 'markdown-agent-ua'],
    [
      get('/', html('<html><body>Just a moment...</body></html>', {}, 503), { 'user-agent': AI_UA }),
      get('/', html(rootHtml())),
    ],
  ),
  'http-ua-negotiation': scenario(
    'the CLI and AI user-agent probes receive the markdown twin while the default probe receives HTML',
    ['markdown-cli-ua', 'markdown-agent-ua', 'accept-markdown', 'markdown-accept-plain', 'agent-ua-reachable'],
    negotiatedRoot(),
  ),
  'http-ua-negotiation-absent': scenario(
    'every markdown-shaped request receives HTML, so the twin family is absent',
    ['markdown-cli-ua', 'markdown-agent-ua', 'accept-markdown', 'markdown-accept-plain'],
    [get('/', html(rootHtml(), ROOT_HEADERS))],
  ),
  'http-404-markdown-recovery': scenario(
    'a markdown 404 body with a same-origin recovery link passes, and a real 404 status passes the plain check',
    ['agent-friendly-404', 'agent-friendly-404-md'],
    [
      ...baseline(),
      get('/anc-web-audit-no-such-page', md('# Not found\n\nSee the [sitemap](/sitemap.xml).\n', {}, 404), { accept: 'text/markdown' }),
      get('/anc-web-audit-no-such-page', NOT_FOUND),
    ],
  ),
  'http-404-markdown-no-recovery': scenario(
    'a markdown 404 body without a recovery link misses the same-origin-recovery assertion',
    ['agent-friendly-404-md'],
    [
      ...baseline(),
      get('/anc-web-audit-no-such-page', md('# Not found\n\nGo [home](/).\n', {}, 404), { accept: 'text/markdown' }),
      get('/anc-web-audit-no-such-page', NOT_FOUND),
    ],
  ),
  'http-soft-404': scenario('a 200 shell on an unknown path is a soft 404 and broken', ['agent-friendly-404', 'agent-friendly-404-md'], [
    ...baseline(),
    get('/anc-web-audit-no-such-page', html(rootHtml())),
  ]),
  'http-robots-ai-rules': scenario(
    'robots.txt with AI-crawler rules and content signals passes both gated checks',
    ['robots', 'robots-ai-rules', 'content-signals'],
    [...baseline(), get('/robots.txt', text(ROBOTS_FULL))],
  ),
  'http-robots-no-ai-rules': scenario(
    'robots.txt without a User-agent line or Content-Signal misses both gated checks',
    ['robots-ai-rules', 'content-signals'],
    [...baseline(), get('/robots.txt', text(ROBOTS_NO_AI))],
  ),
  'http-discovery-cards': scenario(
    'the well-known discovery and auth documents answer with the expected JSON shapes',
    ['a2a-agent-card', 'ai-catalog', 'agent-skills', 'security-txt', 'web-bot-auth', 'oauth-discovery', 'api-catalog', 'sitemap', 'llms-full-txt'],
    [...baseline(), ...discoveryAndAuthSurface(), ...apiSurface(), get('/sitemap.xml', res(200, { 'content-type': 'application/xml' }, SITEMAP)), get('/llms-full.txt', text(LLMS_FULL_TXT))],
    { site_type: 'content' },
  ),
  'http-discovery-cards-broken': scenario(
    'discovery documents that answer 200 with the wrong shape are broken',
    ['a2a-agent-card', 'ai-catalog', 'agent-skills', 'security-txt', 'web-bot-auth'],
    [
      ...baseline(),
      get('/.well-known/security.txt', text('nothing here')),
      get('/.well-known/http-message-signatures-directory', json({ nope: true })),
      get('/.well-known/agent-card.json', html('<html>card</html>')),
      get('/.well-known/ai-catalog.json', json({ version: '1' })),
      get('/.well-known/agent-skills/index.json', json({ tools: [] })),
    ],
  ),

  // ---- legacy-alias-redirects eval -------------------------------------------
  'alias-redirect-pass': scenario('one legacy card path 301s to the canonical card, which is enough to pass', ['mcp-card-legacy-aliases', 'well-known-mcp-card', 'mcp-usage-doc'], [
    ...baseline(),
    get(CARD_PATH, json(SERVER_CARD)),
    get('/.well-known/mcp.json', redirect(u(CARD_PATH))),
    get('/mcp-skill.md', md('# MCP usage\n')),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),
  'alias-inline-copy-noncompliant': scenario('a legacy path serving its own copy of the card is noncompliant', ['mcp-card-legacy-aliases'], [
    ...baseline(),
    get(CARD_PATH, json(SERVER_CARD)),
    get('/mcp.json', json(SERVER_CARD)),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),
  'alias-redirect-away-broken': scenario('a legacy path that 301s away from the canonical card is broken', ['mcp-card-legacy-aliases'], [
    ...baseline(),
    get(CARD_PATH, json(SERVER_CARD)),
    get('/.well-known/mcp', redirect(u('/somewhere-else.json'))),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),
  'alias-non-permanent-broken': scenario('a 302 to the canonical card signals no canonical intent and is broken', ['mcp-card-legacy-aliases'], [
    ...baseline(),
    get(CARD_PATH, json(SERVER_CARD)),
    get('/.well-known/mcp', redirect(u(CARD_PATH), 302)),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),
  'alias-unpublished-optional-absent': scenario('no legacy path published at all is optional-absent, never a penalty', ['mcp-card-legacy-aliases'], [
    ...baseline(),
    get(CARD_PATH, json(SERVER_CARD)),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),

  // ---- cors-preflight ---------------------------------------------------------
  'cors-posture-consistent': scenario('no Allow-Origin on the preflight or the POST is a consistent no-CORS posture: both rows `n_a`', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    ...dualStackMcp({ cors: 'none' }),
  ]),
  'cors-full-pass': scenario('Allow-Origin on both surfaces passes both rows', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    ...dualStackMcp({ cors: 'full' }),
  ]),
  'cors-preflight-only': scenario('the preflight declares CORS but the POST omits Allow-Origin: preflight pass, actual broken', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    ...dualStackMcp({ cors: 'preflight-only' }),
  ]),
  'cors-post-only': scenario('the POST carries Allow-Origin but the preflight does not: preflight broken, actual pass', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    ...dualStackMcp({ cors: 'post-only' }),
  ]),
  'cors-preflight-500-with-acao': scenario('Allow-Origin on a failing preflight is misconfigured: preflight broken, actual classifies from its own POST', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    options(MCP_PATH, res(500, ACAO, 'oops')),
    get(MCP_PATH, text('Method Not Allowed', {}, 405)),
    ...modernMcp(),
    ...legacyMcp({ cors: 'post-only' }),
  ]),
  'cors-preflight-transport-failure': scenario('a transport failure on the preflight suppresses only the preflight row; the actual row classifies from its POST', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    options(MCP_PATH, REFUSED),
    get(MCP_PATH, text('Method Not Allowed', {}, 405)),
    ...modernMcp(),
    ...legacyMcp({ cors: 'post-only' }),
  ]),
  'cors-post-transport-failure-no-cors': scenario('a bare preflight beside a failed POST is an operational unknown, not a declared posture', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    options(MCP_PATH, res(204, {}, '')),
    get(MCP_PATH, text('Method Not Allowed', {}, 405)),
    post(MCP_PATH, REFUSED, { headers: { origin: CORS_ORIGIN } }),
    ...modernMcp(),
    ...legacyMcp(),
  ]),
  'cors-post-rate-limited-no-cors': scenario('a bare preflight beside a POST answered HTTP 408 is an operational unknown on both rows, not a declared posture', ['mcp-cors-preflight', 'mcp-cors-actual'], [
    ...baseline(),
    ...cardSurface(),
    options(MCP_PATH, res(204, {}, '')),
    get(MCP_PATH, text('Method Not Allowed', {}, 405)),
    post(MCP_PATH, text('Request Timeout', {}, 408), { headers: { origin: CORS_ORIGIN } }),
    ...modernMcp(),
    ...legacyMcp(),
  ]),

  // ---- mcp handler -----------------------------------------------------------
  'mcp-dual-stack': scenario('a dual-stack server passes every legacy, modern, conformance and negotiation row', MCP_IDS, [
    ...baseline(),
    ...cardSurface(),
    ...dualStackMcp({ cors: 'full' }),
  ]),
  'mcp-legacy-lane': scenario('a legacy-only server discovered by initialize: legacy rows pass, modern rows read the lane as absent', MCP_IDS, [
    ...baseline(),
    ...legacyOnlyMcp(),
  ]),
  'mcp-modern-lane': scenario('a modern-only server discovered by the header-routed fallback: modern rows pass, legacy rows read the lane as absent', MCP_IDS, [
    ...baseline(),
    ...modernOnlyMcp(),
  ]),
  'mcp-sse-framing': scenario('a legacy tools/list answered as text/event-stream parses the first data line', ['mcp-tools-list'], [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp({ toolsFraming: 'sse' }),
  ]),
  'mcp-open-stream': scenario(
    'a server that answers initialize on a stream it never closes: the seam records the per-check timeout, exactly as a live run does',
    ['mcp-initialize', 'mcp-capabilities'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, TIMEOUT, { body_json_method: 'initialize' }),
      ...legacyMcp(),
    ],
  ),
  'mcp-stateful-session': scenario(
    'a stateful server issues a session on initialize, refuses sessionless conformance probes with -32000, and is scored on the re-ask',
    ['mcp-malformed-body', 'mcp-batch-reject', 'mcp-unknown-tool', 'mcp-tools-list', 'mcp-resources-list'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, rpcError(-32700, 400), { headers: { 'mcp-session-id': 'sess-1' }, body_contains: 'not-json{{' }),
      post(MCP_PATH, rpcError(-32600, 400), { headers: { 'mcp-session-id': 'sess-1' }, body_contains: '[{' }),
      post(MCP_PATH, rpcError(-32602), { headers: { 'mcp-session-id': 'sess-1' }, body_json_method: 'tools/call' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT, ACAO), { headers: { 'mcp-session-id': 'sess-1', origin: CORS_ORIGIN } }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { 'mcp-session-id': 'sess-1' }, body_json_method: 'tools/list' }),
      post(MCP_PATH, rpcResult(RESOURCES_RESULT), { headers: { 'mcp-session-id': 'sess-1' }, body_json_method: 'resources/list' }),
      post(MCP_PATH, rpcError(-32601), { headers: { 'mcp-session-id': 'sess-1' }, body_json_method: 'nonexistent/method' }),
      post(MCP_PATH, res(202, {}, ''), { headers: { 'mcp-session-id': 'sess-1' }, body_json_method: 'notifications/initialized' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { accept: 'application/json' }, body_json_method: 'tools/list' }),
      post(MCP_PATH, text('Not Acceptable', {}, 406), { headers: { accept: 'application/xml' } }),
      post(MCP_PATH, rpcResult(INITIALIZE_RESULT, { 'mcp-session-id': 'sess-1' }), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcError(-32000)),
    ],
  ),
  'mcp-wrong-error-codes': scenario(
    'conformance probes refused under the wrong code are noncompliant; a result where a refusal was required is broken',
    ['mcp-malformed-body', 'mcp-batch-reject', 'mcp-unknown-tool', 'mcp-unknown-method', 'mcp-modern-unknown-method', 'mcp-modern-clientcaps', 'mcp-modern-header-mismatch', 'mcp-modern-version-reject', 'mcp-modern-resources-miss'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      post(MCP_PATH, rpcError(-32600), { headers: { 'mcp-protocol-version': UNSUPPORTED_PROTOCOL } }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'resources/list' }, body_json_method: 'tools/list' }),
      post(MCP_PATH, rpcResult(DISCOVER_RESULT), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'server/discover' } }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'tools/list' } }),
      post(MCP_PATH, rpcError(-32000), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'nonexistent/method' } }),
      post(MCP_PATH, rpcResult({ contents: [] }), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'resources/read' } }),
      post(MCP_PATH, rpcError(-32600, 400), { body_contains: 'not-json{{' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { body_contains: '[{' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { accept: 'application/json' }, body_json_method: 'tools/list' }),
      post(MCP_PATH, text('Not Acceptable', {}, 406), { headers: { accept: 'application/xml' } }),
      post(MCP_PATH, rpcResult(INITIALIZE_RESULT), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { body_json_method: 'tools/list' }),
      post(MCP_PATH, rpcResult(RESOURCES_RESULT), { body_json_method: 'resources/list' }),
      post(MCP_PATH, rpcError(-32601), { body_json_method: 'tools/call' }),
      post(MCP_PATH, rpcError(-32602), { body_json_method: 'nonexistent/method' }),
    ],
  ),
  'mcp-garbage-responses': scenario('a discovered endpoint that answers every POST with an HTML 500 is broken on every probed row', MCP_IDS, [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    post(MCP_PATH, SERVER_ERROR),
  ]),
  'mcp-typed-http-refusals': scenario(
    'bare HTTP 400/415 refusals with no envelope conform where the row allows them; a bare 404 never does',
    ['mcp-malformed-body', 'mcp-accept-unsatisfiable', 'mcp-batch-reject', 'mcp-unknown-tool'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, html('<html>Bad request</html>', {}, 415), { body_contains: 'not-json{{' }),
      post(MCP_PATH, json({ error: 'batch' }, 400), { body_contains: '[{' }),
      post(MCP_PATH, NOT_FOUND, { body_json_method: 'tools/call' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { accept: 'application/json' }, body_json_method: 'tools/list' }),
      post(MCP_PATH, html('<html>Bad request</html>', {}, 400), { headers: { accept: 'application/xml' } }),
      post(MCP_PATH, rpcResult(INITIALIZE_RESULT), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { body_json_method: 'tools/list' }),
      post(MCP_PATH, rpcResult(RESOURCES_RESULT), { body_json_method: 'resources/list' }),
      post(MCP_PATH, rpcError(-32601), { body_json_method: 'nonexistent/method' }),
    ],
  ),
  'mcp-rate-limited': scenario('a -32099 rate-limit refusal is an operational error on every row, never a penalty', MCP_IDS, [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    post(MCP_PATH, rpcError(-32099)),
  ]),
  'mcp-http-rate-limited': scenario(
    'an HTTP 429 or 408 answer is an operational error on every row whatever body rides it, like a -32099 refusal',
    MCP_IDS,
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      post(MCP_PATH, rpcError(-32000, 429), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcError(-32000, 429), { headers: { 'mcp-method': 'server/discover' } }),
      post(MCP_PATH, text('Request Timeout', {}, 408), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL } }),
      post(MCP_PATH, text('Too Many Requests', { 'retry-after': '60' }, 429)),
    ],
  ),
  'mcp-discover-rate-limited': scenario(
    'a 429 on server/discover alone leaves the modern lane unknown, so the modern rows probe on their own answers instead of reading absent',
    [
      'mcp-server-discover',
      'mcp-modern-tools-list',
      'mcp-modern-unknown-method',
      'mcp-modern-clientcaps',
      'mcp-modern-header-mismatch',
      'mcp-modern-version-reject',
      'mcp-modern-resources-miss',
    ],
    [
      ...baseline(),
      ...cardSurface(),
      post(MCP_PATH, text('Too Many Requests', { 'retry-after': '60' }, 429), { headers: { 'mcp-method': 'server/discover' } }),
      ...dualStackMcp(),
    ],
  ),
  'mcp-edges-rate-limited': scenario(
    'the GET and the preflight answer HTTP 429, the preflight with Allow-Origin, while the Origin-bearing POST carries Allow-Origin: the GET fast-fail and preflight rows are operational errors, and the actual row, which its own Allow-Origin settles, passes',
    ['mcp-get-fast-fail', 'mcp-cors-preflight', 'mcp-cors-actual'],
    [
      ...baseline(),
      ...cardSurface(),
      options(MCP_PATH, text('Too Many Requests', { ...ACAO, 'retry-after': '60' }, 429)),
      get(MCP_PATH, text('Too Many Requests', { 'retry-after': '60' }, 429)),
      ...modernMcp(),
      ...legacyMcp({ cors: 'post-only' }),
    ],
  ),
  'mcp-www-authenticate': scenario(
    'an endpoint that answers legacy POSTs with a 401 whose challenge names no metadata, while root RFC 9728 metadata names it: it requires sign-in, so the legacy session rows, the resources rows, and every row a 401 answers read auth-required, and the challenge satisfies the mcp-auth antecedent; its modern lane refuses server/discover with a method-not-found and no 401, an answer a token would not change, so the modern session rows read absent as they do on an open server',
    ['mcp-initialize', 'mcp-server-discover', 'mcp-auth-challenge', 'oauth-protected-resource', 'auth-md'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, res(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="mcp"' }, '{"error":"unauthorized"}')),
      get('/.well-known/oauth-protected-resource', json({ resource: 'https://example.com/mcp', authorization_servers: ['https://example.com'] })),
    ],
  ),
  'mcp-negotiation-defects': scenario(
    'a stream answered to a JSON-only client is broken and a 200 with an unasked-for type is noncompliant',
    ['mcp-accept-json', 'mcp-accept-unsatisfiable'],
    [
      ...baseline(),
      ...cardSurface(),
      ...mcpEdges(),
      ...noModernLane(),
      post(MCP_PATH, res(200, { 'content-type': 'text/event-stream' }, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: TOOLS_RESULT })}\n\n`), { headers: { accept: 'application/json' } }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { headers: { accept: 'application/xml' } }),
      ...legacyMcp(),
    ],
  ),
  'mcp-resources-unadvertised': scenario('capabilities that omit resources gate both resources rows to `n_a`', ['mcp-resources-list', 'mcp-modern-resources-miss'], [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp({ initializeResult: { ...INITIALIZE_RESULT, capabilities: { tools: {} } } }),
  ]),
  'mcp-resources-empty-broken': scenario('resources advertised but resources/list returns an empty array is broken', ['mcp-resources-list'], [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    ...noModernLane(),
    post(MCP_PATH, rpcResult({ resources: [] }), { body_json_method: 'resources/list' }),
    ...legacyMcp(),
  ]),
  'mcp-capabilities-empty': scenario('an initialize result with empty capabilities passes initialize but is broken on the capabilities row', ['mcp-initialize', 'mcp-capabilities'], [
    ...baseline(),
    ...cardSurface(),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp({ initializeResult: { serverInfo: { name: 'example' }, protocolVersion: LEGACY_PROTOCOL, capabilities: {} } }),
  ]),
  'mcp-card-off-origin': scenario('a card declaring an off-origin endpoint is recorded and never probed; discovery falls through to initialize', ['well-known-mcp-card', 'mcp-initialize'], [
    ...baseline(),
    get(CARD_PATH, json({ ...SERVER_CARD, mcp_endpoint: 'https://mcp.example.net/mcp' })),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),
  'mcp-card-no-endpoint-field': scenario('a card without an endpoint field passes the card check while discovery falls through to initialize', ['well-known-mcp-card', 'mcp-initialize'], [
    ...baseline(),
    get(CARD_PATH, json({ name: 'example', serverInfo: { name: 'example' } })),
    ...mcpEdges(),
    ...noModernLane(),
    ...legacyMcp(),
  ]),

  // ---- discovery order: SEP-2127 catalog, card suffix, SEP-1649 --------------
  'discovery-catalog-card': scenario(
    'an AI catalog entry names a SEP-2127 card on the audited origin; its streamable-http remote is the endpoint, so no common path is POSTed',
    ['ai-catalog', 'mcp-initialize'],
    [
      ...baseline(),
      get('/.well-known/ai-catalog.json', aiCatalog(cardEntry({ url: u(CARD_SUFFIX_PATH) }))),
      get(CARD_SUFFIX_PATH, cardDocument(SEP_2127_CARD)),
      ...legacyOnlyMcp(),
    ],
  ),
  'discovery-catalog-inline-card': scenario(
    'an AI catalog entry carries its SEP-2127 card inline; the card is read in place and its remote is the endpoint',
    ['ai-catalog', 'mcp-initialize'],
    [...baseline(), get('/.well-known/ai-catalog.json', aiCatalog(cardEntry({ data: SEP_2127_CARD }))), ...legacyOnlyMcp()],
  ),
  'discovery-catalog-declarations': scenario(
    'catalog cards off the audited origin or behind a URL template are declared, never requested; discovery falls through to initialize',
    ['mcp-initialize'],
    [
      ...baseline(),
      get(
        '/.well-known/ai-catalog.json',
        aiCatalog(
          cardEntry({ url: 'https://cards.example.net/example/server-card' }),
          cardEntry({ data: { ...SEP_2127_CARD, remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' }] } }),
        ),
      ),
      ...legacyOnlyMcp(),
    ],
  ),
  'discovery-suffix-card': scenario(
    'no catalog and no well-known card: initialize finds the endpoint, and the SEP-2127 card under the endpoint at /mcp/server-card is the card of record',
    ['mcp-initialize'],
    [...baseline(), get(CARD_SUFFIX_PATH, cardDocument(SEP_2127_CARD)), ...legacyOnlyMcp()],
  ),
  'discovery-legacy-card': scenario(
    'a SEP-1649 card at the well-known path names the endpoint in transport.url; no common path is POSTed and the card suffix answers 404',
    ['well-known-mcp-card', 'mcp-initialize'],
    [
      ...baseline(),
      get(CARD_PATH, json({ name: 'example', transport: { type: 'streamable-http', url: 'https://example.com/mcp' } })),
      ...legacyOnlyMcp(),
    ],
  ),
  'discovery-card-generations-auth': scenario(
    'an inline SEP-2127 catalog card and a SEP-1649 card declaring authentication name one endpoint that never answers 401; the catalog card wins the endpoint and the SEP-1649 declaration still satisfies the auth antecedents, so the OAuth rows are scored',
    ['oauth-protected-resource', 'auth-md'],
    [
      ...baseline(),
      get('/.well-known/ai-catalog.json', aiCatalog(cardEntry({ data: SEP_2127_CARD }))),
      get(CARD_PATH, json(SERVER_CARD_WITH_AUTH)),
      ...legacyOnlyMcp(),
      get('/.well-known/oauth-protected-resource', json({ resource: 'https://example.com/mcp', authorization_servers: ['https://example.com'] })),
      get('/.well-known/auth.md', md('# Auth\n\nRegister at /signup, then send a bearer token.\n')),
    ],
  ),

  // ---- declared-host follow ---------------------------------------------------
  'follow-card-admit': scenario(
    'the card names an endpoint on another host, whose own card at `<endpoint>/server-card` names it: the MCP rows are scored there',
    FOLLOWED_IDS,
    [
      ...baseline(),
      declaringCard(DECLARED_ENDPOINT),
      selfNamingCard(DECLARED_ENDPOINT),
      ...legacyOnlyMcp({ endpoint: DECLARED_ENDPOINT, cors: 'full' }),
    ],
  ),
  'follow-reciprocity-refused': scenario(
    'the declared endpoint answers GET with 405 and Allow: POST but publishes no card, catalog entry, or metadata naming it: no wire probe, and the MCP rows name the host that did not confirm it',
    FOLLOWED_IDS,
    [
      ...baseline(),
      declaringCard(DECLARED_ENDPOINT),
      get(DECLARED_ENDPOINT, text('Method Not Allowed', { allow: 'POST' }, 405)),
    ],
  ),
  'follow-redirect-hop': scenario(
    'the declared endpoint redirects once to another public host whose card names the final URL: the final URL is the endpoint and the trail records both',
    FOLLOWED_IDS,
    [
      ...baseline(),
      declaringCard(DECLARED_ENDPOINT),
      get(DECLARED_ENDPOINT, redirect(REDIRECTED_ENDPOINT, 302)),
      selfNamingCard(REDIRECTED_ENDPOINT),
      ...legacyOnlyMcp({ endpoint: REDIRECTED_ENDPOINT, cors: 'full' }),
    ],
  ),
  'follow-own-redirect-admit': scenario(
    "the audited site's /mcp answers the discovery POSTs with a 307 to another host whose card at `<endpoint>/server-card` names it: no POST follows the redirect, the target is confirmed like a declared endpoint, and the MCP rows are scored there",
    FOLLOWED_IDS,
    [
      ...baseline(),
      post(MCP_PATH, redirect(REDIRECTED_ENDPOINT, 307)),
      selfNamingCard(REDIRECTED_ENDPOINT),
      ...legacyOnlyMcp({ endpoint: REDIRECTED_ENDPOINT, cors: 'full' }),
    ],
  ),
  'follow-own-redirect-refused': scenario(
    "the audited site's /mcp answers the discovery POSTs with a 307 to another host that publishes nothing naming that URL: no POST or OPTIONS reaches the host, and the MCP rows name the host that did not confirm it",
    FOLLOWED_IDS,
    [...baseline(), post(MCP_PATH, redirect(DECLARED_ENDPOINT, 307))],
  ),
  'follow-host-cap': scenario(
    'four declared hosts each redirect into a private range and are blocked; the fifth exceeds the per-audit host cap and is never requested',
    ['mcp-initialize'],
    [
      ...baseline(),
      get(
        '/.well-known/ai-catalog.json',
        aiCatalog(
          ...[1, 2, 3, 4].map((n) =>
            cardEntry({ data: { ...SEP_2127_CARD, remotes: [{ type: 'streamable-http', url: `https://h${n}.example.net/mcp` }] } }),
          ),
        ),
      ),
      declaringCard('https://h5.example.net/mcp'),
      ...[1, 2, 3, 4].map((n) => get(`https://h${n}.example.net/mcp`, redirect('http://10.0.0.1/mcp', 302))),
    ],
  ),
  'follow-disabled': scenario(
    'the same declared endpoint as follow-card-admit with following off: nothing off the audited origin is requested and the MCP rows read follow-disabled',
    FOLLOWED_IDS,
    [
      ...baseline(),
      declaringCard(DECLARED_ENDPOINT),
      selfNamingCard(DECLARED_ENDPOINT),
      ...legacyOnlyMcp({ endpoint: DECLARED_ENDPOINT, cors: 'full' }),
    ],
    { follow_declarations: false },
  ),
  'follow-http-declarations': scenario(
    'the AI catalog names an https endpoint that redirects to http, the card names an http endpoint, and the api-catalog anchors an http API host whose description is http, each host answering as one the audit would follow: nothing is requested over http, every entry reads not-followed with reason insecure-scheme (the redirected one with its hop as the final URL), and no MCP or API row is evaluated at any of them',
    ['mcp-initialize', 'openapi', 'json-errors'],
    [
      ...baseline(),
      get(
        '/.well-known/ai-catalog.json',
        aiCatalog(cardEntry({ data: { ...SEP_2127_CARD, remotes: [{ type: 'streamable-http', url: REDIRECTED_ENDPOINT }] } })),
      ),
      get(REDIRECTED_ENDPOINT, redirect(HTTP_REDIRECT_HOP, 302)),
      selfNamingCard(HTTP_REDIRECT_HOP),
      declaringCard(HTTP_DECLARED_ENDPOINT),
      selfNamingCard(HTTP_DECLARED_ENDPOINT),
      ...legacyOnlyMcp({ endpoint: HTTP_DECLARED_ENDPOINT, cors: 'full' }),
      get(
        '/.well-known/api-catalog',
        linkset({
          anchor: 'http://api.example.net/',
          'service-desc': [{ href: 'http://api.example.net/openapi.json', type: 'application/openapi+json' }],
        }),
      ),
      get('http://api.example.net/openapi.json', json(OPENAPI)),
      get(`http://api.example.net${API_PROBE_PATH}`, json(API_ERROR, 404)),
    ],
  ),

  // ---- endpoints that require sign-in ----------------------------------------
  'auth-own-endpoint': scenario(
    "the audited site's /mcp answers every POST with a 401 whose challenge names same-host RFC 9728 metadata naming it: the endpoint is found with sign-in required, rows that need no session are scored, and the rest read auth-required",
    [...SIGN_IN_IDS, ...ENFORCEMENT_IDS, 'oauth-protected-resource'],
    [
      ...baseline(),
      ...protectedMcp(MCP_PATH, u(PROTECTED_RESOURCE_PATH)),
      get(PROTECTED_RESOURCE_PATH, json({ resource: u(MCP_PATH), authorization_servers: [AUTH_SERVER] })),
    ],
  ),
  'auth-declared-endpoint': scenario(
    "the card names a root endpoint on another host that answers 401 and publishes metadata naming it without the trailing slash: the metadata admits it, and the MCP rows are scored there with sign-in required",
    [...SIGN_IN_IDS, ...ENFORCEMENT_IDS, 'oauth-protected-resource'],
    [
      ...baseline(),
      declaringCard('https://mcp.example.net/'),
      ...protectedMcp('https://mcp.example.net/', `https://mcp.example.net${PROTECTED_RESOURCE_PATH}`),
      get(
        `https://mcp.example.net${PROTECTED_RESOURCE_PATH}`,
        json({ resource: 'https://mcp.example.net', authorization_servers: [AUTH_SERVER] }),
      ),
    ],
  ),
  'auth-enforcement-defects': scenario(
    "an endpoint that requires sign-in lists an http authorization server and serves a legacy tools/list without a token: the challenge row passes, the metadata row is broken, and the refusal row is noncompliant",
    ENFORCEMENT_IDS,
    [
      ...baseline(),
      post(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH)), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL } }),
      post(MCP_PATH, rpcResult(TOOLS_RESULT), { body_json_method: 'tools/list' }),
      post(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH))),
      get(PROTECTED_RESOURCE_PATH, json({ resource: u(MCP_PATH), authorization_servers: ['http://auth.example.com'] })),
    ],
  ),
  'auth-servers-mixed': scenario(
    "an endpoint that requires sign-in lists a public https authorization server between an http one and one on a private address: an agent can still sign in through the usable server, so the metadata row is noncompliant and names both unusable entries, and none of the three is requested",
    ['mcp-auth-servers'],
    [
      ...baseline(),
      ...protectedMcp(MCP_PATH, u(PROTECTED_RESOURCE_PATH)),
      get(
        PROTECTED_RESOURCE_PATH,
        json({
          resource: u(MCP_PATH),
          authorization_servers: ['http://auth.example.com', AUTH_SERVER, 'https://10.0.0.1/oauth'],
        }),
      ),
    ],
  ),
  'auth-modern-only': scenario(
    "a modern-only server behind OAuth at the audited site's /mcp refuses every legacy POST at HTTP 200 with a JSON-RPC error before reading a token, while every modern POST draws a 401 naming same-host RFC 9728 metadata that names it: the endpoint is found with sign-in required, the modern session rows and the resources rows read auth-required, the legacy session rows read the legacy refusal as they do on an open modern-only server, and the refusal row is asked on the modern lane, where it passes",
    ['mcp-server-discover', 'mcp-modern-tools-list', 'mcp-tools-list', 'mcp-auth-enforced'],
    [
      ...baseline(),
      post(MCP_PATH, rpcError(-32700, 400), { body_contains: 'not-json{{' }),
      post(MCP_PATH, rpcError(-32022, 400, { supported: [MODERN_PROTOCOL] }), {
        headers: { 'mcp-protocol-version': UNSUPPORTED_PROTOCOL },
      }),
      post(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH)), { headers: { 'mcp-protocol-version': MODERN_PROTOCOL } }),
      post(MCP_PATH, { ...rpcError(-32022, 200, { supported: [MODERN_PROTOCOL] }), headers: { 'content-type': 'application/json', ...ACAO } }, {
        headers: { origin: CORS_ORIGIN },
      }),
      post(MCP_PATH, rpcError(-32022, 200, { supported: [MODERN_PROTOCOL] })),
      options(MCP_PATH, res(204, ACAO, '')),
      get(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH))),
      get(PROTECTED_RESOURCE_PATH, json({ resource: u(MCP_PATH), authorization_servers: [AUTH_SERVER] })),
    ],
  ),
  'auth-open-endpoint': scenario(
    'an open server whose card documents that no sign-in is required: no wire probe draws a 401, so the sign-in rows are `n_a`',
    ENFORCEMENT_IDS,
    [...baseline(), get(CARD_PATH, json({ ...SERVER_CARD, authentication: { required: false } })), ...legacyOnlyMcp()],
  ),
  'auth-bare-401': scenario(
    "the audited site's /mcp answers 401 with no challenge and no metadata names it: a bare 401 is refusal evidence, so no endpoint is found",
    ['mcp-initialize'],
    [...baseline(), post(MCP_PATH, challenge401(null))],
  ),
  'auth-echoing-gateway': scenario(
    "the audited site's /mcp answers 401 naming path-suffixed metadata, but the host answers a nonsense path's metadata with that path as its resource too: the metadata confirms nothing, so no endpoint is found",
    ['mcp-initialize'],
    [
      ...baseline(),
      post(MCP_PATH, challenge401(u(`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`))),
      get(`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`, json({ resource: u(MCP_PATH), authorization_servers: [AUTH_SERVER] })),
      get(
        `${PROTECTED_RESOURCE_PATH}/anc-web-audit-no-such-resource`,
        json({ resource: u('/anc-web-audit-no-such-resource'), authorization_servers: [AUTH_SERVER] }),
      ),
    ],
  ),
  'auth-echo-unanswered': scenario(
    "the audited site's card declares its /mcp, which answers every POST with a 401 naming same-host root RFC 9728 metadata that names it, and the metadata read at a nonsense path draws a 503: the card already made the endpoint of record, so an echo read that got no answer leaves sign-in settled, the rows the 401s answer read auth-required, and none reads broken",
    ['mcp-initialize', 'mcp-tools-list', ...ENFORCEMENT_IDS],
    [
      ...baseline(),
      get(CARD_PATH, json(SERVER_CARD)),
      ...protectedMcp(MCP_PATH, u(PROTECTED_RESOURCE_PATH)),
      get(PROTECTED_RESOURCE_PATH, json({ resource: u(MCP_PATH), authorization_servers: [AUTH_SERVER] })),
      get(`${PROTECTED_RESOURCE_PATH}/anc-web-audit-no-such-resource`, text('upstream error', {}, 503)),
    ],
  ),
  'auth-later-401': scenario(
    "the audited site's /mcp serves initialize without a token and refuses server/discover with a method-not-found, while every other request it reads a token for draws a 401 naming same-host RFC 9728 metadata that names it: no handshake asked for sign-in, so the endpoint presents the open design and the sign-in rows are n_a, and each later row whose 401 that metadata backs reads auth-required rather than broken",
    ['mcp-capabilities', 'mcp-tools-list', 'mcp-resources-list', 'mcp-unknown-tool', 'mcp-accept-json', 'mcp-auth-enforced'],
    [
      ...baseline(),
      post(MCP_PATH, rpcError(-32700, 400), { body_contains: 'not-json{{' }),
      post(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH), ACAO), { headers: { origin: CORS_ORIGIN } }),
      post(MCP_PATH, rpcResult(INITIALIZE_RESULT), { body_json_method: 'initialize' }),
      post(MCP_PATH, rpcError(-32601), { headers: { 'mcp-method': 'server/discover' } }),
      post(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH))),
      options(MCP_PATH, res(204, ACAO, '')),
      get(MCP_PATH, challenge401(u(PROTECTED_RESOURCE_PATH))),
      get(PROTECTED_RESOURCE_PATH, json({ resource: u(MCP_PATH), authorization_servers: [AUTH_SERVER] })),
    ],
  ),

  // ---- dns-doh ---------------------------------------------------------------
  'dns-aid-pass': scenario('the first resolver answers Status 0 with a record for the index name', ['dns-aid'], [
    ...baseline(),
    ...dnsAll((name) => (name.startsWith('_index') ? dohAnswer(name) : DOH_NXDOMAIN)),
  ]),
  'dns-aid-nxdomain': scenario('every name resolves NXDOMAIN: absent, which a MAY finalizes as optional-absent', ['dns-aid'], [
    ...baseline(),
    ...dnsAll(() => DOH_NXDOMAIN),
  ]),
  'dns-aid-resolver-fallback': scenario('the first resolver fails at the resolver level and the second answers', ['dns-aid'], [
    ...baseline(),
    ...DOH_NAMES.map((name) => dohGet(DOH_RESOLVERS[0], name, text('gateway error', {}, 502))),
    ...DOH_NAMES.map((name) => dohGet(DOH_RESOLVERS[1], name, name.startsWith('_mcp') ? dohAnswer(name) : DOH_NXDOMAIN)),
  ]),
  'dns-aid-resolvers-unreachable': scenario('every resolver fails at the transport level: an operational error, not an absence', ['dns-aid'], [
    ...baseline(),
    ...dnsAll(() => REFUSED),
  ]),

  // ---- auth-md ----------------------------------------------------------------
  'auth-md-pass': scenario('a markdown auth document passes once the auth antecedent holds', ['auth-md', 'oauth-discovery'], [
    ...baseline(),
    get('/.well-known/openid-configuration', json({ issuer: 'https://example.com', authorization_endpoint: 'https://example.com/authorize' })),
    get('/.well-known/auth.md', md('# Auth\n\nRegister at /signup.\n')),
  ]),
  'auth-md-html-broken': scenario('an HTML page at the auth.md path is present but malformed', ['auth-md'], [
    ...baseline(),
    get('/.well-known/openid-configuration', json({ issuer: 'https://example.com' })),
    get('/.well-known/auth.md', html('<html><body>Auth</body></html>')),
  ]),
  'auth-md-absent': scenario('no auth document at either path is absent, which a MAY finalizes as optional-absent', ['auth-md'], [
    ...baseline(),
    get('/.well-known/openid-configuration', json({ issuer: 'https://example.com' })),
  ]),
  'auth-md-bare-heading': scenario('a document without a content type but opening with a markdown heading still passes', ['auth-md'], [
    ...baseline(),
    get('/.well-known/openid-configuration', json({ issuer: 'https://example.com' })),
    get('/auth.md', res(200, {}, '# Auth\n\nSend a token.\n')),
  ]),

  // ---- webmcp ------------------------------------------------------------------
  'webmcp-script-asset': scenario('a `webmcp` script asset in the root HTML passes and names the marker', ['webmcp'], [
    get('/', html(rootHtml())),
  ]),
  'webmcp-model-context': scenario('an inline navigator.modelContext registration passes', ['webmcp'], [
    get('/', html(`${rootHtml({ webmcp: false }).replace('</body>', '<script>navigator.modelContext.registerTool({name:"x"})</script>\n</body>')}`)),
  ]),
  'webmcp-mention-only': scenario('prose naming the Model Context Protocol is not WebMCP exposure', ['webmcp'], [
    get('/', html(rootHtml({ webmcp: false }).replace('<h1>Example</h1>', '<h1>Example</h1><p>We publish a Model Context Protocol server and a WebMCP guide.</p>'))),
  ]),

  // ---- scoped-llms -------------------------------------------------------------
  'scoped-llms-pass': scenario('a valid scoped llms.txt under a section linked from the root index passes', ['llms-txt-scoped', 'llms-full-txt-scoped'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/llms-full.txt', text(LLMS_FULL_TXT)),
    get('/docs/llms.txt', text(SCOPED_LLMS)),
    get('/docs/llms-full.txt', text(LLMS_FULL_TXT)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ], { site_type: 'content' }),
  'scoped-llms-broken': scenario('a present but malformed scoped file is broken', ['llms-txt-scoped'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/llms.txt', text('just some words with no heading or links')),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ], { site_type: 'content' }),
  'scoped-llms-absent': scenario('every scoped candidate 404s: absent, which a MAY finalizes as optional-absent', ['llms-txt-scoped', 'llms-full-txt-scoped'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/llms-full.txt', text(LLMS_FULL_TXT)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ], { site_type: 'content' }),
  'scoped-llms-sitemap-dirs': scenario('section directories come from the sitemap too, and a private-IP href is never enumerated', ['llms-txt-scoped'], [
    ...baseline(),
    get('/llms.txt', text('# Example\n\n> Summary\n\n- [Private](http://10.0.0.5/docs/x.md)\n- [Off-site](https://other.example.net/docs/y.md)\n\n## When to use\n\nAlways.\n')),
    get('/sitemap.xml', res(200, { 'content-type': 'application/xml' }, SITEMAP)),
    get('/blog/llms.txt', text('# Blog\n\n- [Hello](/blog/hello.md)\n')),
  ], { site_type: 'content' }),

  // ---- markdown-frontmatter ----------------------------------------------------
  'frontmatter-pass': scenario('a markdown twin opening with a terminated frontmatter block passes', ['markdown-frontmatter'], negotiatedRoot()),
  'frontmatter-unterminated-broken': scenario('a leading fence with a key line but no terminator is broken', ['markdown-frontmatter'], negotiatedRoot({
    twin: '---\ntitle: Example\n\n# Example\n',
  })),
  'frontmatter-no-key-line-broken': scenario('a fence pair enclosing no key line is broken', ['markdown-frontmatter'], negotiatedRoot({
    twin: '---\n# not a key\n---\n\n# Example\n',
  })),
  'frontmatter-absent': scenario('a twin opening with prose is absent, which a MAY finalizes as optional-absent', ['markdown-frontmatter'], negotiatedRoot({
    twin: TWIN_PLAIN,
  })),
  'frontmatter-crlf-pass': scenario('CRLF line endings and a leading BOM are tolerated', ['markdown-frontmatter'], negotiatedRoot({
    twin: `﻿${TWIN_WITH_FRONTMATTER.replaceAll('\n', '\r\n')}`,
  })),

  // ---- content-without-js ------------------------------------------------------
  'content-rich-pass': scenario('rich HTML with an H1 and visible text passes without probing the twin', ['content-without-js'], [
    get('/', html(rootHtml())),
  ]),
  'content-thin-twin-na': scenario('thin HTML softened by a live llms.txt content link is `n_a`', ['content-without-js'], [
    get('/', html(rootHtml({ rich: false }))),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ]),
  'content-thin-absent': scenario('thin HTML with no llms.txt is absent', ['content-without-js'], [get('/', html(rootHtml({ rich: false })))]),
  'content-thin-dead-links-absent': scenario('thin HTML whose llms.txt links do not resolve is absent', ['content-without-js', 'llms-txt-links'], [
    get('/', html(rootHtml({ rich: false }))),
    get('/llms.txt', text(LLMS_TXT_FULL)),
  ]),
  'content-non-2xx-broken': scenario('a rich root served with a 5xx is broken, not a pass', ['content-without-js'], [
    get('/', html(rootHtml(), {}, 500)),
  ]),

  // ---- llms-txt-quality --------------------------------------------------------
  'llms-quality-pass': scenario('an llms.txt with an H1, a summary, resolving links and a when-to-use heading passes the trio', ['llms-txt-format', 'llms-txt-links', 'llms-txt-when-to-use'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', md(GUIDE_MD)),
  ]),
  'llms-quality-h1-only': scenario('an llms.txt with only an H1 misses format, has no links to follow, and has no when-to-use heading', ['llms-txt-format', 'llms-txt-links', 'llms-txt-when-to-use'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_H1_ONLY)),
  ]),
  'llms-quality-broken-link': scenario('a link that answers 5xx makes the links row broken', ['llms-txt-links'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/guide.md', md(GUIDE_MD)),
    get('/docs/api.md', SERVER_ERROR),
  ]),
  'llms-quality-dead-link': scenario('a link that answers 404 makes the links row absent', ['llms-txt-links'], [
    ...baseline(),
    get('/llms.txt', text(LLMS_TXT_FULL)),
    get('/docs/guide.md', md(GUIDE_MD)),
  ]),
  'llms-quality-dead-and-http-link': scenario(
    'an llms.txt that lists a dead link and an http link: the http link is never requested, though it would answer, and the dead link decides the links row, which reads absent',
    ['llms-txt-links'],
    [...baseline(), get('/llms.txt', text(LLMS_TXT_HTTP_LINK)), get('/docs/guide.md', md(GUIDE_MD)), get(HTTP_LINK, md(GUIDE_MD))],
  ),
  'llms-quality-http-link': scenario(
    'an llms.txt that lists an http link beside resolving https links: the http link is never requested, though it would answer, and the links row reads noncompliant naming it',
    ['llms-txt-links'],
    [
      ...baseline(),
      get('/llms.txt', text(LLMS_TXT_HTTP_LINK)),
      get('/docs/guide.md', md(GUIDE_MD)),
      get('/docs/api.md', md(GUIDE_MD)),
      get(HTTP_LINK, md(GUIDE_MD)),
    ],
  ),

  // ---- api-hygiene -------------------------------------------------------------
  'api-hygiene-pass': scenario('a documented 4xx GET answered with a JSON error body and rate-limit headers passes both rows', ['json-errors', 'rate-limit-headers'], [
    ...baseline(),
    ...apiSurface(),
  ]),
  'api-hygiene-html-error': scenario('an HTML error body on the API probe is broken and carries no rate-limit header', ['json-errors', 'rate-limit-headers'], [
    ...baseline(),
    ...apiSurface({ errorBody: html('<html><body>Not found</body></html>', {}, 404) }),
  ]),
  'api-hygiene-fallback-path': scenario('with no usable OpenAPI body the probe falls back to the well-known nonsense path', ['json-errors', 'rate-limit-headers'], [
    ...baseline(),
    get(API_FALLBACK_PATH, json({ error: 'not_found' }, 404, { 'x-ratelimit-remaining': '59' })),
  ], { site_type: 'api' }),
  'api-hygiene-json-200': scenario('a 200 JSON body where a client error was expected is absent for json-errors', ['json-errors'], [
    ...baseline(),
    get('/openapi.json', json(OPENAPI)),
    get(API_PROBE_PATH, json({ items: [] })),
  ]),
  'api-anchor-hosts': scenario(
    'a Stripe-shaped api-catalog anchors two API hosts and an MCP endpoint with no service-desc: the OpenAPI row scores each declared description where it is hosted (JSON on one host, YAML on the other), the hygiene rows probe each anchor host once (the documented 4xx path, then the nonsense path) and list both hosts in anchor order, JSON errors pass and rate-limit headers are missing at both, the third anchor is recorded not followed and never requested, and no hygiene probe reaches the audited site',
    ['openapi', 'api-catalog', 'json-errors', 'rate-limit-headers'],
    [
      ...baseline(),
      get(
        '/.well-known/api-catalog',
        linkset(
          {
            anchor: 'https://api.example.net/',
            'service-desc': [{ href: 'https://api.example.net/openapi.json', type: 'application/openapi+json' }],
            'service-doc': [{ href: 'https://example.com/docs/api', type: 'text/html' }],
          },
          {
            anchor: 'https://files.example.net/',
            'service-desc': [{ href: 'https://files.example.net/openapi.yaml', type: 'application/openapi+yaml' }],
          },
          { anchor: 'https://mcp.example.net/mcp', 'service-doc': [{ href: 'https://example.com/docs/mcp', type: 'text/html' }] },
        ),
      ),
      get('https://api.example.net/openapi.json', json(OPENAPI)),
      get(`https://api.example.net${API_PROBE_PATH}`, json(API_ERROR, 404)),
      get('https://files.example.net/openapi.yaml', res(200, { 'content-type': 'application/yaml' }, OPENAPI_YAML)),
      get(`https://files.example.net${API_FALLBACK_PATH}`, json(API_ERROR, 404)),
    ],
  ),
  'api-description-over-cap': scenario(
    'an API anchor declares a JSON description larger than the 512 KiB read cap whose `openapi` key sits after its components, past the bytes read: the OpenAPI row counts it present from the truncated read, and the hygiene probes, with no parsed description to take a path from, fall back to the nonsense path on the anchor host',
    ['openapi'],
    [
      ...baseline(),
      get(
        '/.well-known/api-catalog',
        linkset({
          anchor: 'https://api.example.net/',
          'service-desc': [{ href: 'https://api.example.net/openapi.json', type: 'application/openapi+json' }],
        }),
      ),
      get('https://api.example.net/openapi.json', res(200, { 'content-type': 'application/json' }, OPENAPI_PAST_THE_CAP)),
      get(`https://api.example.net${API_FALLBACK_PATH}`, json(API_ERROR, 404)),
    ],
  ),
};
