// Multi-host fixtures for the declared-host follow suites: a router keyed
// by full URL, a small MCP registry, and an audit driver that keeps every
// request the engine sent.

import { type AuditEvent, type RunWebAuditInput, runWebAudit } from '../../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../../src/worker/audit-web/follow-requests';
import type { WebAuditRegistry, WebCheck } from '../../src/worker/audit-web/registry';
import type { WebScorecard } from '../../src/worker/audit-web/scorecard';
import { stubFetch } from './stub-fetch';

export const TARGET = 'https://example.com/';
export const CARD_TYPE = 'application/mcp-server-card+json';

export const DISCOVERY = {
  ai_catalog: '/.well-known/ai-catalog.json',
  card_suffix: '/server-card',
  well_known: ['/.well-known/mcp.json', '/.well-known/mcp/server-card.json'],
  common_paths: ['/mcp'],
  protocol_version: '2025-06-18',
};

function mcpRow(id: string, handler: WebCheck['handler'], with_: Record<string, unknown>): WebCheck {
  return {
    id,
    category: 'mcp',
    tier: 'required',
    keyword: 'must',
    principle: 'P2',
    site_types: ['mcp'],
    antecedent: 'mcp-present',
    weight: 5,
    title: id,
    hint: 'h',
    handler,
    with: with_,
  };
}

/** One wave-1 POST row and one wave-2 OPTIONS + POST pair, so any wire probe shows up in the request log. */
export function followRegistry(): WebAuditRegistry {
  return {
    version: 1,
    mcp_discovery: DISCOVERY,
    category_order: ['mcp'],
    categories: { mcp: 'MCP' },
    checks: [
      mcpRow('mcp-initialize', 'mcp', { op: 'initialize' }),
      mcpRow('mcp-cors-preflight', 'cors-preflight', { path: '{mcp_endpoint}', surface: 'preflight' }),
    ],
  };
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function html(status = 200, headers: Record<string, string> = {}): Response {
  return new Response('<html><body>hello</body></html>', {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function sep2127Card(...urls: string[]) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'net.example/mcp',
    version: '1.0.0',
    description: 'Example MCP server',
    remotes: urls.map((url) => ({ type: 'streamable-http', url })),
  };
}

export function cardDocument(card: unknown): Response {
  return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': CARD_TYPE } });
}

export function aiCatalog(...entries: unknown[]): Response {
  return json({ specVersion: '1.0', entries });
}

export function cardEntry(fields: Record<string, unknown>) {
  return { identifier: 'urn:air:example:mcp', type: CARD_TYPE, ...fields };
}

export function initializeResult(): Response {
  return json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'net' }, protocolVersion: '2025-06-18' } });
}

export type Seen = { method: string; url: string };
export type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Answers `METHOD url` routes by full URL, 404s the rest, and records every request in order. */
export function router(routes: Record<string, Route>, seen: Seen[], fallback?: Route): typeof fetch {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url });
    const route = routes[`${method} ${url}`] ?? fallback;
    return route ? route(init) : new Response('not found', { status: 404 });
  });
}

/** The audited site: an HTML root and a SEP-1649 card at the well-known path naming `endpoint`. */
export function siteDeclaring(endpoint: string): Record<string, Route> {
  return {
    [`GET ${TARGET}`]: () => html(),
    'GET https://example.com/.well-known/mcp.json': () => json({ name: 'example', mcp_endpoint: endpoint }),
  };
}

export type AuditRun = { events: AuditEvent[]; scorecard: WebScorecard; complete: boolean };

export async function audit(fetchImpl: typeof fetch, extra: Partial<RunWebAuditInput> = {}): Promise<AuditRun> {
  const events: AuditEvent[] = [];
  for await (const event of runWebAudit({
    url: TARGET,
    registry: followRegistry(),
    fetchOptions: { fetchImpl },
    domainBudget: ALWAYS_ADMIT_BUDGET,
    ...extra,
  })) {
    events.push(event);
  }
  const terminal = events.find((e) => e.type === 'complete');
  if (terminal?.type !== 'complete') throw new Error('no complete event');
  return { events, scorecard: terminal.scorecard, complete: terminal.complete };
}

/** Requests that would only follow admission: wire probes. */
export function wireProbesTo(seen: readonly Seen[], host: string): Seen[] {
  return seen.filter((r) => (r.method === 'POST' || r.method === 'OPTIONS') && new URL(r.url).host === host);
}

export function requestsTo(seen: readonly Seen[], host: string): Seen[] {
  return seen.filter((r) => new URL(r.url).host === host);
}

export function row(scorecard: WebScorecard, id: string) {
  const found = scorecard.results.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}
