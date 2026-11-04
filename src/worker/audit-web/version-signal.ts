// What a client with a vendored copy of the web-audit contract compares
// against to learn it is behind this deploy. Every value is fixed for a given
// Worker version, so the body is too, and HIT-1d fits: unlike the path-keyed
// class it carries no `s-maxage`, and a new Worker version starts cold, so a
// release that moves a value is visible at the edge as soon as it deploys.

import { isGetOrHead } from '../accept';
import { applyHeaders } from '../headers';
import { SPEC_VERSION } from '../spec-version.gen';
import { emitLog } from '../telemetry/log';
import {
  loadWebAuditRegistry,
  registryFingerprintPrefix,
  type WebAuditRegistry,
  type WebAuditRegistryEnv,
} from './registry';
import { WEB_SCHEMA_VERSION } from './scorecard';

export interface WebAuditVersionSignal {
  spec_version: string;
  /** The prefix a scorecard scored under this registry records, not the full digest. */
  registry_fingerprint: string;
  web_schema_version: string;
}

// The route has no rate limit and a query string misses the edge, so a request
// a cache-buster sends through must not re-hash the registry.
const fingerprints = new WeakMap<WebAuditRegistry, string>();

async function fingerprintOf(registry: WebAuditRegistry): Promise<string> {
  const known = fingerprints.get(registry);
  if (known !== undefined) return known;
  const prefix = await registryFingerprintPrefix(registry);
  fingerprints.set(registry, prefix);
  return prefix;
}

async function webAuditVersionSignal(env: WebAuditRegistryEnv): Promise<WebAuditVersionSignal> {
  return {
    spec_version: SPEC_VERSION,
    registry_fingerprint: await fingerprintOf(await loadWebAuditRegistry(env)),
    web_schema_version: WEB_SCHEMA_VERSION,
  };
}

// Plain text like the discovery and card routes: the JSON branch of
// applyHeaders would label these bodies as JSON, and its fallback branch would
// give an extensionless path an HTML page's Link, CSP and Vary.
function plainTextError(status: number, body: string, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'cloudflare-cdn-cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      ...headers,
    },
  });
}

export async function handleWebAuditVersion(request: Request, env: WebAuditRegistryEnv): Promise<Response> {
  if (!isGetOrHead(request.method)) {
    return plainTextError(405, 'method not allowed\n', { allow: 'GET, HEAD' });
  }
  let signal: WebAuditVersionSignal;
  try {
    signal = await webAuditVersionSignal(env);
  } catch (err) {
    emitLog(
      { scope: 'web-audit.error' },
      { surface: 'version-signal', message: err instanceof Error ? err.message : String(err) },
      { level: 'error' },
    );
    return plainTextError(503, 'web-audit version signal unavailable\n', { 'retry-after': '30' });
  }
  const url = new URL(request.url);
  return applyHeaders(new Response(request.method === 'HEAD' ? null : JSON.stringify(signal)), {
    request,
    servedMarkdown: false,
    servedJson: true,
    pathname: url.pathname,
    // A query string changes nothing here, so it must not mint a day-long edge
    // object per value; a prefilled /audit is demoted the same way.
    cache: { klass: url.search === '' ? 'hit-1d' : 'hit-min' },
  });
}
