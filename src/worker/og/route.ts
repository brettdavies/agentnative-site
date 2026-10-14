// GET /og/score/<target>/<key>.png
//
// The key is the rounded score and the spec version (`s80-v0.6.0`), or
// `pending` / `unscored`. A request whose key is not the score stored for
// that target 301s to the key that is, so a guessed percent cannot be
// minted into a card. Finished keys are cached immutably: a rescore changes
// the URL the page advertises, and the previous object can stay at the edge.
// Pending and unscored stay on the short cache, because the next run
// replaces them at the same URL.

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
import { loadScoreOgFonts } from './fonts';
import { type LogoFetch, resolveLogo } from './logo';
import { renderScoreOgPng, type ScoreOgFonts } from './render';
import { loadScoreOgSubject, type ScoreOgEnv } from './subject';

export type ScoreOgDeps = {
  fonts?: ScoreOgFonts;
  fetchImpl?: LogoFetch;
  budgetMs?: number;
  now?: () => number;
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

  const key = scoreOgKey({
    scorePct: subject.card.scorePct,
    specVersion: subject.card.specVersion,
    pending: subject.card.pending,
  });
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

  try {
    const fonts = deps.fonts ?? (await loadScoreOgFonts(env));
    const logo =
      subject.pages.length === 0
        ? null
        : await resolveLogo({
            pages: subject.pages,
            fonts,
            fetchImpl: deps.fetchImpl,
            budgetMs: deps.budgetMs,
            now: deps.now,
          });
    const png = await renderScoreOgPng({ ...subject.card, logo }, fonts);
    const body = new ArrayBuffer(png.byteLength);
    new Uint8Array(body).set(png);
    log('ok', started, undefined, subject.card.lane, logo ? 'image' : 'wordmark');
    const headers = new Headers({
      'content-type': 'image/png',
      'content-length': String(png.byteLength),
      'x-robots-tag': 'noindex',
    });
    return applyHeaders(new Response(body, { status: 200, headers }), {
      request,
      pathname: url.pathname,
      servedMarkdown: false,
      cache: { klass: isImmutableScoreOgKey(key) ? 'immutable' : 'hit-min' },
    });
  } catch (err) {
    log('error', started, err, subject.card.lane);
    return text(request, 500, 'scorecard image failed\n');
  }
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
