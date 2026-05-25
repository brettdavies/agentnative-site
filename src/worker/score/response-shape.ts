// Response-shape module for /api/score — single source of truth for the
// success envelope, the error envelope, and the ScoreError discriminated
// union every score-pipeline module imports.
//
// Every /api/score response carries the triad spec_version + anc_version +
// checker_url. Missing any of the three is a hard 500, NOT a quiet
// omission. The check fires at response-build time so a partial response
// can never escape the Worker.
//
// The ScoreError union routes every error through one wire shape;
// assertNever() makes adding a new variant a compile error everywhere it
// is consumed (handler.ts maps each variant to an HTTP status), so a new
// variant cannot silently fall through with no status mapping.
//
// The exec-time fields are split by source:
//   - SPEC_VERSION / SITE_SPEC_VERSION come from build-emitted constants
//     (spec-version.gen.ts).
//   - ANC_VERSION comes from the running sandbox at exec time and is
//     persisted into the cache payload; cached responses read it from the
//     payload, NOT from a build-time constant — otherwise a re-deployed
//     site with a stale cache would lie about which anc actually scored
//     the artifact.
//   - CHECKER_URL is a build-time constant pointing at the production
//     surface; if anc.dev ever moves, the constant moves with it.

import { CHECKER_URL, SITE_SPEC_VERSION, SPEC_VERSION } from '../spec-version.gen';

export type ScoreError =
  | { code: 'invalid_url'; details: string; cta_text: string }
  | { code: 'non_https_url'; cta_text: string }
  | { code: 'non_github_host'; cta_text: string }
  | { code: 'invalid_url_path'; cta_text: string }
  | { code: 'unrecognized_input'; cta_text: string }
  | { code: 'unparseable_install_command'; details: string; cta_text: string }
  | { code: 'chain_no_resolve'; cta_text: string }
  | { code: 'github_repo_not_accessible'; cta_text: string }
  | { code: 'discovery_redirect_loop'; cta_text: string }
  | { code: 'rate_limited'; retry_after: number; cta_text: string }
  | { code: 'install_unsupported'; pm: 'brew' | 'brew_only' | 'bun' | 'go_no_binary'; cta_text: string }
  | { code: 'chain_resolved_install_failed'; details: string; cta_text: string }
  | { code: 'chain_resolved_no_binary_produced'; details: string; cta_text: string }
  | { code: 'timeout'; phase: 'install' | 'score'; cta_text: string }
  | { code: 'turnstile_failed'; cta_text: string }
  | { code: 'scoring_disabled'; cta_text: string }
  | { code: 'sandbox_stub_until_u6'; cta_text: string }
  | { code: 'sandbox_unavailable'; cta_text: string }
  | { code: 'incomplete_response_contract'; details: string; cta_text: string }
  | { code: 'service_misconfigured'; details: string; cta_text: string };

export type ScoreErrorResponse = {
  error: ScoreError;
  spec_version: string;
  checker_url: string;
};

export type ScoreSuccess = {
  scorecard: unknown;
  spec_version: string;
  site_spec_version: string;
  anc_version: string;
  checker_url: string;
  // Set for inline scorecards (cached + live branches) when the binary is
  // derivable from the input. The homepage form's JS redirects here after
  // a successful submit. URL shape `/live-score/<binary>` reads from the
  // R2 cache that the DO + cached lookups write to; one write, one share
  // surface. Absent for:
  //   - `registry_hit` responses (carry their own `scorecard_url` pointing
  //     at the curated static page)
  //   - github-url-without-hint live runs (binary not derivable in the
  //     handler before the DO discovery; rare in practice — Aider-AI/aider
  //     etc. all ship hints)
  share_url?: string;
};

const CTA_INSTALL_ANC = 'Install `anc` and run `anc check .` in your project for full depth.';

/** Compile-time exhaustiveness guard. Reaching this at runtime is a bug. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled ScoreError variant: ${JSON.stringify(value)}`);
}

/** HTTP status for each ScoreError variant. Centralised so handler.ts cannot drift. */
export function statusForError(error: ScoreError): number {
  switch (error.code) {
    case 'invalid_url':
    case 'non_https_url':
    case 'non_github_host':
    case 'invalid_url_path':
    case 'unrecognized_input':
    case 'unparseable_install_command':
    case 'turnstile_failed':
      return 400;
    case 'chain_no_resolve':
    case 'github_repo_not_accessible':
      return 404;
    case 'rate_limited':
      return 429;
    case 'install_unsupported':
    case 'chain_resolved_install_failed':
    case 'chain_resolved_no_binary_produced':
      return 502;
    case 'timeout':
      return 504;
    case 'discovery_redirect_loop':
      return 502;
    case 'scoring_disabled':
    case 'sandbox_stub_until_u6':
    case 'sandbox_unavailable':
      return 503;
    case 'incomplete_response_contract':
    case 'service_misconfigured':
      return 500;
    default:
      return assertNever(error);
  }
}

const JSON_HEADERS_LIVE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'no-store',
} as const;

const JSON_HEADERS_CACHE_HIT = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'public, max-age=300',
} as const;

export type ResponseFreshness = 'live' | 'cache-hit';

/**
 * Build a successful score response. The response triad is asserted
 * inline — a payload missing spec_version / anc_version / checker_url
 * returns 500 with `incomplete_response_contract` so the contract
 * violation is loud, not a silent partial.
 */
export function shapeScoreSuccess(
  scorecard: unknown,
  anc_version: string | null | undefined,
  freshness: ResponseFreshness,
  shareUrl?: string | null,
): Response {
  if (!anc_version) {
    return shapeScoreError(
      {
        code: 'incomplete_response_contract',
        details: 'anc_version missing — refusing to emit a partial response',
        cta_text: CTA_INSTALL_ANC,
      },
      'live',
    );
  }

  const body: ScoreSuccess = {
    scorecard,
    spec_version: SPEC_VERSION,
    site_spec_version: SITE_SPEC_VERSION,
    anc_version,
    checker_url: CHECKER_URL,
    ...(shareUrl ? { share_url: shareUrl } : {}),
  };

  const headers = freshness === 'cache-hit' ? JSON_HEADERS_CACHE_HIT : JSON_HEADERS_LIVE;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/**
 * Build an error response carrying the response triad on every error too.
 * `retry_after` from `rate_limited` is mirrored onto the `Retry-After`
 * HTTP header so well-behaved clients back off automatically.
 */
export function shapeScoreError(error: ScoreError, freshness: ResponseFreshness = 'live'): Response {
  const body: ScoreErrorResponse = {
    error,
    spec_version: SPEC_VERSION,
    checker_url: CHECKER_URL,
  };

  const headers = new Headers(freshness === 'cache-hit' ? JSON_HEADERS_CACHE_HIT : JSON_HEADERS_LIVE);
  if (error.code === 'rate_limited') {
    headers.set('Retry-After', String(error.retry_after));
  } else if (error.code === 'scoring_disabled') {
    headers.set('Retry-After', '3600');
  }

  return new Response(JSON.stringify(body), {
    status: statusForError(error),
    headers,
  });
}

export const CTA = {
  installAnc: CTA_INSTALL_ANC,
} as const;
