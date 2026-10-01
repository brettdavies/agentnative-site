// OAuth-protected MCP endpoints, driven through the engine against the real
// registry rows with a router keyed by full URL, so every host the audit
// touches and every row's reading is visible.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { endpointRedirects } from '../src/worker/audit-web/handlers/shared';
import type { AntecedentToken, WebAuditRegistry } from '../src/worker/audit-web/registry';
import {
  audit,
  cardDocument,
  json,
  type Route,
  requestsTo,
  router,
  row,
  type Seen,
  sep2127Card,
  siteDeclaring,
} from './helpers/follow-fixtures';

const REGISTRY = normalizeWebAuditRegistry(
  yaml.load(readFileSync(join(import.meta.dir, '..', 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8')) as object,
) as WebAuditRegistry;

/** The real MCP rows plus the protected-resource metadata row, each scored exactly as a live audit scores it. */
function mcpRegistry(): WebAuditRegistry {
  return {
    ...REGISTRY,
    checks: REGISTRY.checks.filter((c) => c.category === 'mcp' || c.id === 'oauth-protected-resource'),
  };
}

const ENDPOINT = 'https://mcp.example.net/mcp';
const NET = 'mcp.example.net';

const unauthorized = (challenge?: string): Response =>
  json({ error: 'unauthorized' }, 401, challenge === undefined ? {} : { 'www-authenticate': challenge });

describe('auth rows read the endpoint host', () => {
  test('with a followed endpoint, the protected-resource metadata row reads the endpoint host, not the audited site', async () => {
    const seen: Seen[] = [];
    const routes: Record<string, Route> = {
      ...siteDeclaring(ENDPOINT),
      [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)),
      [`POST ${ENDPOINT}`]: () => unauthorized('Bearer realm="mcp"'),
      [`GET https://${NET}/.well-known/oauth-protected-resource`]: () =>
        json({ resource: ENDPOINT, authorization_servers: ['https://auth.example.net'] }),
    };
    const { scorecard } = await audit(router(routes, seen), { registry: mcpRegistry() });
    expect(row(scorecard, 'oauth-protected-resource')).toMatchObject({ status: 'pass', host: NET });
    expect(
      requestsTo(seen, 'example.com').filter((r) => r.url.includes('/.well-known/oauth-protected-resource')),
    ).toEqual([]);
  });

  test('a document on a followed endpoint host takes no redirect; on the audited origin the default applies', () => {
    const path = '{mcp_origin}/.well-known/oauth-protected-resource';
    expect(endpointRedirects(path, true, 'GET')).toEqual({ refuseRedirects: true });
    expect(endpointRedirects(path, false, 'GET')).toEqual({});
    expect(endpointRedirects(path, undefined, 'GET')).toEqual({});
  });
});

const SAME = 'https://example.com/mcp';
const SAME_METADATA = 'https://example.com/.well-known/oauth-protected-resource';
const ECHO_PROBE = 'https://example.com/.well-known/oauth-protected-resource/anc-web-audit-no-such-resource';
const ACAO = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const UNSUPPORTED_VERSION = '2025-03-26';

const bearer = (metadataUrl: string): string => `Bearer resource_metadata="${metadataUrl}"`;

type ServerOptions = {
  /** The malformed-body probe draws the 401 too, instead of being parsed before the token is checked. */
  challengeMalformed?: boolean;
  metadata?: unknown;
};

/**
 * An MCP server behind OAuth: every POST draws a 401 whose challenge names
 * its RFC 9728 metadata, apart from an unparseable body and an unsupported
 * version claim, which it refuses before reading a token.
 */
function protectedServer(endpoint: string, metadataUrl: string, opts: ServerOptions = {}): Record<string, Route> {
  const challenge = bearer(metadataUrl);
  return {
    [`POST ${endpoint}`]: (init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      if (body.startsWith('not-json') && opts.challengeMalformed !== true) {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
      }
      if (headers.get('mcp-protocol-version') === UNSUPPORTED_VERSION) {
        return json(
          {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32022, message: 'unsupported', data: { supported: ['2026-07-28'] } },
          },
          400,
        );
      }
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate': challenge,
        ...(headers.get('origin') !== null ? ACAO : {}),
      });
    },
    [`OPTIONS ${endpoint}`]: () => new Response(null, { status: 204, headers: ACAO }),
    [`GET ${endpoint}`]: () => unauthorized(challenge),
    [`GET ${metadataUrl}`]: () =>
      json(opts.metadata ?? { resource: endpoint, authorization_servers: ['https://auth.example.net'] }),
  };
}

