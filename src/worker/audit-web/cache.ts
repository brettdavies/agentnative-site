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
  // Absent on entries written before scored_at existed; readers treat a
  // missing stamp as maximally stale so those entries re-score on demand.
  scored_at?: string;
};

// The two board aggregates, rebuilt after a rescore batch and on any
// on-demand rescore of a seeded domain. `leaderboard` is the full board;
// `leaderboard-frontpage` is the top-N slice the homepage injects.
export type WebAggregateKind = 'leaderboard' | 'leaderboard-frontpage';

export type WebAggregateEntry = {
  domain: string;
  url: string;
  name: string;
  description: string;
  score_pct: number;
  score: { relative: number; global: number };
};

export type CachedWebAggregate = {
  spec_version: string;
  generated_at: string;
  entries: WebAggregateEntry[];
};

const CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

// Staleness threshold for the on-demand paths: a hit younger than this
// serves cached; an older hit falls through to a fresh audit (still
// behind the kill-switch/limiter/Turnstile gates).
export const WEB_AUDIT_STALE_AFTER_MS = 5 * 60_000;

// Logical display expiry for user-submitted rows on the /web all view:
// an unseeded entry older than this drops off the board even though the
// R2 object persists (no lifecycle rule covers audits/web/). Tunable;
// any future physical R2 lifecycle TTL must be >= this window so a row
// never vanishes from storage before it ages off the board.
export const WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Board-relevant subset of a listed per-domain entry, parsed from R2 custom metadata. */
export type WebListedAudit = {
  domain: string;
  name: string;
  score_pct: number;
  score: { relative: number; global: number };
  scored_at: string;
  public_listing: boolean;
};

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

/** Canonical audited target: scheme + host + `/` (drops path/query/fragment beyond the origin). */
export function canonicalTargetOf(url: URL): string {
  return `${url.protocol}//${url.host}/`;
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

/**
 * Key for a board aggregate at a spec version. The kind segment can never
 * collide with a per-domain entry: those use a 64-char hex hash segment.
 */
export function aggregateKeyFor(kind: WebAggregateKind, specVersion: string): string {
  return `audits/web/${kind}/${specVersion}.json`;
}

/**
 * `true` when a `scored_at` stamp is missing, unparseable, or older than
 * `thresholdMs`. Staleness is logical only (KTD3): it gates whether an
 * on-demand request re-scores, never whether an entry is served.
 */
export function isStale(scoredAt: string | undefined, thresholdMs: number, now: number = Date.now()): boolean {
  if (!scoredAt) return true;
  const t = Date.parse(scoredAt);
  if (Number.isNaN(t)) return true;
  return now - t > thresholdMs;
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

  const payload = {
    spec_version: specVersion,
    target_url: normalizeTargetUrl(url),
    scorecard,
    scored_at: new Date().toISOString(),
  };
  await writeAuditObject(env, await keyFor(url, specVersion), payload, 'web-cache.put');
}

/**
 * Re-put a stored audit with `public_listing` flipped, writing the flag into
 * both the envelope body and the board custom metadata in a single object
 * write (R2 has no partial-metadata update, so it is a full rewrite). Unlike
 * `put`, `scored_at` is sourced from the stored entry and carried forward so a
 * flag flip never resets the freshness or display-age windows; only an entry
 * that never carried a stamp gets one now. Never throws: a write failure logs
 * and resolves false so callers can refuse to report a patch that did not
 * land.
 */
export async function patchStoredPublicListing(
  env: WebCacheEnv,
  cached: CachedWebAudit,
  value: boolean,
): Promise<boolean> {
  const scorecard = { ...(cached.scorecard as Record<string, unknown>), public_listing: value };
  const payload = {
    spec_version: cached.spec_version,
    target_url: cached.target_url,
    scorecard,
    scored_at: cached.scored_at ?? new Date().toISOString(),
  };
  const key = await keyFor(cached.target_url, cached.spec_version);
  return writeAuditObject(env, key, payload, 'web-cache.patchStoredPublicListing');
}

/**
 * Write a fully-stamped audit envelope to R2, deriving board custom metadata
 * from the same payload so body and metadata can never disagree. Never
 * throws: a write failure logs under `scope` and resolves false.
 */
async function writeAuditObject(
  env: WebCacheEnv,
  key: string,
  payload: CachedWebAudit & { scored_at: string },
  scope: string,
): Promise<boolean> {
  try {
    await env.SCORE_CACHE.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json', cacheControl: CACHE_CONTROL },
      customMetadata: boardMetadataOf(payload.target_url, payload.scorecard, payload.scored_at),
    });
    return true;
  } catch (err) {
    console.log(JSON.stringify({ scope, key, error: errMsg(err) }));
    return false;
  }
}

// Board fields duplicated into R2 custom metadata so the /web all view
// can enumerate cached sites with a bare list() — no per-object body
// fetch on the render path. R2 metadata is string-valued; readers parse.
function boardMetadataOf(targetUrl: string, scorecard: unknown, scoredAt: string): Record<string, string> {
  const sc = scorecard as {
    tool?: { name?: unknown };
    score_pct?: unknown;
    score?: { relative?: unknown; global?: unknown };
    public_listing?: unknown;
  } | null;
  const domain = new URL(targetUrl).host;
  const toolName = sc?.tool?.name;
  const meta: Record<string, string> = {
    domain,
    name: typeof toolName === 'string' && toolName.length > 0 ? toolName : domain,
    scored_at: scoredAt,
    // Board gating reads custom metadata only (never the body), so the opt-in
    // flag must be dual-stored here; string-valued because R2 metadata is
    // string-only, and always emitted so a missing key can't read as opted-in.
    public_listing: String(sc?.public_listing ?? false),
  };
  if (typeof sc?.score_pct === 'number') meta.score_pct = String(sc.score_pct);
  if (typeof sc?.score?.relative === 'number') meta.relative = String(sc.score.relative);
  if (typeof sc?.score?.global === 'number') meta.global = String(sc.score.global);
  return meta;
}

