// R2 read/write wrapper for web-audit scorecards (plan U6, KTD-2/KTD-13).
//
// Mirrors src/worker/score/cache.ts: single source of truth for the key
// shape, refusal-to-cache-half-state, best-effort writes, malformed-entry
// delete. Two divergences from the CLI cache:
//
//   - Key is `audits/web/<url-hash>/<SPEC_VERSION>.json`, where <url-hash>
//     is a hex SHA-256 of the normalized URL (lowercased host, canonical
//     scheme, no fragment, normalized trailing slash). The stored payload
//     also carries `target_url` so the /web/<domain> route can display and
//     cross-check the exact audited URL.
//   - Complete-only (KTD-13): only a complete scorecard is ever written.
//     A run that hits the per-audit deadline is never persisted here.
//
// Reuses the existing SCORE_CACHE R2 bucket (no new binding). The CLI's
// 7-day lifecycle is prefix-scoped to `scores/` and does not apply to the
// new `audits/web/` prefix, which defaults to no expiry.

export type WebCacheEnv = { SCORE_CACHE: R2Bucket };

export type CachedWebAudit = {
  spec_version: string;
  target_url: string;
  scorecard: unknown;
};

const CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

/**
 * Normalize a URL for keying and display: lowercase host, canonical
 * scheme, no fragment, and a normalized trailing slash on a bare-host URL.
 */
export function normalizeTargetUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname === '' || u.pathname === '/') {
    u.pathname = '/';
    // URL already lowercases the scheme; toString drops a redundant trailing slash issue.
    return `${u.protocol}//${u.host}/`;
  }
  // Strip a single trailing slash from non-root paths so /docs and /docs/ collide.
  u.pathname = u.pathname.replace(/\/$/, '');
  return u.toString();
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Deterministic collision-safe key for a target URL at a spec version. */
export async function keyFor(url: string, specVersion: string): Promise<string> {
  const hash = await sha256Hex(normalizeTargetUrl(url));
  return `audits/web/${hash}/${specVersion}.json`;
}

export async function get(env: WebCacheEnv, key: string): Promise<CachedWebAudit | null> {
  let obj: R2ObjectBody | null;
  try {
    obj = await env.SCORE_CACHE.get(key);
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.get', key, error: errMsg(err) }));
    return null;
  }
  if (obj === null) return null;

  let raw: unknown;
  try {
    raw = await obj.json();
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.get', key, error: `json_parse: ${errMsg(err)}` }));
    env.SCORE_CACHE.delete(key).catch(() => {});
    return null;
  }

  if (!isCachedWebAudit(raw)) {
    console.log(JSON.stringify({ scope: 'web-cache.get', key, error: 'corrupted_payload' }));
    env.SCORE_CACHE.delete(key).catch(() => {});
    return null;
  }
  return raw;
}

/**
 * Write a complete web scorecard. Refuses a half-state (empty
 * spec_version or a scorecard without a target_url). Best-effort: a write
 * failure logs but never throws to the caller.
 */
export async function put(env: WebCacheEnv, url: string, scorecard: unknown, specVersion: string): Promise<void> {
  if (!specVersion) throw new Error('web-cache.put: specVersion required (refusal-to-cache-half-state)');
  const targetUrl = (scorecard as { target_url?: unknown } | null)?.target_url;
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
    throw new Error('web-cache.put: scorecard.target_url required (refusal-to-cache-half-state)');
  }

  const payload: CachedWebAudit = { spec_version: specVersion, target_url: normalizeTargetUrl(url), scorecard };
  const key = await keyFor(url, specVersion);
  try {
    await env.SCORE_CACHE.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json', cacheControl: CACHE_CONTROL },
    });
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.put', key, error: errMsg(err) }));
  }
}

function isCachedWebAudit(value: unknown): value is CachedWebAudit {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.spec_version === 'string' &&
    obj.spec_version.length > 0 &&
    typeof obj.target_url === 'string' &&
    obj.target_url.length > 0 &&
    'scorecard' in obj &&
    obj.scorecard !== null &&
    obj.scorecard !== undefined
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
