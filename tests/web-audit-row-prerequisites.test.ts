// Each check's edges, derived by watching the code read: every antecedent
// resolver runs against a matrix of contexts with its source reads recorded, and
// every registry check's handler runs against a context that records the fields
// it touches. `rowPrerequisites` must name exactly that, so an edge can neither
// go missing (a row reading a source that has not settled) nor linger (a row
// waiting on one it never reads).

import { describe, expect, test } from 'bun:test';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import {
  type AntecedentContext,
  antecedentPrerequisites,
  MCP_NOTIFIED,
  MCP_SETTLED,
  type Prerequisite,
  resolveAntecedent,
} from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { handlerFor } from '../src/worker/audit-web/engine';
import type { HandlerContext, McpAuthRequired, ProbeOutcome } from '../src/worker/audit-web/handlers/types';
import { WIRE_PROBE_IDS } from '../src/worker/audit-web/mcp-auth';
import type { AntecedentToken, WebCheck } from '../src/worker/audit-web/registry';
import { rowPrerequisites } from '../src/worker/audit-web/row-prerequisites';
import { stubFetch } from './helpers/stub-fetch';

const registry = loadRegistry();
const ENDPOINT = 'https://example.com/mcp';
const THIN_HTML = '<!doctype html><html><head></head><body></body></html>';

const AUTH: McpAuthRequired = {
  endpoint: ENDPOINT,
  challenge: null,
  lane: 'legacy',
  metadataUrl: 'https://example.com/.well-known/oauth-protected-resource/mcp',
  metadata: {},
};

function htmlRoot(contentType: string): ProbeResponse {
  return { status: 200, headers: { 'content-type': contentType }, body: THIN_HTML, error: null };
}

/** A wire probe's read is one of the settled step: sign-in may have rewritten that row. */
function asPrerequisite(id: string): Prerequisite {
  return WIRE_PROBE_IDS.includes(id) ? MCP_SETTLED : (id as Prerequisite);
}

class RecordingSources extends Map<string, ProbeOutcome> {
  constructor(
    entries: Array<[string, ProbeOutcome]>,
    private readonly reads: Set<Prerequisite>,
  ) {
    super(entries);
  }
  override get(id: string): ProbeOutcome | undefined {
    this.reads.add(asPrerequisite(id));
    return super.get(id);
  }
  override has(id: string): boolean {
    this.reads.add(asPrerequisite(id));
    return super.has(id);
  }
}

class RecordingBodies extends Map<string, string> {
  reads = new Set<Prerequisite>();
  override get(id: string): string | undefined {
    this.reads.add(asPrerequisite(id));
    return super.get(id);
  }
}

const PASSING_SOURCES = (): Array<[string, ProbeOutcome]> =>
  [
    'robots',
    'llms-txt',
    'llms-full-txt',
    'openapi',
    'oauth-discovery',
    'sitemap',
    'accept-markdown',
    ...WIRE_PROBE_IDS,
  ].map((id): [string, ProbeOutcome] => [id, { status: 'pass', evidence: [{ status: 200, ok: true, body: 'x' }] }]);

/** What resolving `token` reads across every combination of the context it can see. */
function tokenReads(token: AntecedentToken): Set<Prerequisite> {
  const reads = new Set<Prerequisite>();
  const roots: Array<ProbeResponse | null> = [null, htmlRoot('text/html'), htmlRoot('application/json')];
  for (const root of roots) {
    for (const mcpEndpoint of [null, ENDPOINT]) {
      for (const mcpAuth of [null, AUTH]) {
        for (const siteType of [null, 'api', 'content'] as const) {
          for (const entries of [[], PASSING_SOURCES()]) {
            const ctx: AntecedentContext = {
              siteType,
              mcpEndpoint,
              discoveryEvidence: [],
              root,
              sources: new RecordingSources(entries, reads),
              mcpAuth,
              mcpLane: 'legacy',
            };
            const recording = new Proxy(ctx, {
              get(target, field, receiver) {
                if (field === 'mcpAuth') reads.add(MCP_SETTLED);
                return Reflect.get(target, field, receiver);
              },
            });
            resolveAntecedent(token, recording);
          }
        }
      }
    }
  }
  return reads;
}

// The notification follows the settled step, so a check waiting on it has the
// other too and names only the later one.
function withoutImplied(edges: Set<Prerequisite>): Set<Prerequisite> {
  if (edges.has(MCP_NOTIFIED)) edges.delete(MCP_SETTLED);
  return edges;
}

