// Logo lookup for a scorecard card.
//
// Order: apple-touch-icon, PNG/SVG icon, og:image, then the conventional
// /apple-touch-icon.png and /favicon.svg paths. A fetch that exceeds the
// budget, returns a non-image, fails the SSRF check, or is a raster smaller
// than MIN_RASTER_PX on either side is skipped: the card draws the tile at
// 112px, and a 32px favicon scaled up reads as a blur. ./find-logo.ts falls
// back to the brand's published logo when nothing here qualifies.
//
// SVG logos are rasterized before they enter the card. ICO and WebP are
// skipped: resvg embeds PNG and JPEG only, and a failed embed must not
// fail the card.

import { logoCandidatesFromHtml, type ScoreOgLogo } from '../../shared/score-og';
import { AUDIT_USER_AGENT } from '../../shared/user-agents';
import { validatePublicUrl } from '../audit-web/ssrf';
import { rasterizeSvgLogo, type ScoreOgFonts } from './render';

const BUDGET_MS = 2_000;
const HTML_CAP = 200_000;
const IMAGE_CAP = 512 * 1024;
const MAX_CANDIDATES = 4;
const MAX_REDIRECTS = 3;
/** Smallest raster side the card's logo tile accepts. */
export const MIN_RASTER_PX = 128;

/** The subset of `fetch` the logo lookup calls. Narrower than `typeof fetch`, which carries runtime-only extras. */
export type LogoFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ResolveLogoInput = {
  pages: string[];
  fonts: ScoreOgFonts;
  fetchImpl?: LogoFetch;
  /** Wall-clock budget for the homepage and every icon attempt together. */
  budgetMs?: number;
  now?: () => number;
};

/** The first logo that draws, or null when the budget or the candidates run out. */
export async function resolveLogo(input: ResolveLogoInput): Promise<ScoreOgLogo | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const budgetMs = input.budgetMs ?? BUDGET_MS;
  const now = input.now ?? Date.now;
  const deadline = now() + budgetMs;
  for (const page of input.pages) {
    if (now() >= deadline) return null;
    const html = await fetchText(page, fetchImpl, remaining(deadline, now));
    if (html === null) continue;
    const candidates = logoCandidatesFromHtml(html.body, html.finalUrl).slice(0, MAX_CANDIDATES + 2);
    let tried = 0;
    for (const candidate of candidates) {
      if (tried >= MAX_CANDIDATES || now() >= deadline) return null;
      if (candidate.startsWith('data:')) {
        const embedded = await logoFromDataUri(candidate, input.fonts);
        if (embedded) return embedded;
        continue;
      }
      tried += 1;
      const file = await fetchBytes(candidate, fetchImpl, remaining(deadline, now));
      if (!file) continue;
      const logo = await logoFromBytes(file.bytes, file.contentType, input.fonts);
      if (logo) return logo;
    }
  }
  return null;
}

/** One image URL through the same guarded fetch, as a card-ready logo or null. */
export async function logoFromUrl(
  url: string,
  fonts: ScoreOgFonts,
  fetchImpl: LogoFetch,
  timeoutMs: number,
): Promise<ScoreOgLogo | null> {
  const file = await fetchBytes(url, fetchImpl, timeoutMs);
  if (!file) return null;
  return logoFromBytes(file.bytes, file.contentType, fonts);
}

function remaining(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now());
}

type TextBody = { body: string; finalUrl: string };

async function fetchText(rawUrl: string, fetchImpl: LogoFetch, timeoutMs: number): Promise<TextBody | null> {
  // Keep the first slice when the homepage is larger than the cap. Icon
  // links live in the head, and discarding the whole document drops them.
  const result = await fetchLimited(rawUrl, fetchImpl, timeoutMs, HTML_CAP, true);
  if (!result) return null;
  const type = result.contentType;
  if (type && !type.includes('text/html') && !type.includes('application/xhtml') && !type.includes('text/plain')) {
    return null;
  }
  return { body: new TextDecoder().decode(result.bytes), finalUrl: result.finalUrl };
}

