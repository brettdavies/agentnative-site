// Where the audit reads the RFC 9728 metadata that settles whether an MCP
// endpoint requires sign-in: the location a 401's challenge names is
// requested only when it is https, public, and on the endpoint's own host,
// it takes precedence over metadata read earlier, and either wave-1
// handshake's 401 can settle it.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import type { ProbeOutcome } from '../src/worker/audit-web/handlers/types';
import { settleMcpAuth } from '../src/worker/audit-web/mcp-auth';
import type { ArtifactSource } from '../src/worker/audit-web/reciprocity';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';
import { audit, json, type Route, router, row, type Seen, siteDeclaring } from './helpers/follow-fixtures';

const REGISTRY = normalizeWebAuditRegistry(
  yaml.load(readFileSync(join(import.meta.dir, '..', 'src', 'data', 'web-audit', 'registry.yaml'), 'utf8')) as object,
) as WebAuditRegistry;
const MCP_REGISTRY: WebAuditRegistry = { ...REGISTRY, checks: REGISTRY.checks.filter((c) => c.category === 'mcp') };

const SAME = 'https://example.com/mcp';
const SAME_METADATA = 'https://example.com/.well-known/oauth-protected-resource';
const ROOT: Record<string, Route> = {
  'GET https://example.com/': () =>
    new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
};
const ENFORCEMENT_ROWS = ['mcp-auth-challenge', 'mcp-auth-servers', 'mcp-auth-enforced'];

const bearer = (metadataUrl: string): string => `Bearer resource_metadata="${metadataUrl}"`;
const metadataNaming =
  (resource: string, server = 'https://auth.example.net'): Route =>
  () =>
    json({ resource, authorization_servers: [server] });

function readings(scorecard: WebScorecard, ids: readonly string[]) {
  return Object.fromEntries(ids.map((id) => [id, [row(scorecard, id).status, row(scorecard, id).na_reason ?? null]]));
}

const NOT_SETTLED: ReturnType<typeof readings> = {
  'mcp-auth-challenge': ['n_a', 'antecedent-unmet'],
  'mcp-auth-servers': ['n_a', 'antecedent-unmet'],
  'mcp-auth-enforced': ['n_a', 'antecedent-unmet'],
};

/**
 * Locations a challenge can name that the auditor must never request. Each
 * would serve metadata naming the endpoint if asked, and the endpoint's
 * own well-known metadata names it too, so only the refusal to follow the
 * challenge keeps sign-in unsettled.
 */
const FORBIDDEN = [
  'https://evil.example.org/.well-known/oauth-protected-resource',
  'http://example.com/.well-known/oauth-protected-resource',
  'https://169.254.169.254/latest/meta-data/oauth-protected-resource',
];

function challengingWith(named: string): Record<string, Route> {
  return {
    ...ROOT,
    [`POST ${SAME}`]: () => json({ error: 'unauthorized' }, 401, { 'www-authenticate': bearer(named) }),
    [`GET ${SAME_METADATA}`]: metadataNaming(SAME),
    [`GET ${named}`]: metadataNaming(SAME),
  };
}

describe('a challenge naming metadata the auditor will not read', () => {
  test("on a common path's 401, the named location gets no request and no endpoint is found", async () => {
    for (const named of FORBIDDEN) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(router(challengingWith(named), seen), { registry: MCP_REGISTRY });
      expect({ named, requested: seen.some((r) => r.url === named), endpoint: scorecard.mcp_endpoint }).toEqual({
        named,
        requested: false,
        endpoint: null,
      });
    }
  });

  test("on a card-declared endpoint's wave-1 401, the named location gets no request and sign-in stays unsettled", async () => {
    for (const named of FORBIDDEN) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(router({ ...challengingWith(named), ...siteDeclaring(SAME) }, seen), {
        registry: MCP_REGISTRY,
      });
      expect(scorecard.mcp_endpoint).toBe(SAME);
      expect({
        named,
        requested: seen.some((r) => r.url === named),
        rows: readings(scorecard, ENFORCEMENT_ROWS),
      }).toEqual({ named, requested: false, rows: NOT_SETTLED });
    }
  });
});

