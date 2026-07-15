// Rescore triggers: the weekly cron and the post-deploy authed hook both
// start the web-rescore Workflow through the same single-flight helper,
// so overlapping triggers coalesce onto the in-flight batch instead of
// double-spending the audit budget. The "current instance" pointer lives
// in KV; the authoritative liveness check is the Workflow instance status
// (a stale pointer to a finished batch never blocks a new start).

import type { WebRescoreWorkflowBinding } from './rescore-workflow';

export interface WebRescoreTriggerEnv {
  SCORE_KV?: KVNamespace;
  WEB_RESCORE_WORKFLOW: WebRescoreWorkflowBinding;
  WEB_RESCORE_SECRET?: string;
}

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
        console.log(JSON.stringify({ scope: 'web-rescore.trigger', coalesced: true, instance: pointer }));
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
  console.log(JSON.stringify({ scope: 'web-rescore.trigger', coalesced: false, instance: instanceId }));
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
 * POST /api/web-rescore — the deploy hook. Authed by a shared secret
 * header; a missing Worker-side secret is a fail-fast 500 (a silent 401
 * would hide the misconfiguration from the deploy pass).
 */
export async function handleWebRescore(request: Request, env: WebRescoreTriggerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'POST', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (!env.WEB_RESCORE_SECRET) {
    return jsonResponse({ error: 'service_misconfigured', message: 'WEB_RESCORE_SECRET missing' }, 500);
  }
  const presented = request.headers.get('x-web-rescore-secret');
  if (!presented || !(await secretsMatch(presented, env.WEB_RESCORE_SECRET))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const { instanceId, coalesced } = await startWebRescore(env);
  return jsonResponse({ started: !coalesced, coalesced, instance_id: instanceId }, 202);
}
