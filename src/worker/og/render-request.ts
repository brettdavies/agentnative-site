// The site's side of a render request. The site holds the records, the
// registry and ASSETS, so it builds each card's inputs here and the render
// Worker reads no site record. A render is asked for only when the switch is
// on and the card is finished: pending and unscored cards have no clip.

import type { RenderInputs, RenderService } from '../../shared/og-render';
import { isImmutableScoreOgKey, scoreOgKey } from '../../shared/score-og';
import { emitLog } from '../telemetry/log';
import { loadScoreOgSubject, type ScoreOgEnv, type ScoreOgSubject } from './subject';

export type OgVideoEnv = ScoreOgEnv & { RENDER?: RenderService; OG_VIDEO_ENABLED?: string };

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

/** `call`, or a rejection once `ms` pass first. */
export function withinMs<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`render Worker took longer than ${ms} ms`)), ms);
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

/** Ask for one target's clip. Never throws: a render request must not fail the audit that made it. */
export async function requestRender(env: OgVideoEnv, target: string): Promise<void> {
  if (!ogVideoEnabled(env) || !env.RENDER) return;
  try {
    const inputs = await readyRenderInputs(env, target);
    if (inputs) await env.RENDER.request(inputs);
  } catch (err) {
    emitLog(
      { scope: 'score.og' },
      { outcome: 'render-request-error', error: err instanceof Error ? err.message : String(err) },
      { level: 'error' },
    );
  }
}
