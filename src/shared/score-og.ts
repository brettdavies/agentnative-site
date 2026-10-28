// Scorecard Open Graph card: the path, the cache key, the alt text, and the
// SVG. The Worker rasterizes the SVG; this module stays free of wasm so the
// build and the unit tests can call it.
//
// The URL carries everything the card shows: the rounded score, the spec
// version, the edition (a website's audit date, a CLI's tool version, a
// branch's commit), and the template version
// (`/og/score/<target>/s82-v0.6.0-d20261026-r1.png`). Any change to the card
// mints a new URL, so an edge cache of the previous PNG does not have to be
// purged to stop lying. `pending` and `unscored` are the two keys for a card
// that has no number yet.

import { isResultTarget, SCORE_PREFIX, scorePath } from './audit-routes';
import { escHtml } from './esc-html';
import { shortDate } from './result-spine';

export const SCORE_OG_WIDTH = 1200;
export const SCORE_OG_HEIGHT = 630;
export const SCORE_OG_PREFIX = '/og/score/';

/** Family names as the bundled card fonts declare them; resvg draws the default face for any other name. */
export const SCORE_OG_FONT = { sans: 'Uncut Sans', mono: 'Monaspace Xenon Medium' } as const;

/** Bump on any change to the card's layout or motion, so every card gets a new URL. */
export const SCORE_OG_TEMPLATE = 1;

/** Dark-mode foundation tokens, resolved to sRGB. SVG cannot read the oklch variables. */
const COLOR = {
  bg: '#060a0e',
  raised: '#0d1218',
  tile: '#f3f2ed',
  fg: '#f3f2ed',
  muted: '#818a94',
  secondary: '#9199a2',
  accent: '#6dbdff',
  track: '#1d252d',
  high: '#5ac576',
  mid: '#f3ae58',
  low: '#f9776e',
  highBar: '#4fce74',
  midBar: '#ffb147',
  lowBar: '#f4514c',
} as const;

const NAME_MAX_WIDTH = 700;
const SUBTITLE_MAX_CHARS = 42;

const KEY_RE =
  /^(?:pending|unscored|s(?:100|[1-9]?\d)-v\d+(?:\.\d+){0,3}(?:-(?:d\d{8}|t[a-z0-9._]{1,24}|h[0-9a-f]{8}|g[0-9a-f]{7}))?-r\d{1,4})$/;

const SPEC_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
/** anc records a tool's whole `--version` line (`curl 8.22.0 (x86_64…)`); the card shows the version number in it. */
const VERSION_TOKEN_RE = /\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.]*)?/;
const KEY_SAFE_VERSION_RE = /^[0-9a-z][0-9a-z.-]{0,23}$/;
const EDITION_LABEL_MAX = 26;

export type ScoreOgLane = 'web' | 'cli';

export type ScoreOgLogo = {
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
};

export type ScoreOgCard = {
  name: string;
  /** Domain, binary, or other second line. Omitted when it would repeat `name`. */
  subtitle: string | null;
  lane: ScoreOgLane;
  /** Null when the card is pending or unscored. */
  scorePct: number | null;
  pending: boolean;
  specVersion: string | null;
  /** What distinguishes this scorecard from the target's others; null when its record carries none. */
  edition: ScoreOgEdition | null;
  logo: ScoreOgLogo | null;
};

/** `token` goes in the key; `label` is what the card's footer shows. */
export type ScoreOgEdition = { token: string; label: string };

export type ScoreOgEditionInput = {
  lane: ScoreOgLane;
  scoredAt?: string | null;
  toolVersion?: string | null;
  sourceSha?: string | null;
};

/**
 * A website's edition is its UTC audit date. A CLI's is its source commit
 * when it was built from a branch, else its tool version.
 */
export function scoreOgEdition(input: ScoreOgEditionInput): ScoreOgEdition | null {
  if (input.lane === 'web') {
    const date = shortDate(input.scoredAt);
    return date ? { token: `d${date.replaceAll('-', '')}`, label: date } : null;
  }
  const sha = input.sourceSha?.trim().toLowerCase() ?? '';
  if (/^[0-9a-f]{7,}$/.test(sha)) return { token: `g${sha.slice(0, 7)}`, label: sha.slice(0, 7) };
  const version = input.toolVersion?.match(VERSION_TOKEN_RE)?.[0];
  if (!version) return null;
  const token = KEY_SAFE_VERSION_RE.test(version) ? `t${version.replaceAll('-', '_')}` : `h${fnv1a32(version)}`;
  const shown = `v${version}`;
  const label = shown.length > EDITION_LABEL_MAX ? `${shown.slice(0, EDITION_LABEL_MAX - 1)}…` : shown;
  return { token, label };
}

