// Whole-audit score invariants, asserted ACROSS server shapes.
//
// Every other web-audit test pins one row's status against one stubbed
// response. That granularity cannot see a scoring inversion, because an
// inversion is a relation BETWEEN two whole audits: both audits in the
// pair can be individually correct while the pair is wrong. A suite made
// only of per-row assertions reports an inverted score model as healthy.
//
// So these tests compare `scoreWebAudit` output for two shapes that
// differ in exactly one server behavior, and assert an ordering or an
// equality, never an absolute number. Absolute numbers move whenever the
// registry gains a check, so a suite built on them gets re-baselined
// instead of investigated. Each case names both shapes, so a failure
// reads as the sentence a contributor needs: shape X must not outscore
// shape Y.
//
// One direction is deliberately NOT an invariant. The scorer prices
// `broken` below `absent` on purpose (a present but invalid surface
// misleads an agent more than a missing one), so withdrawing a surface
// that traps agents raises a score for every check in the registry, MCP
// or not. `noncompliant` is what keeps that rule from reaching a surface
// an agent can actually use: a lane that answers with the wrong error
// code still lets the caller proceed, so it earns positive credit and
// showing it beats hiding it. The invariants below are therefore stated
// over WORKING capabilities and over equal-quality pairs, and the test
// that pins the withdraw-a-trap direction says so in its own name.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { attachInlineRemediation } from '../src/worker/audit-web/display';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import {
  CONFORMANCE_OPS,
  ERA_OPS,
  LEGACY_CONFORMANCE_OPS,
  MODERN_LANE_DEPENDENT_OPS,
} from '../src/worker/audit-web/handlers/mcp';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';
import { scoreWebAudit, universeMaxOf, type WebScore } from '../src/worker/audit-web/score';
import type { EngineResult } from '../src/worker/audit-web/scorecard';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');
const MODERN_PROTOCOL = '2026-07-28';
const BASE = 'https://example.com/';

const registry = normalizeWebAuditRegistry(
  yaml.load(await readFile(REGISTRY_PATH, 'utf8')) as object,
) as unknown as WebAuditRegistry;
const universeMax = universeMaxOf(registry.checks);

const json = (body: object, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rpcError = (code: number, status = 200, data?: Record<string, unknown>): Response =>
  json({ jsonrpc: '2.0', id: 1, error: { code, message: 'nope', ...(data !== undefined ? { data } : {}) } }, status);
const toolsResult = (): Response =>
  json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } });
const resourcesResult = (): Response =>
  json({ jsonrpc: '2.0', id: 1, result: { resources: [{ uri: 'resource://x', name: 'x' }] } });

type McpHandler = (headers: Headers, body: string) => Response;

