// The logo a brand publishes for its domain, from context.dev's brand
// endpoint (https://docs.context.dev), for a card whose homepage offers no
// icon large enough. Code hosts are skipped: a lookup on github.com returns
// GitHub's own logo, not the project's.
//
// An answer about the domain settles the lookup, logos or not: a 2xx, or the
// 400 and 404 the API returns for a domain it does not know. Anything else
// (a timeout, a network error, a key or credit problem such as 401 or 402, a
// rate limit, a server error) says nothing about the domain and leaves it
// unsettled.

import type { LogoFetch } from './logo';

const BRAND_ENDPOINT = 'https://api.context.dev/v1/brand/retrieve';
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht', 'sourceforge.net']);
const MAX_URLS = 3;

type BrandLogo = {
  url?: unknown;
  type?: unknown;
  mode?: unknown;
  resolution?: { width?: unknown; height?: unknown };
};

export type BrandLogoUrls = { urls: string[]; settled: boolean };

const DOMAIN_ANSWER_STATUSES = new Set([400, 404]);

/** Brand logo URLs for a registrable domain, best first. Empty on a code host, a miss, or any failure. */
export async function brandLogoUrls(
  domain: string,
  apiKey: string,
  fetchImpl: LogoFetch,
  timeoutMs: number,
): Promise<BrandLogoUrls> {
  if (CODE_HOSTS.has(domain)) return { urls: [], settled: true };
  if (timeoutMs <= 0) return { urls: [], settled: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(BRAND_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'by_domain', domain }),
    });
    if (!res.ok) return { urls: [], settled: DOMAIN_ANSWER_STATUSES.has(res.status) };
    const body = (await res.json()) as { brand?: { logos?: unknown } };
    const logos = Array.isArray(body.brand?.logos) ? (body.brand.logos as BrandLogo[]) : [];
    const urls = logos
      .filter(
        (logo): logo is BrandLogo & { url: string } => typeof logo.url === 'string' && logo.url.startsWith('https://'),
      )
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, MAX_URLS)
      .map((logo) => logo.url);
    return { urls, settled: true };
  } catch {
    return { urls: [], settled: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Icons before wordmark logos, square before wide, self-contained backgrounds first, then larger. */
function rank(logo: BrandLogo): number {
  const width = typeof logo.resolution?.width === 'number' ? logo.resolution.width : 0;
  const height = typeof logo.resolution?.height === 'number' ? logo.resolution.height : 0;
  const aspect = height > 0 ? width / height : 0;
  const vector = typeof logo.url === 'string' && logo.url.endsWith('.svg');
  let score = Math.min(vector ? 1024 : Math.min(width, height), 1024);
  if (logo.type === 'icon') score += 4096;
  if (aspect >= 0.8 && aspect <= 1.25) score += 2048;
  if (logo.mode === 'has_opaque_background') score += 1024;
  return score;
}
