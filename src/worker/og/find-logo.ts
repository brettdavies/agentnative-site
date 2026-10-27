// A card's brand logo, looked up once per homepage host: the stored result
// in SCORE_CACHE, else the homepage's own icon (./logo.ts), else the brand's
// published logo for the registrable domain (./brand-logo.ts). The outcome,
// a logo or a miss, is stored under og/logo/<sha256(host)>, keyed by host
// because docs.example.com and example.com can carry different icons, so
// the paid brand lookup runs at most once per host until the og-30day-ttl
// lifecycle rule expires it.

import { getDomain } from 'tldts';
import type { ScoreOgLogo } from '../../shared/score-og';
import { sha256Hex } from '../audit-web/cache';
import { brandLogoUrls } from './brand-logo';
import { type LogoFetch, logoFromUrl, resolveLogo } from './logo';
import type { ScoreOgFonts } from './render';

const STORED_LOGO_PREFIX = 'og/logo/';
const BRAND_BUDGET_MS = 3_000;

/** Where the card's logo came from: drawn into the `x-anc-card-logo` response header. */
export type LogoSource = 'homepage' | 'brand' | 'stored' | 'tile';

export type FoundLogo = { logo: ScoreOgLogo | null; source: LogoSource };

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
    if (stored !== undefined) return { logo: stored, source: stored ? 'stored' : 'tile' };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let logo = await resolveLogo({
    pages: input.pages,
    fonts: input.fonts,
    fetchImpl,
    budgetMs: input.budgetMs,
    now: input.now,
  });
  let source: LogoSource = logo ? 'homepage' : 'tile';
  const domain = host ? getDomain(host) : null;
  if (!logo && domain && input.brandApiKey) {
    const urls = await brandLogoUrls(domain, input.brandApiKey, fetchImpl, BRAND_BUDGET_MS);
    for (const url of urls) {
      logo = await logoFromUrl(url, input.fonts, fetchImpl, BRAND_BUDGET_MS);
      if (logo) {
        source = 'brand';
        break;
      }
    }
  }

  if (key && host) {
    const store = storeLogo(input.bucket, key, host, logo, source).catch(() => {});
    if (input.waitUntil) input.waitUntil(store);
    else await store;
  }
  return { logo, source };
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
