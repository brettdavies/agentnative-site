// Web-audit orchestrator (plan U5, reworked per plan-003 KTD-2). Runs
// MCP endpoint discovery and the single canonical root fetch, then
// evaluates in two waves: wave 1 probes the antecedent-source checks
// (the WAVE1_CHECK_IDS set); wave 2 runs the dependent checks with
// antecedents resolved from wave-1 results and the root fetch reused —
// no duplicate `/` fetch. Each check finalizes to
// pass / noncompliant / broken / absent / n_a / skip / error; an
// applicable MAY that comes back absent is re-tagged n_a with na_reason
// 'optional-absent', an unmet antecedent yields na_reason
// 'antecedent-unmet', and a handler-stated na_reason (the CORS pair's
// 'posture-consistent') passes through to the result row alongside the
// handler's `unprobed` marker.
//
// The engine yields each result as it finalizes (KTD-6: streaming
// transport is the route's concern) and a terminal `complete` event
// carrying the scorecard built from the collected results.

import {
  type AntecedentContext,
  antecedentUnmetEvidence,
  resolveAntecedent,
  siteTypeApplies,
  WAVE1_CHECK_IDS,
} from './antecedents';
import type { ProbeResponse } from './assert';
import { discoverMcpEndpoint } from './discovery';
import { runApiHygiene } from './handlers/api-hygiene';
import { runAuthMd } from './handlers/auth-md';
import { runContentWithoutJs } from './handlers/content-without-js';
import { runCorsPreflight } from './handlers/cors-preflight';
import { runDnsDoh } from './handlers/dns-doh';
import { runHttp, runLegacyAliasRedirects } from './handlers/http';
import { runLlmsTxtQuality } from './handlers/llms-txt-quality';
import { runMarkdownFrontmatter } from './handlers/markdown-frontmatter';
import {
  advertisedCapabilities,
  mcpModernLaneFrom,
  mcpSessionIdFrom,
  notifyMcpInitialized,
  runMcp,
} from './handlers/mcp';
import { enumerateScopedDirs, runScopedLlms } from './handlers/scoped-llms';
import type { EvidenceItem, HandlerContext, McpLaneEvidence, ProbeOutcome } from './handlers/types';
import { runWebMcp } from './handlers/webmcp';
import type { WebAuditRegistry, WebCheck, WebSiteType } from './registry';
import { buildWebScorecard, type EngineResult, type ScorecardStatus, type WebScorecard } from './scorecard';
import { type GuardedFetchOptions, guardedFetch } from './ssrf';

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_PER_CHECK_TIMEOUT_MS = 8_000;
const DEFAULT_PER_AUDIT_DEADLINE_MS = 25_000;

export interface RunWebAuditInput {
  url: string;
  registry: WebAuditRegistry;
  siteType?: WebSiteType | null;
  publicListing?: boolean;
  specVersion?: string;
  concurrency?: number;
  perCheckTimeoutMs?: number;
  perAuditDeadlineMs?: number;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  /** Injectable clock for deterministic deadline tests. */
  now?: () => number;
}

export type AuditEvent =
  | { type: 'discovery'; endpoint: string | null; evidence: EvidenceItem[] }
  | { type: 'result'; result: EngineResult }
  | { type: 'complete'; scorecard: WebScorecard; complete: boolean };

const HANDLERS: Partial<Record<WebCheck['handler'], (check: WebCheck, ctx: HandlerContext) => Promise<ProbeOutcome>>> =
  {
    http: runHttp,
    'cors-preflight': runCorsPreflight,
    mcp: runMcp,
    'dns-doh': runDnsDoh,
    'auth-md': runAuthMd,
    webmcp: runWebMcp,
    'scoped-llms': runScopedLlms,
    'markdown-frontmatter': runMarkdownFrontmatter,
    'content-without-js': runContentWithoutJs,
    'llms-txt-quality': runLlmsTxtQuality,
    'api-hygiene': runApiHygiene,
  };

function retainedBody(sources: ReadonlyMap<string, ProbeOutcome>, checkId: string): string {
  for (const item of sources.get(checkId)?.evidence ?? []) {
    if (typeof item.body === 'string') return item.body;
  }
  return '';
}

function normalizeBase(rawUrl: string): { base: string; host: string; domain: string } {
  const u = new URL(rawUrl);
  const base = `${u.protocol}//${u.host}/`;
  return { base, host: u.hostname, domain: u.host };
}

function probeStatusToScorecard(status: ProbeOutcome['status']): ScorecardStatus {
  return status === 'na' ? 'n_a' : status;
}