/** Wrap an MCP-endpoint POST handler with the card + root a discovery pass needs. */
function site(mcp: McpHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${BASE}.well-known/mcp.json`) return json({ mcp_endpoint: `${BASE}mcp` });
    if (url === BASE) {
      return new Response('<html><body><h1>x</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url !== `${BASE}mcp`) return new Response('not found', { status: 404 });
    return mcp(new Headers(init?.headers), init?.body === undefined ? '' : String(init.body));
  }) as typeof fetch;
}

function bodyMethod(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? ((parsed as { method?: string }).method ?? null)
      : null;
  } catch {
    return null;
  }
}

/** A fully conforming legacy lane that advertises and serves both capability groups. */
function legacyLane(_headers: Headers, body: string, sessionId?: string): Response {
  let isBatch = false;
  try {
    isBatch = Array.isArray(JSON.parse(body));
  } catch {
    isBatch = false;
  }
  if (isBatch) return rpcError(-32600, 400);
  const method = bodyMethod(body);
  if (method === 'initialize') {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          serverInfo: { name: 'legacy' },
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
        },
      },
    );
  }
  if (method === 'tools/list') return toolsResult();
  if (method === 'resources/list') return resourcesResult();
  if (method === 'tools/call') return rpcError(-32602);
  if (method === null) return rpcError(-32700, 400);
  return rpcError(-32601);
}

const discoverResult = (capabilities: Record<string, unknown> = { tools: {}, resources: {} }): Response =>
  json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      supportedVersions: [MODERN_PROTOCOL],
      capabilities,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'dual', version: '1.0' } },
    },
  });

/** A fully conforming modern lane: every conformance probe draws its accept code. */
function modernConforming(headers: Headers, body: string): Response {
  const mcpMethod = headers.get('mcp-method');
  if (headers.get('mcp-protocol-version') !== MODERN_PROTOCOL) {
    return rpcError(-32022, 400, { supported: [MODERN_PROTOCOL] });
  }
  if (mcpMethod === 'server/discover') return discoverResult();
  let parsed: { method?: string; params?: { _meta?: Record<string, unknown> } } | null = null;
  try {
    parsed = JSON.parse(body) as { method?: string; params?: { _meta?: Record<string, unknown> } };
  } catch {
    return rpcError(-32700, 400);
  }
  const meta = parsed?.params?._meta ?? {};
  if (!('io.modelcontextprotocol/clientCapabilities' in meta)) return rpcError(-32602, 400);
  if (mcpMethod !== parsed?.method) return rpcError(-32020, 400);
  if (mcpMethod === 'resources/read') return rpcError(-32602);
  if (mcpMethod === 'tools/list') return toolsResult();
  return rpcError(-32601);
}

/**
 * A modern lane that serves discovery and tools/list but answers every
 * conformance probe with a result instead of the refusal code: the shape
 * an early adopter has before implementing the error taxonomy.
 */
function modernLenient(headers: Headers, _body: string): Response {
  const mcpMethod = headers.get('mcp-method');
  if (mcpMethod === 'server/discover') return discoverResult();
  if (mcpMethod === 'resources/read') return resourcesResult();
  return toolsResult();
}

/** A modern lane whose conformance probes all draw the same wrong code. */
function modernWrongCodes(headers: Headers, _body: string): Response {
  const mcpMethod = headers.get('mcp-method');
  if (mcpMethod === 'server/discover') return discoverResult();
  if (mcpMethod === 'tools/list') return toolsResult();
  return rpcError(-32603);
}

/**
 * A modern lane that serves discovery and tools/list and answers every
 * one of the five conformance probes with a well-formed refusal under
 * `code`: the shape an early adopter has before implementing the error
 * taxonomy. Every conformance row lands `noncompliant`, so the whole
 * shape is a working lane with a wrong taxonomy and nothing else.
 */
function modernWrongTaxonomy(code: number): McpHandler {
  return (headers, body) => {
    const mcpMethod = headers.get('mcp-method');
    if (mcpMethod === 'server/discover') return discoverResult();
    if (headers.get('mcp-protocol-version') !== MODERN_PROTOCOL) return rpcError(code);
    let parsed: { method?: string; params?: { _meta?: Record<string, unknown> } } | null = null;
    try {
      parsed = JSON.parse(body) as { method?: string; params?: { _meta?: Record<string, unknown> } };
    } catch {
      return rpcError(code);
    }
    const meta = parsed?.params?._meta ?? {};
    if (!('io.modelcontextprotocol/clientCapabilities' in meta)) return rpcError(code);
    if (mcpMethod !== parsed?.method) return rpcError(code);
    if (mcpMethod === 'tools/list') return toolsResult();
    return rpcError(code);
  };
}

const isModern = (headers: Headers): boolean => headers.get('mcp-method') !== null;

/** Compose a conforming legacy half with a modern half. */
function dualStack(modern: McpHandler): typeof fetch {
  return site((headers, body) => (isModern(headers) ? modern(headers, body) : legacyLane(headers, body)));
}

/** The same server with only its `server/discover` answer replaced. */
function withDiscover(modern: McpHandler, discover: () => Response): McpHandler {
  return (headers, body) => (headers.get('mcp-method') === 'server/discover' ? discover() : modern(headers, body));
}

/** Advertise `capabilities.tools` on discovery, then refuse modern tools/list. */
function advertiseThenRefuse(toolsListCode: number): McpHandler {
  return (headers) => {
    const mcpMethod = headers.get('mcp-method');
    if (mcpMethod === 'server/discover') return discoverResult({ tools: {} });
    if (mcpMethod === 'tools/list') return rpcError(toolsListCode);
    return rpcError(-32603);
  };
}

interface Audit {
  score: WebScore;
  rows: EngineResult[];
}

const audits = new Map<string, Promise<Audit>>();

/** Whole-audit score for a shape, memoized so a shape used by several cases runs once. */
function auditOf(label: string, fetchImpl: typeof fetch): Promise<Audit> {
  const cached = audits.get(label);
  if (cached) return cached;
  const run = (async (): Promise<Audit> => {
    const rows: EngineResult[] = [];
    for await (const event of runWebAudit({
      url: BASE,
      registry,
      fetchOptions: { fetchImpl },
    }) as AsyncGenerator<AuditEvent>) {
      if (event.type === 'result') rows.push(event.result);
    }
    return { score: scoreWebAudit(rows, universeMax), rows };
  })();
  audits.set(label, run);
  return run;
}

const SHAPES: Record<string, typeof fetch> = {
  // Dual-stack, modern lane fully conforming.
  'dual-stack conforming': dualStack(modernConforming),
  // The same server, discovery withheld.
  'dual-stack conforming with server/discover withheld': dualStack(
    withDiscover(modernConforming, () => rpcError(-32601)),
  ),
  // Dual-stack whose modern conformance answers are all wrong.
  'dual-stack with a lenient modern lane': dualStack(modernLenient),
  'dual-stack with a lenient modern lane, server/discover withheld': dualStack(
    withDiscover(modernLenient, () => rpcError(-32601)),
  ),
  'dual-stack answering every modern conformance probe -32603': dualStack(modernWrongCodes),
  'dual-stack answering every modern conformance probe -32603, server/discover withheld': dualStack(
    withDiscover(modernWrongCodes, () => rpcError(-32601)),
  ),
  // A working modern lane whose every conformance answer is the wrong
  // code, and the same lane with discovery withheld.
  'modern lane with a wrong error taxonomy': dualStack(modernWrongTaxonomy(-32603)),
  'modern lane with a wrong error taxonomy, server/discover withheld': dualStack(
    withDiscover(modernWrongTaxonomy(-32603), () => rpcError(-32601)),
  ),
  // The same lane picking a different wrong code.
  'modern lane with a wrong error taxonomy (-32001)': dualStack(modernWrongTaxonomy(-32001)),
  // Legacy-only, declining the modern lane three different ways.
  'legacy-only stateless': site(legacyLane),
  'legacy-only stateful (session required)': site((headers, body) => {
    if (bodyMethod(body) === 'initialize') return legacyLane(headers, body, 'sess');
    if (headers.get('mcp-session-id') !== 'sess') return rpcError(-32000, 400);
    return legacyLane(headers, body);
  }),
  'legacy-only spec-compliant (400s an unknown version)': site((headers, body) => {
    const version = headers.get('mcp-protocol-version');
    if (version !== null && version !== '2025-06-18') return new Response('Bad Request', { status: 400 });
    return legacyLane(headers, body);
  }),
  // Advertise tools on discovery, then refuse the method with two codes.
  'advertises tools then refuses modern tools/list -32601': dualStack(advertiseThenRefuse(-32601)),
  'advertises tools then refuses modern tools/list -32603': dualStack(advertiseThenRefuse(-32603)),
  // Operational conditions on the discovery probe.
  'server/discover answers -32000 at HTTP 500': dualStack(withDiscover(modernConforming, () => rpcError(-32000, 500))),
  'server/discover answers -32000 at HTTP 429': dualStack(withDiscover(modernConforming, () => rpcError(-32000, 429))),
  'server/discover answers a bare 500': dualStack(
    withDiscover(modernConforming, () => new Response('boom', { status: 500 })),
  ),
  'server/discover answers -32000 at HTTP 400': dualStack(withDiscover(modernConforming, () => rpcError(-32000, 400))),
};

const scoreFor = (label: string): Promise<Audit> => auditOf(label, SHAPES[label]);

/** Both headline scores of `better` are at least those of `worse`. */
async function expectNotBelow(better: string, worse: string): Promise<void> {
  const [b, w] = [await scoreFor(better), await scoreFor(worse)];
  expect(`relative ${better}=${b.score.relative} vs ${worse}=${w.score.relative}`).toBe(
    `relative ${better}=${b.score.relative} vs ${worse}=${Math.min(w.score.relative, b.score.relative)}`,
  );
  expect(`global ${better}=${b.score.global} vs ${worse}=${w.score.global}`).toBe(
    `global ${better}=${b.score.global} vs ${worse}=${Math.min(w.score.global, b.score.global)}`,
  );
}

/** Two shapes score identically on both axes and on earned points. */
async function expectSameScore(a: string, b: string): Promise<void> {
  const [x, y] = [await scoreFor(a), await scoreFor(b)];
  expect(`${a}: ${x.score.relative}/${x.score.global}/${x.score.earned}`).toBe(
    `${a}: ${y.score.relative}/${y.score.global}/${y.score.earned}`,
  );
}

const statusOf = (audit: Audit, id: string): string => String(audit.rows.find((r) => r.id === id)?.status);

describe('monotonicity: serving a lane never scores below hiding it', () => {
  test('a conforming modern lane outscores the same server with server/discover withheld', async () => {
    const served = await scoreFor('dual-stack conforming');
    const hidden = await scoreFor('dual-stack conforming with server/discover withheld');
    expect(`served=${served.score.relative} hidden=${hidden.score.relative}`).toBe(
      `served=${served.score.relative} hidden=${Math.min(hidden.score.relative, served.score.relative - 1)}`,
    );
    await expectNotBelow('dual-stack conforming', 'dual-stack conforming with server/discover withheld');
  });

  test('a legacy-only server never outscores a dual-stack conforming one', async () => {
    await expectNotBelow('dual-stack conforming', 'legacy-only stateless');
  });

  test('a legacy-only server holds the modern rows at a zero-credit absence, never a penalty', async () => {
    // The six modern-lane rows occupy their slot at zero credit rather
    // than leaving scoring: an agent reaching for the lane finds nothing,
    // which is what `absent` means. They are marked unprobed because no
    // request was sent, which is what keeps six remediation prompts for a
    // lane the run never reached off the scorecard.
    const audit = await scoreFor('legacy-only stateless');
    for (const op of MODERN_LANE_DEPENDENT_OPS) {
      const id = op === 'modern-tools-list' ? 'mcp-modern-tools-list' : `mcp-${op}`;
      const row = audit.rows.find((r) => r.id === id);
      expect(`${id}:${String(row?.status)}/${String(row?.unprobed)}`).toBe(`${id}:absent/true`);
    }
  });

  test('an unprobed row carries a result line but no remediation', async () => {
    // The fix prompt for a specific conformance behavior on a lane the
    // run never requested names a defect nothing observed.
    const audit = await scoreFor('legacy-only stateless');
    const rows = audit.rows.map((r) => ({
      id: r.id,
      status: r.status,
      evidence: r.evidence,
      ...(r.unprobed === true ? { unprobed: true as const } : {}),
    }));
    const enriched = attachInlineRemediation({ results: rows }, {}, 'https://anc.dev') as {
      results: Array<{ id: string; result?: string; remediation?: unknown }>;
    };
    for (const op of MODERN_LANE_DEPENDENT_OPS) {
      const id = op === 'modern-tools-list' ? 'mcp-modern-tools-list' : `mcp-${op}`;
      const row = enriched.results.find((r) => r.id === id);
      expect(`${id}:remediation=${String('remediation' in (row ?? {}))}`).toBe(`${id}:remediation=false`);
      expect(`${id}:result=${typeof row?.result}`).toBe(`${id}:result=string`);
    }
    // The discovery row itself WAS probed, so it keeps its remediation:
    // serving the modern revision is the actionable advice for this shape.
    const discover = enriched.results.find((r) => r.id === 'mcp-server-discover');
    expect('remediation' in (discover ?? {})).toBe(true);
  });

  test('withholding the discriminator buys exactly the legacy-only baseline, never more', async () => {
    // A withheld modern lane and an absent one are indistinguishable on
    // the wire, so they must score identically. Any gap is an arbitrage.
    await expectSameScore('dual-stack conforming with server/discover withheld', 'legacy-only stateless');
    await expectSameScore('dual-stack with a lenient modern lane, server/discover withheld', 'legacy-only stateless');
  });
});

describe('no-arbitrage: the refusal a server picks must not move its score', () => {
  test('an advertised lane refusing its own method is broken whichever code it picks', async () => {
    const notFound = await scoreFor('advertises tools then refuses modern tools/list -32601');
    const internal = await scoreFor('advertises tools then refuses modern tools/list -32603');
    expect(statusOf(notFound, 'mcp-modern-tools-list')).toBe('broken');
    expect(statusOf(internal, 'mcp-modern-tools-list')).toBe('broken');
    await expectSameScore(
      'advertises tools then refuses modern tools/list -32601',
      'advertises tools then refuses modern tools/list -32603',
    );
  });

  test('a legacy-only server scores the same however it declines the modern lane', async () => {
    await expectSameScore('legacy-only stateless', 'legacy-only stateful (session required)');
    await expectSameScore('legacy-only stateless', 'legacy-only spec-compliant (400s an unknown version)');
  });
});

describe('conformance direction: answering better never scores worse', () => {
  test('correct modern conformance codes outscore uniformly wrong ones', async () => {
    await expectNotBelow('dual-stack conforming', 'dual-stack answering every modern conformance probe -32603');
    await expectNotBelow('dual-stack conforming', 'dual-stack with a lenient modern lane');
    await expectNotBelow('dual-stack conforming', 'modern lane with a wrong error taxonomy');
  });

  test('a lane that answers the conformance probes wrongly still reads as present', async () => {
    // The wrong answers must be scored, not gated away: a modern lane
    // that discovery evidenced is probed on its own merits.
    const audit = await scoreFor('dual-stack answering every modern conformance probe -32603');
    expect(statusOf(audit, 'mcp-server-discover')).toBe('pass');
    // tools/list is served here, so the missing clientCapabilities draws a
    // result where a refusal was required: a trap, not a taxonomy defect.
    expect(statusOf(audit, 'mcp-modern-clientcaps')).toBe('broken');
    expect(statusOf(audit, 'mcp-modern-unknown-method')).toBe('noncompliant');
  });

  test('a wrongly-coded refusal reads noncompliant on every modern conformance row', async () => {
    const audit = await scoreFor('modern lane with a wrong error taxonomy');
    expect(statusOf(audit, 'mcp-server-discover')).toBe('pass');
    expect(statusOf(audit, 'mcp-modern-tools-list')).toBe('pass');
    for (const op of MODERN_LANE_DEPENDENT_OPS.filter((o) => o !== 'modern-tools-list')) {
      expect(`mcp-${op}:${statusOf(audit, `mcp-${op}`)}`).toBe(`mcp-${op}:noncompliant`);
    }
  });
});

describe('showing an imperfect lane beats hiding it', () => {
  test('a working modern lane with a wrong error taxonomy outscores the same lane withheld', async () => {
    // The defect this status exists to remove: under a single `broken`
    // bucket, five wrongly-coded refusals cost more than never answering
    // at all, so the auditor paid an operator to withdraw a capability an
    // agent could use. Both bytes-on-the-wire shapes are indistinguishable
    // from an absent lane, so the only lever is to stop paying for it.
    const shown = await scoreFor('modern lane with a wrong error taxonomy');
    const hidden = await scoreFor('modern lane with a wrong error taxonomy, server/discover withheld');
    expect(
      `rel ${shown.score.relative}>${hidden.score.relative} glob ${shown.score.global}>${hidden.score.global} earned ${shown.score.earned}>${hidden.score.earned}`,
    ).toBe(
      `rel ${shown.score.relative}>${Math.min(hidden.score.relative, shown.score.relative - 1)} glob ${shown.score.global}>${Math.min(hidden.score.global, shown.score.global - 1)} earned ${shown.score.earned}>${Math.min(hidden.score.earned, shown.score.earned - 0.1)}`,
    );
  });

  test('a partly-noncompliant modern lane outscores the same lane withheld', async () => {
    // The measured mixed shape: discovery and tools/list serve, three
    // conformance rows answer under the wrong code and two answer with a
    // result where a refusal belonged.
    await expectNotBelow(
      'dual-stack answering every modern conformance probe -32603',
      'dual-stack answering every modern conformance probe -32603, server/discover withheld',
    );
  });

  test('the wrong code a lane picks does not move its score', async () => {
    // Two wrong codes are equally wrong. If they scored differently, the
    // taxonomy defect would become a code-shopping exercise.
    await expectSameScore(
      'modern lane with a wrong error taxonomy',
      'modern lane with a wrong error taxonomy (-32001)',
    );
  });
});

describe('an operational condition on the discriminator is not an era verdict', () => {
  test('-32000 at a server-error or rate-limit status scores as a broken discovery probe', async () => {
    for (const label of ['server/discover answers -32000 at HTTP 500', 'server/discover answers -32000 at HTTP 429']) {
      const audit = await scoreFor(label);
      expect(`${label}:${statusOf(audit, 'mcp-server-discover')}`).toBe(`${label}:broken`);
      await expectSameScore(label, 'server/discover answers a bare 500');
    }
  });

  test('-32000 at a status that can carry an era signal still reads as an absent lane', async () => {
    const audit = await scoreFor('server/discover answers -32000 at HTTP 400');
    expect(statusOf(audit, 'mcp-server-discover')).toBe('absent');
    await expectSameScore('server/discover answers -32000 at HTTP 400', 'legacy-only stateless');
  });

  test('a transient failure on the discriminator publishes an absence it marks as unprobed', async () => {
    // The failure suppresses the modern rows either way, and the rows
    // score as absences, so the scorecard must at least record that no
    // request reached the surface: the verdict caches for weeks on one
    // response, and an unprobed row prints no fix prompt for a defect
    // nothing observed. Resolving the lane `unknown` on an era-unreadable
    // status is what would make the rows probe instead, and that moves
    // the bare-500 control this file pins below.
    const audit = await scoreFor('server/discover answers -32000 at HTTP 500');
    const row = audit.rows.find((r) => r.id === 'mcp-modern-tools-list');
    expect(`${String(row?.status)}/${String(row?.unprobed)}`).toBe('absent/true');
  });
});

describe('the scorer prices the four scored statuses in one order, for every check', () => {
  test('pass beats noncompliant beats absent beats broken', async () => {
    // The whole model in one assertion, on synthetic rows so it reads as
    // the scorer's rule rather than an MCP-handler behavior. Every
    // ordering below is a consequence of this one.
    const filler = Array.from({ length: 10 }, () => ({ keyword: 'should' as const, status: 'pass' as const }));
    const at = (status: 'pass' | 'noncompliant' | 'absent' | 'broken') =>
      scoreWebAudit([{ keyword: 'should', status }, ...filler], universeMax);
    const order = ['pass', 'noncompliant', 'absent', 'broken'] as const;
    const descending = order
      .slice(1)
      .every((status, i) => at(order[i]).earned > at(status).earned && at(order[i]).global > at(status).global);
    expect(`pass > noncompliant > absent > broken: ${descending}`).toBe('pass > noncompliant > absent > broken: true');
  });

  test('a noncompliant row occupies its full weight in the relative denominator', async () => {
    // An absent SHOULD is discounted to half weight; a noncompliant one
    // carries an observation and is not. Without this the positive credit
    // would arrive alongside a shrunken denominator and the two effects
    // would be impossible to reason about separately.
    const pass = { keyword: 'should' as const, status: 'pass' as const };
    const noncompliant = scoreWebAudit([pass, { keyword: 'should', status: 'noncompliant' }], universeMax);
    const absent = scoreWebAudit([pass, { keyword: 'should', status: 'absent' }], universeMax);
    // 3.75/6 = 63 vs 3/4.5 = 67: the discounted absence reads HIGHER on
    // the relative axis even though it earned less, which is the residual
    // the half-weight rule leaves and the reason global is the tiebreak.
    expect(`${noncompliant.relative}/${absent.relative}`).toBe('63/67');
    expect(noncompliant.global > absent.global).toBe(true);
  });

  test('withdrawing a trap raises a score, which is the scorer and not the MCP handler', async () => {
    // This is the one doing-less-outscores-doing-more direction that is
    // by design. It holds for any check, so the pair below is synthetic
    // rows through scoreWebAudit rather than a server shape: attributing
    // it to the MCP handler is the mistake this case exists to prevent.
    const filler = Array.from({ length: 10 }, () => ({ keyword: 'should' as const, status: 'pass' as const }));
    const broken = scoreWebAudit([{ keyword: 'should', status: 'broken' }, ...filler], universeMax);
    const absent = scoreWebAudit([{ keyword: 'should', status: 'absent' }, ...filler], universeMax);
    expect(absent.relative > broken.relative && absent.global > broken.global).toBe(true);
  });

  test('a modern lane that answers a refusal probe with a result scores below one that is honestly absent', async () => {
    // The consequence of the rule above on the MCP family, pinned so it
    // reads as a known and deliberate ordering rather than a fresh bug.
    // This lane tells the caller that an unknown method succeeded and
    // that a nonexistent resource was read, so it is a trap and not a
    // taxonomy defect; `noncompliant` deliberately does not reach it.
    const broken = await scoreFor('dual-stack with a lenient modern lane');
    const hidden = await scoreFor('dual-stack with a lenient modern lane, server/discover withheld');
    expect(hidden.score.relative > broken.score.relative).toBe(true);
  });
});

describe('row families are declared once and cover the registry', () => {
  const declared = [...ERA_OPS, ...CONFORMANCE_OPS];

  test('the two families partition every declared op', () => {
    expect(new Set(declared).size).toBe(declared.length);
    expect([...ERA_OPS].filter((op) => CONFORMANCE_OPS.includes(op)).join(',')).toBe('');
  });

  test('every MCP op the registry uses is declared, and every declared op is used', () => {
    const used = new Set(
      registry.checks
        .filter((c) => c.handler === 'mcp')
        .map((c) => String((c.with as { op?: string }).op))
        .filter((op) => op !== 'undefined'),
    );
    expect(
      [...used]
        .filter((op) => !declared.includes(op as (typeof declared)[number]))
        .sort()
        .join(','),
    ).toBe('');
    expect(
      declared
        .filter((op) => !used.has(op))
        .sort()
        .join(','),
    ).toBe('');
  });

  test('the modern-lane gate covers every modern row except the discriminator', () => {
    expect(MODERN_LANE_DEPENDENT_OPS.includes('server-discover')).toBe(false);
    expect([...MODERN_LANE_DEPENDENT_OPS].sort().join(',')).toBe(
      [
        'modern-clientcaps',
        'modern-header-mismatch',
        'modern-resources-miss',
        'modern-tools-list',
        'modern-unknown-method',
        'modern-version-reject',
      ].join(','),
    );
  });

  test('the session re-ask covers the legacy conformance rows and nothing else', () => {
    expect([...LEGACY_CONFORMANCE_OPS].sort().join(',')).toBe('batch-reject,malformed-body,unknown-tool');
    expect([...LEGACY_CONFORMANCE_OPS].every((op) => CONFORMANCE_OPS.includes(op))).toBe(true);
  });
});
