// The contract between the site Worker and the render Worker (anc-og-render).
// The site asks for renders and on-demand cards over its RENDER service
// binding and consumes og-rendered; the render Worker draws, looks up logos,
// encodes clips, and runs one RenderJob per card. Both Workers import this
// module, so neither imports the other's code.

import type { ScoreOgCard, ScoreOgLane } from './score-og';

/** Where a card's logo came from, as the `x-anc-card-logo` response header names it. */
export const LOGO_SOURCES = ['homepage', 'brand', 'stored', 'tile'] as const;

export type LogoSource = (typeof LOGO_SOURCES)[number];

/** Everything a render needs, built by the site from the scorecard it serves; the render Worker reads no site record. */
export type RenderInputs = {
  /** Canonical result target. */
  target: string;
  key: string;
  card: Omit<ScoreOgCard, 'logo'>;
  /** HTTPS pages the logo may come from; empty draws the tile. */
  pages: string[];
  scoredAt: string | null;
};

/** `png` means the job has stored its card and is encoding the clip. */
export type RenderJobState = 'queued' | 'rendering' | 'png' | 'done' | 'failed';

export type RenderJobStatus = { state: 'none' } | { state: RenderJobState; run: string; attempt: number };

/**
 * An on-demand card. `settled` is false when the logo lookup was cut short, so the tile it drew is not the host's
 * answer and the card must not be cached for long. `skew` means the two Workers draw different template versions.
 */
export type DrawnCard =
  | { outcome: 'card'; png: Uint8Array; card: 'drawn' | 'stored'; logo: LogoSource; settled: boolean }
  | { outcome: 'skew' };

/** Sent when a clip is stored, so the site can purge the page that should now name it. */
export type OgRenderedMessage = { target: string; lane: ScoreOgLane; key: string };

/** The render Worker's RPC surface, as the site's service binding calls it. */
export interface RenderService {
  request(inputs: RenderInputs): Promise<RenderJobStatus>;
  requestMany(inputs: RenderInputs[]): Promise<RenderJobStatus[]>;
  status(target: string, key: string): Promise<RenderJobStatus>;
  drawCard(inputs: RenderInputs): Promise<DrawnCard>;
}

/** A clip uploaded longer ago than this is rendered again, ahead of the 30-day lifecycle rule. */
export const CLIP_FRESH_MS = 21 * 24 * 60 * 60 * 1000;

/** What a `RenderJob.wait` caller waits for: the stored PNG, or a terminal state. */
export type RenderJobWaitUntil = 'png' | 'terminal';
