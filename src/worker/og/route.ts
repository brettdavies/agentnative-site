// GET /og/score/<target>/<key>.png
//
// The key names everything the card shows (`s80-v0.6.0-d20261026-r1`; the
// grammar is in src/shared/score-og.ts), or `pending` / `unscored`. A request
// whose key is not the score stored for that target 301s to the key that is,
// so a guessed percent cannot be minted into a card. Finished keys are cached
// immutably: a rescore changes the URL the page advertises, and the previous
// object can stay at the edge. Pending and unscored stay on the short cache,
// because the next run replaces them at the same URL.
//
// A finished card the render Worker has stored in R2 is read from there.
// Anything else is drawn by the render Worker over the RENDER binding; this
// Worker draws nothing. When that call fails or runs out its time, the route
// serves the site's default card on the short cache, so a link preview keeps
// an image and the real card takes over once drawing works again.

import { SITE_OG_IMAGE_PATH } from '../../shared/og-card';
import type { DrawnCard, LogoSource, RenderInputs } from '../../shared/og-render';
import {
  isImmutableScoreOgKey,
  isScoreOgKey,
  isScoreOgPath,
  parseScoreOgPath,
  scoreOgKey,
  scoreOgPath,
} from '../../shared/score-og';
import { applyHeaders, type CacheClassSpec } from '../headers';
import { emitLog } from '../telemetry/log';
import { type OgVideoEnv, renderInputsOf } from './render-request';
import { readStoredCard } from './store';
import { loadScoreOgSubject } from './subject';

export type ScoreOgDeps = {
  /** How long the render Worker gets to draw before the default card is served. */
  timeoutMs?: number;
};

/** A cold render Worker draws in a few seconds; Discord gives a whole preview about 10. */
const DRAW_TIMEOUT_MS = 8_000;

const REDIRECT_CACHE: CacheClassSpec = { klass: 'hit-min' };

type CardHeader = 'drawn' | 'stored' | 'fallback';

/** Serve one scorecard card, or redirect to the key the stored score names. */
export async function handleScoreOg(request: Request, env: OgVideoEnv, deps: ScoreOgDeps = {}): Promise<Response> {
  const started = Date.now();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  if (!isScoreOgPath(url.pathname)) return text(request, 404, 'not found\n');
  const parsed = parseScoreOgPath(url.pathname);
  if (!parsed || !isScoreOgKey(parsed.key)) return text(request, 404, 'not found\n');

  let subject: Awaited<ReturnType<typeof loadScoreOgSubject>>;
  try {
    subject = await loadScoreOgSubject(env, parsed.target);
  } catch (err) {
    log('error', started, err);
    return text(request, 500, 'scorecard image failed\n');
  }
  if (subject.status === 'unavailable') {
    log('unavailable', started);
    return text(request, 503, 'the scorecard could not be read right now\n', { 'retry-after': '30' });
  }
  if (subject.status === 'missing') {
    log('missing', started);
    return text(request, 404, 'not found\n');
  }

  const key = scoreOgKey(subject.card);
  let canonical: string;
  try {
    canonical = scoreOgPath(subject.target, key);
  } catch (err) {
    log('error', started, err);
    return text(request, 500, 'scorecard image failed\n');
  }
  const lane = subject.card.lane;
  if (canonical !== url.pathname || url.search !== '') {
    log('redirect', started, undefined, lane);
    return applyHeaders(new Response(null, { status: 301, headers: { Location: canonical } }), {
      request,
      pathname: url.pathname,
      servedMarkdown: false,
      cache: REDIRECT_CACHE,
    });
  }

  const immutable = isImmutableScoreOgKey(key);
  if (immutable) {
    const stored = await readStoredCard(env.SCORE_CACHE, subject.target, key).catch(() => null);
    if (stored) {
      log('stored', started, undefined, lane, stored.logo ?? undefined);
      return pngResponse(request, url.pathname, stored.png, true, cardDiagnostics('stored', stored.logo));
    }
  }

  let drawn: DrawnCard;
  try {
    drawn = await drawRemote(env, renderInputsOf(subject), deps.timeoutMs ?? DRAW_TIMEOUT_MS);
  } catch (err) {
    log('fallback', started, err, lane);
    return defaultCard(request, url.pathname, env);
  }
  if (drawn.outcome === 'skew') {
    log('skew', started, undefined, lane);
    return text(request, 503, 'the scorecard image could not be drawn right now\n', { 'retry-after': '30' });
  }
  log(drawn.settled ? 'ok' : 'logo-unsettled', started, undefined, lane, drawn.logo);
  return pngResponse(
    request,
    url.pathname,
    drawn.png,
    immutable && drawn.settled,
    cardDiagnostics(drawn.card, drawn.logo),
  );
}

function drawRemote(env: OgVideoEnv, inputs: RenderInputs, ms: number): Promise<DrawnCard> {
  if (!env.RENDER) return Promise.reject(new Error('RENDER binding missing'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`render Worker took longer than ${ms} ms`)), ms);
  });
  return Promise.race([env.RENDER.drawCard(inputs), timeout]).finally(() => clearTimeout(timer));
}

async function defaultCard(request: Request, pathname: string, env: OgVideoEnv): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(`https://assets.internal${SITE_OG_IMAGE_PATH}`));
  if (!asset.ok) return text(request, 500, 'scorecard image failed\n');
  return pngResponse(request, pathname, new Uint8Array(await asset.arrayBuffer()), false, { 'x-anc-card': 'fallback' });
}

/**
 * `x-anc-card` says whether this response drew the card, read it from R2, or fell back to the site's default card,
 * and `x-anc-card-logo` which source the card's logo came from, read from the stored card's metadata on the stored
 * path, so a live smoke can tell the paths apart. An edge hit replays the headers of the response it cached.
 */
function cardDiagnostics(card: CardHeader, logo: LogoSource | null): Record<string, string> {
  return logo ? { 'x-anc-card': card, 'x-anc-card-logo': logo } : { 'x-anc-card': card };
}

function pngResponse(
  request: Request,
  pathname: string,
  png: Uint8Array,
  immutable: boolean,
  diagnostics: Record<string, string>,
): Response {
  const body = new ArrayBuffer(png.byteLength);
  new Uint8Array(body).set(png);
  const headers = new Headers({
    'content-type': 'image/png',
    'content-length': String(png.byteLength),
    'x-robots-tag': 'noindex',
    ...diagnostics,
  });
  return applyHeaders(new Response(body, { status: 200, headers }), {
    request,
    pathname,
    servedMarkdown: false,
    cache: { klass: immutable ? 'immutable' : 'hit-min' },
  });
}

function text(request: Request, status: number, body: string, extra?: Record<string, string>): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex', ...extra });
  return applyHeaders(new Response(body, { status, headers }), {
    request,
    pathname: new URL(request.url).pathname,
    servedMarkdown: false,
    cache: { klass: 'miss' },
  });
}

function log(outcome: string, started: number, err?: unknown, lane?: string, logo?: string): void {
  const error = err instanceof Error ? err.message : err ? String(err) : undefined;
  emitLog(
    { scope: 'score.og' },
    { outcome, lane, logo, duration_ms: Date.now() - started, error },
    { level: outcome === 'error' ? 'error' : outcome === 'fallback' ? 'warn' : 'log' },
  );
}