export type ScoreOgKeyInput = {
  scorePct: number | null;
  specVersion: string | null;
  pending?: boolean;
  edition: ScoreOgEdition | null;
};

/** The filename stem. `pending` wins over a number: an in-flight run has no score yet. */
export function scoreOgKey(input: ScoreOgKeyInput): string {
  if (input.pending) return 'pending';
  const rounded = roundedScore(input.scorePct);
  if (rounded === null) return 'unscored';
  const spec = input.specVersion?.trim() ?? '';
  const safe = SPEC_VERSION_RE.test(spec) ? spec : '0';
  const edition = input.edition ? `-${input.edition.token}` : '';
  return `s${rounded}-v${safe}${edition}-r${SCORE_OG_TEMPLATE}`;
}

export function isScoreOgKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** True when the key names a finished score, so the PNG can be cached immutably. */
export function isImmutableScoreOgKey(key: string): boolean {
  return key.startsWith('s');
}

export function isScoreOgPath(pathname: string): boolean {
  return pathname === '/og/score' || pathname.startsWith(SCORE_OG_PREFIX);
}

/** Site-relative path. `scorePath` rejects a target the result route would not serve. */
export function scoreOgPath(target: string, key: string): string {
  if (!isScoreOgKey(key)) throw new RangeError(`not a scorecard OG key: ${key}`);
  const suffix = scorePath(target).slice(SCORE_PREFIX.length);
  return `${SCORE_OG_PREFIX}${suffix}/${key}.png`;
}

export function scoreOgUrl(base: string, target: string, key: string): string {
  return `${base.replace(/\/$/, '')}${scoreOgPath(target, key)}`;
}

export type ParsedScoreOgPath = { target: string; key: string };

export function parseScoreOgPath(pathname: string): ParsedScoreOgPath | null {
  if (!pathname.startsWith(SCORE_OG_PREFIX) || !pathname.endsWith('.png')) return null;
  const rest = pathname.slice(SCORE_OG_PREFIX.length, -'.png'.length);
  const segments = rest.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) return null;
  const key = segments.pop();
  if (!key || !isScoreOgKey(key)) return null;
  const decoded = segments.map(decodeSegment);
  if (decoded.some((segment) => segment === null || segment.includes('/'))) return null;
  const target = (decoded as string[]).join('/');
  if (!isResultTarget(target)) return null;
  return { target, key };
}

/** Alt text for the scorecard card. Names the same number the page shows. */
export function scoreOgAlt(input: {
  name: string;
  lane: ScoreOgLane;
  scorePct: number | null;
  specVersion: string | null;
  pending?: boolean;
}): string {
  const surface = input.lane === 'web' ? 'agent-readiness audit' : 'agent-native CLI scorecard';
  if (input.pending) return `${input.name}: audit in progress. ${surface} on anc.dev.`;
  const rounded = roundedScore(input.scorePct);
  if (rounded === null) return `${input.name}: unscored. ${surface} on anc.dev.`;
  const spec = specLabel(input.specVersion);
  return `${input.name} scored ${rounded}%${spec ? ` against spec ${spec}` : ''}. ${surface} on anc.dev.`;
}

const APEX_TLDS = new Set(['com', 'dev', 'io', 'org', 'net', 'app', 'ai', 'co', 'so', 'sh', 'fyi', 'xyz']);

/**
 * Brand line for a website host. A seed label wins. An apex domain
 * (`railway.com`) becomes a title-cased label with the host as the subtitle.
 * Anything else keeps the host as the only line.
 */
export function brandName(
  host: string,
  friendly: string | null | undefined,
): { name: string; subtitle: string | null } {
  const domain = host.trim();
  const label = friendly?.trim();
  if (label && label.toLowerCase() !== domain.toLowerCase()) return { name: label, subtitle: domain };
  const parts = domain.split('.');
  if (parts.length === 2 && APEX_TLDS.has(parts[1].toLowerCase()) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(parts[0])) {
    const brand = parts[0]
      .split('-')
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
      .join(' ');
    return { name: brand, subtitle: domain };
  }
  return { name: domain, subtitle: null };
}

/** Two-letter tile for a name with no usable logo. */
export function wordmarkInitials(name: string): string {
  const cleaned = name.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const parts = cleaned.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const alnum = cleaned.replace(/[^A-Za-z0-9]/g, '');
  const letters = alnum.slice(0, 2);
  return (letters || '?').toUpperCase();
}

export type FittedLine = { text: string; fontSize: number };

