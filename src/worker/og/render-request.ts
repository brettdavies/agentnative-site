// The site's side of a render request. The site holds the records, the
// registry and ASSETS, so it builds each card's inputs here and the render
// Worker reads no site record. A render is asked for only when the switch is
// on and the card is finished: pending and unscored cards have no clip.

import type { RenderInputs, RenderService } from '../../shared/og-render';
import { isImmutableScoreOgKey, scoreOgKey } from '../../shared/score-og';
import { withinMs } from '../../shared/within-ms';
import { emitLog } from '../telemetry/log';
import { loadScoreOgSubject, type ScoreOgEnv, type ScoreOgSubject } from './subject';

export type OgVideoEnv = ScoreOgEnv & { RENDER?: RenderService; OG_VIDEO_ENABLED?: string };

/** The same ceiling the CLI write gives its page purge. */
const REQUEST_BUDGET_MS = 5_000;

export function ogVideoEnabled(env: { OG_VIDEO_ENABLED?: string }): boolean {
  return env.OG_VIDEO_ENABLED === 'true';
}

export function renderInputsOf(subject: Extract<ScoreOgSubject, { status: 'ready' }>): RenderInputs {
  const { logo: _logo, ...card } = subject.card;
  return {
    target: subject.target,
    key: scoreOgKey(subject.card),
    card,
    pages: subject.pages,
    scoredAt: subject.scoredAt,
  };
}

/** A finished card's inputs; null for a missing, unreadable, pending or unscored one, which has no clip. */
export async function readyRenderInputs(env: ScoreOgEnv, target: string): Promise<RenderInputs | null> {
  const subject = await loadScoreOgSubject(env, target);
  if (subject.status !== 'ready') return null;
  const inputs = renderInputsOf(subject);
  return isImmutableScoreOgKey(inputs.key) ? inputs : null;
}

/**
 * Ask for one target's clip. Never throws, and gives up after the bound: callers await it ahead of an audit's result
 * or response, which a slow render Worker must not hold.
 */
export async function requestRender(env: OgVideoEnv, target: string): Promise<void> {
  const render = env.RENDER;
  if (!ogVideoEnabled(env) || !render) return;
  const ask = async () => {
    const inputs = await readyRenderInputs(env, target);
    if (inputs) await render.request(inputs);
  };
  try {
    await withinMs(ask(), REQUEST_BUDGET_MS, `render request took longer than ${REQUEST_BUDGET_MS} ms`);
  } catch (err) {
    emitLog(
      { scope: 'score.og' },
      { outcome: 'render-request-error', error: err instanceof Error ? err.message : String(err) },
      { level: 'error' },
    );
  }
}
