// The API category on api-catalog anchors: the OpenAPI row scores the
// description each API anchor declares, wherever it is hosted, and the
// hygiene rows probe each anchor host, driven through the engine with the
// shipped registry's API checks and a router keyed by full URL so every
// host the audit touches is visible.

import { describe, expect, test } from 'bun:test';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import {
  audit,
  cardDocument,
  html,
  initializeResult,
  json,
  type Route,
  redirect,
  requestsTo,
  router,
  row,
  type Seen,
  sep2127Card,
  TARGET,
} from './helpers/follow-fixtures';

const CATALOG = 'https://example.com/.well-known/api-catalog';
const API = 'api.example.net';
const NONSENSE = 'anc-web-audit-no-such';
const FALLBACK_PATH = '/anc-web-audit-no-such-api';
const DOCUMENTED_PROBE = `https://${API}/v1/items/anc-web-audit-no-such`;

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Example API', version: '1.0.0' },
  paths: {
    '/v1/items/{id}': { get: { responses: { '200': { description: 'ok' }, '404': { description: 'missing' } } } },
  },
};
const OPENAPI_YAML = 'openapi: 3.1.0\ninfo:\n  title: Example API\n  version: 1.0.0\npaths: {}\n';

const API_IDS = ['openapi', 'api-catalog', 'json-errors', 'rate-limit-headers'];

function apiRegistry(...extra: string[]): WebAuditRegistry {
  const registry = loadRegistry();
  const ids = [...API_IDS, ...extra];
  return { ...registry, checks: registry.checks.filter((check) => ids.includes(check.id)) };
}

function linkset(...contexts: unknown[]): Response {
  return new Response(JSON.stringify({ linkset: contexts }), {
    headers: { 'content-type': 'application/linkset+json' },
  });
}

function anchor(url: string, ...descriptions: string[]) {
  return {
    anchor: url,
    ...(descriptions.length > 0
      ? { 'service-desc': descriptions.map((href) => ({ href, type: 'application/openapi+json' })) }
      : {}),
    'service-doc': [{ href: 'https://example.com/docs/api', type: 'text/html' }],
  };
}

function htmlError(status = 404): Response {
  return new Response('<html><body>Not found</body></html>', { status, headers: { 'content-type': 'text/html' } });
}

function site(catalog: () => Response, extra: Record<string, Route> = {}): Record<string, Route> {
  return { [`GET ${TARGET}`]: () => html(), [`GET ${CATALOG}`]: catalog, ...extra };
}

function hygieneProbes(seen: readonly Seen[]): string[] {
  return seen.filter((r) => r.url.includes(NONSENSE)).map((r) => r.url);
}

async function auditApi(
  routes: Record<string, Route>,
  seen: Seen[],
  followDeclarations = true,
  registry = apiRegistry(),
) {
  return audit(router(routes, seen), { registry, followDeclarations });
}

