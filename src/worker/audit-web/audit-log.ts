// Structured logging for the web-audit engine's consumers. Workers Logs
// (observability.enabled, 100% head sampling) indexes one JSON object per
// console call, so every line carries a `scope` field for querying, matching
// the cache/purge logging convention used across the Worker.
//
// Two verbosity tiers:
//   - always: one `web-audit.run` summary per audit plus `web-audit.error`
//     on an engine failure, cheap enough for production volume.
//   - WEB_AUDIT_DEBUG === 'true': additionally one `web-audit.check` line
//     per check result and a `web-audit.discovery` line with the full probe
//     evidence. Bound in env.staging.vars only; production opts in
//     transiently via `wrangler deploy --var` when an incident needs it.

import { emitLog } from '../telemetry/log';
import type { AuditEvent } from './engine';

export interface AuditLogEnv {
  WEB_AUDIT_DEBUG?: string;
}

export function auditDebugEnabled(env: AuditLogEnv): boolean {
  return env.WEB_AUDIT_DEBUG === 'true';
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
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
  opts: { target: string; surface: 'stream' | 'mcp' | 'rescore' },
): AsyncGenerator<AuditEvent> {
  const debug = auditDebugEnabled(env);
  const started = Date.now();
  const statusCounts: Record<string, number> = {};
  let terminal = 'none';
  let endpoint: string | null = null;
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
        if (debug) {
          log({
            scope: 'web-audit.check',
            target: opts.target,
            id: event.result.id,
            status: event.result.status,
            evidence: event.result.evidence,
          });
        }
      } else if (event.type === 'complete') {
        terminal = event.complete ? 'complete' : 'incomplete';
      } else if (event.type === 'unreachable') {
        terminal = 'unreachable';
      }
      yield event;
    }
  } finally {
    log({
      scope: 'web-audit.run',
      target: opts.target,
      surface: opts.surface,
      terminal,
      mcp_endpoint: endpoint,
      elapsed_ms: Date.now() - started,
      checks: statusCounts,
    });
  }
}

/** One `web-audit.error` line for an engine/stream failure; always on. */
export function logAuditError(target: string, surface: string, err: unknown): void {
  console.error(
    JSON.stringify({
      scope: 'web-audit.error',
      target,
      surface,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}