const ENDPOINT = 'https://mcp.example.net/mcp';
const NET_ROOT_METADATA = 'https://mcp.example.net/.well-known/oauth-protected-resource';
const NET_SUFFIXED_METADATA = `${NET_ROOT_METADATA}/mcp`;

/** A followed endpoint admitted by its path-suffixed metadata, whose POST 401 names the root metadata instead. */
function admittedBySuffixedMetadata(rootMetadata: Route): Record<string, Route> {
  return {
    ...siteDeclaring(ENDPOINT),
    [`GET ${NET_SUFFIXED_METADATA}`]: metadataNaming(ENDPOINT, 'https://suffixed-auth.example.net'),
    [`GET ${NET_ROOT_METADATA}`]: rootMetadata,
    [`POST ${ENDPOINT}`]: () => json({ error: 'unauthorized' }, 401, { 'www-authenticate': bearer(NET_ROOT_METADATA) }),
  };
}

describe('metadata read while admitting an endpoint gives way to the location its 401 names', () => {
  test('the named root metadata settles sign-in, and its authorization servers are the ones scored', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(admittedBySuffixedMetadata(metadataNaming(ENDPOINT, 'https://root-auth.example.net')), seen),
      { registry: MCP_REGISTRY },
    );
    expect(scorecard.declared_hosts).toMatchObject([{ outcome: 'followed', admitted_by: 'metadata' }]);
    expect(row(scorecard, 'mcp-auth-servers')).toMatchObject({
      status: 'pass',
      evidence: 'authorization_servers: https://root-auth.example.net',
    });
    expect(seen.filter((r) => r.url === NET_ROOT_METADATA)).toHaveLength(1);
  });

  test('when the named metadata names another resource, the admitting metadata does not settle sign-in', async () => {
    const { scorecard } = await audit(
      router(admittedBySuffixedMetadata(metadataNaming('https://mcp.example.net/other')), []),
      { registry: MCP_REGISTRY },
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(readings(scorecard, ENFORCEMENT_ROWS)).toEqual(NOT_SETTLED);
  });
});

describe('settling sign-in from the server/discover handshake alone', () => {
  const CHALLENGE = bearer(SAME_METADATA);
  const metadata = { resource: SAME, authorization_servers: ['https://auth.example.net'] };
  const served: ProbeResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
    error: null,
  };
  const missing: ProbeResponse = { status: 404, headers: {}, body: '', error: null };
  const source: ArtifactSource = {
    get: async (url) => (url === SAME_METADATA ? served : missing),
    decline: () => {},
  };
  const discoverChallenged: ProbeOutcome = {
    status: 'broken',
    evidence: [{ url: SAME, status: 401, www_authenticate: CHALLENGE }],
  };
  const initializeAnswers: Array<[string, ProbeOutcome]> = [
    [
      'a transport error',
      { status: 'error', evidence: [{ url: SAME, status: null, error: 'TypeError: connection reset' }] },
    ],
    ['an error envelope at HTTP 200', { status: 'absent', evidence: [{ url: SAME, status: 200, error_code: -32022 }] }],
  ];

  test('a 401 on server/discover requires sign-in when initialize errored or was answered without a result', async () => {
    for (const [label, initialize] of initializeAnswers) {
      const settled = await settleMcpAuth({
        endpoint: SAME,
        known: null,
        observed: null,
        sources: new Map([
          ['mcp-initialize', initialize],
          ['mcp-server-discover', discoverChallenged],
        ]),
        source,
      });
      expect({ label, settled }).toEqual({
        label,
        settled: { endpoint: SAME, challenge: CHALLENGE, lane: 'modern', metadataUrl: SAME_METADATA, metadata },
      });
    }
  });
});
