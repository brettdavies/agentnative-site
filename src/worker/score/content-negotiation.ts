// Content negotiation for the GET read path and its suffixed twins:
// URL-suffix detection first, then Accept-header q-value parsing
// (`accept.ts: detectScorePreference`).
//
//   .json suffix          → 'json'  (always; bypasses Accept)
//   .md suffix            → 'markdown'
//   no suffix             → detectScorePreference(request)  (defaults 'json')
//
// Never substring-match the Accept header: the accepts package handles
// q-values, wildcards, and bad input; substring matching breaks on
// `Accept: text/markdown;q=0.1, application/json;q=0.9`.

import { API_SCORE_PATH } from '../../shared/audit-routes';
import type { ScorePreference } from '../accept';
import { detectScorePreference } from '../accept';
import { isRepresentationPinned } from '../headers';

export type { ScorePreference } from '../accept';

/** True for the three path shapes the GET read path answers: bare, `.md`, and `.json`. */
export function isScorePath(pathname: string): boolean {
  return pathname === API_SCORE_PATH || pathname === `${API_SCORE_PATH}.md` || pathname === `${API_SCORE_PATH}.json`;
}

export function preferenceFor(pathname: string, request: Request): ScorePreference {
  if (isRepresentationPinned(pathname)) {
    return pathname.endsWith('.md') ? 'markdown' : 'json';
  }
  return detectScorePreference(request);
}
