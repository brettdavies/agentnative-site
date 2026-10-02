// OAuth-protected MCP endpoints, driven through the engine against the real
// registry rows with a router keyed by full URL, so every host the audit
// touches and every row's reading is visible.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { enrichWebScorecardForDisplay } from '../src/worker/audit-web/display';
import { endpointRedirects } from '../src/worker/audit-web/handlers/shared';
import { signInEndpoint } from '../src/worker/audit-web/mcp-auth';
import type { ArtifactSource } from '../src/worker/audit-web/reciprocity';
import type { AntecedentToken, WebAuditRegistry } from '../src/worker/audit-web/registry';
import type { WebRemediationCatalog } from '../src/worker/audit-web/remediation';
import type { ScorecardStatus, WebScorecard } from '../src/worker/audit-web/scorecard';
import { buildWebSummaryMarkdown } from '../src/worker/audit-web/summary-markdown';
import { buildWebSummaryBody } from '../src/worker/audit-web/summary-render';
import {
  audit,
  cardDocument,
  initializeResult,
  json,
  type Route,
  requestsTo,
  router,
  row,
  type Seen,
  sep2127Card,
  siteDeclaring,
  TARGET,
} from './helpers/follow-fixtures';

const DATA = join(import.meta.dir, '..', 'src', 'data', 'web-audit');
const REGISTRY = normalizeWebAuditRegistry(
  yaml.load(readFileSync(join(DATA, 'registry.yaml'), 'utf8')) as object,
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
  /** The WWW-Authenticate every 401 carries, in place of one naming the metadata. */
  challenge?: string;
  /** A legacy tools/list is served without a token while every other method is refused. */
  servesToolsWithoutToken?: boolean;
};

/**
 * An MCP server behind OAuth: every POST draws a 401 whose challenge names
 * its RFC 9728 metadata, apart from an unparseable body and an unsupported
 * version claim, which it refuses before reading a token.
 */
