// Stored website scorecards shaped like audits that followed the hosts a site
// declares: a stripe.dev-shaped result (an OAuth-protected MCP server on
// mcp.stripe.com, an API host anchored in the api-catalog, a catalog anchor
// that was not followed) and a two-anchor result whose API rows each carry
// one outcome per host. Rows sit in the shape the engine stores, with the
// live registry's ids, titles, categories, and lanes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../../src/build/13-web-audit-registry.mjs';
import type { WebAuditRegistry } from '../../src/worker/audit-web/registry';
import type { WebRemediationCatalog } from '../../src/worker/audit-web/remediation';

const DATA = join(new URL('../..', import.meta.url).pathname, 'src', 'data', 'web-audit');

export const REGISTRY = normalizeWebAuditRegistry(
  yaml.load(readFileSync(join(DATA, 'registry.yaml'), 'utf8')) as object,
) as unknown as WebAuditRegistry;

export const REMEDIATION = normalizeWebRemediation(
  yaml.load(readFileSync(join(DATA, 'remediation.yaml'), 'utf8')) as object,
  REGISTRY.checks.map((check) => check.id),
  Object.keys(REGISTRY.retired ?? {}),
) as unknown as WebRemediationCatalog;

type Row = Record<string, unknown> & { id: string; status: string };

/** A stored website scorecard, with the fields a test reads named and the rest left open. */
export type StoredScorecard = Record<string, unknown> & {
  target_url: string;
  results: Row[];
  follow_declarations?: unknown;
  declared_hosts?: unknown;
};

