// GET and HEAD /og/clip/<target>/<key>.mp4
//
// The clip the render Worker stored for a card, served whole from R2. This
// route never draws or renders, so a request can never start a render. A key
// that is not the target's current one 301s to the current key only when
// that clip exists. Byte ranges are the edge cache's job: on the cached
// entrypoint, Workers Caching strips Range, stores this full 200, and answers
// 206 or 416 itself, cold cache included. A 206 built here would be
// uncacheable (https://developers.cloudflare.com/workers/cache/configuration/#range-requests).

import {
  isImmutableScoreOgKey,
  isScoreOgClipPath,
  parseScoreOgClipPath,
  scoreOgClipPath,
  scoreOgKey,
} from '../../shared/score-og';
import { applyHeaders } from '../headers';
import { emitLog } from '../telemetry/log';
import { ogMethodNotAllowed, ogText, ogUnavailable } from './respond';
import { headClip, readStoredClip } from './store';
import { loadScoreOgSubject, type ScoreOgEnv } from './subject';

const CLIP_UNREADABLE = 'the scorecard clip could not be read right now\n';

export async function handleScoreOgClip(request: Request, env: ScoreOgEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return ogMethodNotAllowed();
  const url = new URL(request.url);
  const parsed = isScoreOgClipPath(url.pathname) ? parseScoreOgClipPath(url.pathname) : null;
  if (!parsed) return ogText(request, 404, 'not found\n');

  try {
    const subject = await loadScoreOgSubject(env, parsed.target);
    if (subject.status === 'unavailable') return ogUnavailable(request, CLIP_UNREADABLE);
    if (subject.status === 'missing') return ogText(request, 404, 'not found\n');
    const key = scoreOgKey(subject.card);
    if (!isImmutableScoreOgKey(key)) return ogText(request, 404, 'not found\n');

    const canonical = scoreOgClipPath(subject.target, key);
    if (canonical !== url.pathname || url.search !== '') {
      const current = await headClip(env.SCORE_CACHE, subject.target, key);
      if (!current) return ogText(request, 404, 'not found\n');
      return applyHeaders(new Response(null, { status: 301, headers: { Location: canonical } }), {
        request,
        pathname: url.pathname,
        servedMarkdown: false,
        cache: { klass: 'hit-min' },
      });
    }

    const clip = await readClip(env.SCORE_CACHE, subject.target, key, request.method === 'HEAD');
    if (!clip) return ogText(request, 404, 'not found\n');
    const headers = new Headers({
      'content-type': 'video/mp4',
      'content-length': String(clip.size),
      'accept-ranges': 'bytes',
      'x-robots-tag': 'noindex',
    });
    return applyHeaders(new Response(clip.body, { status: 200, headers }), {
      request,
      pathname: url.pathname,
      servedMarkdown: false,
      cache: { klass: 'immutable' },
    });
  } catch (err) {
    emitLog(
      { scope: 'score.og' },
      { outcome: 'clip-error', error: err instanceof Error ? err.message : String(err) },
      { level: 'error' },
    );
    return ogUnavailable(request, CLIP_UNREADABLE);
  }
}

/** The clip's size and body; a HEAD reads the metadata alone. */
async function readClip(
  bucket: R2Bucket,
  target: string,
  key: string,
  headOnly: boolean,
): Promise<{ size: number; body: ReadableStream | null } | null> {
  if (headOnly) {
    const head = await headClip(bucket, target, key);
    return head ? { size: head.size, body: null } : null;
  }
  const object = await readStoredClip(bucket, target, key);
  return object ? { size: object.size, body: object.body } : null;
}
