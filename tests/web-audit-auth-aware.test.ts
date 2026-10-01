// OAuth-protected MCP endpoints, driven through the engine against the real
// registry rows with a router keyed by full URL, so every host the audit
// touches and every row's reading is visible.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { endpointRedirects } from '../src/worker/audit-web/handlers/shared';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
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
