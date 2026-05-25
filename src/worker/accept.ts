// Content-negotiation helpers — use RFC 7231 q-value parsing via the
// `accepts` npm package (NOT substring matching, per the
// `accept-header-q-value` learning).
//
// detectPreference — site-default ('html' | 'markdown'). Used by index.ts
//                    for the asset-first path; markdown is opt-in.
//
// detectScorePreference — /api/score endpoint ('json' | 'markdown'). JSON is
//                         default; markdown is opt-in. The handler combines
//                         this with URL-suffix detection
//                         (`/api/score.md`, `/api/score.json`) in
//                         `score/content-negotiation.ts`.
//
// See docs/DESIGN.md §3.4 (Worker paragraph) + eng review A3. Site-side
// test matrix lives in tests/worker.test.ts; /api/score q-value tests live
// in the same file's /api/score describe block.

import accepts from 'accepts';

export type Preference = 'html' | 'markdown';
export type ScorePreference = 'json' | 'markdown';

const SITE_PREFERENCE_ORDER = ['text/html', 'text/markdown'];
const SCORE_PREFERENCE_ORDER = ['application/json', 'text/markdown', 'text/html'];

/**
 * Shim a Workers `Request` into the shape `accepts` expects: it only reads
 * `headers.accept`, not the full IncomingMessage surface.
 */
function shim(request: Request) {
  return {
    headers: {
      accept: request.headers.get('accept') ?? '',
    },
  };
}

export function detectPreference(request: Request): Preference {
  // @ts-expect-error — the accepts package types an IncomingMessage but only
  // reads `headers.accept`; the shim is sufficient.
  const match = accepts(shim(request)).type(SITE_PREFERENCE_ORDER);
  return match === 'text/markdown' ? 'markdown' : 'html';
}

export function detectScorePreference(request: Request): ScorePreference {
  // @ts-expect-error — see detectPreference above.
  const match = accepts(shim(request)).type(SCORE_PREFERENCE_ORDER);
  return match === 'text/markdown' ? 'markdown' : 'json';
}
