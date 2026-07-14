// Worker route /score/live/<binary> + markdown twin.
//
// Reads the cached scorecard from R2, derives a minimal `tool` shape
// from `scorecard.tool` (no registry editorial fields — live-scored
// binaries by definition didn't match a registry entry), and hands off
// to the shared `buildScorecardBody` / `buildScorecardMarkdown` in
// `src/shared/scorecard-format.mjs`. The static `/score/<slug>` build
// path uses the SAME shared renderer — the `live` URL segment is purely
// informational about where the scorecard came from (R2 cache vs.
// committed `scorecards/<slug>.json`).
//
// Shell template comes from `dist/_internal/score-live-shell.html`,
// emitted by `src/build/build.mjs` from the same `emitShell()` helper
// that builds the static pages. Drift can't happen because the template
// is regenerated on every build.

import {
  buildScorecardBody as sharedBuildScorecardBody,
  buildScorecardMarkdown as sharedBuildScorecardMarkdown,
  escHtml as sharedEscHtml,
} from '../../shared/scorecard-format.mjs';
import { detectPreference } from '../accept';
import { SITE_SPEC_VERSION, SPEC_VERSION } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import { get as cacheGet, keyFor as cacheKeyFor } from './cache';
import { loadRegistryIndex, type RegistryIndex, resolveCuratedSlug, SHARE_URL_BINARY_RE } from './registry-lookup';

// Lazy-cached shell template — fetched on the first /score/live request
// in each isolate and held for the lifetime of the isolate. Workers re-
// instantiate isolates frequently so the bounded staleness is fine.
let shellTemplatePromise: Promise<string> | null = null;

async function loadShellTemplate(env: { ASSETS: Fetcher }): Promise<string> {
  if (!shellTemplatePromise) {
    shellTemplatePromise = (async () => {
      const res = await env.ASSETS.fetch(new Request('https://assets.internal/_internal/score-live-shell.html'));
      if (!res.ok) throw new Error(`score-live shell template missing (status ${res.status})`);
      return await res.text();
    })().catch((err) => {
      shellTemplatePromise = null;
      throw err;
    });
  }
  return shellTemplatePromise;
}

/** Test-only — drop the cached template. */
export function _resetShellTemplateCache(): void {
  shellTemplatePromise = null;
}

// ---------------------------------------------------------------------------
// Scorecard shape — minimal subset this file reads. The shared renderer
// accepts the full structurally-typed scorecard; this Worker-local type
// just narrows the few fields the wrapper itself touches (tool.name/
// binary, spec_version, badge.score_pct). See content/scorecard-schema.md
// for the complete shape.
// ---------------------------------------------------------------------------

type Scorecard = {
  spec_version?: string;
  tool?: { name?: string; binary?: string; version?: string | null };
  badge?: { score_pct?: number; eligible?: boolean; embed_markdown?: string };
};