function protectedServer(endpoint: string, metadataUrl: string, opts: ServerOptions = {}): Record<string, Route> {
  const challenge = opts.challenge ?? bearer(metadataUrl);
  return {
    [`POST ${endpoint}`]: (init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      if (
        opts.servesToolsWithoutToken === true &&
        body.includes('"tools/list"') &&
        !headers.has('mcp-protocol-version')
      ) {
        return json({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] },
        });
      }
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

describe('finding a sign-in endpoint among challenged common paths', () => {
  test('paths on one host share one read of the root metadata', async () => {
    const reads: string[] = [];
    const source: ArtifactSource = {
      get: async (url) => {
        reads.push(url);
        return { status: 404, headers: {}, body: '', error: null };
      },
      decline: () => {},
    };
    const challenged = ['/mcp', '/sse'].map((path) => ({
      path,
      url: `https://example.com${path}`,
      probed: 'mcp-common-path',
      challenge: null,
    }));
    expect(await signInEndpoint(challenged, source)).toBeNull();
    expect(reads).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/mcp',
      'https://example.com/.well-known/oauth-protected-resource',
      'https://example.com/.well-known/oauth-protected-resource/sse',
    ]);
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

const MODERN = '2026-07-28';

/**
 * A modern-only server behind OAuth: every header-routed modern request
 * draws a 401 naming its metadata, while every legacy request is refused at
 * HTTP 200 with a JSON-RPC error before any token is read.
 */
function modernOnlyProtectedServer(endpoint: string, metadataUrl: string): Record<string, Route> {
  return {
    ...protectedServer(endpoint, metadataUrl),
    [`POST ${endpoint}`]: (init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      const version = headers.get('mcp-protocol-version');
      if (body.startsWith('not-json')) {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
      }
      if (version === UNSUPPORTED_VERSION) {
        return json(
          { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'unsupported', data: { supported: [MODERN] } } },
          400,
        );
      }
      if (version === MODERN) return unauthorized(bearer(metadataUrl));
      return json(
        { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'unsupported', data: { supported: [MODERN] } } },
        200,
        headers.get('origin') !== null ? ACAO : {},
      );
    },
  };
}

describe('a modern-only server behind OAuth', () => {
  test('a legacy lane refused at HTTP 200 serves nothing without sign-in, so the session rows read auth-required and the refusal row asks on the modern lane', async () => {
    const { scorecard } = await audit(router({ ...ROOT, ...modernOnlyProtectedServer(SAME, SAME_METADATA) }, []), {
      registry: mcpRegistry(),
    });
    expect(scorecard.mcp_endpoint).toBe(SAME);
    for (const id of SESSION_ROWS) {
      expect({ id, reading: [row(scorecard, id).status, row(scorecard, id).na_reason] }).toEqual({
        id,
        reading: ['n_a', 'auth-required'],
      });
    }
    // Only the modern lane answers 401, so a pass shows where the row asked.
    expect(row(scorecard, 'mcp-auth-enforced')).toMatchObject({ status: 'pass', evidence: 'refused with 401' });
    expect(scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id)).toEqual([]);
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
  'mcp-auth-challenge': 'mcp-auth-required',
  'mcp-auth-servers': 'mcp-auth-required',
  'mcp-auth-enforced': 'mcp-auth-required',
};

describe('the MCP rows declare what they need from a protected server', () => {
  test('every MCP row other than the in-page tools row is classified, and declares its class', () => {
    const rows = REGISTRY.checks.filter((c) => c.category === 'mcp' && c.antecedent !== 'html-root');
    expect(Object.fromEntries(rows.map((c) => [c.id, c.antecedent]))).toEqual(MCP_ROW_CLASSES);
  });
});

const ENFORCEMENT_ROWS = ['mcp-auth-challenge', 'mcp-auth-servers', 'mcp-auth-enforced'];

const readings = (scorecard: WebScorecard, ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, [row(scorecard, id).status, row(scorecard, id).na_reason ?? null]]));

describe('auth enforcement rows', () => {
  test('a correctly protected endpoint passes all three, scored at the endpoint host', async () => {
    const { scorecard } = await audit(
      router(
        {
          ...ROOT,
          ...siteDeclaring(ENDPOINT),
          ...protectedServer(ENDPOINT, `https://${NET}/.well-known/oauth-protected-resource`),
        },
        [],
      ),
      { registry: mcpRegistry() },
    );
    expect(readings(scorecard, ENFORCEMENT_ROWS)).toEqual({
      'mcp-auth-challenge': ['pass', null],
      'mcp-auth-servers': ['pass', null],
      'mcp-auth-enforced': ['pass', null],
    });
    for (const id of ENFORCEMENT_ROWS) expect({ id, host: row(scorecard, id).host }).toEqual({ id, host: NET });
  });

  test('they apply on the audited origin too, to an endpoint found on a common path or declared by a card', async () => {
    for (const [label, routes] of [
      ['common path', { ...ROOT, ...protectedServer(SAME, SAME_METADATA) }],
      ['card', { ...ROOT, ...siteDeclaring(SAME), ...protectedServer(SAME, SAME_METADATA) }],
    ] as const) {
      const { scorecard } = await audit(router(routes, []), { registry: mcpRegistry() });
      expect({ label, readings: readings(scorecard, ENFORCEMENT_ROWS) }).toEqual({
        label,
        readings: {
          'mcp-auth-challenge': ['pass', null],
          'mcp-auth-servers': ['pass', null],
          'mcp-auth-enforced': ['pass', null],
        },
      });
    }
  });

  test('an open endpoint, including one whose card documents that no sign-in is required, reads all three n_a', async () => {
    for (const card of [
      { name: 'open', mcp_endpoint: SAME },
      { name: 'open', mcp_endpoint: SAME, authentication: { required: false } },
    ]) {
      const { scorecard } = await audit(
        router(
          {
            ...ROOT,
            'GET https://example.com/.well-known/mcp.json': () => json(card),
            [`POST ${SAME}`]: () => initializeResult(),
          },
          [],
        ),
        { registry: mcpRegistry() },
      );
      expect(readings(scorecard, ENFORCEMENT_ROWS)).toEqual({
        'mcp-auth-challenge': ['n_a', 'antecedent-unmet'],
        'mcp-auth-servers': ['n_a', 'antecedent-unmet'],
        'mcp-auth-enforced': ['n_a', 'antecedent-unmet'],
      });
    }
  });

  test('a 401 whose challenge names no resource_metadata misses the challenge row and nothing else', async () => {
    const { scorecard } = await audit(
      router({ ...ROOT, ...protectedServer(SAME, SAME_METADATA, { challenge: 'Bearer realm="mcp"' }) }, []),
      { registry: mcpRegistry() },
    );
    expect(readings(scorecard, ENFORCEMENT_ROWS)).toEqual({
      'mcp-auth-challenge': ['noncompliant', null],
      'mcp-auth-servers': ['pass', null],
      'mcp-auth-enforced': ['pass', null],
    });
  });

  test('authorization_servers with a non-https or private value fails the metadata row, and no value is ever requested', async () => {
    for (const server of ['http://auth.example.net/', 'https://10.0.0.1/oauth']) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(
        router(
          {
            ...ROOT,
            ...protectedServer(SAME, SAME_METADATA, { metadata: { resource: SAME, authorization_servers: [server] } }),
          },
          seen,
        ),
        { registry: mcpRegistry() },
      );
      expect({ server, status: row(scorecard, 'mcp-auth-servers').status }).toEqual({ server, status: 'broken' });
      expect(requestsTo(seen, 'auth.example.net')).toEqual([]);
      expect(requestsTo(seen, '10.0.0.1')).toEqual([]);
    }
  });

  test('a protected endpoint whose unauthenticated tools/list returns tools fails the rejection row', async () => {
    const { scorecard } = await audit(
      router({ ...ROOT, ...protectedServer(SAME, SAME_METADATA, { servesToolsWithoutToken: true }) }, []),
      { registry: mcpRegistry() },
    );
    expect(row(scorecard, 'mcp-auth-enforced')).toMatchObject({
      status: 'noncompliant',
      evidence: 'a request without a token was served a result',
    });
  });
});

