// The API category on api-catalog anchors: the OpenAPI row scores the
// description each API anchor declares, wherever it is hosted, and the
// hygiene rows probe each anchor host, driven through the engine with the
// shipped registry's API checks and a router keyed by full URL so every
// host the audit touches is visible.

import { describe, expect, test } from 'bun:test';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import { NO_PLAINTEXT_REQUEST } from '../src/shared/web-audit-result-line';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import { OPENAPI_MAX_BODY_BYTES } from '../src/worker/audit-web/ssrf';
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

type Placement = { anchor: string; url: string; offOrigin: boolean };

const DESCRIPTION_PLACEMENTS: Array<[string, Placement]> = [
  [
    'read by the follow slice off the audited origin',
    { anchor: `https://${API}/`, url: `https://${API}/openapi.json`, offOrigin: true },
  ],
  [
    'read on the audited origin',
    { anchor: 'https://example.com/', url: 'https://example.com/openapi.json', offOrigin: false },
  ],
];

// Stripe's spec3.json puts its `openapi` key after the components object,
// which alone runs past the bytes the cap reads.
const PADDING = 'x'.repeat(OPENAPI_MAX_BODY_BYTES);
const JSON_PAST_THE_CAP = JSON.stringify({ components: { schemas: { padding: PADDING } }, ...OPENAPI });
const YAML_PAST_THE_CAP = `components:\n  schemas:\n    padding: ${PADDING}\nopenapi: 3.1.0\npaths: {}\n`;
const HTML_PAST_THE_CAP = `<!doctype html>\n<html><body><p>${PADDING}</p><a href="/openapi.json">OpenAPI</a></body></html>\n`;

const PRESENT_PAST_THE_CAP: Array<[string, string, string]> = [
  ['JSON', 'application/json', JSON_PAST_THE_CAP],
  ['YAML', 'application/yaml', YAML_PAST_THE_CAP],
  ['a JSON object served as plain text', 'text/plain', JSON_PAST_THE_CAP],
];

const NOT_A_DESCRIPTION_PAST_THE_CAP: Array<[string, string, string]> = [
  ['an HTML page', 'text/html', HTML_PAST_THE_CAP],
  ['an HTML page labelled JSON', 'application/json', HTML_PAST_THE_CAP],
  ['plain text that opens no JSON object', 'text/plain', `${PADDING}\nopenapi\n`],
  ['an AsyncAPI document in YAML', 'application/yaml', `asyncapi: 3.0.0\n# ${PADDING}\nopenapi\n`],
  ['a GraphQL introspection result', 'application/json', `{"__schema": {"types": "${PADDING}"}, "openapi": 1}`],
];

function rawEvidence(events: Awaited<ReturnType<typeof auditApi>>['events'], id: string) {
  return events.flatMap((e) => (e.type === 'result' && e.result.id === id ? e.result.raw_evidence : []));
}

