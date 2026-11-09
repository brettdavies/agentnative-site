// The curated pass: every curated CLI card and every seeded website card
// whose clip is missing or older than 21 days is asked for in one batch.
// Live audits ask for their own clips as they finish; curated cards change
// on a deploy (a template bump, a registry update) or age toward the 30-day
// lifecycle rule without any audit to ask for them. The pass runs after
// each deploy and on the weekly cron, apart from the rescore Workflow,
// because a deploy that joins a running rescore would skip the new
// deploy's keys. The render Worker spaces the batch's renders 400 ms apart.

import { hasScorecard } from '../../shared/audit-envelope';
import { CLIP_FRESH_MS, type RenderInputs } from '../../shared/og-render';
import { requireRescoreAuth } from '../audit-web/rescore-trigger';
import { loadWebSeed } from '../audit-web/seed';
import { loadRegistryIndex } from '../score/registry-lookup';
import { emitLog } from '../telemetry/log';
import { type OgVideoEnv, ogVideoEnabled, readyRenderInputs } from './render-request';
import { headClip } from './store';

/** Targets read at once; each costs a record read and a clip head. */
const CONCURRENCY = 8;

export type CuratedPassResult = { enabled: boolean; requested: number; fresh: number; skipped: number };

export async function runCuratedPass(env: OgVideoEnv): Promise<CuratedPassResult> {
  const result: CuratedPassResult = { enabled: ogVideoEnabled(env), requested: 0, fresh: 0, skipped: 0 };
  if (!result.enabled || !env.RENDER) return { ...result, enabled: false };
  const [registry, seed] = await Promise.all([loadRegistryIndex(env), loadWebSeed(env)]);
  const targets = [
    ...Object.entries(registry.by_slug)
      .filter(([, entry]) => hasScorecard(entry))
      .map(([slug]) => slug),
    ...seed.map((entry) => entry.domain),
  ];
  const now = Date.now();
  const stale: RenderInputs[] = [];
  for (let at = 0; at < targets.length; at += CONCURRENCY) {
    await Promise.all(
      targets.slice(at, at + CONCURRENCY).map(async (target) => {
        const inputs = await staleInputs(env, target, now).catch((err: unknown) => {
          emitLog({ scope: 'score.og' }, { outcome: 'curated-pass-error', error: String(err) }, { level: 'error' });
          return 'skipped' as const;
        });
        if (inputs === 'skipped') result.skipped += 1;
        else if (inputs === 'fresh') result.fresh += 1;
        else stale.push(inputs);
      }),
    );
  }
  if (stale.length > 0) await env.RENDER.requestMany(stale);
  result.requested = stale.length;
  emitLog({ scope: 'score.og' }, { outcome: 'curated-pass', ...result });
  return result;
}

/** The card's inputs when its clip is missing or older than the fresh window. */
async function staleInputs(env: OgVideoEnv, target: string, now: number): Promise<RenderInputs | 'fresh' | 'skipped'> {
  const inputs = await readyRenderInputs(env, target);
  if (!inputs) return 'skipped';
  const clip = await headClip(env.SCORE_CACHE, inputs.target, inputs.key);
  return clip && now - clip.uploaded.getTime() < CLIP_FRESH_MS ? 'fresh' : inputs;
}

/** POST /api/og-curated-pass: the deploy hook, behind the rescore hook's shared-secret gate. */
export async function handleCuratedPass(
  request: Request,
  env: OgVideoEnv & { WEB_RESCORE_SECRET?: string },
): Promise<Response> {
  const denied = await requireRescoreAuth(request, env.WEB_RESCORE_SECRET);
  if (denied) return denied;
  return new Response(JSON.stringify(await runCuratedPass(env)), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