/** Compact human-readable evidence line derived from a handler's evidence. */
function summarizeEvidence(check: WebCheck, outcome: ProbeOutcome): string {
  const first = outcome.evidence[0] ?? {};
  if (outcome.status === 'na') return String((first.why as string[] | undefined)?.join('; ') ?? 'not applicable');

  if (check.handler === 'mcp') {
    if (first.error) return `${first.url}: ${first.error}`;
    // An era verdict and a conformance defect each state their reason in
    // `why`; the response fields describe the refusal, not the surface
    // the row is scoring. A bare `error code -32022` would read as the
    // wrong code on a row whose code was right and whose payload was not.
    if ((outcome.status === 'absent' || outcome.status === 'noncompliant') && Array.isArray(first.why)) {
      return (first.why as string[]).join('; ');
    }
    const op = check.with ? (check.with as { op?: string }).op : undefined;
    if (op === 'initialize') {
      const si = first.serverInfo as { name?: string } | null;
      return si?.name
        ? `serverInfo ${si.name}, protocol ${first.protocolVersion}`
        : 'no serverInfo in initialize result';
    }
    if (op === 'server-discover' && 'supported_versions' in first) {
      const versions = first.supported_versions as unknown[] | null;
      const si = first.serverInfo as { name?: string } | null;
      if (!Array.isArray(versions)) return 'no supportedVersions in the server/discover result';
      return `supports ${versions.join(', ')}, serverInfo ${si?.name ?? 'missing'}`;
    }
    if ('tools' in first) {
      const tools = first.tools as unknown[] | null;
      return Array.isArray(tools)
        ? `${tools.length} tools, ${first.with_input_schema} with input schema`
        : 'no tools array';
    }
    if ('error_code' in first) return `error code ${first.error_code}`;
  }

  if (check.handler === 'cors-preflight') {
    const side = (label: string, row: EvidenceItem | undefined): string =>
      row ? `${label} ${row.error ?? row.status ?? 'error'} allow-origin ${row.allow_origin ?? 'absent'}` : label;
    return `${side(
      'preflight',
      outcome.evidence.find((e) => e.probe === 'preflight'),
    )}; ${side(
      'post',
      outcome.evidence.find((e) => e.probe === 'post'),
    )}`;
  }

  if (check.handler === 'dns-doh') {
    const hit = outcome.evidence.find((e) => typeof e.answers === 'number' && (e.answers as number) > 0);
    if (hit) return `${hit.name}: ${hit.answers} record(s) via ${hit.resolver}`;
    return 'no DNS-AID records';
  }

  if (check.handler === 'webmcp') {
    // Which marker matched is the whole finding: without it a pass reads as
    // a bare 200 and a bad match cannot be told from a real one.
    const hit = outcome.evidence.find((e) => typeof e.marker === 'string');
    if (hit) return `${hit.url} -> ${hit.status} (${hit.marker})`;
  }

  // Every alias is probed, so most evidence items are unpublished paths the
  // row does not turn on. Name the one that decided the verdict, or the
  // generic line would report a 404 on a path the site never served.
  if (check.eval === 'legacy-alias-redirects') {
    const wanted = outcome.status === 'pass' ? 'pass' : 'broken';
    const decisive = outcome.evidence.find((e) => e.alias_verdict === wanted) ?? first;
    const note = (decisive.why as string[] | undefined)?.[0];
    return `${decisive.url ?? check.id} -> ${decisive.status ?? 'error'}${note ? ` (${note})` : ''}`;
  }

  // http
  const evidenceItem = outcome.status === 'pass' ? (outcome.evidence.find((e) => e.ok) ?? first) : first;
  if (evidenceItem.error) return `${evidenceItem.url}: ${evidenceItem.error}`;
  const why = (evidenceItem.why as string[] | undefined)?.[
    ((evidenceItem.why as string[] | undefined)?.length ?? 1) - 1
  ];
  const isMiss = outcome.status === 'broken' || outcome.status === 'absent' || outcome.status === 'error';
  return `${evidenceItem.url ?? check.id} -> ${evidenceItem.status ?? 'error'}${isMiss && why ? ` (${why})` : ''}`;
}

function baseFields(check: WebCheck): Omit<EngineResult, 'status' | 'evidence' | 'raw_evidence'> {
  return {
    id: check.id,
    title: check.title,
    principle: check.principle,
    keyword: check.keyword,
    tier: check.tier,
    category: check.category,
    weight: check.weight,
  };
}