/** Shrink, then truncate, so a long name stays inside the lockup column. */
export function fitName(text: string): FittedLine {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sizeFor = (value: string): number => {
    let size = 68;
    while (size > 36 && value.length * size * 0.56 > NAME_MAX_WIDTH) size -= 2;
    return size;
  };
  let shown = clean;
  let fontSize = sizeFor(shown);
  if (shown.length * fontSize * 0.56 > NAME_MAX_WIDTH) {
    while (shown.length > 1 && shown.length * 36 * 0.56 > NAME_MAX_WIDTH) shown = shown.slice(0, -1);
    shown = `${shown.slice(0, -1).trimEnd()}…`;
    fontSize = sizeFor(shown);
  }
  return { text: shown, fontSize };
}

/**
 * The CLI lockup. A curated page is named by its registry slug (`ripgrep`),
 * with the binary as the second line when it differs. A live card uses the
 * scorecard's tool name, then the request target.
 */
export function cliOgIdentity(
  target: string,
  tool: { name?: string | null; binary?: string | null } | null | undefined,
  curatedSlug?: string | null,
): { name: string; subtitle: string | null } {
  const slug = curatedSlug?.trim();
  const toolName = tool?.name?.trim();
  const binary = tool?.binary?.trim();
  const name = slug || toolName || target;
  const subtitle = binary && binary !== name ? binary : target !== name ? target : null;
  return { name, subtitle };
}

export function fitSubtitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= SUBTITLE_MAX_CHARS) return clean;
  return `${clean.slice(0, SUBTITLE_MAX_CHARS - 1).trimEnd()}…`;
}

type RankedLogo = { url: string; rank: number };

/**
 * Icon URLs from a fetched homepage, best first. Apple touch icons and PNG
 * icons outrank `og:image` (usually a wide social card) and `.ico`.
 */
export function logoCandidatesFromHtml(html: string, pageUrl: string): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const ranked: RankedLogo[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = attrs(tag[0]);
    const rel = attr.rel ?? '';
    const href = attr.href;
    if (!href) continue;
    const rank = linkRank(rel, attr.type ?? '', attr.sizes ?? '', href);
    if (rank === null) continue;
    const url = resolveHttpUrl(href, page);
    if (url) ranked.push({ url, rank });
  }
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = attrs(tag[0]);
    const key = `${attr.property ?? ''} ${attr.name ?? ''}`.toLowerCase();
    const content = attr.content;
    if (!content) continue;
    let rank: number | null = null;
    if (key.includes('og:image')) rank = 800;
    else if (key.includes('twitter:image')) rank = 700;
    if (rank === null) continue;
    const url = resolveHttpUrl(content, page);
    if (url) ranked.push({ url, rank });
  }
  const origin = page.origin;
  ranked.push({ url: `${origin}/apple-touch-icon.png`, rank: 400 });
  ranked.push({ url: `${origin}/favicon.svg`, rank: 350 });
  ranked.push({ url: `${origin}/favicon.ico`, rank: 100 });
  ranked.sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of ranked) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item.url);
  }
  return out;
}

