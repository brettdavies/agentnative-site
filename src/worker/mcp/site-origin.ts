// Origin every MCP-emitted link is built from.
//
// A tool result that hardcodes the canonical host sends a caller to
// production no matter which deployment answered it: on staging, share
// URLs and fix-skill links pointed at anc.dev while the same rows rendered
// on the page pointed at the staging Worker, so the two surfaces disagreed
// on where a finding lives. The rendered result page already derives its
// origin from the request; this is the same rule for the MCP tools.

import { getMcpRequest } from './request-context';

/** The canonical site, used when no request is in scope (tests, warmups). */
export const CANONICAL_SITE_URL = 'https://anc.dev';

/**
 * Origin of the request currently being served, falling back to the
 * canonical site. Never returns a trailing slash, so callers concatenate
 * paths directly.
 */
export function siteOrigin(): string {
  const request = getMcpRequest();
  if (!request) return CANONICAL_SITE_URL;
  try {
    return new URL(request.url).origin;
  } catch {
    return CANONICAL_SITE_URL;
  }
}
