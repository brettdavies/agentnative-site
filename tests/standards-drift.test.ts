// The spec-drift compare: every watched source type resolves to the pinned
// value through an injected fetch, canonicalization absorbs serializer key
// order, and a real upstream change surfaces as exactly one drifted entry.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  checkDrift,
  type FetchImpl,
  MANIFEST_PATH,
  parseManifest,
  SOURCE_TYPES,
  TIERS,
} from '../scripts/standards/check-drift';

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const PR_API = 'https://api.github.com/repos/acme/spec/pulls/7';
const SCHEMA_API = 'https://api.github.com/repos/acme/ext/contents/schema.json?ref=main';
const DOC_API = 'https://api.github.com/repos/acme/ext/contents/docs/discovery.md?ref=main';
const SCHEMA_URL = 'https://schemas.example.test/v1/card.schema.json';
const OPENAPI_URL = 'https://registry.example.test/openapi.json';
const DRAFT_API = 'https://datatracker.ietf.org/doc/draft-acme-dnsop-thing/doc.json';

const SCHEMA_BODY = '{\n  "type": "object",\n  "$defs": { "b": 1, "a": [2, 1] }\n}\n';
const SCHEMA_REORDERED = '{"$defs":{"b":1,"a":[2,1]},"type":"object"}';
const SCHEMA_CANONICAL = '{"$defs":{"a":[2,1],"b":1},"type":"object"}';
const DOC_BODY = '# Discovery\n\nFetch the card.\n';
const PR_HEAD = 'a'.repeat(40);

const MANIFEST = `
sources:
  - id: acme-pr
    tier: proposal
    type: github-pr
    url: https://github.com/acme/spec/pull/7
    canonicalization: json
    pinned: { state: open, merged: false, head_sha: "${PR_HEAD}" }
  - id: acme-schema
    tier: proposal
    type: github-file
    url: https://github.com/acme/ext/blob/main/schema.json
    canonicalization: json
    pinned: "${sha256(SCHEMA_CANONICAL)}"
  - id: acme-discovery
    tier: proposal
    type: github-file
    url: https://github.com/acme/ext/blob/main/docs/discovery.md
    canonicalization: none
    pinned: "${sha256(DOC_BODY)}"
  - id: acme-schema-url
    tier: proposal
    type: url-status
    url: ${SCHEMA_URL}
    canonicalization: json
    pinned: 404
  - id: acme-draft
    tier: draft
    type: ietf-draft
    url: https://datatracker.ietf.org/doc/draft-acme-dnsop-thing/
    canonicalization: json
    pinned: { rev: "02", state: Active }
  - id: acme-registry-schema
    tier: spec
    type: json-field
    url: ${OPENAPI_URL}
    pointer: /components/schemas/Server/properties/$schema/examples/0
    canonicalization: json
    pinned: https://schemas.example.test/2025-12-11/server.schema.json
`;

type Routes = Record<string, () => Response>;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function cleanRoutes(): Routes {
  return {
    [PR_API]: () => json({ number: 7, state: 'open', merged: false, head: { sha: PR_HEAD, ref: 'sep/card' } }),
    [SCHEMA_API]: () => new Response(SCHEMA_BODY),
    [DOC_API]: () => new Response(DOC_BODY),
    [SCHEMA_URL]: () => new Response('not found', { status: 404 }),
    [DRAFT_API]: () => json({ name: 'draft-acme-dnsop-thing', rev: '02', state: 'Active', pages: 20 }),
    [OPENAPI_URL]: () =>
      json({
        openapi: '3.1.0',
        components: {
          schemas: {
            Server: {
              properties: { $schema: { examples: ['https://schemas.example.test/2025-12-11/server.schema.json'] } },
            },
          },
        },
      }),
  };
}

function fakeFetch(routes: Routes): FetchImpl {
  return async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`unrouted fetch: ${url}`);
    return route();
  };
}

const manifest = () => parseManifest(MANIFEST);

