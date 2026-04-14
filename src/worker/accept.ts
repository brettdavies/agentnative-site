// Content-negotiation helper — returns whichever of 'html' | 'markdown' the
// caller prefers, using RFC 7231 q-value parsing via the `accepts` npm
// package. Falls back to 'html' on absent, malformed, or non-matching Accept
// headers (html is the citation default; markdown is opt-in).
//
// See docs/DESIGN.md §3.4 (Worker paragraph) + eng review A3. Test matrix lives
// in tests/worker.test.ts.

import accepts from 'accepts';

export type Preference = 'html' | 'markdown';

const PREFERENCE_ORDER = ['text/html', 'text/markdown'];

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
  const match = accepts(shim(request)).type(PREFERENCE_ORDER);
  return match === 'text/markdown' ? 'markdown' : 'html';
}
