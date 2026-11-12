// What the website MCP tools answer with, and the refusals their source gates
// share, so `audit_website` and `set_website_public_listing` give a caller the
// same text for the same refusal.

import { sitePairOf } from '../../../shared/audit-routes';
import { coerceUrl } from '../../audit-web/cache';
import { prepareWebTarget, type WebTarget } from '../../audit-web/core';
import { HOURLY_AUDIT_CEILING } from '../../audit-web/limiter';

export const SOURCE_IP_REQUIRED =
  'fresh audits require a source IP; missing cf-connecting-ip is not rate-limit-keyable.';
export const BURST_REFUSED = 'audit rate limit exceeded — burst window (30 per 60 seconds per source).';
export const HOURLY_FULL = `audit rate limit exceeded — ${HOURLY_AUDIT_CEILING} fresh audits per hour per source.`;

export function textContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function jsonRpcError32099(message: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ jsonrpc: '2.0', error: { code: -32099, message } }, null, 2) },
    ],
    isError: true,
  };
}

export function isError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** The tool input's host at its https origin, behind the SSRF gate; a scheme other than http(s) is refused. */
export function siteTarget(url: string): { ok: true; target: WebTarget } | { ok: false; reason: string } {
  const parsed = coerceUrl(url);
  if (!parsed) return { ok: false, reason: 'invalid url' };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${parsed.protocol} is not http(s)` };
  }
  return prepareWebTarget(parsed.host);
}

/** The answer when the stored scorecard of `site` could not be read; a stored record is never reported removed or missing for it. */
export function unreadableRecord(site: string, retryTool: string) {
  return isError(
    `cache_unavailable: the stored scorecard for ${site} could not be read right now; it has not been removed. Retry ${retryTool} in 30 seconds.`,
  );
}

/** The answer when the record that names a `www.` host's site could not be read; the host's own record is never read in its place. */
export function cacheUnavailable(host: string, retryTool: string) {
  return unreadableRecord(sitePairOf(host)?.apex ?? host, retryTool);
}
