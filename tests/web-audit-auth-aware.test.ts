// OAuth-protected MCP endpoints, driven through the engine against the real
// registry rows with a router keyed by full URL, so every host the audit
// touches and every row's reading is visible.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { loadRegistry, runScenario } from '../scripts/web-audit/conformance-corpus';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { enrichWebScorecardForDisplay } from '../src/worker/audit-web/display';
import { runProtectedResource } from '../src/worker/audit-web/handlers/protected-resource';
import { endpointRedirects } from '../src/worker/audit-web/handlers/shared';
import { directArtifactSource, signInEndpoint } from '../src/worker/audit-web/mcp-auth';
import { type ArtifactSource, resolveProtectedResourceMetadata } from '../src/worker/audit-web/reciprocity';
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

  test('a host that mints path-echo metadata grants no presence when its echo read fails, times out, or answers 5xx', async () => {
    const suffixed = `${SAME_METADATA}/mcp`;
    const echoReads: Array<[string, Route]> = [
      [
        'timeout',
        () => {
          throw new DOMException('deadline exceeded', 'TimeoutError');
        },
      ],
      [
        'transport error',
        () => {
          throw new TypeError('connection refused');
        },
      ],
      ['5xx', () => new Response('upstream error', { status: 503 })],
    ];
    for (const [label, echo] of echoReads) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(
        router({ ...ROOT, ...protectedServer(SAME, suffixed), [`GET ${ECHO_PROBE}`]: echo }, seen),
        { registry: mcpRegistry() },
      );
      expect({ label, echoRead: seen.some((r) => r.url === ECHO_PROBE), endpoint: scorecard.mcp_endpoint }).toEqual({
        label,
        echoRead: true,
        endpoint: null,
      });
    }
  });

  test('an echo read the budget never sends confirms nothing', async () => {
    const suffixed = `${SAME_METADATA}/mcp`;
    const seen: Seen[] = [];
    const fetchImpl = router(protectedServer(SAME, suffixed), seen);
    let slices = 1;
    const source = directArtifactSource(() => (slices-- > 0 ? 1_000 : null), { fetchImpl });
    expect(await resolveProtectedResourceMetadata(SAME, source)).toBeNull();
    expect(seen.map((r) => r.url)).toEqual([suffixed]);
  });

  test('an echo read answered below 500 without the nonsense path lets path-suffixed metadata stand', async () => {
    const suffixed = `${SAME_METADATA}/mcp`;
    const seen: Seen[] = [];
    const source = directArtifactSource(() => 1_000, { fetchImpl: router(protectedServer(SAME, suffixed), seen) });
    expect(await resolveProtectedResourceMetadata(SAME, source)).toMatchObject({ url: suffixed });
    expect(seen.map((r) => r.url)).toEqual([suffixed, ECHO_PROBE]);
  });

  test('an echo read drawing a 408 or a 429 is no answer about the path, while every other status below 500 is one', async () => {
    const suffixed = `${SAME_METADATA}/mcp`;
    const standsAt = async (status: number): Promise<boolean> => {
      const routes = { ...protectedServer(SAME, suffixed), [`GET ${ECHO_PROBE}`]: () => new Response('', { status }) };
      const source = directArtifactSource(() => 1_000, { fetchImpl: router(routes, []) });
      return (await resolveProtectedResourceMetadata(SAME, source)) !== null;
    };
    const statuses = [400, 401, 403, 404, 408, 410, 429];
    const stands = Object.fromEntries(await Promise.all(statuses.map(async (s) => [s, await standsAt(s)] as const)));
    expect(stands).toEqual({ 400: true, 401: true, 403: true, 404: true, 408: false, 410: true, 429: false });
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

  // The card already made the endpoint of record, so the metadata decides
  // only whether it requires sign-in; an echo read that got no answer says
  // nothing that could unsettle that.
  test('a card-declared endpoint below the root still requires sign-in when the echo read draws a 503, a 429, or a timeout', async () => {
    const echoReads: Array<[string, Route]> = [
      ['503', () => new Response('upstream error', { status: 503 })],
      ['429', () => new Response('slow down', { status: 429 })],
      [
        'timeout',
        () => {
          throw new DOMException('deadline exceeded', 'TimeoutError');
        },
      ],
    ];
    for (const [label, echo] of echoReads) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(
        router(
          { ...ROOT, ...siteDeclaring(SAME), ...protectedServer(SAME, SAME_METADATA), [`GET ${ECHO_PROBE}`]: echo },
          seen,
        ),
        { registry: mcpRegistry() },
      );
      expect({
        label,
        echoRead: seen.some((r) => r.url === ECHO_PROBE),
        rows: readings(scorecard, ['mcp-initialize', ...SESSION_ROWS]),
        signIn: readings(scorecard, ENFORCEMENT_ROWS),
        broken: scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id),
      }).toEqual({
        label,
        echoRead: true,
        rows: Object.fromEntries(['mcp-initialize', ...SESSION_ROWS].map((id) => [id, ['n_a', 'auth-required']])),
        signIn: {
          'mcp-auth-challenge': ['pass', null],
          'mcp-auth-servers': ['pass', null],
          'mcp-auth-enforced': ['pass', null],
        },
        broken: [],
      });
    }
  });

  test('an echo read that echoed the nonsense path refuses sign-in on a card-declared endpoint too', async () => {
    const { scorecard } = await audit(
      router(
        {
          ...ROOT,
          ...siteDeclaring(SAME),
          ...protectedServer(SAME, SAME_METADATA),
          [`GET ${ECHO_PROBE}`]: () =>
            json({ resource: 'https://example.com/anc-web-audit-no-such-resource', authorization_servers: [] }),
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
      probed: 'initialize' as const,
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

const LEGACY_SESSION_ROWS = [
  'mcp-capabilities',
  'mcp-tools-list',
  'mcp-unknown-tool',
  'mcp-accept-json',
  'mcp-accept-unsatisfiable',
];
const MODERN_SESSION_ROWS = ['mcp-server-discover', 'mcp-modern-tools-list'];
const RESOURCES_ROWS = ['mcp-resources-list', 'mcp-modern-resources-miss'];

type Readings = ReturnType<typeof readings>;

const authRequiredOn = (ids: readonly string[]): Readings =>
  Object.fromEntries(ids.map((id) => [id, ['n_a', 'auth-required']]));

/** The open counterpart of the modern-only server: the same legacy refusal, and every modern request served. */
function modernOnlyOpenServer(endpoint: string): Record<string, Route> {
  const refusing = modernOnlyProtectedServer(endpoint, SAME_METADATA);
  return {
    [`OPTIONS ${endpoint}`]: refusing[`OPTIONS ${endpoint}`],
    [`POST ${endpoint}`]: (init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('mcp-protocol-version') !== MODERN) return refusing[`POST ${endpoint}`](init);
      if (headers.get('mcp-method') === 'server/discover') {
        return json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            supportedVersions: [MODERN],
            capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'open' } },
          },
        });
      }
      return json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    },
  };
}

