// The spec-drift compare: every watched source type resolves to the pinned
// value through an injected fetch, canonicalization absorbs serializer key
// order, and a real upstream change surfaces as exactly one drifted entry.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  checkDrift,
  type FetchImpl,
  MANIFEST_PATH,
  parseManifest,
  SOURCE_TYPES,
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
    expect(report.errors.map((e) => ['id' in e ? e.id : null, e.reason])).toEqual([
      ['acme-schema', 'http-status'],
      ['acme-draft', 'fetch-failed'],
    ]);
  });
});

describe('GitHub API reads authenticate with a supplied token', () => {
  async function authorizationByUrl(options?: { githubToken?: string }): Promise<Record<string, string | null>> {
    const seen: Record<string, string | null> = {};
    const inner = fakeFetch(cleanRoutes());
    const recording: FetchImpl = async (url, init) => {
      seen[url] = new Headers(init?.headers).get('authorization');
      return inner(url, init);
    };
    const report = await checkDrift(manifest(), recording, options);
    expect(report.status).toBe('clean');
    return seen;
  }

  test('the token reaches api.github.com only, and only when supplied', async () => {
    expect(await authorizationByUrl({ githubToken: 'test-token' })).toEqual({
      [PR_API]: 'Bearer test-token',
      [SCHEMA_API]: 'Bearer test-token',
      [DOC_API]: 'Bearer test-token',
      [SCHEMA_URL]: null,
      [DRAFT_API]: null,
      [OPENAPI_URL]: null,
    });
    const anonymous = await authorizationByUrl();
    expect(Object.values(anonymous)).toEqual([null, null, null, null, null, null]);
  });
});

describe('a moved or missing source routes to the right next step', () => {
  const errorsOf = (report: Awaited<ReturnType<typeof checkDrift>>) =>
    report.errors.map((e) => ({ id: 'id' in e ? e.id : null, reason: e.reason, action: e.next_step.action }));

  test('drift found alongside an error is still listed, and the run reports the error', async () => {
    const routes = cleanRoutes();
    routes[PR_API] = () => json({ number: 7, state: 'open', merged: false, head: { sha: 'b'.repeat(40) } });
    routes[DRAFT_API] = () => new Response('upstream down', { status: 503 });
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.status).toBe('error');
    expect(report.exit_code).toBe(2);
    expect(report.drifted.map((d) => d.id)).toEqual(['acme-pr']);
    expect(errorsOf(report)).toEqual([{ id: 'acme-draft', reason: 'http-status', action: 'retry' }]);
  });

  test('a watched URL answering 503 or 429 is a retryable error, not a changed status', async () => {
    for (const status of [503, 429]) {
      const routes = cleanRoutes();
      routes[SCHEMA_URL] = () => new Response('busy', { status });
      const report = await checkDrift(manifest(), fakeFetch(routes));
      expect({ status, drifted: report.drifted }).toEqual({ status, drifted: [] });
      expect(errorsOf(report)).toEqual([{ id: 'acme-schema-url', reason: 'http-status', action: 'retry' }]);
    }
  });

  test('a watched file that no longer exists asks for the manifest entry to be re-pointed', async () => {
    const routes = cleanRoutes();
    routes[DOC_API] = () => new Response('Not Found', { status: 404 });
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.drifted).toEqual([]);
    expect(errorsOf(report)).toEqual([{ id: 'acme-discovery', reason: 'http-status', action: 'fix-manifest' }]);
  });

  test('a JSON Pointer whose path vanished asks for the pointer to be fixed rather than pinning null', async () => {
    const routes = cleanRoutes();
    routes[OPENAPI_URL] = () => json({ openapi: '3.2.0', components: { schemas: {} } });
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.drifted).toEqual([]);
    expect(errorsOf(report)).toEqual([{ id: 'acme-registry-schema', reason: 'parse-failed', action: 'fix-manifest' }]);
  });

  test('a changed value at a JSON Pointer reports one drifted entry', async () => {
    const next = 'https://schemas.example.test/2026-03-01/server.schema.json';
    const routes = cleanRoutes();
    routes[OPENAPI_URL] = () =>
      json({ components: { schemas: { Server: { properties: { $schema: { examples: [next] } } } } } });
    const report = await checkDrift(manifest(), fakeFetch(routes));
    expect(report.errors).toEqual([]);
    expect(report.drifted.map((d) => [d.id, d.new])).toEqual([['acme-registry-schema', next]]);
  });
});

describe('the committed manifest', () => {
  test('parses into at least one entry', () => {
    expect(parseManifest(readFileSync(MANIFEST_PATH, 'utf8')).length).toBeGreaterThan(0);
  });

  test('an unknown tier or source type is rejected', () => {
    expect(() => parseManifest(MANIFEST.replace('tier: draft', 'tier: rumor'))).toThrow(/tier/);
    expect(() => parseManifest(MANIFEST.replace('type: url-status', 'type: url-body'))).toThrow(/type/);
  });

  test('the server-card schema pin is the vendored schema, so an upstream shape change reads as drift', () => {
    const entry = parseManifest(readFileSync(MANIFEST_PATH, 'utf8')).find((e) => e.id === 'mcp-server-card-schema');
    const vendored = readFileSync(
      join(import.meta.dir, '..', 'src', 'data', 'web-audit', 'server-card.schema.json'),
      'utf8',
    );
    expect(sha256(canonicalJson(JSON.parse(vendored)))).toBe(String(entry?.pinned));
  });
});