const PER_DOMAIN_HASH_RE = /^[0-9a-f]{64}$/;

export type ListAllWebAuditsOpts = {
  specVersion: string;
  excludeDomains: ReadonlySet<string>;
  now?: number;
  maxAgeMs?: number;
};

/**
 * Enumerate every cached per-domain audit at `specVersion` from R2 custom
 * metadata alone. Skips aggregate keys, other spec versions, excluded
 * (seeded/curated) domains, entries past the display window, and entries
 * whose metadata is missing or unparseable (pre-metadata writes self-heal
 * on their next audit). Best-effort like the rest of this module: a list
 * failure logs and returns what was collected, never throws.
 */
export async function listAllWebAudits(env: WebCacheEnv, opts: ListAllWebAuditsOpts): Promise<WebListedAudit[]> {
  const out: WebListedAudit[] = [];
  const maxAgeMs = opts.maxAgeMs ?? WEB_ALL_BOARD_DISPLAY_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  // The trailing key segment is compared as a literal string so version
  // dots can never act as regex wildcards (0.5.0 must not match 0x5x0).
  const versionSegment = `${opts.specVersion}.json`;
  let cursor: string | undefined;
  try {
    do {
      const page = await env.SCORE_CACHE.list({ prefix: 'audits/web/', include: ['customMetadata'], cursor });
      for (const obj of page.objects) {
        const parts = obj.key.split('/');
        if (parts.length !== 4 || !PER_DOMAIN_HASH_RE.test(parts[2]) || parts[3] !== versionSegment) continue;
        const entry = parseListedMetadata(obj.customMetadata);
        if (!entry) continue;
        if (opts.excludeDomains.has(entry.domain)) continue;
        if (isStale(entry.scored_at, maxAgeMs, now)) continue;
        out.push(entry);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.listAllWebAudits', error: errMsg(err) }));
  }
  return out;
}

function parseListedMetadata(meta: Record<string, string> | undefined): WebListedAudit | null {
  if (!meta) return null;
  const { domain, name, scored_at } = meta;
  if (!domain || !scored_at) return null;
  const scorePct = numberField(meta.score_pct);
  const relative = numberField(meta.relative);
  const globalScore = numberField(meta.global);
  if (scorePct === null || relative === null || globalScore === null) return null;
  return {
    domain,
    name: name && name.length > 0 ? name : domain,
    score_pct: scorePct,
    score: { relative, global: globalScore },
    scored_at,
    // A missing key coerces to false: an unmigrated object reads as not-listed.
    public_listing: meta.public_listing === 'true',
  };
}

function numberField(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function getAggregate(
  env: WebCacheEnv,
  kind: WebAggregateKind,
  specVersion: string,
): Promise<CachedWebAggregate | null> {
  const key = aggregateKeyFor(kind, specVersion);
  let obj: R2ObjectBody | null;
  try {
    obj = await env.SCORE_CACHE.get(key);
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.getAggregate', key, error: errMsg(err) }));
    return null;
  }
  if (obj === null) return null;

  let raw: unknown;
  try {
    raw = await obj.json();
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.getAggregate', key, error: `json_parse: ${errMsg(err)}` }));
    env.SCORE_CACHE.delete(key).catch(() => {});
    return null;
  }

  if (!isCachedWebAggregate(raw)) {
    console.log(JSON.stringify({ scope: 'web-cache.getAggregate', key, error: 'corrupted_payload' }));
    env.SCORE_CACHE.delete(key).catch(() => {});
    return null;
  }
  return raw;
}

/**
 * Write a board aggregate. Refuses a half-state (empty spec_version).
 * Best-effort like `put`: a write failure logs but never throws.
 */
export async function putAggregate(
  env: WebCacheEnv,
  kind: WebAggregateKind,
  entries: WebAggregateEntry[],
  specVersion: string,
): Promise<void> {
  if (!specVersion) throw new Error('web-cache.putAggregate: specVersion required (refusal-to-cache-half-state)');
  const payload: CachedWebAggregate = {
    spec_version: specVersion,
    generated_at: new Date().toISOString(),
    entries,
  };
  const key = aggregateKeyFor(kind, specVersion);
  try {
    await env.SCORE_CACHE.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json', cacheControl: CACHE_CONTROL },
    });
  } catch (err) {
    console.log(JSON.stringify({ scope: 'web-cache.putAggregate', key, error: errMsg(err) }));
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
    obj.scorecard !== undefined &&
    (obj.scored_at === undefined || typeof obj.scored_at === 'string')
  );
}

function isWebAggregateEntry(value: unknown): value is WebAggregateEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const score = obj.score as Record<string, unknown> | null | undefined;
  return (
    typeof obj.domain === 'string' &&
    obj.domain.length > 0 &&
    typeof obj.url === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.score_pct === 'number' &&
    typeof score === 'object' &&
    score !== null &&
    typeof score.relative === 'number' &&
    typeof score.global === 'number'
  );
}

function isCachedWebAggregate(value: unknown): value is CachedWebAggregate {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.spec_version === 'string' &&
    obj.spec_version.length > 0 &&
    typeof obj.generated_at === 'string' &&
    Array.isArray(obj.entries) &&
    obj.entries.every(isWebAggregateEntry)
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