describe('a modern-only server behind OAuth', () => {
  test('a legacy lane refused at HTTP 200 without a 401 reads as it does on an open modern-only server, and the rows sign-in blocks read auth-required', async () => {
    const guarded = await audit(router({ ...ROOT, ...modernOnlyProtectedServer(SAME, SAME_METADATA) }, []), {
      registry: mcpRegistry(),
    });
    const open = await audit(router({ ...ROOT, ...modernOnlyOpenServer(SAME) }, []), { registry: mcpRegistry() });
    const legacyOnOpen: Readings = {
      'mcp-capabilities': ['absent', null],
      'mcp-tools-list': ['absent', null],
      'mcp-unknown-tool': ['noncompliant', null],
      'mcp-accept-json': ['pass', null],
      'mcp-accept-unsatisfiable': ['noncompliant', null],
    };
    expect(guarded.scorecard.mcp_endpoint).toBe(SAME);
    expect({
      open: readings(open.scorecard, LEGACY_SESSION_ROWS),
      guarded: readings(guarded.scorecard, LEGACY_SESSION_ROWS),
      blocked: readings(guarded.scorecard, [...MODERN_SESSION_ROWS, ...RESOURCES_ROWS]),
    }).toEqual({
      open: legacyOnOpen,
      guarded: legacyOnOpen,
      blocked: authRequiredOn([...MODERN_SESSION_ROWS, ...RESOURCES_ROWS]),
    });
    // Only the modern lane answers 401, so a pass shows where the row asked.
    expect(row(guarded.scorecard, 'mcp-auth-enforced')).toMatchObject({ status: 'pass', evidence: 'refused with 401' });
    expect(guarded.scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id)).toEqual([]);
  });

  test('the challenge on server/discover alone opens the auth discovery rows, so they are evaluated rather than antecedent-unmet', async () => {
    const scenario = SCENARIOS['auth-modern-only'];
    if (scenario === undefined) throw new Error('the auth-modern-only corpus scenario is missing');
    const run = await runScenario('auth-modern-only', scenario, loadRegistry());
    const scorecard = JSON.parse(run.output) as WebScorecard;
    expect(readings(scorecard, ['oauth-protected-resource', 'oauth-discovery', 'auth-md'])).toEqual({
      'oauth-protected-resource': ['pass', null],
      'oauth-discovery': ['n_a', 'optional-absent'],
      'auth-md': ['n_a', 'optional-absent'],
    });
  });
});