// The one edge no read shows: every later request to the MCP endpoint comes
// after the session is notified, so an `mcp-*` token waits whatever it reads.
function tokenEdges(token: AntecedentToken): Set<Prerequisite> {
  const reads = tokenReads(token);
  if (token.startsWith('mcp-')) reads.add(MCP_NOTIFIED);
  return withoutImplied(reads);
}

const FIELD_READS: Partial<Record<keyof HandlerContext, readonly Prerequisite[]>> = {
  scopedDirs: ['llms-txt', 'sitemap'],
  apiDescriptionBodies: ['openapi'],
  // A request carrying the session is what the notification must precede.
  mcpSessionId: [MCP_NOTIFIED],
  mcpLanes: [MCP_SETTLED],
  mcpAuth: [MCP_SETTLED],
  mcpSignIn: [MCP_SETTLED],
};

type Answers = { status: number; headers: Record<string, string>; apiTargets: HandlerContext['apiTargets'] };

// A read can sit behind one answer or context shape, so both are run: every answer
// a 200 with no API anchor, and every answer a 401 challenge with one.
const CONTEXT_SHAPES: readonly Answers[] = [
  { status: 200, headers: { 'content-type': 'text/plain', 'mcp-session-id': 's' }, apiTargets: null },
  {
    status: 401,
    headers: { 'content-type': 'text/plain', 'www-authenticate': 'Bearer realm="x"' },
    apiTargets: {
      descriptions: [],
      hosts: [
        {
          origin: 'https://api.example.com',
          anchors: [{ url: 'https://api.example.com/', description: 'https://api.example.com/openapi.json' }],
          declared: true,
        },
      ],
    },
  },
];

/** What `check`'s handler reads from the context, across every shape it can see. */
async function handlerReads(check: WebCheck): Promise<Set<Prerequisite>> {
  const reads = new Set<Prerequisite>();
  for (const { status, headers, apiTargets } of CONTEXT_SHAPES) {
    const fetchImpl = stubFetch(() => new Response('# Doc\n', { status, headers }));
    const bodies = new RecordingBodies([
      ['llms-txt', '# Site\n\n> Summary\n\n- [Docs](https://example.com/docs/a.md)\n'],
      ['openapi', '{"openapi":"3.1.0","servers":[{"url":"https://example.com/"}]}'],
    ]);
    const ctx: HandlerContext = {
      base: 'https://example.com/',
      host: 'example.com',
      mcpEndpoint: ENDPOINT,
      protocolVersion: '2025-06-18',
      defaultTimeoutMs: 200,
      root: htmlRoot('text/html'),
      scopedDirs: ['/docs'],
      retainedBodies: bodies,
      retainedDocuments: new Map(),
      apiTargets,
      apiDescriptionBodies: new Map(),
      apiHostProbes: new Map(),
      fetchOptions: { fetchImpl },
      mcpSessionId: 's',
      mcpLanes: { modern: 'present', legacyAdvertised: [], modernAdvertised: [] },
      mcpAuth: null,
      mcpSignIn: async () => false,
    };
    const recording = new Proxy(ctx, {
      get(target, field, receiver) {
        for (const prerequisite of FIELD_READS[field as keyof HandlerContext] ?? []) reads.add(prerequisite);
        return Reflect.get(target, field, receiver);
      },
    });
    await handlerFor(check)?.(check, recording);
    for (const read of bodies.reads) reads.add(read);
  }
  return reads;
}

describe('a check waits on exactly what its code reads', () => {
  const tokens = [...new Set(registry.checks.map((check) => check.antecedent))];

  test.each(tokens)('the antecedent %s declares what its resolver reads', (token) => {
    expect(new Set(antecedentPrerequisites(token))).toEqual(tokenEdges(token));
  });

  test.each(registry.checks.map((check): [string, WebCheck] => [check.id, check]))(
    'the check %s waits on its resolver and handler reads',
    async (_id, check) => {
      const derived = new Set([...tokenEdges(check.antecedent), ...(await handlerReads(check))]);
      expect(withoutImplied(new Set(rowPrerequisites(check)))).toEqual(withoutImplied(derived));
    },
  );

  test('a source check other than a wire probe reads no other source: it probes before they settle', async () => {
    const sourceIds = PASSING_SOURCES()
      .map(([id]) => id)
      .filter((id) => !WIRE_PROBE_IDS.includes(id));
    const reading: string[] = [];
    for (const check of registry.checks.filter((c) => sourceIds.includes(c.id))) {
      if ((await handlerReads(check)).size > 0) reading.push(check.id);
    }
    expect(reading).toEqual([]);
  });
});