// `sharedEscHtml` accepts `unknown`; this thin wrapper narrows to string
// so the freshness-marker template literal below stays readable.
function esc(s: string): string {
  return sharedEscHtml(s);
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

export type SummaryRenderInput = {
  scorecard: Scorecard;
  binary: string;
  ancVersion: string;
  toolVersion: string;
  // 'cache-hit' shows a quiet "(cached)" marker; 'live' does not.
  freshness: 'cache-hit' | 'live';
};

function buildFreshnessMarker(freshness: SummaryRenderInput['freshness']): string {
  return freshness === 'cache-hit'
    ? `<span class="live-score-summary__freshness" title="Served from cached scorecard">cached</span>`
    : `<span class="live-score-summary__freshness live-score-summary__freshness--live" title="Just scored">just scored</span>`;
}

const LIVE_BREADCRUMB = { href: '/', label: 'Score another' };

const LIVE_CTA_NOTE_HTML = `<a href="/install">Install <code>anc</code></a> first if you don't have it. Run <code>anc audit .</code> from inside the project for source-level and project-level audits.`;

/**
 * Build the HTML body for `/score/live/<binary>`. Thin wrapper over the
 * shared `buildScorecardBody` — passes a `tool` derived from the
 * scorecard (no registry editorial fields), a homepage breadcrumb, a
 * freshness marker, and suppresses the badge SVG preview (no curated
 * `/badge/<binary>.svg` exists for non-registry binaries).
 *
 * Identical section structure to `/score/<slug>` — the URL is the only
 * thing that signals "this came from the live cache."
 */
export function buildScoreSummaryBody(input: SummaryRenderInput): string {
  const { scorecard, binary, ancVersion, toolVersion, freshness } = input;
  const tool = {
    name: scorecard.tool?.name ?? binary,
    binary: scorecard.tool?.binary ?? binary,
  };
  const specVersion = scorecard.spec_version ?? SPEC_VERSION;
  const titleSuffix = `<span class="live-score-summary__version">${esc(toolVersion || '—')}</span>`;
  const headerSubline = `Binary <code>${esc(binary)}</code> · scored by anc ${esc(ancVersion)} · spec ${esc(specVersion)} ${buildFreshnessMarker(freshness)}`;

  return sharedBuildScorecardBody(tool, scorecard, {
    version: toolVersion,
    breadcrumb: LIVE_BREADCRUMB,
    titleSuffix,
    headerSubline,
    showBadgePreview: false,
    ctaNoteHtml: LIVE_CTA_NOTE_HTML,
  });
}

/**
 * Build the markdown body for `/score/live/<binary>.md`. Thin wrapper
 * over the shared `buildScorecardMarkdown` — same single source of truth
 * as the HTML body above. `baseUrl: 'https://anc.dev'` makes principle
 * links absolute because this surface is fetched cross-origin via
 * `Accept: text/markdown` (no `absolutifyMarkdownLinks` post-pass like
 * the static twin gets at build time).
 */
export function buildScoreSummaryMarkdown(input: SummaryRenderInput): string {
  const { scorecard, binary, ancVersion, toolVersion, freshness } = input;
  const tool = {
    name: scorecard.tool?.name ?? binary,
    binary: scorecard.tool?.binary ?? binary,
  };
  const specVersion = scorecard.spec_version ?? SPEC_VERSION;
  const headerLine = `# ${tool.name} ${toolVersion ? `(${toolVersion})` : ''}`.trim();
  const provenance = `Binary \`${binary}\` · scored by anc ${ancVersion} · spec ${specVersion} · ${freshness === 'cache-hit' ? 'cached' : 'just scored'}`;
  return sharedBuildScorecardMarkdown(tool, scorecard, {
    version: toolVersion,
    baseUrl: 'https://anc.dev',
    header: `${headerLine}\n\n${provenance}`,
  });
}

// ---------------------------------------------------------------------------
// Page renderer + Worker-route handler
// ---------------------------------------------------------------------------

// Same CSP shape applyHeaders sets on static pages — mirrored here because
// /score/live/<binary> bypasses the static asset pipeline. Turnstile
// directives stay because the share-URL surface links back to the
// homepage form, and CF Web Analytics directives stay because the
// beacon is injected on every HTML response when enabled at the zone
// level. Uniform CSP across HTML responses is easier to assert than
// per-page exceptions.
const LIVE_SCORE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  'frame-src https://challenges.cloudflare.com; ' +
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'self'";

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // 5 minutes at the edge with stale-while-revalidate matches the cache
  // policy elsewhere on the site. A re-score within the TTL still hits the
  // cache; after eviction, the page 404s until the next scoring event.
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': LIVE_SCORE_CSP,
} as const;

const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  'X-Robots-Tag': 'noindex',
} as const;

function substituteShell(
  template: string,
  fields: { title: string; description: string; canonicalPath: string; body: string },
): string {
  // Single-pass substitution — placeholders are well-known + author-fixed,
  // not user input, so no escape-injection risk on the placeholder side.
  // The `body` slot is built from escaped scorecard fields above.
  return template
    .replaceAll('{{TITLE}}', esc(fields.title))
    .replaceAll('{{DESCRIPTION}}', esc(fields.description))
    .replaceAll('{{CANONICAL_PATH}}', esc(fields.canonicalPath))
    .replaceAll('{{BODY}}', fields.body);
}