/**
 * A legacy-only server behind OAuth: every legacy request draws a 401
 * naming its metadata, while a header-routed modern request is refused with
 * a method-not-found before any token is read.
 */
function legacyOnlyProtectedServer(endpoint: string, metadataUrl: string): Record<string, Route> {
  const server = protectedServer(endpoint, metadataUrl);
  return {
    ...server,
    [`POST ${endpoint}`]: (init) => {
      if (new Headers(init?.headers).get('mcp-protocol-version') === MODERN) {
        return json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } });
      }
      return server[`POST ${endpoint}`](init);
    },
  };
}

describe('a legacy-only server behind OAuth', () => {
  test('a modern lane refused without a 401 reads absent as it does on an open legacy-only server, and the rows sign-in blocks read auth-required', async () => {
    const guarded = await audit(router({ ...ROOT, ...legacyOnlyProtectedServer(SAME, SAME_METADATA) }, []), {
      registry: mcpRegistry(),
    });
    const open = await audit(
      router(
        {
          ...ROOT,
          [`POST ${SAME}`]: (init) =>
            new Headers(init?.headers).get('mcp-protocol-version') === MODERN
              ? json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } })
              : initializeResult(),
        },
        [],
      ),
      { registry: mcpRegistry() },
    );
    const modernAbsent: Readings = {
      'mcp-server-discover': ['absent', null],
      'mcp-modern-tools-list': ['absent', null],
    };
    expect({
      open: readings(open.scorecard, MODERN_SESSION_ROWS),
      guarded: readings(guarded.scorecard, MODERN_SESSION_ROWS),
      blocked: readings(guarded.scorecard, [...LEGACY_SESSION_ROWS, ...RESOURCES_ROWS]),
    }).toEqual({
      open: modernAbsent,
      guarded: modernAbsent,
      blocked: authRequiredOn([...LEGACY_SESSION_ROWS, ...RESOURCES_ROWS]),
    });
    expect(readings(guarded.scorecard, ENFORCEMENT_ROWS)).toEqual({
      'mcp-auth-challenge': ['pass', null],
      'mcp-auth-servers': ['pass', null],
      'mcp-auth-enforced': ['pass', null],
    });
    expect(guarded.scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id)).toEqual([]);
  });
});

/** The rows outside the session class that a correctly protected server answers with a 401. */
const PRESENT_ROWS_DRAWING_401 = [
  'mcp-unknown-method',
  'mcp-batch-reject',
  'mcp-modern-unknown-method',
  'mcp-modern-clientcaps',
  'mcp-modern-header-mismatch',
];