function toResult(check: WebCheck, outcome: ProbeOutcome): EngineResult {
  return {
    ...baseFields(check),
    status: probeStatusToScorecard(outcome.status),
    ...(outcome.na_reason !== undefined ? { na_reason: outcome.na_reason } : {}),
    ...(outcome.unprobed === true ? { unprobed: true as const } : {}),
    evidence: summarizeEvidence(check, outcome),
    raw_evidence: outcome.evidence,
  };
}

function naResult(check: WebCheck, naReason: NonNullable<EngineResult['na_reason']>, evidence: string): EngineResult {
  return {
    ...baseFields(check),
    status: 'n_a',
    na_reason: naReason,
    evidence,
    raw_evidence: [{ why: [evidence] }],
  };
}

function errorResult(check: WebCheck, message: string): EngineResult {
  return { ...baseFields(check), status: 'error', evidence: message, raw_evidence: [{ error: message }] };
}

function skipResult(check: WebCheck): EngineResult {
  return {
    ...baseFields(check),
    status: 'skip',
    evidence: 'skipped: per-audit deadline exceeded',
    raw_evidence: [{ why: ['per-audit deadline exceeded'] }],
  };
}

/** An applicable MAY that is simply absent is optional, not a miss (R3). */
function finalizeOptional(check: WebCheck, result: EngineResult): EngineResult {
  if (check.keyword === 'may' && result.status === 'absent') {
    return { ...result, status: 'n_a', na_reason: 'optional-absent' };
  }
  return result;
}

/** Run tasks with a concurrency cap, yielding each result as it resolves. */
async function* mapConcurrentUnordered<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  let index = 0;
  const pending = new Map<number, Promise<{ key: number; value: R }>>();
  const schedule = (): boolean => {
    if (index >= items.length) return false;
    const key = index;
    const item = items[index];
    index += 1;
    pending.set(
      key,
      fn(item).then((value) => ({ key, value })),
    );
    return true;
  };
  for (let i = 0; i < concurrency; i++) if (!schedule()) break;
  while (pending.size > 0) {
    const { key, value } = await Promise.race(pending.values());
    pending.delete(key);
    yield value;
    schedule();
  }
}

