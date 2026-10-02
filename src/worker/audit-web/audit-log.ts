// Structured logging for the web-audit engine's consumers, through the
// central emitter so every record carries a `scope` field the cache/purge
// logging convention across the Worker shares.
//
// Two verbosity tiers:
//   - always: one `web-audit.run` summary per audit plus `web-audit.error`
//     on an engine failure, cheap enough for production volume. A run that
//     completes also records what its follow slice spent: outcome counts
//     from the declared-hosts trail, the request count, the elapsed time,
//     the requests per declared domain under that domain's hash, the same
//     hash its budget's KV key carries, and the reservations a budget layer
//     error decided, so an outage reads apart from a spent hour.
//   - WEB_AUDIT_DEBUG === 'true': additionally one `web-audit.check` line
//     per check result and a `web-audit.discovery` line with the full probe
//     evidence, both on the emitter's debug tier. Bound in env.staging.vars
//     only; production opts in transiently via `wrangler deploy --var` when
//     an incident needs it.

import { emitLog } from '../telemetry/log';
import { sha256Hex } from './cache';
import type { AuditEvent } from './engine';
import type { FollowStats } from './follow';
import type { DeclaredHostEntry } from './provenance';

export interface AuditLogEnv {
  WEB_AUDIT_DEBUG?: string;
}

export function auditDebugEnabled(env: AuditLogEnv): boolean {
  return env.WEB_AUDIT_DEBUG === 'true';
}

/** How many trail entries carry each value of `field`. */
function tally(trail: readonly DeclaredHostEntry[], field: 'outcome' | 'cause'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of trail) {
    const value = entry[field];
    if (typeof value === 'string') counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** The run record's follow fields. */
async function followFields(trail: readonly DeclaredHostEntry[], stats: FollowStats): Promise<Record<string, unknown>> {
  const domainRequests: Record<string, number> = {};
  for (const [domain, requests] of Object.entries(stats.domainRequests)) {
    domainRequests[await sha256Hex(domain)] = requests;
  }
  return {
    follow_outcomes: tally(trail, 'outcome'),
    follow_budget_causes: tally(trail, 'cause'),
    follow_requests: stats.requests,
    follow_elapsed_ms: stats.elapsedMs,
    follow_domain_requests: domainRequests,
    follow_budget_errors: stats.budgetErrors,
  };
}

/**
 * Pass-through wrapper over the engine's event stream that emits the
 * per-audit summary (and per-event debug lines) as events flow, so the
 * streaming route and the MCP tool instrument one way instead of two.
 * Consumers iterate this exactly like the raw engine generator.
 */
export async function* instrumentAuditEvents(
  events: AsyncGenerator<AuditEvent>,
  env: AuditLogEnv,
  opts: { target: string; surface: 'stream' | 'mcp' | 'rescore'; followDeclarations: boolean },
): AsyncGenerator<AuditEvent> {
  const debug = auditDebugEnabled(env);
  const started = Date.now();
  const statusCounts: Record<string, number> = {};
  let terminal = 'none';
  let endpoint: string | null = null;
  let follow: Record<string, unknown> = {};
  try {
    for await (const event of events) {
      if (event.type === 'discovery') {
        endpoint = event.endpoint;
        emitLog(
          { scope: 'web-audit.discovery' },
          { target: opts.target, endpoint, evidence: event.evidence },
          { tier: 'debug', debug },
        );
      } else if (event.type === 'result') {
        statusCounts[event.result.status] = (statusCounts[event.result.status] ?? 0) + 1;
        emitLog(
          { scope: 'web-audit.check' },
          { target: opts.target, id: event.result.id, status: event.result.status, evidence: event.result.evidence },
          { tier: 'debug', debug },
        );
      } else if (event.type === 'complete') {
        terminal = event.complete ? 'complete' : 'incomplete';
        follow = await followFields(event.scorecard.declared_hosts ?? [], event.follow);
      } else if (event.type === 'unreachable') {
        terminal = 'unreachable';
      }
      yield event;
    }
  } finally {
    emitLog(
      { scope: 'web-audit.run' },
      {
        target: opts.target,
        surface: opts.surface,
        follow_declarations: opts.followDeclarations,
        terminal,
        mcp_endpoint: endpoint,
        elapsed_ms: Date.now() - started,
        checks: statusCounts,
        ...follow,
      },
    );
  }
}

/** One `web-audit.error` line for an engine/stream failure; always on. */
export function logAuditError(target: string, surface: string, err: unknown): void {
  emitLog(
    { scope: 'web-audit.error' },
    { target, surface, message: err instanceof Error ? err.message : String(err) },
    { level: 'error' },
  );
}