/**
 * A protected server whose handshakes fail transiently once discovery has
 * found it: the discovery POSTs draw the 401, and wave 1's initialize and
 * server/discover get `transient` instead.
 */
function flakyHandshakes(transient: Route): Record<string, Route> {
  const server = protectedServer(SAME, SAME_METADATA);
  let initializes = 0;
  return {
    ...server,
    [`POST ${SAME}`]: (init) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      if (headers.get('mcp-method') === 'server/discover') return transient(init);
      if (body.includes('"initialize"') && ++initializes > 1) return transient(init);
      return server[`POST ${SAME}`](init);
    },
  };
}

describe('a handshake that fails transiently on an endpoint discovery found through its 401', () => {
  test('the 401 discovery drew still settles sign-in, so the rows that draw 401 read auth-required and none reads broken', async () => {
    const failures: Array<[string, Route]> = [
      [
        'timeout',
        () => {
          throw new DOMException('deadline exceeded', 'TimeoutError');
        },
      ],
      [
        'transport error',
        () => {
          throw new TypeError('connection reset');
        },
      ],
    ];
    for (const [label, transient] of failures) {
      const { scorecard } = await audit(router({ ...ROOT, ...flakyHandshakes(transient) }, []), {
        registry: mcpRegistry(),
      });
      expect({ label, endpoint: scorecard.mcp_endpoint }).toEqual({ label, endpoint: SAME });
      expect({ label, handshakes: readings(scorecard, ['mcp-initialize', 'mcp-server-discover']) }).toEqual({
        label,
        handshakes: { 'mcp-initialize': ['error', null], 'mcp-server-discover': ['n_a', 'auth-required'] },
      });
      expect({ label, readings: readings(scorecard, [...SESSION_ROWS, ...PRESENT_ROWS_DRAWING_401]) }).toEqual({
        label,
        readings: Object.fromEntries(
          [...SESSION_ROWS, ...PRESENT_ROWS_DRAWING_401].map((id) => [id, ['n_a', 'auth-required']]),
        ),
      });
      expect({ label, enforcement: readings(scorecard, ENFORCEMENT_ROWS) }).toEqual({
        label,
        enforcement: {
          'mcp-auth-challenge': ['pass', null],
          'mcp-auth-servers': ['pass', null],
          'mcp-auth-enforced': ['pass', null],
        },
      });
      expect({ label, broken: scorecard.results.filter((r) => r.status === 'broken').map((r) => r.id) }).toEqual({
        label,
        broken: [],
      });
    }
  });

  // The handshake rows read their own 429 or 5xx, and a server/discover
  // answered that way leaves no modern lane, so only the legacy rows that
  // draw a 401 are probed here.
  test('a rate limit or a server error on the handshakes leaves the session rows and the legacy rows that draw 401 reading auth-required', async () => {
    const ids = [...SESSION_ROWS, 'mcp-unknown-method', 'mcp-batch-reject'];
    for (const status of [429, 503]) {
      const { scorecard } = await audit(
        router({ ...ROOT, ...flakyHandshakes(() => new Response('try later', { status })) }, []),
        { registry: mcpRegistry() },
      );
      expect({ status, readings: readings(scorecard, ids) }).toEqual({
        status,
        readings: Object.fromEntries(ids.map((id) => [id, ['n_a', 'auth-required']])),
      });
      expect({ status, enforced: readings(scorecard, ['mcp-auth-enforced']) }).toEqual({
        status,
        enforced: { 'mcp-auth-enforced': ['pass', null] },
      });
    }
  });

  test('an endpoint that never answered 401 gets no sign-in from a failed handshake', async () => {
    const { scorecard } = await audit(
      router(
        {
          ...ROOT,
          ...siteDeclaring(SAME),
          [`POST ${SAME}`]: () => {
            throw new TypeError('connection reset');
          },
          [`GET ${SAME_METADATA}`]: () => json({ resource: SAME, authorization_servers: ['https://auth.example.net'] }),
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

  // An agent signs in through any usable server the list names, so bad
  // entries beside one cost a spec detail; a list with none usable leaves it
  // nowhere to sign in.
  test('one usable authorization server beside unusable ones reads noncompliant and names every unusable entry; none usable reads broken', async () => {
    const cases: Array<{ servers: string[]; status: ScorecardStatus; evidence: string }> = [
      {
        servers: ['http://auth.example.net/', 'https://auth.example.net', 'https://10.0.0.1/oauth'],
        status: 'noncompliant',
        evidence:
          'authorization server http://auth.example.net/ is not https; authorization server https://10.0.0.1/oauth names a private or reserved host',
      },
      {
        servers: ['http://auth.example.net/', 'https://10.0.0.1/oauth'],
        status: 'broken',
        evidence:
          'authorization server http://auth.example.net/ is not https; authorization server https://10.0.0.1/oauth names a private or reserved host',
      },
    ];
    for (const { servers, status, evidence } of cases) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(
        router(
          {
            ...ROOT,
            ...protectedServer(SAME, SAME_METADATA, { metadata: { resource: SAME, authorization_servers: servers } }),
          },
          seen,
        ),
        { registry: mcpRegistry() },
      );
      const { status: read, evidence: line } = row(scorecard, 'mcp-auth-servers');
      expect({ servers, status: read, evidence: line }).toEqual({ servers, status, evidence });
      expect(requestsTo(seen, 'auth.example.net')).toEqual([]);
      expect(requestsTo(seen, '10.0.0.1')).toEqual([]);
    }
  });

  // The public engine never audits a private endpoint, so this branch is
  // reached only by a run on the endpoint's own network, which can reach a
  // private authorization server too.
  test('a private authorization server is usable for a private endpoint and unusable for a public one', async () => {
    const check = REGISTRY.checks.find((c) => c.id === 'mcp-auth-servers');
    if (!check) throw new Error('missing mcp-auth-servers');
    const readFor = async (endpoint: string, servers: string[]) => {
      const outcome = await runProtectedResource(check, {
        base: 'https://example.com/',
        host: 'example.com',
        mcpEndpoint: endpoint,
        protocolVersion: '2025-06-18',
        defaultTimeoutMs: 50,
        fetchOptions: {
          fetchImpl: (async () => {
            throw new Error('an authorization server is never requested');
          }) as unknown as typeof fetch,
        },
        mcpAuth: {
          endpoint,
          challenge: null,
          lane: 'legacy',
          metadataUrl: `${new URL(endpoint).origin}/.well-known/oauth-protected-resource`,
          metadata: { resource: endpoint, authorization_servers: servers },
        },
      });
      return [outcome.status, outcome.evidence[0]?.why] as const;
    };
    expect({
      privateServerPrivateEndpoint: await readFor('http://10.0.0.5/mcp', ['https://10.0.0.6/oauth']),
      privateHttpServerPrivateEndpoint: await readFor('http://10.0.0.5/mcp', ['http://10.0.0.6/oauth']),
      localhostServerLocalEndpoint: await readFor('http://localhost:8787/mcp', [
        'https://localhost:9000/oauth',
        'https://auth.example.net',
      ]),
      privateServerPublicEndpoint: await readFor(SAME, ['https://10.0.0.6/oauth']),
    }).toEqual({
      privateServerPrivateEndpoint: ['pass', ['authorization_servers: https://10.0.0.6/oauth']],
      privateHttpServerPrivateEndpoint: ['broken', ['authorization server http://10.0.0.6/oauth is not https']],
      localhostServerLocalEndpoint: [
        'pass',
        ['authorization_servers: https://localhost:9000/oauth, https://auth.example.net'],
      ],
      privateServerPublicEndpoint: [
        'broken',
        ['authorization server https://10.0.0.6/oauth names a private or reserved host'],
      ],
    });
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
