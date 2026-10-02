// What a default audit sends to the hosts a site declares, stated once so
// the audit_website tool description and the MCP server instructions
// disclose the same probes and the same caps the follow slice enforces.

import { FOLLOW_SLICE_MS } from './follow';
import { MAX_FOLLOW_REQUESTS, MAX_FOLLOWED_HOSTS } from './follow-requests';
import { DECLARED_DOMAIN_HOURLY_CEILING } from './limiter';

export const FOLLOW_DISCLOSURE =
  'By default (follow_declarations true) a website audit also contacts third-party hosts the site declares. An MCP ' +
  "server the site's server card names gets GETs for the documents that could confirm it (a card at " +
  "<endpoint>/server-card, its host's /.well-known/ai-catalog.json, RFC 9728 protected-resource metadata) and is " +
  "wire-probed (JSON-RPC POSTs, a CORS preflight) only after one of those documents on the endpoint's own host names " +
  "the endpoint. An API host anchored in the site's api-catalog gets document fetches (its OpenAPI description) and " +
  "one GET to a nonsense path on the site's declaration alone. Each audit follows at most " +
  `${MAX_FOLLOWED_HOSTS} off-origin hosts with at most ${MAX_FOLLOW_REQUESTS} follow-phase document requests inside ` +
  `a ${FOLLOW_SLICE_MS / 1000}-second follow window, so following lengthens an audit's wall time. Across all ` +
  `audits and sites, following is also capped at about ${DECLARED_DOMAIN_HOURLY_CEILING} audits per hour per ` +
  "declared registrable domain; an audit past that cap leaves that domain's hosts unprobed, and when the site has " +
  'a saved scorecard from the last 24 hours that audit is returned without replacing it, with no scorecard_url, ' +
  'markdown_url, or json_url. ' +
  'follow_declarations false audits only the site and returns a result that is never saved, and the operator can ' +
  'switch following off for every audit (WEB_AUDIT_FOLLOW_ENABLED).';