type LiveScoreEnv = CacheEnv & { ASSETS: Fetcher };

// Strict slug shape — shared with the handler's share-URL minting site
// (registry-lookup.ts) so a share_url the handler emits can never miss
// this route. Mirrors the registry-name validation in scorecards.mjs.
const BINARY_SLUG_RE = SHARE_URL_BINARY_RE;

export type LiveScorePathMatch = {
  binary: string;
  /** True for `/score/live/<binary>.md`, false for the canonical HTML path. */
  isMarkdown: boolean;
};

/**
 * Extract `<binary>` from `/score/live/<binary>` or `/score/live/<binary>.md`.
 * Returns null when the path doesn't match OR the slug fails the strict
 * shape check (no uppercase, no dots, no slashes, no leading hyphen,
 * bounded length). Tight regex matters here — this is the user-input
 * boundary for an R2 key lookup.
 *
 * URL pattern nests under the existing `/score/` namespace so the URL
 * hierarchy reads as: `/score/<tool>` (curated static) and
 * `/score/live/<binary>` (dynamic live-scored). The string "live" is
 * reserved as a registry name in scorecards.mjs so a future curated tool
 * named "live" can't collide.
 *
 * The two surfaces share routing because every HTML page on the site
 * carries a markdown twin (site-wide invariant). The handler picks the
 * response format from the suffix; Accept-header negotiation kicks in for
 * the suffix-less path.
 *
 * Returns just the binary string for caller convenience when the .md
 * distinction doesn't matter; use parseLiveScorePathMatch for the
 * structured form.
 */
export function parseLiveScorePath(pathname: string): string | null {
  return parseLiveScorePathMatch(pathname)?.binary ?? null;
}

export function parseLiveScorePathMatch(pathname: string): LiveScorePathMatch | null {
  const mdMatch = pathname.match(/^\/score\/live\/([^/]+)\.md$/);
  if (mdMatch) {
    return BINARY_SLUG_RE.test(mdMatch[1]) ? { binary: mdMatch[1], isMarkdown: true } : null;
  }
  const m = pathname.match(/^\/score\/live\/([^/]+)$/);
  if (!m) return null;
  return BINARY_SLUG_RE.test(m[1]) ? { binary: m[1], isMarkdown: false } : null;
}

/**
 * Handle a GET `/score/live/<binary>` (or `.md`) request. Returns:
 *   - 200 HTML / markdown with the rendered summary if R2 has a cached scorecard
 *   - 404 HTML / markdown if the cache is empty (no recent paste-and-score
 *     for this binary, or the 7-day lifecycle reaped the entry)
 *   - 405 for non-GET/HEAD methods
 *
 * Format selection:
 *   - `.md` suffix → markdown
 *   - no suffix + `Accept: text/markdown` (q-weighted) → markdown
 *   - otherwise → HTML
 */