async function auditDescription(placement: Placement, contentType: string, body: string) {
  const seen: Seen[] = [];
  const { events, scorecard } = await auditApi(
    site(() => linkset(anchor(placement.anchor, placement.url)), {
      [`GET ${placement.url}`]: () => new Response(body, { headers: { 'content-type': contentType } }),
    }),
    seen,
  );
  return { openapi: row(scorecard, 'openapi'), evidence: rawEvidence(events, 'openapi'), seen };
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

  test('an anchor host not followed, listed first, neither masks nor passes the failing host beside it', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`https://${API}/`, `https://${API}/openapi.json`),
            anchor(TARGET, 'https://example.com/openapi.yaml'),
          ),
        {
          'GET https://example.com/openapi.yaml': () => new Response(OPENAPI_YAML),
          [`GET https://example.com${FALLBACK_PATH}`]: () => htmlError(),
        },
      ),
      seen,
      false,
    );
    expect(row(scorecard, 'json-errors')).toMatchObject({
      status: 'broken',
      hosts: [
        { host: API, status: 'n_a', na_reason: 'follow-disabled' },
        { host: 'example.com', status: 'broken' },
      ],
    });
    expect(requestsTo(seen, API)).toEqual([]);
  });

  test('the OpenAPI row needs every declared description: one passing beside one answering 404 reads absent', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`https://${API}/`, `https://${API}/openapi.json`),
            anchor('https://files.example.net/', 'https://files.example.net/openapi.json'),
          ),
        { [`GET https://${API}/openapi.json`]: () => json(OPENAPI) },
      ),
      seen,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({
      status: 'absent',
      hosts: [
        { host: API, status: 'pass' },
        { host: 'files.example.net', status: 'absent' },
      ],
    });
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

  describe.each(DESCRIPTION_PLACEMENTS)('an OpenAPI description %s', (_where, placement) => {
    test.each(
      PRESENT_PAST_THE_CAP,
    )('cut at the cap as %s, its marker past the cap, counts as present with its evidence marked truncated', async (_shape, contentType, body) => {
      const { openapi, evidence, seen } = await auditDescription(placement, contentType, body);
      expect(openapi.status).toBe('pass');
      expect(evidence[0]).toMatchObject({
        url: placement.url,
        status: 200,
        ok: true,
        truncated: true,
        why: ['status 200 in [200]', 'description larger than 512 KiB; read in part, presence counted'],
      });
      expect(evidence[0]?.off_origin === true).toBe(placement.offOrigin);
      expect(hygieneProbes(seen)).toEqual([`${new URL(placement.anchor).origin}${FALLBACK_PATH}`]);
    });

    test.each(
      NOT_A_DESCRIPTION_PAST_THE_CAP,
    )('cut at the cap as %s keeps its miss', async (_shape, contentType, body) => {
      const { openapi, evidence } = await auditDescription(placement, contentType, body);
      expect(openapi.status).toBe('broken');
      expect(evidence[0]).toMatchObject({
        url: placement.url,
        ok: false,
        truncated: true,
        why: ['status 200 in [200]', 'body no match /openapi|swagger/'],
      });
    });

    test('read whole without the marker keeps its miss', async () => {
      const { openapi, evidence } = await auditDescription(
        placement,
        'application/json',
        JSON.stringify({ components: { schemas: {} }, paths: {} }),
      );
      expect(openapi.status).toBe('broken');
      expect(evidence[0]).toMatchObject({ ok: false, why: ['status 200 in [200]', 'body no match /openapi|swagger/'] });
      expect(evidence[0]?.truncated).toBeUndefined();
    });
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

  test('an off-origin description that passes is not a JSON Schema reference of the audited site, which gets no schema probe', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () => json(OPENAPI),
      }),
      seen,
      true,
      apiRegistry('json-schemas'),
    );
    expect(row(scorecard, 'openapi').status).toBe('pass');
    expect(row(scorecard, 'json-schemas')).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
    expect(requestsTo(seen, 'example.com').filter((r) => r.url.includes('schema'))).toEqual([]);
  });

  test("an off-origin description answering 401 is not the audited site's auth surface", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () =>
          json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="specs"' }),
      }),
      seen,
      true,
      apiRegistry('oauth-discovery', 'auth-md'),
    );
    for (const id of ['oauth-discovery', 'auth-md'])
      expect(row(scorecard, id)).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
    expect(requestsTo(seen, 'example.com').filter((r) => r.url.includes('auth.md'))).toEqual([]);
  });

  test('a declared content site follows no API anchor and reads no description, since no API row applies to it', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
          'GET https://specs.example.org/openapi.json': () => json(OPENAPI),
        }),
        seen,
      ),
      { registry: apiRegistry(), siteType: 'content' },
    );
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com')).toEqual([]);
    expect(scorecard.declared_hosts?.filter((entry) => entry.outcome === 'followed')).toEqual([]);
    for (const id of API_IDS) expect(row(scorecard, id).status).toBe('n_a');
  });

  test('every API row applies to the api site type alone, which is what the follow slice gates the catalog on', () => {
    const api = loadRegistry().checks.filter((check) => check.category === 'api');
    expect(api.length).toBeGreaterThan(0);
    for (const check of api)
      expect({ id: check.id, site_types: check.site_types }).toEqual({ id: check.id, site_types: ['api'] });
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

  test('an API mounted under /v2 is probed under /v2, at the path its description documents', async () => {
    const seen: Seen[] = [];
    const mounted = `https://${API}/v2/v1/items/anc-web-audit-no-such`;
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/v2/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () => json(OPENAPI),
        [`GET ${mounted}`]: () => json({ error: 'not_found' }, 404),
      }),
      seen,
    );
    expect(hygieneProbes(seen)).toEqual([mounted]);
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: API });
  });

  test('an off-origin description whose redirect hop redirects again reads unreachable, not broken', async () => {
    const seen: Seen[] = [];
    const hop = 'https://mirror.example.org/openapi.json';
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`https://${API}/`, 'https://specs.example.org/openapi.json')), {
        'GET https://specs.example.org/openapi.json': () => redirect(hop),
        [`GET ${hop}`]: () => redirect('https://elsewhere.example.org/openapi.json'),
      }),
      seen,
    );
    expect(row(scorecard, 'openapi')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-unreachable',
      host: 'mirror.example.org',
    });
    expect(scorecard.declared_hosts).toContainEqual({
      surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
      kind: 'api-description',
      url: 'https://specs.example.org/openapi.json',
      host: 'specs.example.org',
      final_url: hop,
      outcome: 'unreachable',
    });
    expect(requestsTo(seen, 'elsewhere.example.org')).toEqual([]);
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

  test("an anchor and a description in the auditor's own zone get no description read and no hygiene GET", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor('https://api.anc.dev/', 'https://anc.dev/openapi.json'))),
      seen,
    );
    expect(seen.filter((r) => new URL(r.url).hostname.endsWith('anc.dev'))).toEqual([]);
    expect(scorecard.declared_hosts?.map((entry) => [entry.kind, entry.outcome, entry.reason])).toEqual([
      ['api-anchor', 'not-followed', 'self-path'],
      ['api-description', 'not-followed', 'self-path'],
    ]);
    for (const id of ['openapi', 'json-errors', 'rate-limit-headers']) expect(row(scorecard, id).status).toBe('n_a');
  });

  test('an anchor on an IP literal and a description on localhost are blocked and never requested', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor('https://127.0.0.1/', 'http://localhost/openapi.json'))),
      seen,
    );
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com')).toEqual([]);
    expect(scorecard.declared_hosts?.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ['api-anchor', 'blocked'],
      ['api-description', 'blocked'],
    ]);
    expect(row(scorecard, 'openapi')).toMatchObject({ status: 'n_a', na_reason: 'declared-host-blocked' });
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'n_a', na_reason: 'declared-host-blocked' });
  });

  test('an http anchor and an http description are never requested, and neither is an http redirect hop of an https description', async () => {
    const seen: Seen[] = [];
    const hop = 'http://files.example.net/openapi.json';
    const { scorecard, events } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`http://${API}/`, `http://${API}/openapi.json`),
            anchor('https://files.example.net/', 'https://files.example.net/openapi.json'),
          ),
        {
          [`GET http://${API}/openapi.json`]: () => json(OPENAPI),
          [`GET http://${API}/v1/items/anc-web-audit-no-such`]: () => json({ error: 'not_found' }, 404),
          'GET https://files.example.net/openapi.json': () => redirect(hop),
          [`GET ${hop}`]: () => json(OPENAPI),
        },
      ),
      seen,
    );
    expect(seen.filter((r) => r.url.startsWith('http:'))).toEqual([]);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/api-catalog#/linkset/0',
        kind: 'api-anchor',
        url: `http://${API}/`,
        host: API,
        outcome: 'not-followed',
        reason: 'insecure-scheme',
      },
      {
        surface: '/.well-known/api-catalog#/linkset/1',
        kind: 'api-anchor',
        url: 'https://files.example.net/',
        host: 'files.example.net',
        outcome: 'followed',
      },
      {
        surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
        kind: 'api-description',
        url: `http://${API}/openapi.json`,
        host: API,
        outcome: 'not-followed',
        reason: 'insecure-scheme',
      },
      {
        surface: '/.well-known/api-catalog#/linkset/1/service-desc/0',
        kind: 'api-description',
        url: 'https://files.example.net/openapi.json',
        host: 'files.example.net',
        final_url: hop,
        outcome: 'not-followed',
        reason: 'insecure-scheme',
      },
    ]);
    expect(row(scorecard, 'openapi').hosts?.map((h) => h.host)).not.toContain(API);
    expect(row(scorecard, 'openapi').status).toBe('absent');
    expect(rawEvidence(events, 'openapi').map((item) => [item.url, item.why])).toEqual([
      [`http://${API}/openapi.json`, [`not https; ${NO_PLAINTEXT_REQUEST}`]],
      ['https://files.example.net/openapi.json', [`redirects to http; ${NO_PLAINTEXT_REQUEST}`]],
    ]);
  });

  test('a catalog that declares its API only over http reads absent on every API row, as one that declares none does', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await auditApi(
      site(() => linkset(anchor(`http://${API}/`, `http://${API}/openapi.json`))),
      seen,
    );
    expect(seen.filter((r) => r.url.startsWith('http:'))).toEqual([]);
    expect(['openapi', 'json-errors', 'rate-limit-headers'].map((id) => [id, row(scorecard, id).status])).toEqual([
      ['openapi', 'absent'],
      ['json-errors', 'absent'],
      ['rate-limit-headers', 'absent'],
    ]);
    expect(row(scorecard, 'openapi').evidence).toBe(`http://${API}/openapi.json: not https; ${NO_PLAINTEXT_REQUEST}`);
    expect(row(scorecard, 'json-errors').evidence).toBe(`http://${API}/: not https; ${NO_PLAINTEXT_REQUEST}`);
    expect(row(scorecard, 'openapi').hosts ?? []).toEqual([]);
  });

  test('an https API declared beside an http one is scored on the https one alone', async () => {
    const seen: Seen[] = [];
    const plain = 'plain.example.org';
    const { scorecard } = await auditApi(
      site(
        () =>
          linkset(
            anchor(`http://${plain}/`, `http://${plain}/openapi.json`),
            anchor(`https://${API}/`, `https://${API}/openapi.json`),
          ),
        {
          [`GET https://${API}/openapi.json`]: () => json(OPENAPI),
          [`GET ${DOCUMENTED_PROBE}`]: () => json({ error: 'not_found' }, 404),
        },
      ),
      seen,
    );
    expect(seen.filter((r) => r.url.startsWith('http:'))).toEqual([]);
    expect(row(scorecard, 'openapi')).toMatchObject({ status: 'pass', host: API });
    expect(row(scorecard, 'json-errors')).toMatchObject({ status: 'pass', host: API });
    expect(row(scorecard, 'openapi').evidence).not.toContain(plain);
  });
});
