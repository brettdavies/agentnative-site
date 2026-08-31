// Origin resolution for MCP tool results.
//
// A tool result that hardcodes the production host hands an agent a link
// to a different deployment than the one it is talking to. Every URL a
// tool mints therefore derives from the in-flight request.
//
// The request comes from the AsyncLocalStorage in request-context.ts, not
// a module-level variable: one Worker isolate serves many requests
// concurrently, so a shared "current origin" would let one request's host
// leak into another's response under load. AsyncLocalStorage gives each
// request its own store.
//
// No request in scope means no client to answer — warmups, direct unit
// calls — so the canonical host stands in.

import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { getMcpRequest } from './request-context';

export { CANONICAL_SITE_URL };

export function siteOrigin(): string {
  const request = getMcpRequest();
  if (!request) return CANONICAL_SITE_URL;
  try {
    return new URL(request.url).origin;
  } catch {
    return CANONICAL_SITE_URL;
  }
}