export async function handleLiveScorePage(request: Request, env: LiveScoreEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { 'content-type': 'text/plain' } });
  }

  const url = new URL(request.url);
  const match = parseLiveScorePathMatch(url.pathname);
  if (!match) {
    return renderNotFound(env, '(invalid)', false);
  }

  const { binary } = match;
  // Content negotiation: explicit `.md` suffix always wins; otherwise
  // honor the Accept header (defaults to HTML when ambiguous, same as
  // the rest of the site).
  const wantMarkdown = match.isMarkdown || (!match.isMarkdown && detectPreference(request) === 'markdown');

  // Curated-tool redirect. The /score/live/<binary> surface is for
  // binaries NOT in the registry — registry-curated tools have a
  // canonical /score/<slug> page. The homepage POST flow already
  // short-circuits via the registry fast-path, but defense-in-depth:
  // any directly-constructed /score/live/<curated-binary> URL (or a
  // stale R2 cache entry for a binary that has since been added to
  // the registry) bounces here to the canonical page. Catches both
  // binary === entry.name (most tools) and binary === entry.binary
  // (alias entries like ripgrep/rg, ast-grep/sg). The .md suffix
  // and 5-minute cache match the rest of the site's redirect policy.
  let registryIndex: RegistryIndex | null = null;
  try {
    registryIndex = await loadRegistryIndex(env);
  } catch {
    // Asset fetch failed — proceed without the curated check rather
    // than 5xx the live path. A future request will retry.
  }
  const curatedSlug = registryIndex ? resolveCuratedSlug(binary, registryIndex) : null;
  if (curatedSlug) {
    const canonical = `/score/${curatedSlug}${wantMarkdown ? '.md' : ''}`;
    return new Response(null, {
      status: 301,
      headers: { Location: canonical, 'Cache-Control': 'public, max-age=300' },
    });
  }

  const cached = await cacheGet(env, cacheKeyFor(binary, SPEC_VERSION));
  if (!cached) {
    return renderNotFound(env, binary, wantMarkdown);
  }

  const renderInput: SummaryRenderInput = {
    scorecard: cached.scorecard as Scorecard,
    binary,
    ancVersion: cached.anc_version,
    toolVersion: cached.tool_version,
    freshness: 'cache-hit',
  };

  if (wantMarkdown) {
    const md = buildScoreSummaryMarkdown(renderInput);
    return new Response(md, { status: 200, headers: MARKDOWN_HEADERS });
  }

  const body = buildScoreSummaryBody(renderInput);

  const toolName = (cached.scorecard as Scorecard).tool?.name ?? binary;
  const pct = (cached.scorecard as Scorecard).badge?.score_pct ?? 0;
  const title = `${toolName} — Agent-Native Live Score`;
  const description = `${toolName} scored ${pct}% against the agent-native CLI standard (anc ${cached.anc_version}, spec ${SPEC_VERSION}). Live-scored binary, not a curated audit.`;
  const canonicalPath = `/score/live/${binary}`;

  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const html = substituteShell(template, { title, description, canonicalPath, body });
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

async function renderNotFound(env: LiveScoreEnv, binary: string, wantMarkdown: boolean): Promise<Response> {
  if (wantMarkdown) {
    const lines = [
      `# No live score for \`${binary}\` yet`,
      '',
      'Live-score URLs surface a cached scorecard from a recent paste-and-score run. If no one has scored this binary in the last 7 days, the cache is empty.',
      '',
      '## Score it now',
      '',
      'Paste the tool name, install command, or GitHub URL on the [homepage](https://anc.dev/) to score it. Once it scores, the share URL works.',
      '',
      `Or [install \`anc\`](https://anc.dev/install) and run \`anc audit ${binary}\` locally.`,
      '',
    ];
    return new Response(lines.join('\n'), { status: 404, headers: MARKDOWN_HEADERS });
  }

  const body = `<header class="live-score-summary__header">
  <h1>No live score for <code>${esc(binary)}</code> yet</h1>
  <p class="live-score-summary__meta">Live-score URLs surface a cached scorecard from a recent paste-and-score run. If no one has scored this binary in the last 7 days, the cache is empty.</p>
</header>
<section class="live-score-summary__cta">
  <h2>Score it now</h2>
  <p>Paste the tool name, install command, or GitHub URL on the <a href="/">homepage</a> to score it. Once it scores, the share URL works.</p>
  <p>Or <a href="/install">install <code>anc</code></a> and run <code>anc audit ${esc(binary)}</code> locally.</p>
</section>`;

  const title = `Not yet scored — anc.dev`;
  const description = `No cached live scorecard for ${binary}. Score it on the homepage or run anc audit locally.`;
  const canonicalPath = `/score/live/${binary}`;

  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const html = substituteShell(template, { title, description, canonicalPath, body });
  return new Response(html, { status: 404, headers: HTML_HEADERS });
}

// Statically referenced so unused-export linters keep these alive.
void SITE_SPEC_VERSION;
