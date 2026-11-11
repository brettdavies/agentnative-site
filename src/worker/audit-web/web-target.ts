// The site a request names. A target is a host and the https origin the cache
// is keyed by. A request for `www.<a>` names `<a>` when the stored record of
// `<a>` shows the pair folded, and names `www.<a>` otherwise; every other host
// names itself. The resolution reads no record of `www.<a>`, so a read that
// failed is never answered as an audit that does not exist.

import { sitePairOf } from '../../shared/audit-routes';
import { SPEC_VERSION } from '../spec-version.gen';
import {
  type CachedWebAudit,
  get as cacheGet,
  canonicalTargetOf,
  getForRequest,
  keyFor,
  type WebCacheEnv,
} from './cache';
import { readSiteHosts } from './provenance';
import { validatePublicUrl } from './ssrf';

export type WebTarget = {
  /** The host the result route serves, with a non-default port. */
  host: string;
  /** The canonical `https://<host>/` origin the cache is keyed by. */
  canonical: string;
};

/**
 * The website lane's server-side target: the shared classifier's host,
 * fixed to the https scheme, then the SSRF gate on that origin before any
 * cache read. A refused origin returns the gate's reason.
 */
export function prepareWebTarget(host: string): { ok: true; target: WebTarget } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(`https://${host}/`);
  } catch {
    return { ok: false, reason: 'invalid host' };
  }
  const canonical = canonicalTargetOf(url);
  const validation = validatePublicUrl(canonical);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, target: { host: url.host, canonical } };
}

/** The target of a host that already passed `prepareWebTarget`'s parse, such as one half of a validated pair. */
export function targetOfHost(host: string): WebTarget {
  const url = new URL(`https://${host}/`);
  return { host: url.host, canonical: canonicalTargetOf(url) };
}

/** The hosts a stored audit records as one site; empty for an audit that recorded no fold. */
export function recordedSiteHosts(record: CachedWebAudit | null): string[] {
  return readSiteHosts((record?.scorecard as { site_hosts?: unknown } | null | undefined)?.site_hosts);
}

export type WebResolution = {
  /** The site the request names. */
  target: WebTarget;
  /** The host as typed; the engine starts its audit here. */
  requested: WebTarget;
  /**
   * The named site's stored audit when the resolver read it, which it does
   * for a `www.` host that names a fold; undefined when it read nothing, and
   * null when the record it read is a miss.
   */
  stored: CachedWebAudit | null | undefined;
};

/**
 * Resolve a requested host to the site it names. `strict` surfaces an
 * unreadable record of `<a>` as `WebCacheUnavailableError`, for a path that
 * answers a reader; `tolerant` counts it as no fold, for a path whose audit
 * observes the fold itself.
 */
export async function resolveWebTarget(
  env: WebCacheEnv,
  requested: WebTarget,
  read: 'strict' | 'tolerant',
): Promise<WebResolution> {
  const pair = sitePairOf(requested.host);
  if (pair === null || requested.host !== pair.www) return { target: requested, requested, stored: undefined };
  const apex = targetOfHost(pair.apex);
  const key = await keyFor(apex.canonical, SPEC_VERSION);
  const stored = read === 'strict' ? await getForRequest(env, key) : await cacheGet(env, key);
  if (!recordedSiteHosts(stored).includes(requested.host)) return { target: requested, requested, stored: undefined };
  return { target: apex, requested, stored };
}
