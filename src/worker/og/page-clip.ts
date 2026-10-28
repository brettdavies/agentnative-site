// What a scorecard page says about its clip. The page names the clip in
// og:video only when the clip for its current card exists, checked with one
// R2 head per page render; the page cache bounds how often that runs. R2
// trouble omits the block and never fails the page.
//
// `x-anc-clip` tells an operator why a page names no clip: `present`, the
// switch is `off`, the RenderJob's state (`queued`, `rendering`, `failed`),
// or `none` when no job answers. The job is asked only when the clip is
// absent, within 250 ms, because a Durable Object answers from one location
// and a page served far from it pays the round trip. A live or failed job
// also sends its run id as `x-anc-clip-run`, the id its og.render log records
// carry.

import { escHtml } from '../../shared/esc-html';
import type { RenderJobState } from '../../shared/og-render';
import {
  isImmutableScoreOgKey,
  parseScoreOgPath,
  SCORE_OG_HEIGHT,
  SCORE_OG_WIDTH,
  scoreOgClipUrl,
} from '../../shared/score-og';
import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { type OgVideoEnv, ogVideoEnabled, withinMs } from './render-request';
import { headClip } from './store';

const STATUS_BUDGET_MS = 250;

type ClipHeader = 'present' | 'off' | 'none' | 'queued' | 'rendering' | 'failed';

export type PageClip = { metaHtml: string; headers: Record<string, string> };

const JOB_HEADER: Record<RenderJobState, ClipHeader> = {
  queued: 'queued',
  rendering: 'rendering',
  png: 'rendering',
  failed: 'failed',
  done: 'none',
};

export async function pageClip(env: OgVideoEnv, target: string, key: string): Promise<PageClip> {
  if (!isImmutableScoreOgKey(key)) return { metaHtml: '', headers: { 'x-anc-clip': 'none' } };
  const clip = await headClip(env.SCORE_CACHE, target, key).catch(() => null);
  if (clip) {
    return {
      metaHtml: ogVideoMeta(scoreOgClipUrl(CANONICAL_SITE_URL, target, key)),
      headers: { 'x-anc-clip': 'present' },
    };
  }
  if (!ogVideoEnabled(env)) return { metaHtml: '', headers: { 'x-anc-clip': 'off' } };
  const status = await jobStatus(env, target, key);
  if (!status || status.state === 'none') return { metaHtml: '', headers: { 'x-anc-clip': 'none' } };
  const header = JOB_HEADER[status.state];
  const headers: Record<string, string> = { 'x-anc-clip': header };
  if (header !== 'none') headers['x-anc-clip-run'] = status.run;
  return { metaHtml: '', headers };
}

function jobStatus(env: OgVideoEnv, target: string, key: string) {
  if (!env.RENDER) return Promise.resolve(null);
  return withinMs(env.RENDER.status(target, key), STATUS_BUDGET_MS).catch(() => null);
}

function ogVideoMeta(url: string): string {
  const href = escHtml(url);
  return [
    `<meta property="og:video" content="${href}" />`,
    `<meta property="og:video:secure_url" content="${href}" />`,
    '<meta property="og:video:type" content="video/mp4" />',
    `<meta property="og:video:width" content="${SCORE_OG_WIDTH}" />`,
    `<meta property="og:video:height" content="${SCORE_OG_HEIGHT}" />`,
  ].join('\n    ');
}

/** A built curated page carries its card URL in og:image; the clip shares its target and key. */
export function curatedCardOf(html: string): { target: string; key: string } | null {
  const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
  if (!image) return null;
  try {
    return parseScoreOgPath(new URL(image).pathname);
  } catch {
    return null;
  }
}

/** Insert the og:video tags into a built page's head. */
export function withOgVideo(html: string, metaHtml: string): string {
  if (!metaHtml) return html;
  const at = html.indexOf('</head>');
  return at === -1 ? html : `${html.slice(0, at)}    ${metaHtml}\n${html.slice(at)}`;
}
