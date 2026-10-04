// The URL an API anchor host's hygiene GET goes to: a path a description
// documents, under the base its first server names on the anchor's origin,
// else under the anchor's own path, and the nonsense path under that same
// base when no description yields one.

import { describe, expect, test } from 'bun:test';
import type { CatalogAnchor } from '../src/worker/audit-web/api-catalog';
import { apiTargets } from '../src/worker/audit-web/api-targets';
import { deriveHostProbeUrl } from '../src/worker/audit-web/handlers/api-probe-url';

const DESCRIPTION = 'https://api.example.net/specs/openapi.json';

function spec(servers?: unknown[]) {
  return {
    openapi: '3.1.0',
    ...(servers !== undefined ? { servers } : {}),
    paths: { '/items/{id}': { get: { responses: { '404': { description: 'missing' } } } } },
  };
}

function hostProbe(anchorUrl: string, body: unknown): string {
  const anchor: CatalogAnchor = {
    url: anchorUrl,
    source: '/.well-known/api-catalog#/linkset/0',
    description: { url: DESCRIPTION, source: '/.well-known/api-catalog#/linkset/0/service-desc/0' },
  };
  const entries = [
    { surface: anchor.source, kind: 'api-anchor' as const, url: anchorUrl, outcome: 'followed' as const },
  ];
  const targets = apiTargets('https://example.com/', [anchor], { entries, descriptions: new Map() });
  const host = targets?.hosts[0];
  if (host === undefined) throw new Error('no anchor host target');
  const bodies = new Map([[DESCRIPTION, typeof body === 'string' ? body : JSON.stringify(body)]]);
  return deriveHostProbeUrl(host, bodies).url;
}

describe('deriveHostProbeUrl', () => {
  test.each([
    [
      'the anchor path',
      'https://api.example.net/v2/',
      spec(),
      'https://api.example.net/v2/items/anc-web-audit-no-such',
    ],
    [
      "the first server's path on the anchor's origin",
      'https://api.example.net/',
      spec([{ url: 'https://api.example.net/v1' }]),
      'https://api.example.net/v1/items/anc-web-audit-no-such',
    ],
    [
      "a relative server URL, resolved against the description's URL",
      'https://api.example.net/',
      spec([{ url: '/v3' }]),
      'https://api.example.net/v3/items/anc-web-audit-no-such',
    ],
    [
      'the anchor path, past a server on another origin',
      'https://api.example.net/v2',
      spec([{ url: 'https://sandbox.example.org/v9' }]),
      'https://api.example.net/v2/items/anc-web-audit-no-such',
    ],
    [
      'the anchor path, past a templated server URL',
      'https://api.example.net/v2/',
      spec([{ url: 'https://api.example.net/{version}' }]),
      'https://api.example.net/v2/items/anc-web-audit-no-such',
    ],
    [
      'the anchor path, for the nonsense path when no description parses',
      'https://api.example.net/v2/',
      'openapi: 3.1.0\npaths: {}\n',
      'https://api.example.net/v2/anc-web-audit-no-such-api',
    ],
  ])('a documented path is probed under %s', (_, anchorUrl, body, probe) => {
    expect(hostProbe(anchorUrl, body)).toBe(probe);
  });

  test('a path key naming another authority stays on the anchor host', () => {
    const hostile = { openapi: '3.1.0', paths: { '//evil.example.org/x': { get: { responses: {} } } } };
    expect(new URL(hostProbe('https://api.example.net/', hostile)).host).toBe('api.example.net');
    expect(new URL(hostProbe('https://api.example.net/v2/', hostile)).host).toBe('api.example.net');
  });
});