const ROOT: Record<string, Route> = {
  'GET https://example.com/': () =>
    new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
};

const SESSION_ROWS = [
  'mcp-capabilities',
  'mcp-tools-list',
  'mcp-resources-list',
  'mcp-modern-tools-list',
  'mcp-server-discover',
  'mcp-unknown-tool',
  'mcp-modern-resources-miss',
  'mcp-accept-json',
  'mcp-accept-unsatisfiable',
];

describe('presence with auth required', () => {
  test("the audited site's own /mcp answering 401 with same-host metadata naming it is the endpoint, and its initialize row reads auth-required", async () => {
    const { scorecard } = await audit(router({ ...ROOT, ...protectedServer(SAME, SAME_METADATA) }, []), {
      registry: mcpRegistry(),
    });
    expect(scorecard.mcp_endpoint).toBe(SAME);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'auth-required',
      host: 'example.com',
    });
  });

  test('a bare 401 on the common path is refusal evidence: no endpoint', async () => {
    const { scorecard } = await audit(router({ ...ROOT, [`POST ${SAME}`]: () => unauthorized() }, []), {
      registry: mcpRegistry(),
    });
    expect(scorecard.mcp_endpoint).toBeNull();
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'antecedent-unmet' });
  });

  test('a challenge whose metadata does not resolve, or whose metadata names another endpoint, grants no presence', async () => {
    const unresolvable = await audit(
      router({ ...ROOT, [`POST ${SAME}`]: () => unauthorized(bearer(SAME_METADATA)) }, []),
      {
        registry: mcpRegistry(),
      },
    );
    expect(unresolvable.scorecard.mcp_endpoint).toBeNull();
    const other = await audit(
      router(
        {
          ...ROOT,
          ...protectedServer(SAME, SAME_METADATA, {
            metadata: { resource: 'https://example.com/other', authorization_servers: ['https://auth.example.net'] },
          }),
        },
        [],
      ),
      { registry: mcpRegistry() },
    );
    expect(other.scorecard.mcp_endpoint).toBeNull();
  });

  test('a host whose nonsense path also answers with metadata echoing that path grants no presence', async () => {
    const suffixed = `${SAME_METADATA}/mcp`;
    const { scorecard } = await audit(
      router(
        {
          ...ROOT,
          ...protectedServer(SAME, suffixed),
          [`GET ${ECHO_PROBE}`]: () =>
            json({ resource: 'https://example.com/anc-web-audit-no-such-resource', authorization_servers: [] }),
        },
        [],
      ),
      { registry: mcpRegistry() },
    );
    expect(scorecard.mcp_endpoint).toBeNull();
  });

  test('a card-declared endpoint on the audited origin answering 401 with matching metadata reads auth-required, not broken', async () => {
    const { scorecard } = await audit(
      router({ ...ROOT, ...siteDeclaring(SAME), ...protectedServer(SAME, SAME_METADATA) }, []),
      { registry: mcpRegistry() },
    );
    expect(scorecard.mcp_endpoint).toBe(SAME);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'auth-required' });
    expect(row(scorecard, 'mcp-tools-list')).toMatchObject({ status: 'n_a', na_reason: 'auth-required' });
  });
});