async function fetchBytes(
  rawUrl: string,
  fetchImpl: LogoFetch,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const result = await fetchLimited(rawUrl, fetchImpl, timeoutMs, IMAGE_CAP);
  if (!result) return null;
  return { bytes: result.bytes, contentType: result.contentType };
}

type Limited = { bytes: Uint8Array; contentType: string; finalUrl: string };

/**
 * HTTPS GET through the same host check the web audit uses. Redirects are
 * followed by hand and re-checked. http is never requested. The body is
 * capped; a timeout aborts the socket.
 */
async function fetchLimited(
  rawUrl: string,
  fetchImpl: LogoFetch,
  timeoutMs: number,
  cap: number,
  truncate = false,
): Promise<Limited | null> {
  if (timeoutMs <= 0) return null;
  let current = publicHttps(rawUrl);
  if (!current) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': AUDIT_USER_AGENT,
            accept: 'image/png,image/jpeg,image/svg+xml,text/html;q=0.9,*/*;q=0.1',
          },
        });
      } catch {
        return null;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return null;
        }
        const validated = publicHttps(next.toString());
        if (!validated) return null;
        current = validated;
        continue;
      }
      if (!response.ok) return null;
      const bytes = await readCap(response, cap, truncate);
      if (!bytes) return null;
      return {
        bytes,
        contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
        finalUrl: current,
      };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function publicHttps(raw: string): string | null {
  const validated = validatePublicUrl(raw);
  if (!validated.ok || validated.url.protocol !== 'https:') return null;
  return validated.url.toString();
}

async function readCap(response: Response, cap: number, truncate: boolean): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength <= cap) return buf;
    return truncate ? buf.subarray(0, cap) : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const step = await reader.read();
      if (step.done) break;
      const room = cap - total;
      const piece = step.value.byteLength > room ? step.value.subarray(0, room) : step.value;
      chunks.push(piece);
      total += piece.byteLength;
      if (piece.byteLength < step.value.byteLength) {
        await reader.cancel();
        if (!truncate) return null;
        break;
      }
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function logoFromBytes(bytes: Uint8Array, contentType: string, fonts: ScoreOgFonts): Promise<ScoreOgLogo | null> {
  if (isPng(bytes) || contentType.includes('image/png')) {
    return isPng(bytes) && largeEnough(rasterSize(bytes)) ? { mime: 'image/png', bytes } : null;
  }
  if (isJpeg(bytes) || contentType.includes('image/jpeg')) {
    return isJpeg(bytes) && largeEnough(rasterSize(bytes)) ? { mime: 'image/jpeg', bytes } : null;
  }
  if (contentType.includes('image/svg') || looksLikeSvg(bytes)) {
    const text = new TextDecoder().decode(bytes);
    if (!text.includes('<svg')) return null;
    return rasterizeSvgLogo(text, fonts);
  }
  return null;
}

function largeEnough(size: { width: number; height: number } | null): boolean {
  return size !== null && size.width >= MIN_RASTER_PX && size.height >= MIN_RASTER_PX;
}

/** Pixel size from a PNG's IHDR or a JPEG's start-of-frame marker; null when the header cannot be read. */
export function rasterSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) {
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (!isJpeg(bytes)) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    offset += 2 + length;
  }
  return null;
}

async function logoFromDataUri(href: string, fonts: ScoreOgFonts): Promise<ScoreOgLogo | null> {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(href);
  if (!match) return null;
  const mime = (match[1] ?? '').toLowerCase();
  let payload: string;
  try {
    payload = match[2] ? atob(match[3].replace(/\s/g, '')) : decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) bytes[i] = payload.charCodeAt(i);
  if (bytes.byteLength > IMAGE_CAP) return null;
  return logoFromBytes(bytes, mime, fonts);
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml');
}
