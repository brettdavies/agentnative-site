import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { ctx, htmlRoot, outcome } from './web-audit-antecedents-helpers';

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