describe('rows on a protected endpoint', () => {
  test('rows that need no session run and can pass; session rows read auth-required; nothing reads broken', async () => {
    const { scorecard } = await audit(router({ ...ROOT, ...protectedServer(SAME, SAME_METADATA) }, []), {
      registry: mcpRegistry(),
    });
    for (const id of [
      'mcp-get-fast-fail',
      'mcp-cors-preflight',
      'mcp-cors-actual',
      'mcp-malformed-body',
      'mcp-modern-version-reject',
    ]) {
      expect({ id, status: row(scorecard, id).status }).toEqual({ id, status: 'pass' });
    }
    for (const id of SESSION_ROWS) {
      expect({ id, reading: [row(scorecard, id).status, row(scorecard, id).na_reason] }).toEqual({
        id,
        reading: ['n_a', 'auth-required'],
      });
    }
    expect(scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id)).toEqual([]);
  });

  test('the modern rows are probed rather than read absent, and a 401 to the malformed-body probe reads auth-required, not pass', async () => {
    const { scorecard } = await audit(
      router({ ...ROOT, ...protectedServer(SAME, SAME_METADATA, { challengeMalformed: true }) }, []),
      { registry: mcpRegistry() },
    );
    expect(row(scorecard, 'mcp-modern-version-reject')).toMatchObject({ status: 'pass' });
    expect(row(scorecard, 'mcp-modern-version-reject').unprobed).toBeUndefined();
    expect(row(scorecard, 'mcp-malformed-body')).toMatchObject({ status: 'n_a', na_reason: 'auth-required' });
  });

  test('a followed endpoint admitted by its metadata: rows name its host, and the metadata is read once', async () => {
    const root = 'https://mcp.example.net/';
    const metadataUrl = 'https://mcp.example.net/.well-known/oauth-protected-resource';
    const seen: Seen[] = [];
    const registry = {
      ...mcpRegistry(),
      checks: mcpRegistry().checks.filter((c) => c.id !== 'oauth-protected-resource'),
    };
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(root),
          ...protectedServer(root, metadataUrl, {
            metadata: { resource: 'https://mcp.example.net', authorization_servers: ['https://auth.example.net'] },
          }),
        },
        seen,
      ),
      { registry },
    );
    expect(scorecard.mcp_endpoint).toBe(root);
    expect(scorecard.declared_hosts).toMatchObject([{ outcome: 'followed', admitted_by: 'metadata' }]);
    for (const id of SESSION_ROWS) {
      expect({ id, row: row(scorecard, id) }).toMatchObject({
        id,
        row: { status: 'n_a', na_reason: 'auth-required', host: NET },
      });
    }
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'auth-required', host: NET });
    expect(seen.filter((r) => r.url === metadataUrl)).toHaveLength(1);
    expect(requestsTo(seen, NET).filter((r) => r.url.includes('anc-web-audit-no-such-resource'))).toEqual([]);
  });
});

/** Which antecedent each MCP row on the MCP endpoint declares, by what it needs from a protected server. */
const MCP_ROW_CLASSES: Record<string, AntecedentToken> = {
  'mcp-initialize': 'mcp-present',
  'mcp-unknown-method': 'mcp-present',
  'mcp-malformed-body': 'mcp-present',
  'mcp-batch-reject': 'mcp-present',
  'mcp-modern-unknown-method': 'mcp-present',
  'mcp-modern-clientcaps': 'mcp-present',
  'mcp-modern-header-mismatch': 'mcp-present',
  'mcp-modern-version-reject': 'mcp-present',
  'mcp-get-fast-fail': 'mcp-present',
  'mcp-cors-preflight': 'mcp-present',
  'mcp-cors-actual': 'mcp-present',
  'well-known-mcp-card': 'mcp-present',
  'mcp-card-legacy-aliases': 'mcp-present',
  'mcp-usage-doc': 'mcp-present',
  'mcp-server-discover': 'mcp-session',
  'mcp-capabilities': 'mcp-session',
  'mcp-tools-list': 'mcp-session',
  'mcp-modern-tools-list': 'mcp-session',
  'mcp-unknown-tool': 'mcp-session',
  'mcp-accept-json': 'mcp-session',
  'mcp-accept-unsatisfiable': 'mcp-session',
  'mcp-resources-list': 'mcp-resources',
  'mcp-modern-resources-miss': 'mcp-resources',
};

describe('the MCP rows declare what they need from a protected server', () => {
  test('every MCP row other than the in-page tools row is classified, and declares its class', () => {
    const rows = REGISTRY.checks.filter((c) => c.category === 'mcp' && c.antecedent !== 'html-root');
    expect(Object.fromEntries(rows.map((c) => [c.id, c.antecedent]))).toEqual(MCP_ROW_CLASSES);
  });
});