describe('API category on api-catalog anchors', () => {
  test('one off-origin anchor with an off-origin JSON OpenAPI: the OpenAPI host is its provenance and the anchor host alone receives one GET both hygiene rows read', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () => json(OPENAPI),
        [`GET ${DOCUMENTED_PROBE}`]: () => json({ error: 'not_found' }, 404),
      }),
      seen,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({
      status: 'pass',
      hosts: [{ host: 'specs.example.org' }],
      host: 'specs.example.org',
    });
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: API });
    expect(row(scorecard, 'rate-limit-headers')).toMatchObject({ status: 'absent', host: API });
    expect(hygieneProbes(seen)).toEqual([DOCUMENTED_PROBE]);
    const entryPaths = requestsTo(seen, 'example.com').map((r) => new URL(r.url).pathname);
    expect(entryPaths.filter((path) => path.includes(NONSENSE) || path.includes('openapi'))).toEqual([]);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/api-catalog#/linkset/0',
        kind: 'api-anchor',
        url: `https://${API}/`,
        host: API,
        outcome: 'followed',
      },
      {
        surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
        kind: 'api-description',
        url: 'https://specs.example.org/openapi.json',
        host: 'specs.example.org',
        outcome: 'followed',
      },
    ]);
  });

  test('two anchors, one answering JSON errors and one HTML: the row is broken and lists both hosts with their own outcomes', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`https://${API}/`, `https://${API}/openapi.json`),
            anchor('https://files.example.net/', 'https://files.example.net/openapi.yaml'),
          ),
        {
          [`GET https://${API}/openapi.json`]: () => json(OPENAPI),
          'GET https://files.example.net/openapi.yaml': () => new Response(OPENAPI_YAML),
          [`GET ${DOCUMENTED_PROBE}`]: () => json({ error: 'not_found' }, 404),
          [`GET https://files.example.net${FALLBACK_PATH}`]: () => htmlError(),
        },
      ),
      seen,
    );
    const jsonErrors = row(scorecard, 'json-errors');
    expect(jsonErrors.status).toBe('broken');
    expect(jsonErrors.hosts).toEqual([
      { host: API, status: 'pass' },
      { host: 'files.example.net', status: 'broken' },
    ]);
    expect(jsonErrors.host).toBeUndefined();
    expect(jsonErrors.evidence).toContain('files.example.net');
  });

  test('a YAML OpenAPI passes presence, and the hygiene probes fall back to the nonsense path on the anchor host', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, `https://${API}/openapi.yaml`)), {
        [`GET https://${API}/openapi.yaml`]: () =>
          new Response(OPENAPI_YAML, { headers: { 'content-type': 'application/yaml' } }),
        [`GET https://${API}${FALLBACK_PATH}`]: () => json({ error: 'not_found' }, 404),
      }),
      seen,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({ status: 'pass', host: API });
    expect(hygieneProbes(seen)).toEqual([`https://${API}${FALLBACK_PATH}`]);
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: API });
  });

  test('an OpenAPI larger than the cap counts as present and its evidence records the truncation', async () => {
    const seen: Seen[] = [];
    const huge = { ...OPENAPI, 'x-padding': 'x'.repeat(600 * 1024) };
    const { events, scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, `https://${API}/openapi.json`)), {
        [`GET https://${API}/openapi.json`]: () => json(huge),
      }),
      seen,
    );
    expect(row(scorecard, 'openapi').status).toBe('pass');
    const result = events.flatMap((e) => (e.type === 'result' && e.result.id === 'openapi' ? [e.result] : []))[0];
    expect(result?.raw_evidence[0]).toMatchObject({ url: `https://${API}/openapi.json`, truncated: true });
    expect(hygieneProbes(seen)).toEqual([`https://${API}${FALLBACK_PATH}`]);
  });

  test('with no catalog and no on-origin OpenAPI, the API checks stay n/a', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi({ [`GET ${TARGET}`]: () => html() }, seen);
    for (const id of API_IDS)
      expect(row(scorecard, id)).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
    expect(hygieneProbes(seen)).toEqual([]);
  });

  test('an MCP-only catalog beside an on-origin /openapi.json evaluates the API category at the audited origin', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset({
            anchor: 'https://example.com/mcp',
            'service-desc': [
              { href: 'https://example.com/.well-known/mcp/server-card.json', type: 'application/json' },
            ],
          }),
        {
          'GET https://example.com/openapi.json': () => json(OPENAPI),
          'GET https://example.com/v1/items/anc-web-audit-no-such': () => json({ error: 'not_found' }, 404),
        },
      ),
      seen,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({ status: 'pass', host: 'example.com' });
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: 'example.com' });
    expect(hygieneProbes(seen)).toEqual([
      'https://example.com/v1/items/anc-web-audit-no-such',
      'https://example.com/v1/items/anc-web-audit-no-such',
    ]);
    expect(scorecard.declared_hosts).toEqual([]);
  });

  test("a catalog whose only anchor's service-desc is an MCP card leaves the API surface n/a and sends no hygiene probe", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() =>
        linkset({
          anchor: 'https://example.com/mcp',
          'service-desc': [{ href: 'https://example.com/.well-known/mcp/server-card.json', type: 'application/json' }],
          'service-doc': [{ href: 'https://example.com/mcp-skill', type: 'text/html' }],
        }),
      ),
      seen,
    );
    for (const id of API_IDS)
      expect(row(scorecard, id)).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
    expect(hygieneProbes(seen)).toEqual([]);
  });

  test('an anchor without a service-desc beside an OpenAPI-bearing one is recorded not followed and never requested', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () => linkset(anchor(`https://${API}/`, `https://${API}/openapi.json`), anchor('https://status.example.net/')),
        {
          [`GET https://${API}/openapi.json`]: () => json(OPENAPI),
          [`GET ${DOCUMENTED_PROBE}`]: () => json({ error: 'not_found' }, 404),
        },
      ),
      seen,
    );
    expect(requestsTo(seen, 'status.example.net')).toEqual([]);
    expect(hygieneProbes(seen)).toEqual([DOCUMENTED_PROBE]);
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', hosts: [{ host: API }] });
    expect(scorecard.declared_hosts).toContainEqual({
      surface: '/.well-known/api-catalog#/linkset/1',
      kind: 'api-anchor',
      url: 'https://status.example.net/',
      host: 'status.example.net',
      outcome: 'not-followed',
      reason: 'no-service-desc',
    });
  });

  test('with following off, rows that need an off-origin anchor or description read follow-disabled and nothing off the audited origin is requested', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json'))),
      seen,
      false,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({
      status: 'n_a',
      na_reason: 'follow-disabled',
      host: 'specs.example.org',
    });
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'n_a', na_reason: 'follow-disabled', host: API });
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com')).toEqual([]);
  });

  test('a description host that gives no response leaves the OpenAPI row unreachable and the MCP rows their own reason', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () => {
          throw new Error('connection refused');
        },
        [`GET https://${API}${FALLBACK_PATH}`]: () => json({ error: 'not_found' }, 404),
      }),
      seen,
      true,
      apiRegistry('mcp-initialize'),
    );
    expect(row(scorecard, 'openapi')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-unreachable',
      host: 'specs.example.org',
    });
    expect(scorecard.declared_hosts).toContainEqual({
      surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
      kind: 'api-description',
      url: 'https://specs.example.org/openapi.json',
      host: 'specs.example.org',
      outcome: 'unreachable',
    });
    expect(hygieneProbes(seen)).toEqual([`https://${API}${FALLBACK_PATH}`]);
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: API });
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
  });

  test('an MCP endpoint reached through a POST redirect keeps its host slot when the API anchors and descriptions span four other hosts', async () => {
    const moved = 'https://mcp.example.com/mcp';
    const mirrored = 'https://github.com/o/r/raw/main/openapi.json';
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`https://${API}/`, mirrored),
            anchor('https://files.example.net/', `https://${API}/openapi.json`),
          ),
        {
          'POST https://example.com/mcp': () => redirect(moved, 307),
          [`GET ${moved}/server-card`]: () => cardDocument(sep2127Card(moved)),
          [`POST ${moved}`]: () => initializeResult(),
          [`GET ${mirrored}`]: () => redirect('https://raw.githubusercontent.com/o/r/main/openapi.json'),
          'GET https://raw.githubusercontent.com/o/r/main/openapi.json': () => json(OPENAPI),
          [`GET https://${API}/openapi.json`]: () => json(OPENAPI),
        },
      ),
      seen,
      true,
      apiRegistry('mcp-initialize'),
    );
    expect(scorecard.mcp_endpoint).toBe(moved);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: 'mcp.example.com' });
    expect(scorecard.declared_hosts?.map((entry) => [entry.kind, entry.host, entry.outcome])).toEqual([
      ['api-anchor', API, 'followed'],
      ['api-anchor', 'files.example.net', 'followed'],
      ['api-description', 'github.com', 'budget-exceeded'],
      ['api-description', API, 'followed'],
      ['mcp-endpoint', 'mcp.example.com', 'followed'],
    ]);
  });

  test('a hygiene probe of an off-origin anchor host takes no redirect to another origin', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, `https://${API}/openapi.yaml`)), {
        [`GET https://${API}/openapi.yaml`]: () => new Response(OPENAPI_YAML),
        [`GET https://${API}${FALLBACK_PATH}`]: () => redirect('https://www.example.org/not-found'),
      }),
      seen,
    );
    expect(hygieneProbes(seen)).toEqual([`https://${API}${FALLBACK_PATH}`]);
    expect(requestsTo(seen, 'www.example.org')).toEqual([]);
    expect(row(scorecard, 'json-errors')).toMatchObject({ host: API });
  });
});
