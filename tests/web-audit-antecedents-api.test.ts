import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import { catalogAnchors, isApiAnchor } from '../src/worker/audit-web/api-catalog';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { ctx, htmlRoot, outcome } from './web-audit-antecedents-helpers';

const CATALOG_URL = 'https://example.com/.well-known/api-catalog';

function retainedCatalog(body: unknown, overrides: Partial<ProbeResponse> = {}) {
  return {
    url: CATALOG_URL,
    response: {
      status: 200,
      headers: { 'content-type': 'application/linkset+json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      error: null,
      ...overrides,
    },
  };
}

// anc.dev's own catalog: one anchor whose service-desc is its MCP server card.
const MCP_ONLY = {
  linkset: [
    {
      anchor: 'https://example.com/mcp',
      'service-desc': [{ href: 'https://example.com/.well-known/mcp/server-card.json', type: 'application/json' }],
      'service-doc': [{ href: 'https://example.com/mcp-skill', type: 'text/html' }],
    },
  ],
};

describe('catalogAnchors: the linkset anchors the API category reads', () => {
  test('an anchor is an API anchor through its first service-desc that is not an MCP surface, resolved against the catalog', () => {
    const anchors = catalogAnchors(
      retainedCatalog({
        linkset: [
          {
            anchor: 'https://api.example.net/',
            'service-desc': [
              { href: 'https://api.example.net/.well-known/mcp/server-card.json' },
              { href: '/specs/openapi.json' },
            ],
          },
          { anchor: 'https://status.example.net/', 'service-doc': [{ href: 'https://status.example.net/docs' }] },
          { 'service-desc': [{ href: '/no-anchor.json' }] },
        ],
      }),
    );
    expect(anchors).toEqual([
      {
        url: 'https://api.example.net/',
        source: '/.well-known/api-catalog#/linkset/0',
        description: {
          url: 'https://example.com/specs/openapi.json',
          source: '/.well-known/api-catalog#/linkset/0/service-desc/1',
        },
      },
      { url: 'https://status.example.net/', source: '/.well-known/api-catalog#/linkset/1' },
    ]);
    expect(anchors.filter(isApiAnchor).map((a) => a.url)).toEqual(['https://api.example.net/']);
  });

  test("anc.dev's MCP-only catalog lists an anchor but no API anchor", () => {
    const anchors = catalogAnchors(retainedCatalog(MCP_ONLY));
    expect(anchors.map((a) => a.url)).toEqual(['https://example.com/mcp']);
    expect(anchors.filter(isApiAnchor)).toEqual([]);
  });

  test('a catalog that did not answer 200, was cut at its cap, or has no linkset lists no anchor', () => {
    expect(catalogAnchors(undefined)).toEqual([]);
    expect(catalogAnchors(retainedCatalog(MCP_ONLY, { status: 404 }))).toEqual([]);
    expect(catalogAnchors(retainedCatalog(MCP_ONLY, { truncated: true }))).toEqual([]);
    expect(catalogAnchors(retainedCatalog({ entries: [] }))).toEqual([]);
  });
});

describe('resolveAntecedent: api', () => {
  test('api-surface holds via each union signal independently and fails when none hold', () => {
    expect(resolveAntecedent('api-surface', ctx({ siteType: 'api' }))).toBe('apply');
    expect(
      resolveAntecedent('api-surface', ctx({ root: htmlRoot('<link rel="service-desc" href="/openapi.json">') })),
    ).toBe('apply');
    const linkHeaderRoot: ProbeResponse = {
      status: 200,
      headers: { 'content-type': 'text/html', link: '</openapi.json>; rel="service-desc"' },
      body: '<html></html>',
      error: null,
    };
    expect(resolveAntecedent('api-surface', ctx({ root: linkHeaderRoot }))).toBe('apply');
    const openapi200 = ctx({
      sources: new Map([['openapi', outcome('broken', [{ url: 'https://x.dev/openapi.json', status: 200 }])]]),
    });
    expect(resolveAntecedent('api-surface', openapi200)).toBe('apply');
    const llmsApiLink = ctx({
      sources: new Map([
        [
          'llms-txt',
          outcome('pass', [{ url: 'https://x.dev/llms.txt', status: 200, body: '- [API](/api/reference)' }]),
        ],
      ]),
    });
    expect(resolveAntecedent('api-surface', llmsApiLink)).toBe('apply');
    expect(resolveAntecedent('api-surface', ctx())).toBe('n_a');
  });

  test('api-surface holds on an API anchor in the retained api-catalog, and not on an MCP-only one', () => {
    const anchors = catalogAnchors(
      retainedCatalog({
        linkset: [
          { anchor: 'https://api.example.net/', 'service-desc': [{ href: 'https://api.example.net/openapi.json' }] },
        ],
      }),
    );
    expect(resolveAntecedent('api-surface', ctx({ apiAnchors: anchors.filter(isApiAnchor) }))).toBe('apply');
    const mcpOnly = catalogAnchors(retainedCatalog(MCP_ONLY)).filter(isApiAnchor);
    expect(resolveAntecedent('api-surface', ctx({ apiAnchors: mcpOnly }))).toBe('n_a');
  });

  test('api-surface stays n_a for an MCP-first site advertising service-desc/doc at its MCP card', () => {
    // Regression: a homepage Link header pointing service-desc at the MCP
    // server card (RFC 8631) is not a REST API surface, so the openapi and
    // api-catalog checks must not activate.
    const mcpFirstRoot: ProbeResponse = {
      status: 200,
      headers: {
        'content-type': 'text/html',
        link: '</.well-known/api-catalog>; rel="api-catalog", </.well-known/mcp/server-card.json>; rel="service-desc", </mcp-skill>; rel="service-doc"',
      },
      body: '<html><body><main>anc audits MCP, llms.txt, OpenAPI, and JSON Schema.</main></body></html>',
      error: null,
    };
    expect(resolveAntecedent('api-surface', ctx({ mcpEndpoint: 'https://anc.dev/mcp', root: mcpFirstRoot }))).toBe(
      'n_a',
    );
  });

  test('api-surface holds when service-desc/doc targets a non-MCP description', () => {
    const restRoot: ProbeResponse = {
      status: 200,
      headers: { 'content-type': 'text/html', link: '</service/describe>; rel="service-desc"' },
      body: '<html></html>',
      error: null,
    };
    expect(resolveAntecedent('api-surface', ctx({ root: restRoot }))).toBe('apply');
  });

  test('api-surface ignores a bare openapi/swagger mention in page prose', () => {
    const proseRoot = htmlRoot('<html><body><main>We support OpenAPI and Swagger in our tooling.</main></body></html>');
    expect(resolveAntecedent('api-surface', ctx({ root: proseRoot }))).toBe('n_a');
  });

  test('api-surface holds when the sitemap lists an OpenAPI/Swagger document', () => {
    const specSitemap = ctx({
      sources: new Map([
        [
          'sitemap',
          outcome('pass', [
            {
              url: 'https://x.dev/sitemap.xml',
              status: 200,
              body: '<url><loc>https://x.dev/api/v1/openapi.json</loc></url>',
            },
          ]),
        ],
      ]),
    });
    expect(resolveAntecedent('api-surface', specSitemap)).toBe('apply');
  });

  test('api-surface ignores a sitemap URL that only contains the word openapi', () => {
    // A doc page like /web-audit/skill/openapi is not an API surface; only a
    // .json/.yaml descriptor URL counts.
    const docPageSitemap = ctx({
      sources: new Map([
        [
          'sitemap',
          outcome('pass', [
            {
              url: 'https://x.dev/sitemap.xml',
              status: 200,
              body: '<url><loc>https://x.dev/web-audit/skill/openapi</loc></url>',
            },
          ]),
        ],
      ]),
    });
    expect(resolveAntecedent('api-surface', docPageSitemap)).toBe('n_a');
  });

  test('api-surface holds when llms.txt links an OpenAPI descriptor', () => {
    const llmsSpec = ctx({
      sources: new Map([
        ['llms-txt', outcome('pass', [{ url: 'https://x.dev/llms.txt', status: 200, body: '- [API](/openapi.json)' }])],
      ]),
    });
    expect(resolveAntecedent('api-surface', llmsSpec)).toBe('apply');
  });

  test('api-surface ignores a bare openapi mention or doc-page link in llms.txt', () => {
    // A summary that names OpenAPI, or a link to a doc page like
    // /web-audit/skill/openapi, is not an API surface; llms.txt is scanned
    // for a descriptor URL or a curated /api/ path, not a bare word.
    const llmsProse = ctx({
      sources: new Map([
        [
          'llms-txt',
          outcome('pass', [
            {
              url: 'https://x.dev/llms.txt',
              status: 200,
              body: '> We document OpenAPI and Swagger.\n- [OpenAPI check](/web-audit/skill/openapi)',
            },
          ]),
        ],
      ]),
    });
    expect(resolveAntecedent('api-surface', llmsProse)).toBe('n_a');
  });

  test('schemas-ref holds on a passing openapi or a schema reference in the root', () => {
    const openapiPass = ctx({ sources: new Map([['openapi', outcome('pass')]]) });
    expect(resolveAntecedent('schemas-ref', openapiPass)).toBe('apply');
    expect(resolveAntecedent('schemas-ref', ctx({ root: htmlRoot('see /schema.json for shapes') }))).toBe('apply');
    expect(resolveAntecedent('schemas-ref', ctx())).toBe('n_a');
  });
});
