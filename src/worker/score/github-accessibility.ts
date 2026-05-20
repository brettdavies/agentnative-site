// Cheap pre-DO probe for github-url inputs: HEAD https://github.com/<owner>/<repo>.
// 200/2xx means the repo is anonymously visible — proceed to the DO. 404 means
// the repo is private, deleted, or never existed — fast-fail BEFORE the DO
// dispatch so the user doesn't pay a sandbox cold-start (and the platform
// doesn't pay container minutes) on a request that cannot resolve a binary
// regardless. Anything else (5xx, network error, non-redirect non-404) is
// treated as "unknown" and fails-OPEN so a transient github outage doesn't
// silently break scoring.
//
// Redirect handling: github 301s for renamed repos (the redirect points at
// the canonical owner/repo on github.com — fine, that's still "accessible").
// But following redirects unconditionally would let a malicious upstream
// pivot the probe to an arbitrary host. We use `redirect: 'manual'` and
// treat any 3xx as "accessible" without inspecting Location — github's own
// 301s for moves all land on github.com anyway, and we don't need the
// target URL, just the binary "is this fetchable" answer.
//
// In-isolate cache: a Map keyed by `<owner>/<repo>` (lowercased) with a
// timestamp-based TTL. Workers re-instantiate isolates frequently, so the
// cache is bounded; the TTL exists so a private→public flip is observed
// within ~5 min on a long-lived isolate.

const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Owner+repo shape lock applied independently here, even though validate.ts
// already enforces the same character classes at the Worker boundary. This
// is defense-in-depth against a future caller that bypasses validate.ts and
// hands a raw string to this module: a missing guard here would let
// arbitrary characters interpolate into the URL passed to fetch(). The
// regexes mirror GitHub's own owner + repo rules.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type AccessibilityResult =
  | { state: 'accessible' }
  | { state: 'not_accessible' }
  | { state: 'unknown'; reason: 'timeout' | 'network_error' | 'non_2xx_non_404' | 'invalid_slug' };

export type CheckOpts = {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Override the default 3 s probe timeout. */
  timeoutMs?: number;
};

type CacheEntry = { result: AccessibilityResult; expiresAt: number };

// Module-scoped cache. Bounded by isolate lifetime + TTL. We don't bother
// with an LRU eviction because the working set on a public-binary scorer is
// dominated by the same ~hundred repos across requests; an unbounded Map of
// owner/repo keys on a per-isolate basis stays well under any sensible
// memory ceiling.
const cache = new Map<string, CacheEntry>();

/** Test-only: drop the in-isolate cache between tests. */
export function _resetAccessibilityCache(): void {
  cache.clear();
}

export async function checkGithubAccessibility(
  owner: string,
  repo: string,
  opts: CheckOpts = {},
): Promise<AccessibilityResult> {
  // Defense-in-depth: refuse to interpolate anything we wouldn't accept at
  // validate.ts. An invalid slug here means a caller bypassed the validator;
  // we return `unknown` rather than `not_accessible` so the caller fails
  // OPEN (the DO will run its own validation and bounce with the right
  // error). The bonus is no spurious HEAD probes against malformed URLs.
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    return { state: 'unknown', reason: 'invalid_slug' };
  }

  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeout = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);

  let result: AccessibilityResult;
  try {
    const res = await fetcher(`https://github.com/${owner}/${repo}`, {
      method: 'HEAD',
      // Manual redirects: a github 30x for a renamed repo means the repo
      // exists (just moved); we treat that as accessible without
      // dereferencing the Location header. This blocks a hypothetical
      // pivot where github 30x'd to a non-github host (won't happen for
      // real github traffic, but the manual mode makes the property
      // structural rather than trust-based).
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'anc.dev-accessibility-probe/1' },
    });
    if (res.status === 404) {
      result = { state: 'not_accessible' };
    } else if (res.status >= 200 && res.status < 400) {
      // 2xx + 3xx both mean the repo is reachable. We don't follow the
      // 30x to confirm; see redirect comment above.
      result = { state: 'accessible' };
    } else {
      // 5xx, 401, 403, 429, etc. Fail-open: the DO will run its own probe
      // and produce an honest error code if the repo really is broken.
      result = { state: 'unknown', reason: 'non_2xx_non_404' };
    }
  } catch (err) {
    // AbortError when the timeout fires; everything else collapses to
    // network_error. In both cases the caller fails-open and dispatches
    // the DO. Differentiating timeout vs. network helps log analysis
    // without changing behavior.
    const reason = err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : 'network_error';
    result = { state: 'unknown', reason };
  } finally {
    clearTimeout(t);
  }

  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
