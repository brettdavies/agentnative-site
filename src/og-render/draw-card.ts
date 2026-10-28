// The on-demand card: a crawler asked the site for a PNG that is not stored
// yet. A RenderJob already running for the card stores its PNG within a few
// seconds, so the draw waits up to 2 s for that PNG before drawing its own,
// and two draws of the same card do not race the job. A card drawn here is
// stored only when its logo lookup settled; a lookup cut short draws the
// tile, which must not be pinned under a key the clip draws with a logo.

import {
  type DrawnCard,
  type RenderInputs,
  type RenderJobState,
  type RenderJobStatus,
  templateOfKey,
} from '../shared/og-render';
import { isImmutableScoreOgKey, SCORE_OG_TEMPLATE } from '../shared/score-og';
import { readStoredCard } from '../worker/og/store';
import { loadScoreOgFonts } from './fonts';
import { drawStill, logRender, type RenderDeps, type RenderEnv } from './render-job';

/** How long a crawler's card waits on a running job's PNG before drawing its own. */
export const JOB_PNG_WAIT_MS = 2_000;

const RUNNING: ReadonlySet<RenderJobState> = new Set(['queued', 'rendering']);

/** The two RenderJob calls the on-demand card makes. */
export type JobStub = {
  status(): Promise<RenderJobStatus>;
  wait(deadline: number, until: 'png' | 'terminal'): Promise<RenderJobStatus>;
};

export async function drawCard(
  env: RenderEnv,
  inputs: RenderInputs,
  job: JobStub,
  deps: RenderDeps = {},
): Promise<DrawnCard> {
  const started = Date.now();
  const base = { key: inputs.key, lane: inputs.card.lane, started };
  const template = templateOfKey(inputs.key);
  if (template !== null && template !== SCORE_OG_TEMPLATE) {
    logRender({ ...base, outcome: 'card-skew' });
    return { outcome: 'skew' };
  }

  if (isImmutableScoreOgKey(inputs.key)) {
    const current = await job.status();
    const status =
      current.state !== 'none' && RUNNING.has(current.state)
        ? await job.wait(started + JOB_PNG_WAIT_MS, 'png')
        : current;
    const stored = await readStoredCard(env.SCORE_CACHE, inputs.target, inputs.key);
    if (stored) {
      const run = status.state === 'none' ? {} : { run: status.run, attempt: status.attempt };
      logRender({ ...base, ...run, outcome: 'card-job', logo: stored.logo ?? undefined });
      return { outcome: 'card', png: stored.png, card: 'stored', logo: stored.logo ?? 'tile', settled: true };
    }
  }

  const fonts = deps.fonts ?? (await loadScoreOgFonts());
  const { png, found } = await drawStill(env, inputs, fonts, { fetchImpl: deps.fetchImpl });
  logRender({ ...base, outcome: found.settled ? 'card-drawn' : 'card-unsettled', logo: found.source });
  return { outcome: 'card', png, card: 'drawn', logo: found.source, settled: found.settled };
}
