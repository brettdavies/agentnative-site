// Web-audit orchestrator (plan U5). Runs MCP endpoint discovery, then
// fans out every applicable check with bounded concurrency under a
// per-audit deadline and a per-check timeout, yielding each result as it
// resolves (KTD-6: streaming transport is the route's concern; the engine
// just yields via an async iterator). Emits a terminal `complete` event
// carrying the anc scorecard built from the collected results.
//
// mcp-present checks are gated to n_a when discovery finds no endpoint;
// a check that throws yields `error` and the run still completes.

import { discoverMcpEndpoint } from './discovery';
import { runCorsPreflight } from './handlers/cors-preflight';
import { runDnsDoh } from './handlers/dns-doh';
import { runHttp } from './handlers/http';
import { runMcp } from './handlers/mcp';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './handlers/types';
import type { WebAuditRegistry, WebCheck } from './registry';
import { buildWebScorecard, type EngineResult, type ScorecardStatus, type WebScorecard } from './scorecard';
import type { GuardedFetchOptions } from './ssrf';

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_PER_CHECK_TIMEOUT_MS = 8_000;
const DEFAULT_PER_AUDIT_DEADLINE_MS = 25_000;

export interface RunWebAuditInput {
  url: string;
  registry: WebAuditRegistry;
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
  };

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
    if (check.with && (check.with as { op?: string }).op === 'initialize') {
      const si = first.serverInfo as { name?: string } | null;
      return si?.name
        ? `serverInfo ${si.name}, protocol ${first.protocolVersion}`
        : 'no serverInfo in initialize result';
    }
    if ('tools' in first) {
      const tools = first.tools as unknown[] | null;
      return Array.isArray(tools)
        ? `${tools.length} tools, ${first.with_input_schema} with input schema`
        : 'no tools array';
    }
    if ('allow_origin' in first) return `allow-origin ${first.allow_origin ?? 'absent'}`;
    if ('error_code' in first) return `error code ${first.error_code}`;
  }

  if (check.handler === 'cors-preflight') {
    return `${first.status} allow-origin ${first.allow_origin ?? 'absent'}`;
  }

  if (check.handler === 'dns-doh') {
    const hit = outcome.evidence.find((e) => typeof e.answers === 'number' && (e.answers as number) > 0);
    if (hit) return `${hit.name}: ${hit.answers} record(s) via ${hit.resolver}`;
    return 'no DNS-AID records';
  }

  // http
  const evidenceItem = outcome.status === 'pass' ? (outcome.evidence.find((e) => e.ok) ?? first) : first;
  if (evidenceItem.error) return `${evidenceItem.url}: ${evidenceItem.error}`;
  const why = (evidenceItem.why as string[] | undefined)?.[
    ((evidenceItem.why as string[] | undefined)?.length ?? 1) - 1
  ];
  return `${evidenceItem.url ?? check.id} -> ${evidenceItem.status ?? 'error'}${outcome.status === 'fail' && why ? ` (${why})` : ''}`;
}

async function runCheck(check: WebCheck, ctx: HandlerContext): Promise<EngineResult> {
  const base: Omit<EngineResult, 'status' | 'evidence' | 'raw_evidence'> = {
    id: check.id,
    title: check.title,
    principle: check.principle,
    keyword: check.keyword,
    tier: check.tier,
    category: check.category,
    weight: check.weight,
  };

  if (check.antecedent === 'mcp-present' && !ctx.mcpEndpoint) {
    return {
      ...base,
      status: 'n_a',
      evidence: 'no MCP endpoint discovered',
      raw_evidence: [{ why: ['no MCP endpoint'] }],
    };
  }

  try {
    const handler = HANDLERS[check.handler];
    if (!handler) throw new Error(`no handler registered for "${check.handler}"`);
    const outcome = await handler(check, ctx);
    return {
      ...base,
      status: probeStatusToScorecard(outcome.status),
      evidence: summarizeEvidence(check, outcome),
      raw_evidence: outcome.evidence,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'error', evidence: `handler error: ${message}`, raw_evidence: [{ error: message }] };
  }
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
    timeoutMs: Math.min(perCheckTimeoutMs, Math.max(0, deadline - now())),
    fetchOptions: input.fetchOptions,
  });
  yield { type: 'discovery', endpoint: discovery.endpoint, evidence: discovery.evidence };

  let incomplete = false;
  const results: EngineResult[] = [];

  const runOne = async (check: WebCheck): Promise<EngineResult> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      incomplete = true;
      return {
        id: check.id,
        title: check.title,
        principle: check.principle,
        keyword: check.keyword,
        tier: check.tier,
        category: check.category,
        weight: check.weight,
        status: 'skip',
        evidence: 'skipped: per-audit deadline exceeded',
        raw_evidence: [{ why: ['per-audit deadline exceeded'] }],
      };
    }
    const ctx: HandlerContext = {
      base,
      host,
      mcpEndpoint: discovery.endpoint,
      protocolVersion: input.registry.mcp_discovery.protocol_version,
      defaultTimeoutMs: Math.min(perCheckTimeoutMs, remaining),
      fetchOptions: input.fetchOptions,
    };
    return runCheck(check, ctx);
  };

  for await (const result of mapConcurrentUnordered(input.registry.checks, concurrency, runOne)) {
    results.push(result);
    yield { type: 'result', result };
  }

  const scorecard = buildWebScorecard(results, {
    targetUrl: base,
    domain,
    mcpEndpoint: discovery.endpoint,
    discoveryEvidence: discovery.evidence,
    specVersion: input.specVersion ?? '',
  });
  yield { type: 'complete', scorecard, complete: !incomplete };
}
