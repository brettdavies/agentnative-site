// A card's brand logo, looked up once per homepage host: the stored result
// in SCORE_CACHE, else the homepage's own icon (./logo.ts), else the brand's
// published logo for the registrable domain (./brand-logo.ts). The outcome,
// a logo or a miss, is stored under og/logo/<sha256(host)>, keyed by host
// because docs.example.com and example.com can carry different icons. A miss
// is stored only when every lookup that ran settled: one cut short by a
// timeout or an outage would otherwise pin the tile for the host for 30 days.
// The brand API's own answer is stored apart, under og/brand/<sha256(domain)>,
// once it settles, so the paid lookup runs at most once per registrable
// domain until the og-30day-ttl lifecycle rule expires it, even while a slow
// homepage keeps the host's outcome unsettled.

import { getDomain } from 'tldts';
import type { LogoSource } from '../shared/og-render';
import type { ScoreOgLogo } from '../shared/score-og';
import { sha256Hex } from '../worker/audit-web/cache';
import { type BrandLogoUrls, brandLogoUrls } from './brand-logo';
import { type LogoFetch, logoFromUrl, resolveLogo } from './logo';
import type { ScoreOgFonts } from './render';

const STORED_LOGO_PREFIX = 'og/logo/';
const STORED_BRAND_PREFIX = 'og/brand/';
const BRAND_BUDGET_MS = 3_000;

/** `settled` is false when a lookup was cut short, so the tile it fell back to is not the host's answer. */
export type FoundLogo = { logo: ScoreOgLogo | null; source: LogoSource; settled: boolean };

export type FindLogoInput = {
  pages: string[];
  fonts: ScoreOgFonts;
  bucket: R2Bucket;
  brandApiKey?: string;
  fetchImpl?: LogoFetch;
  budgetMs?: number;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export async function findLogo(input: FindLogoInput): Promise<FoundLogo> {
  const host = hostOf(input.pages[0]);
  const key = host ? `${STORED_LOGO_PREFIX}${await sha256Hex(host)}` : null;
  if (key) {
    const stored = await readStoredLogo(input.bucket, key).catch(() => undefined);
    if (stored !== undefined) return { logo: stored, source: stored ? 'stored' : 'tile', settled: true };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const homepage = await resolveLogo({
    pages: input.pages,
    fonts: input.fonts,
    fetchImpl,
    budgetMs: input.budgetMs,
    now: input.now,
  });
  let logo = homepage.logo;
  let cutShort = homepage.cutShort;
  let source: LogoSource = logo ? 'homepage' : 'tile';
  const domain = host ? getDomain(host) : null;
  if (!logo && domain && input.brandApiKey) {
    const brand = await brandAnswer(input, domain, input.brandApiKey, fetchImpl);
    cutShort ||= !brand.settled;
    for (const url of brand.urls) {
      const found = await logoFromUrl(url, input.fonts, fetchImpl, BRAND_BUDGET_MS);
      cutShort ||= found.cutShort;
      if (found.logo) {
        logo = found.logo;
        source = 'brand';
        break;
      }
    }
  }
  const settled = logo !== null || !cutShort;

  if (key && host && settled) {
    const store = storeLogo(input.bucket, key, host, logo, source).catch(() => {});
    if (input.waitUntil) input.waitUntil(store);
    else await store;
  }
  return { logo, source, settled };
}

async function brandAnswer(
  input: FindLogoInput,
  domain: string,
  apiKey: string,
  fetchImpl: LogoFetch,
): Promise<BrandLogoUrls> {
  const key = `${STORED_BRAND_PREFIX}${await sha256Hex(domain)}`;
  const stored = await readStoredBrand(input.bucket, key).catch(() => null);
  if (stored) return { urls: stored, settled: true };
  const answer = await brandLogoUrls(domain, apiKey, fetchImpl, BRAND_BUDGET_MS);
  if (answer.settled) {
    const store = input.bucket
      .put(key, new TextEncoder().encode(JSON.stringify(answer.urls)), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { domain },
      })
      .catch(() => {});
    if (input.waitUntil) input.waitUntil(store);
    else await store;
  }
  return answer;
}

/** The stored brand answer's logo URLs, or null when none is stored or it does not parse. */
async function readStoredBrand(bucket: R2Bucket, key: string): Promise<string[] | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
  return Array.isArray(parsed) && parsed.every((url) => typeof url === 'string') ? parsed : null;
}

function hostOf(page: string | undefined): string | null {
  if (!page) return null;
  try {
    return new URL(page).hostname || null;
  } catch {
    return null;
  }
}

/** The stored logo, null for a stored miss, undefined when nothing is stored. */
async function readStoredLogo(bucket: R2Bucket, key: string): Promise<ScoreOgLogo | null | undefined> {
  const object = await bucket.get(key);
  if (!object) return undefined;
  if (object.customMetadata?.miss === '1') return null;
  const mime = object.httpMetadata?.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { mime, bytes: new Uint8Array(await object.arrayBuffer()) };
}

async function storeLogo(
  bucket: R2Bucket,
  key: string,
  host: string,
  logo: ScoreOgLogo | null,
  source: LogoSource,
): Promise<void> {
  if (logo) {
    await bucket.put(key, logo.bytes, { httpMetadata: { contentType: logo.mime }, customMetadata: { host, source } });
  } else {
    await bucket.put(key, new Uint8Array(0), { customMetadata: { host, miss: '1' } });
  }
}