describe('values the audited server chose reach every reader inert', () => {
  test('authorization_servers carrying markup render escaped on the HTML page, in the markdown twin, and in the MCP read', async () => {
    const remediation = normalizeWebRemediation(
      yaml.load(readFileSync(join(DATA, 'remediation.yaml'), 'utf8')) as object,
      REGISTRY.checks.map((c) => c.id),
    ) as WebRemediationCatalog;
    const cases: Array<{ value: string; status: ScorecardStatus; shown: string }> = [
      {
        value: 'https://auth.example.net/<script>alert(1)</script>',
        status: 'pass',
        shown: 'auth.example.net/%3Cscript%3E',
      },
      { value: '<img src=x onerror=alert(1)>', status: 'broken', shown: '%3Cimg%20src=x%20onerror=alert%281%29%3E' },
    ];
    for (const { value, status, shown } of cases) {
      const { scorecard } = await audit(
        router(
          {
            ...ROOT,
            ...protectedServer(SAME, SAME_METADATA, { metadata: { resource: SAME, authorization_servers: [value] } }),
          },
          [],
        ),
        { registry: mcpRegistry() },
      );
      expect({ value, status: row(scorecard, 'mcp-auth-servers').status }).toEqual({ value, status });
      const input = { scorecard, domain: 'example.com', targetUrl: TARGET, remediation, origin: 'https://anc.dev' };
      const read = JSON.stringify(
        enrichWebScorecardForDisplay(scorecard, {
          registry: REGISTRY,
          catalog: remediation,
          origin: 'https://anc.dev',
        }),
        null,
        2,
      );
      const surfaces = { html: buildWebSummaryBody(input), markdown: buildWebSummaryMarkdown(input), mcp: read };
      const markup = Object.fromEntries(
        Object.entries(surfaces).map(([surface, text]) => [surface, /<script>alert|<img src=x/i.test(text)]),
      );
      expect({ value, markup }).toEqual({ value, markup: { html: false, markdown: false, mcp: false } });
      const named = Object.fromEntries(
        Object.entries(surfaces).map(([surface, text]) => [surface, text.includes(shown)]),
      );
      expect({ value, named }).toEqual({ value, named: { html: true, markdown: true, mcp: true } });
    }
  });
});

describe('the enforcement rows are registered completely', () => {
  test('each has a remediation entry, and the build fails without one', () => {
    const doc = yaml.load(readFileSync(join(DATA, 'remediation.yaml'), 'utf8')) as {
      remediation: Record<string, unknown>;
    };
    const ids = REGISTRY.checks.map((c) => c.id);
    for (const id of ENFORCEMENT_ROWS) {
      expect(ids).toContain(id);
      const { [id]: _dropped, ...rest } = doc.remediation;
      expect(() => normalizeWebRemediation({ remediation: rest }, ids)).toThrow(
        `check "${id}" has no remediation entry`,
      );
    }
  });

  test('a protected-resource row must name an op its handler reads', () => {
    const doc = yaml.load(readFileSync(join(DATA, 'registry.yaml'), 'utf8')) as {
      checks: Array<Record<string, unknown>>;
    };
    const challenge = doc.checks.find((c) => c.id === 'mcp-auth-challenge');
    expect(challenge?.with).toEqual({ op: 'challenge' });
    const broken = {
      ...doc,
      checks: doc.checks.map((c) => (c === challenge ? { ...c, with: { op: 'nonsense' } } : c)),
    };
    expect(() => normalizeWebAuditRegistry(broken)).toThrow(/mcp-auth-challenge.*with\.op/);
  });
});