function check(id: string) {
  const found = REGISTRY.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no registry check ${id}`);
  return found;
}

/** One stored row: the registry's facts for `id`, then the run's own. */
export function row(id: string, status: string, fields: Record<string, unknown> = {}): Row {
  const c = check(id);
  return {
    id,
    label: c.title,
    category: c.category,
    group: c.principle,
    layer: 'web',
    keyword: c.keyword,
    tier: c.tier,
    principle: c.principle,
    status,
    evidence: null,
    ...fields,
  };
}

/** Where a row's evidence came from, as the engine stores one host. */
export function at(host: string): { hosts: Array<{ host: string }>; host: string } {
  return { hosts: [{ host }], host };
}

const MCP = 'mcp.stripe.com';
const SIGN_IN = { na_reason: 'auth-required', evidence: `https://${MCP}/`, ...at(MCP) };

function laneIds(lane: string): string[] {
  return REGISTRY.checks.filter((c) => c.category === 'mcp' && c.lane === lane).map((c) => c.id);
}

/** stripe.dev's MCP rows: every legacy and modern check needs a session, and one shared check is not run either. */
function stripeMcpRows(): Row[] {
  return [
    ...laneIds('legacy').map((id) => row(id, 'n_a', SIGN_IN)),
    ...laneIds('modern').map((id) => row(id, 'n_a', SIGN_IN)),
    row('mcp-server-card', 'pass', {
      advisory: 'superseded',
      evidence: 'https://stripe.dev/.well-known/mcp/server-card.json -> 200',
      ...at('stripe.dev'),
    }),
    row('mcp-card-legacy-aliases', 'n_a', { na_reason: 'optional-absent', ...at('stripe.dev') }),
    row('mcp-usage-doc', 'n_a', { na_reason: 'optional-absent', ...at(MCP) }),
    row('mcp-get-fast-fail', 'pass', { evidence: `https://${MCP}/ -> 405`, ...at(MCP) }),
    row('mcp-cors-preflight', 'pass', { evidence: 'preflight 204', ...at(MCP) }),
    row('mcp-cors-actual', 'n_a', SIGN_IN),
    row('mcp-auth-challenge', 'pass', { evidence: 'resource_metadata', ...at(MCP) }),
    row('mcp-auth-servers', 'pass', { evidence: 'authorization_servers', ...at(MCP) }),
    row('mcp-auth-enforced', 'pass', { evidence: 'refused with 401', ...at(MCP) }),
    row('webmcp', 'n_a', { na_reason: 'optional-absent', ...at('stripe.dev') }),
  ];
}

function stripeApiRows(): Row[] {
  return [
    row('openapi', 'pass', { evidence: 'https://api.stripe.com/openapi/spec3.json -> 200', ...at('api.stripe.com') }),
    row('json-schemas', 'n_a', { na_reason: 'antecedent-unmet', hosts: [] }),
    row('api-catalog', 'pass', { evidence: 'https://stripe.dev/.well-known/api-catalog -> 200', ...at('stripe.dev') }),
    row('json-errors', 'pass', { evidence: '404 with a JSON body', ...at('api.stripe.com') }),
    row('rate-limit-headers', 'absent', { evidence: 'no rate-limit header', ...at('api.stripe.com') }),
  ];
}

export const STRIPE_TRAIL = [
  {
    surface: '/.well-known/mcp/server-card.json',
    kind: 'mcp-endpoint',
    url: 'https://mcp.stripe.com/',
    host: MCP,
    outcome: 'followed',
    admitted_by: 'metadata',
  },
  {
    surface: '/.well-known/api-catalog#/linkset/0',
    kind: 'api-anchor',
    url: 'https://api.stripe.com/',
    host: 'api.stripe.com',
    outcome: 'followed',
  },
  {
    surface: '/.well-known/api-catalog#/linkset/1',
    kind: 'api-anchor',
    url: 'https://docs.stripe.com/api',
    host: 'docs.stripe.com',
    outcome: 'not-followed',
    reason: 'no-service-desc',
  },
  {
    surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
    kind: 'api-description',
    url: 'https://api.stripe.com/openapi/spec3.json',
    host: 'api.stripe.com',
    outcome: 'followed',
  },
];

const STRIPE_DISCOVERY = [
  {
    source: '/.well-known/mcp/server-card.json',
    document: 'server-card',
    status: 200,
    shape: 'sep-1649',
    endpoint: 'https://mcp.stripe.com/',
    blocked: 'off-origin endpoint declaration',
  },
  { source: '/.well-known/api-catalog', document: 'api-catalog', status: 200, shape: 'linkset' },
];

function rollup(id: string, name: string, rows: readonly Row[]) {
  const counted = rows.filter((r) => ['pass', 'noncompliant', 'broken', 'absent'].includes(r.status));
  return { id, name, passed: counted.filter((r) => r.status === 'pass').length, counted: counted.length };
}

/** A stored scorecard for `host` holding `rows`, its categories rolled up from them. */
export function scorecardOf(host: string, rows: Row[], extra: Record<string, unknown> = {}): StoredScorecard {
  const ids = [...new Set(rows.map((r) => String(r.category)))];
  return {
    schema_version: '0.5',
    spec_version: '0.4.0',
    target_url: `https://${host}/`,
    tool: { name: host, url: `https://${host}/` },
    mcp_discovery: [],
    site_type: null,
    public_listing: false,
    vantage: { network: 'public', credentialed: false },
    score_pct: 70,
    score: { relative: 70, global: 26 },
    categories: REGISTRY.category_order
      .filter((id) => ids.includes(id))
      .map((id) =>
        rollup(
          id,
          REGISTRY.categories[id],
          rows.filter((r) => r.category === id),
        ),
      ),
    results: rows,
    ...extra,
  };
}

/** stripe.dev as a followed audit stores it. */
export function stripeShaped() {
  return scorecardOf('stripe.dev', [...stripeApiRows(), ...stripeMcpRows()], {
    mcp_endpoint: 'https://mcp.stripe.com/',
    mcp_discovery: STRIPE_DISCOVERY,
    follow_declarations: true,
    declared_hosts: STRIPE_TRAIL,
  });
}

/** Two API anchors on two hosts: the hygiene rows carry one outcome per host. */
export function twoAnchorShaped() {
  const both = (a: string, b: string) => ({
    hosts: [
      { host: 'api.example.net', status: a },
      { host: 'files.example.net', status: b },
    ],
  });
  return scorecardOf(
    'example.com',
    [
      row('openapi', 'pass', { evidence: 'https://api.example.net/openapi.json -> 200', ...both('pass', 'pass') }),
      row('json-errors', 'broken', {
        evidence: 'https://files.example.net/x -> 404 (HTML)',
        ...both('pass', 'broken'),
      }),
    ],
    {
      follow_declarations: true,
      declared_hosts: [
        {
          surface: '/.well-known/api-catalog#/linkset/0',
          kind: 'api-anchor',
          url: 'https://api.example.net/',
          host: 'api.example.net',
          outcome: 'followed',
        },
        {
          surface: '/.well-known/api-catalog#/linkset/1',
          kind: 'api-anchor',
          url: 'https://files.example.net/',
          host: 'files.example.net',
          outcome: 'followed',
        },
      ],
    },
  );
}
