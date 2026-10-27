// GET /og/score/<target>/<key>.png
//
// The key names everything the card shows (`s80-v0.6.0-d20261026-r1`; the
// grammar is in src/shared/score-og.ts), or `pending` / `unscored`. A request whose key is not the score stored for
// that target 301s to the key that is, so a guessed percent cannot be
// minted into a card. Finished keys are cached immutably: a rescore changes
// the URL the page advertises, and the previous object can stay at the edge.
// Pending and unscored stay on the short cache, because the next run
// replaces them at the same URL. A finished card is also stored in R2
// (./store.ts), so an edge miss reads it rather than drawing it again.

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
import { findLogo, type LogoSource } from './find-logo';
import { loadScoreOgFonts } from './fonts';
import type { LogoFetch } from './logo';
import { renderScoreOgPng, type ScoreOgFonts } from './render';
import { readStoredCard, storeCard } from './store';
import { loadScoreOgSubject, type ScoreOgEnv } from './subject';

export type ScoreOgDeps = {
  fonts?: ScoreOgFonts;
  fetchImpl?: LogoFetch;
  budgetMs?: number;
  now?: () => number;
  /** Runs the R2 store after the response; the request's ctx.waitUntil in the Worker. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

const REDIRECT_CACHE: CacheClassSpec = { klass: 'hit-min' };

/** Serve one scorecard card, or redirect to the key the stored score names. */
export async function handleScoreOg(request: Request, env: ScoreOgEnv, deps: ScoreOgDeps = {}): Promise<Response> {
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
  if (canonical !== url.pathname || url.search !== '') {
    log('redirect', started, undefined, subject.card.lane);
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
      log('stored', started, undefined, subject.card.lane, stored.logo ?? undefined);
      return pngResponse(request, url.pathname, stored.png, immutable, cardDiagnostics('stored', stored.logo));
    }
  }

  try {
    const fonts = deps.fonts ?? (await loadScoreOgFonts(env));
    const found =
      subject.pages.length === 0
        ? { logo: null, source: 'tile' as const, settled: true }
        : await findLogo({
            pages: subject.pages,
            fonts,
            bucket: env.SCORE_CACHE,
            brandApiKey: env.CONTEXT_DEV_API_KEY,
            fetchImpl: deps.fetchImpl,
            budgetMs: deps.budgetMs,
            now: deps.now,
            waitUntil: deps.waitUntil,
          });
    const png = await renderScoreOgPng({ ...subject.card, logo: found.logo }, fonts);
    log(found.settled ? 'ok' : 'logo-unsettled', started, undefined, subject.card.lane, found.source);
    const finalCard = immutable && found.settled;
    if (finalCard) {
      const meta = { scoredAt: subject.scoredAt, logo: found.source };
      const store = storeCard(env.SCORE_CACHE, subject.target, key, png, meta).catch((err: unknown) =>
        log('store-error', started, err, subject.card.lane),
      );
      if (deps.waitUntil) deps.waitUntil(store);
      else await store;
    }
    return pngResponse(request, url.pathname, png, finalCard, cardDiagnostics('drawn', found.source));
  } catch (err) {
    log('error', started, err, subject.card.lane);
    return text(request, 500, 'scorecard image failed\n');
  }
}

/**
 * `x-anc-card` says whether this response drew the card or read it from R2, and `x-anc-card-logo` which source the
 * card's logo came from, read from the stored card's metadata on the stored path, so a live smoke can tell the paths
 * apart. An edge hit replays the headers of the response it cached.
 */
function cardDiagnostics(card: 'drawn' | 'stored', logo: LogoSource | null): Record<string, string> {
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
    { level: outcome === 'error' ? 'error' : 'log' },
  );
}
