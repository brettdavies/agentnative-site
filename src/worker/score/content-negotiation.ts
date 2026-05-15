// /api/score content negotiation. Combines URL-suffix detection
// (`/api/score.md`, `/api/score.json`) with Accept-header q-value parsing
// (`accept.ts: detectScorePreference`).
//
// Plan U5 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md):
//
//   .json suffix          → 'json'  (always; bypasses Accept, mirrors the
//                                    triple-emit-content-negotiation pattern)
//   .md suffix            → 'markdown'
//   no suffix             → detectScorePreference(request)  (defaults 'json')
//
// `accept-header-q-value` learning: NEVER substring-match the Accept
// header. The accepts package handles q-values, wildcards, and bad input
// correctly; substring matching breaks on `Accept: text/markdown;q=0.1,
// application/json;q=0.9`.

import type { ScorePreference } from '../accept';
import { detectScorePreference } from '../accept';

export type { ScorePreference } from '../accept';

/** True for the three /api/score path shapes the handler responds to. */
export function isScorePath(pathname: string): boolean {
  return pathname === '/api/score' || pathname === '/api/score.md' || pathname === '/api/score.json';
}

export function preferenceFor(pathname: string, request: Request): ScorePreference {
  if (pathname.endsWith('.json')) return 'json';
  if (pathname.endsWith('.md')) return 'markdown';
  return detectScorePreference(request);
}