describe('fetchers resolve the pinned value for every source type', () => {
  test('a clean upstream reports no drift and no errors across all five types', async () => {
    const report = await checkDrift(manifest(), fakeFetch(cleanRoutes()));
    expect(report.errors).toEqual([]);
    expect(report.drifted).toEqual([]);
    expect(report.checked).toBe(6);
    expect(report.status).toBe('clean');
    expect(report.exit_code).toBe(0);
    const types = new Set(manifest().map((entry) => entry.type));
    expect([...types].sort()).toEqual([...SOURCE_TYPES].sort());
  });

  test('reordered keys in a fetched JSON document do not report drift', async () => {
    const routes = cleanRoutes();
    routes[SCHEMA_API] = () => new Response(SCHEMA_REORDERED);
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.drifted).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});

describe('a real upstream change reports exactly one drifted entry', () => {
  async function driftOf(mutate: (routes: Routes) => void) {
    const routes = cleanRoutes();
    mutate(routes);
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.errors).toEqual([]);
    expect(report.status).toBe('drift');
    expect(report.exit_code).toBe(1);
    expect(report.drifted).toHaveLength(1);
    return report.drifted[0];
  }

  test('a changed PR head SHA', async () => {
    const newHead = 'b'.repeat(40);
    const drift = await driftOf((routes) => {
      routes[PR_API] = () => json({ state: 'open', merged: false, head: { sha: newHead } });
    });
    expect(drift).toEqual({
      id: 'acme-pr',
      tier: 'proposal',
      type: 'github-pr',
      url: 'https://github.com/acme/spec/pull/7',
      old: { state: 'open', merged: false, head_sha: PR_HEAD },
      new: { state: 'open', merged: false, head_sha: newHead },
    });
  });

  test('a changed file hash', async () => {
    const changed = '{"$defs":{"a":[2,1],"b":1},"type":"object","required":["remotes"]}';
    const drift = await driftOf((routes) => {
      routes[SCHEMA_API] = () => new Response(changed);
    });
    expect(drift.id).toBe('acme-schema');
    expect(drift.old).toBe(sha256(SCHEMA_CANONICAL));
    expect(drift.new).toBe(sha256('{"$defs":{"a":[2,1],"b":1},"required":["remotes"],"type":"object"}'));
  });

  test('a schema URL that starts resolving', async () => {
    const drift = await driftOf((routes) => {
      routes[SCHEMA_URL] = () => json({ $schema: 'https://json-schema.org/draft/2020-12/schema' });
    });
    expect(drift).toMatchObject({ id: 'acme-schema-url', type: 'url-status', url: SCHEMA_URL, old: 404, new: 200 });
  });

  test('a bumped draft revision', async () => {
    const drift = await driftOf((routes) => {
      routes[DRAFT_API] = () => json({ name: 'draft-acme-dnsop-thing', rev: '03', state: 'Active' });
    });
    expect(drift).toMatchObject({
      id: 'acme-draft',
      tier: 'draft',
      type: 'ietf-draft',
      url: 'https://datatracker.ietf.org/doc/draft-acme-dnsop-thing/',
      old: { rev: '02', state: 'Active' },
      new: { rev: '03', state: 'Active' },
    });
  });
});

describe('fetch failures are reported apart from drift', () => {
  test('an HTTP error and a network failure become errors, never drift or a clean pass', async () => {
    const routes = cleanRoutes();
    routes[SCHEMA_API] = () => new Response('upstream down', { status: 503 });
    routes[DRAFT_API] = () => {
      throw new TypeError('network unreachable');
    };
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.drifted).toEqual([]);
    expect(report.status).toBe('error');
    expect(report.exit_code).toBe(2);
    expect(report.errors.map((e) => [e.id, e.reason])).toEqual([
      ['acme-schema', 'http-status'],
      ['acme-draft', 'fetch-failed'],
    ]);
  });
});

describe('the committed manifest', () => {
  test('parses, and every entry carries a known tier and source type', () => {
    const entries = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(TIERS).toContain(entry.tier);
      expect(SOURCE_TYPES).toContain(entry.type);
    }
  });

  test('an unknown tier or source type is rejected', () => {
    expect(() => parseManifest(MANIFEST.replace('tier: draft', 'tier: rumor'))).toThrow(/tier/);
    expect(() => parseManifest(MANIFEST.replace('type: url-status', 'type: url-body'))).toThrow(/type/);
  });
});