export async function* runWebAudit(input: RunWebAuditInput): AsyncGenerator<AuditEvent> {
  const { base, host, domain } = normalizeBase(input.url);
  const now = input.now ?? Date.now;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const perCheckTimeoutMs = input.perCheckTimeoutMs ?? DEFAULT_PER_CHECK_TIMEOUT_MS;
  const perAuditDeadlineMs = input.perAuditDeadlineMs ?? DEFAULT_PER_AUDIT_DEADLINE_MS;
  const deadline = now() + perAuditDeadlineMs;

  const discovery = await discoverMcpEndpoint(input.url, input.registry.mcp_discovery, {
    timeoutMs: perCheckTimeoutMs,
    deadlineAt: deadline,
    now,
    fetchOptions: input.fetchOptions,
  });
  yield { type: 'discovery', endpoint: discovery.endpoint, evidence: discovery.evidence };

  // The single canonical root fetch every root-HTML check and several
  // antecedents read. null = failed at the network level.
  const rootResp = await guardedFetch(
    base,
    {},
    { ...input.fetchOptions, timeoutMs: Math.min(perCheckTimeoutMs, Math.max(1, deadline - now())) },
  );
  const root: ProbeResponse | null = rootResp.status === null ? null : rootResp;

  let incomplete = false;
  const results: EngineResult[] = [];
  const scopedDirs: string[] = [];
  const retainedBodies = new Map<string, string>();
  let mcpSessionId: string | null = null;
  let mcpLanes: McpLaneEvidence = { modern: 'unknown', legacyAdvertised: [], modernAdvertised: [] };

  const handlerCtx = (): HandlerContext => ({
    base,
    host,
    mcpEndpoint: discovery.endpoint,
    protocolVersion: input.registry.mcp_discovery.protocol_version,
    defaultTimeoutMs: Math.min(perCheckTimeoutMs, Math.max(1, deadline - now())),
    root: root ?? undefined,
    scopedDirs,
    retainedBodies,
    fetchOptions: input.fetchOptions,
    mcpSessionId,
    mcpLanes,
  });

  const probeOne = async (
    check: WebCheck,
  ): Promise<{ check: WebCheck; outcome: ProbeOutcome | null; result: EngineResult }> => {
    if (deadline - now() <= 0) {
      incomplete = true;
      return { check, outcome: null, result: skipResult(check) };
    }
    try {
      const handler = check.eval === 'legacy-alias-redirects' ? runLegacyAliasRedirects : HANDLERS[check.handler];
      if (!handler) throw new Error(`no handler registered for "${check.handler}"`);
      const outcome = await handler(check, handlerCtx());
      if (outcome.incomplete || deadline - now() <= 0) incomplete = true;
      return { check, outcome, result: toResult(check, outcome) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { check, outcome: null, result: errorResult(check, `handler error: ${message}`) };
    }
  };

  // Wave 1: probe the antecedent-source checks unconditionally.
  const wave1Checks = input.registry.checks.filter((c) => WAVE1_CHECK_IDS.has(c.id));
  const wave2Checks = input.registry.checks.filter((c) => !WAVE1_CHECK_IDS.has(c.id));
  const sources = new Map<string, ProbeOutcome>();
  const wave1Results = new Map<string, EngineResult>();
  for await (const { check, outcome, result } of mapConcurrentUnordered(wave1Checks, concurrency, probeOne)) {
    if (outcome) sources.set(check.id, outcome);
    wave1Results.set(check.id, result);
  }

  const actx: AntecedentContext = {
    siteType: input.siteType,
    mcpEndpoint: discovery.endpoint,
    discoveryEvidence: discovery.evidence,
    root,
    sources,
  };

  // Section directories for the scoped-llms probes: the root llms.txt
  // link index unioned with sitemap paths, both retained in wave 1.
  scopedDirs.push(...enumerateScopedDirs(retainedBody(sources, 'llms-txt'), retainedBody(sources, 'sitemap'), base));
  const llmsTxtBody = retainedBody(sources, 'llms-txt');
  if (llmsTxtBody.length > 0) retainedBodies.set('llms-txt', llmsTxtBody);
  const openapiBody = retainedBody(sources, 'openapi');
  if (openapiBody.length > 0) retainedBodies.set('openapi', openapiBody);
  mcpSessionId = mcpSessionIdFrom(sources.get('mcp-initialize'));
  mcpLanes = {
    modern: mcpModernLaneFrom(sources.get('mcp-server-discover')),
    legacyAdvertised: advertisedCapabilities(sources.get('mcp-initialize')?.evidence ?? []),
    modernAdvertised: advertisedCapabilities(sources.get('mcp-server-discover')?.evidence ?? []),
  };
  if (mcpSessionId && discovery.endpoint) {
    await notifyMcpInitialized(discovery.endpoint, mcpSessionId, {
      timeoutMs: Math.min(perCheckTimeoutMs, Math.max(1, deadline - now())),
      fetchOptions: input.fetchOptions,
    });
    if (deadline - now() <= 0) incomplete = true;
  }

  // Gate: declared-type filter first, then the antecedent token. Returns
  // the n_a/error result when the check must not be scored.
  const gate = (check: WebCheck): EngineResult | null => {
    if (!siteTypeApplies(check.site_types, actx)) {
      return naResult(check, 'antecedent-unmet', 'not applicable to the declared site type');
    }
    const resolution = resolveAntecedent(check.antecedent, actx);
    if (resolution === 'n_a') {
      return naResult(check, 'antecedent-unmet', antecedentUnmetEvidence(check.antecedent));
    }
    if (resolution === 'error') {
      return errorResult(check, 'antecedent unresolvable: root fetch failed');
    }
    return null;
  };

  // Finalize + yield wave-1 results through the same gate.
  for (const check of wave1Checks) {
    const gated = gate(check);
    const result = finalizeOptional(
      check,
      gated ?? wave1Results.get(check.id) ?? errorResult(check, 'missing wave-1 result'),
    );
    results.push(result);
    yield { type: 'result', result };
  }

  // Wave 2: gated checks resolve immediately; applicable ones probe with
  // the root fetch and wave-1 signals reused.
  const applicable: WebCheck[] = [];
  for (const check of wave2Checks) {
    const gated = gate(check);
    if (gated) {
      const result = finalizeOptional(check, gated);
      results.push(result);
      yield { type: 'result', result };
    } else {
      applicable.push(check);
    }
  }

  for await (const { check, result } of mapConcurrentUnordered(applicable, concurrency, probeOne)) {
    const finalized = finalizeOptional(check, result);
    results.push(finalized);
    yield { type: 'result', result: finalized };
  }

  const scorecard = buildWebScorecard(results, {
    targetUrl: base,
    domain,
    mcpEndpoint: discovery.endpoint,
    discoveryEvidence: discovery.evidence,
    specVersion: input.specVersion ?? '',
    siteType: input.siteType ?? null,
    publicListing: input.publicListing,
    registry: input.registry,
  });
  yield { type: 'complete', scorecard, complete: !incomplete };
}
