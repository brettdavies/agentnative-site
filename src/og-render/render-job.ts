/// <reference path="./bundled-modules.ts" />
// One card's render, as a RenderJob's alarm runs it: find the logo, draw and
// store the PNG, draw the clip's frames into a GIF, have the Media binding
// turn it into an MP4, and store that. The PNG is stored before any frame is
// drawn, so an on-demand request for the card can take it while the clip
// encodes, and a binding failure still leaves the card stored.
//
// The video binding has no local simulation, so a local run with
// LOCAL_MEDIA_STANDIN set stores the committed sample clip in its place and
// everything around the binding runs as deployed.

import {
  CLIP_FRESH_MS,
  type LogoSource,
  type OgRenderedMessage,
  type RenderInputs,
  templateOfKey,
} from '../shared/og-render';
import { isImmutableScoreOgKey, SCORE_OG_TEMPLATE, type ScoreOgCard } from '../shared/score-og';
import { SCORE_OG_MOTION, type ScoreOgMotion } from '../shared/score-og-motion';
import { headClip, storeCard, storeClip } from '../worker/og/store';
import { emitLog } from '../worker/telemetry/log';
import { type FoundLogo, findLogo } from './find-logo';
import standinClip from './fixtures/standin.mp4';
import { loadScoreOgFonts } from './fonts';
import { encodeClipGif, type YieldFrame } from './gif';
import type { LogoFetch } from './logo';
import { bundledBytes, renderScoreOgPng, type ScoreOgFonts } from './render';
import type { RenderJob } from './render-job-do';

/** Off the request path, a slow homepage gets longer than a crawler's on-demand card gives it. */
const RENDER_LOGO_BUDGET_MS = 8_000;

export type RenderEnv = {
  SCORE_CACHE: R2Bucket;
  MEDIA: MediaBinding;
  OG_RENDERED: Queue<OgRenderedMessage>;
  RENDER_JOB: DurableObjectNamespace<RenderJob>;
  /** context.dev key for the brand-logo fallback; unset skips that lookup. */
  CONTEXT_DEV_API_KEY?: string;
  LOCAL_MEDIA_STANDIN?: string;
};

export type RenderDeps = {
  fonts?: ScoreOgFonts;
  fetchImpl?: LogoFetch;
  motion?: ScoreOgMotion;
  yieldFrame?: YieldFrame;
};

export type RenderOutcome = { outcome: 'skew' } | { outcome: 'fresh' } | { outcome: 'rendered'; logo: LogoSource };

/** Thrown when the job's run was taken over, so a stale run stops before spending the encode. */
export class RunTakenOver extends Error {
  constructor() {
    super('render run taken over');
  }
}

export type DrawnStill = { card: ScoreOgCard; png: Uint8Array; found: FoundLogo };

/** Draw the still card with its logo, and store it when the logo lookup settled on a finished key. */
export async function drawStill(
  env: RenderEnv,
  inputs: RenderInputs,
  fonts: ScoreOgFonts,
  options: { budgetMs?: number; fetchImpl?: LogoFetch },
): Promise<DrawnStill> {
  const found: FoundLogo =
    inputs.pages.length === 0
      ? { logo: null, source: 'tile', settled: true }
      : await findLogo({
          pages: inputs.pages,
          fonts,
          bucket: env.SCORE_CACHE,
          brandApiKey: env.CONTEXT_DEV_API_KEY,
          fetchImpl: options.fetchImpl,
          budgetMs: options.budgetMs,
        });
  const card: ScoreOgCard = { ...inputs.card, logo: found.logo };
  const png = await renderScoreOgPng(card, fonts);
  if (found.settled && isImmutableScoreOgKey(inputs.key)) {
    await storeCard(env.SCORE_CACHE, inputs.target, inputs.key, png, {
      scoredAt: inputs.scoredAt,
      logo: found.source,
    });
  }
  return { card, png, found };
}

/** `onPng` marks the job; it returns false once the run has been taken over. */
export async function runRender(
  env: RenderEnv,
  inputs: RenderInputs,
  onPng: () => Promise<boolean>,
  deps: RenderDeps = {},
): Promise<RenderOutcome> {
  if (templateOfKey(inputs.key) !== SCORE_OG_TEMPLATE) return { outcome: 'skew' };
  const existing = await headClip(env.SCORE_CACHE, inputs.target, inputs.key);
  if (existing && Date.now() - existing.uploaded.getTime() < CLIP_FRESH_MS) return { outcome: 'fresh' };

  const fonts = deps.fonts ?? (await loadScoreOgFonts());
  const still = await drawStill(env, inputs, fonts, { budgetMs: RENDER_LOGO_BUDGET_MS, fetchImpl: deps.fetchImpl });
  if (!(await onPng())) throw new RunTakenOver();

  const gif = await encodeClipGif(still.card, fonts, deps.motion ?? SCORE_OG_MOTION, deps.yieldFrame);
  const mp4 = env.LOCAL_MEDIA_STANDIN === 'true' ? await bundledBytes(standinClip) : await toMp4(env.MEDIA, gif);
  await storeClip(env.SCORE_CACHE, inputs.target, inputs.key, mp4, {
    scoredAt: inputs.scoredAt,
    logo: still.found.source,
  });
  return { outcome: 'rendered', logo: still.found.source };
}

/** Without an explicit size the binding returns 686x360. */
async function toMp4(media: MediaBinding, gif: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(gif);
      controller.close();
    },
  });
  const result = media.input(input).transform({ width: 1200, height: 630 }).output({ mode: 'video', audio: false });
  const response = await result.response();
  if (!response.ok) throw new Error(`media binding answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export type RenderLogFields = {
  outcome: string;
  key: string;
  lane: string;
  started: number;
  run?: string;
  attempt?: number;
  logo?: LogoSource;
  err?: unknown;
};

/** One og.render record. It names the card key, never the target, so no host name reaches the log. */
export function logRender(fields: RenderLogFields): void {
  const { err, started, ...rest } = fields;
  const code = (err as { code?: unknown } | undefined)?.code;
  emitLog(
    { scope: 'og.render' },
    {
      ...rest,
      duration_ms: Date.now() - started,
      binding_error: typeof code === 'number' ? code : undefined,
      error: err instanceof Error ? err.message : undefined,
    },
    { level: err ? 'error' : 'log' },
  );
}