/** The 1200×630 card. `logo` is already a PNG or JPEG; SVG logos are rasterized by the caller. */
export function renderScoreOgSvg(card: ScoreOgCard): string {
  const name = fitName(card.name);
  const subtitle = card.subtitle ? fitSubtitle(card.subtitle) : null;
  const rounded = card.pending ? null : roundedScore(card.scorePct);
  const scoreText = card.pending ? 'Pending' : rounded === null ? 'Unscored' : `${rounded}%`;
  const scoreSize = rounded === null ? 56 : 112;
  const scoreColor = rounded === null ? COLOR.muted : bandColor(rounded);
  const bar = rounded === null ? COLOR.track : barColor(rounded);
  const meterWidth = rounded === null ? 0 : Math.round((rounded / 100) * 1072);
  const lane = card.lane === 'web' ? 'website audit' : 'CLI scorecard';
  const footerTail = card.edition ? `${lane}  ·  ${card.edition.label}` : lane;
  const logo = logoMarkup(card.logo, wordmarkInitials(card.name));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SCORE_OG_WIDTH}" height="${SCORE_OG_HEIGHT}" viewBox="0 0 ${SCORE_OG_WIDTH} ${SCORE_OG_HEIGHT}">
  <rect width="${SCORE_OG_WIDTH}" height="${SCORE_OG_HEIGHT}" fill="${COLOR.bg}"/>
  <g transform="translate(64 48) scale(1.75)">
    <rect width="32" height="32" rx="6" fill="${COLOR.accent}"/>
    <g fill="none" stroke="${COLOR.bg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9,10 15,16 9,22"/>
      <line x1="17" y1="23" x2="24" y2="23"/>
    </g>
  </g>
  <text x="136" y="82" fill="${COLOR.accent}" font-family="${SCORE_OG_FONT.mono}" font-size="28">anc.dev</text>
  <text x="1136" y="64" text-anchor="end" fill="${COLOR.muted}" font-family="${SCORE_OG_FONT.mono}" font-size="20">SCORE</text>
  <text x="1136" y="168" text-anchor="end" fill="${scoreColor}" font-family="${SCORE_OG_FONT.sans}" font-weight="700" font-size="${scoreSize}">${escHtml(scoreText)}</text>
  <g transform="translate(64 230) scale(3.5)">
    <rect width="32" height="32" rx="6" fill="${COLOR.accent}"/>
    <g fill="none" stroke="${COLOR.bg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9,10 15,16 9,22"/>
      <line x1="17" y1="23" x2="24" y2="23"/>
    </g>
  </g>
  <text x="196" y="302" text-anchor="middle" fill="${COLOR.secondary}" font-family="${SCORE_OG_FONT.sans}" font-weight="600" font-size="48">×</text>
  ${logo}
  <text x="400" y="${subtitle ? 286 : 310}" fill="${COLOR.fg}" font-family="${SCORE_OG_FONT.sans}" font-weight="600" font-size="${name.fontSize}">${escHtml(name.text)}</text>
  ${subtitle ? `<text x="400" y="334" fill="${COLOR.muted}" font-family="${SCORE_OG_FONT.mono}" font-size="26">${escHtml(subtitle)}</text>` : ''}
  <rect x="64" y="430" width="1072" height="16" rx="8" fill="${COLOR.track}"/>
  <rect x="64" y="430" width="${meterWidth}" height="16" rx="8" fill="${bar}"/>
  <text x="64" y="560" font-family="${SCORE_OG_FONT.mono}" font-size="24"><tspan fill="${COLOR.accent}">anc.dev</tspan><tspan fill="${COLOR.muted}"> · ${escHtml(footerTail)}</tspan></text>
</svg>`;
}

function logoMarkup(logo: ScoreOgLogo | null, initials: string): string {
  const x = 248;
  const y = 230;
  const size = 112;
  if (!logo) {
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="22" fill="${COLOR.raised}" stroke="${COLOR.accent}" stroke-width="3"/>
  <text x="${x + size / 2}" y="${y + 70}" text-anchor="middle" fill="${COLOR.accent}" font-family="${SCORE_OG_FONT.sans}" font-weight="700" font-size="42">${escHtml(initials)}</text>`;
  }
  const mime = logo.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const href = `data:${mime};base64,${bytesToBase64(logo.bytes)}`;
  return `<clipPath id="brand-logo"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="22"/></clipPath>
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="22" fill="${COLOR.tile}"/>
  <image href="${href}" xlink:href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" clip-path="url(#brand-logo)"/>`;
}

function specLabel(specVersion: string | null): string | null {
  return specVersion && SPEC_VERSION_RE.test(specVersion) ? `v${specVersion}` : null;
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function roundedScore(scorePct: number | null): number | null {
  if (scorePct === null || !Number.isFinite(scorePct)) return null;
  const rounded = Math.round(scorePct);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

function bandColor(pct: number): string {
  if (pct >= 80) return COLOR.high;
  if (pct >= 50) return COLOR.mid;
  return COLOR.low;
}

function barColor(pct: number): string {
  if (pct >= 80) return COLOR.highBar;
  if (pct >= 50) return COLOR.midBar;
  return COLOR.lowBar;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

function linkRank(rel: string, type: string, sizes: string, href: string): number | null {
  const tokens = rel.toLowerCase().split(/\s+/);
  const size = Number.parseInt(sizes, 10);
  const sizeBoost = Number.isFinite(size) ? size : 0;
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 3000 + sizeBoost;
  if (tokens.includes('icon') || tokens.includes('shortcut')) {
    const kind = `${type} ${href}`.toLowerCase();
    const base = kind.includes('svg')
      ? 2500
      : kind.includes('png')
        ? 2000
        : kind.includes('icon') || kind.endsWith('.ico') || kind.includes('.ico?')
          ? 400
          : 1500;
    return base + sizeBoost;
  }
  return null;
}

function resolveHttpUrl(href: string, page: URL): string | null {
  if (href.startsWith('data:')) return href.length <= 48_000 ? href : null;
  try {
    const url = new URL(href, page);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
