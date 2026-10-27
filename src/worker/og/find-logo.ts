// A card's brand logo, looked up once per registrable domain: the stored
// result in SCORE_CACHE, else the homepage's own icon (./logo.ts), else the
// brand's published logo (./brand-logo.ts). The outcome, a logo or a miss,
// is stored under og/logo/<sha256(domain)> so the paid brand lookup runs at
// most once per domain until the og-30day-ttl lifecycle rule expires it.

import { getDomain } from 'tldts';
import type { ScoreOgLogo } from '../../shared/score-og';
import { sha256Hex } from '../audit-web/cache';
import { brandLogoUrls } from './brand-logo';
import { type LogoFetch, logoFromUrl, resolveLogo } from './logo';
import type { ScoreOgFonts } from './render';

const STORED_LOGO_PREFIX = 'og/logo/';
const BRAND_BUDGET_MS = 3_000;

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

export async function findLogo(input: FindLogoInput): Promise<ScoreOgLogo | null> {
  const domain = registrableDomain(input.pages[0]);
  const key = domain ? `${STORED_LOGO_PREFIX}${await sha256Hex(domain)}` : null;
  if (key) {
    const stored = await readStoredLogo(input.bucket, key).catch(() => undefined);
    if (stored !== undefined) return stored;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let logo = await resolveLogo({
    pages: input.pages,
    fonts: input.fonts,
    fetchImpl,
    budgetMs: input.budgetMs,
    now: input.now,
  });
  if (!logo && domain && input.brandApiKey) {
    const urls = await brandLogoUrls(domain, input.brandApiKey, fetchImpl, BRAND_BUDGET_MS);
    for (const url of urls) {
      logo = await logoFromUrl(url, input.fonts, fetchImpl, BRAND_BUDGET_MS);
      if (logo) break;
    }
  }

  if (key) {
    const store = storeLogo(input.bucket, key, domain as string, logo).catch(() => {});
    if (input.waitUntil) input.waitUntil(store);
    else await store;
  }
  return logo;
}

function registrableDomain(page: string | undefined): string | null {
  if (!page) return null;
  try {
    return getDomain(new URL(page).hostname) ?? null;
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

async function storeLogo(bucket: R2Bucket, key: string, domain: string, logo: ScoreOgLogo | null): Promise<void> {
  if (logo) {
    await bucket.put(key, logo.bytes, { httpMetadata: { contentType: logo.mime }, customMetadata: { domain } });
  } else {
    await bucket.put(key, new Uint8Array(0), { customMetadata: { domain, miss: '1' } });
  }
}
