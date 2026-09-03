// Rescore triggers: the weekly cron and the post-deploy authed hook both
// start the web-rescore Workflow through the same single-flight helper,
// so overlapping triggers coalesce onto the in-flight batch instead of
// double-spending the audit budget. The "current instance" pointer lives
// in KV; the authoritative liveness check is the Workflow instance status
// (a stale pointer to a finished batch never blocks a new start).

import { emitLog } from '../telemetry/log';
import { runWithHitMinPurge } from './hit-min-purge';
import { runWebPublicListingBackfill, type WebBackfillEnv } from './public-listing-backfill';
import type { WebRescoreWorkflowBinding } from './rescore-workflow';

export interface WebRescoreTriggerEnv {
  SCORE_KV?: KVNamespace;
  WEB_RESCORE_WORKFLOW: WebRescoreWorkflowBinding;
  WEB_RESCORE_SECRET?: string;
}

export type WebBackfillTriggerEnv = WebBackfillEnv & { WEB_RESCORE_SECRET?: string };

const CURRENT_INSTANCE_KEY = 'web_rescore:current';

// A batch is in flight in any of these states; everything else (complete,
// errored, terminated, unknown) admits a fresh start.
const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function startWebRescore(env: WebRescoreTriggerEnv): Promise<{ instanceId: string; coalesced: boolean }> {
  const pointer = env.SCORE_KV ? await env.SCORE_KV.get(CURRENT_INSTANCE_KEY).catch(() => null) : null;
  if (pointer) {
    try {
      const existing = await env.WEB_RESCORE_WORKFLOW.get(pointer);
      const { status } = await existing.status();
      if (ACTIVE_STATUSES.has(status)) {
        emitLog({ scope: 'web-rescore.trigger' }, { coalesced: true, instance: pointer });
        return { instanceId: pointer, coalesced: true };
      }
    } catch {
      // Unknown or expired instance: fall through to a fresh start.
    }
  }
  const instanceId = `rescore-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.WEB_RESCORE_WORKFLOW.create({ id: instanceId });
  if (env.SCORE_KV) {
    await env.SCORE_KV.put(CURRENT_INSTANCE_KEY, instanceId, { expirationTtl: 6 * 3600 }).catch(() => {});
  }
  emitLog({ scope: 'web-rescore.trigger' }, { coalesced: false, instance: instanceId });
  return { instanceId, coalesced: false };
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

// Compare via fixed-length digests so the comparison cost is independent
// of where the presented secret diverges (no timing oracle on the secret).
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(presented), sha256Bytes(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Shared gate for the secret-authed rescore endpoints: POST-only, a
 * fail-fast 500 when the Worker-side secret is unset (a silent 401 would
 * hide the misconfiguration from the deploy pass), and a constant-time
 * secret compare. Resolves the rejection response, or null when the
 * request is authorized.
 */
async function requireRescoreAuth(request: Request, secret: string | undefined): Promise<Response | null> {
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'POST', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (!secret) {
    return jsonResponse({ error: 'service_misconfigured', message: 'WEB_RESCORE_SECRET missing' }, 500);
  }
  const presented = request.headers.get('x-web-rescore-secret');
  if (!presented || !(await secretsMatch(presented, secret))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  return null;
}

/** POST /api/web-rescore — the deploy hook, behind the shared-secret gate. */
export async function handleWebRescore(request: Request, env: WebRescoreTriggerEnv): Promise<Response> {
  const denied = await requireRescoreAuth(request, env.WEB_RESCORE_SECRET);
  if (denied) return denied;
  const { instanceId, coalesced } = await startWebRescore(env);
  return jsonResponse({ started: !coalesced, coalesced, instance_id: instanceId }, 202);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * POST /api/web-audit-backfill — the one-time `public_listing` backfill,
 * behind the same `WEB_RESCORE_SECRET` constant-time gate as the rescore
 * hook. Body (all optional): `dry_run` (report only), `cursor` (resume a
 * prior run), `max_writes` (per-run object cap, both modes). Returns the
 * run's written/skipped/failed tally plus the resume cursor. Completion
 * differs by mode: a real run re-runs from the start until it reports zero
 * writes; a dry run writes nothing, so it is cursored forward until `done`.
 * A seed-load failure aborts the batch and
 * surfaces as a 500 rather than a partial success that could stamp curated
 * domains false.
 */
export async function handleWebBackfill(
  request: Request,
  env: WebBackfillTriggerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireRescoreAuth(request, env.WEB_RESCORE_SECRET);
  if (denied) return denied;

  const body: Record<string, unknown> = await request
    .json()
    .then((v) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}))
    .catch(() => ({}));

  try {
    const result = await runWithHitMinPurge(ctx, () =>
      runWebPublicListingBackfill(env, {
        dryRun: body.dry_run === true,
        cursor: optionalString(body.cursor),
        maxWrites: optionalPositiveInt(body.max_writes),
      }),
    );
    return jsonResponse(result, 200);
  } catch (err) {
    emitLog({ scope: 'web-backfill.trigger' }, { error: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ error: 'backfill_aborted', message: 'seed load failed; no objects written' }, 500);
  }
}
