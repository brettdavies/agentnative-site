// Server-side renderer for /score/live/<binary> + markdown twin.
//
// Reads the cached scorecard from R2 and emits either:
//
//   - HTML at /score/live/<binary> — top-3 issues + score badge + CTA,
//     wrapped in the site shell (build-emitted template asset).
//   - Markdown at /score/live/<binary>.md OR Accept: text/markdown — same
//     content, plain markdown twin so agents pasting `Accept:
//     text/markdown` get a clean document. Mirrors the site-wide
//     "every HTML page has a markdown twin" invariant.
//
// Skips the full check table + per-tool metadata blocks the static
// `/score/<tool>` page carries — this is a paste-and-share surface, not
// a deep-dive page.
//
// Shell template comes from `dist/_internal/score-live-shell.html`,
// emitted by `src/build/build.mjs` from the same `emitShell()` helper
// that builds the static pages. Drift can't happen because the template
// is regenerated on every build.

import {
  extractTopIssues,
  formatAuditTableMarkdownLines,
  groupToPrincipleNum,
  escHtml as sharedEscHtml,
} from '../../shared/scorecard-format.mjs';
import { detectPreference } from '../accept';
import { SITE_SPEC_VERSION, SPEC_VERSION } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import { get as cacheGet, keyFor as cacheKeyFor } from './cache';
import { SHARE_URL_BINARY_RE } from './registry-lookup';

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
// Scorecard shape — minimal subset the summary renderer reads. Status covers
// the schema 0.6 7-status taxonomy; only `fail`/`warn` reach the issue
// renderer (via extractTopIssues), so the extra values are accepted but never
// surfaced here. See content/scorecard-schema.md.
// ---------------------------------------------------------------------------

type CheckResult = {
  status: 'pass' | 'warn' | 'fail' | 'opt_out' | 'n_a' | 'skip' | 'error';
  label: string;
  group: string;
  evidence: string | null;
};

type Scorecard = {
  schema_version?: string;
  tool?: { name?: string; binary?: string; version?: string | null };
  target?: { kind?: string; command?: string; path?: string | null };
  badge?: { score_pct?: number; eligible?: boolean };
  results?: CheckResult[];
  audience?: string | null;
  audit_profile?: string | null;
};

// HTML escape + top-issues extraction + principle-number derivation all
// come from src/shared/scorecard-format.mjs so the Worker + build use the
// same primitives. `sharedEscHtml` accepts `unknown`; this thin wrapper
// narrows to string so callsites stay readable.
function esc(s: string): string {
  return sharedEscHtml(s);
}

// principle-num derivation uses the shared `groupToPrincipleNum` (above).

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

/**
 * Build the HTML body for `/score/live/<binary>`. Reuses the visual rhythm
 * of `buildScorecardBody` in `scorecards-render.mjs` but trims to the
 * summary surface: header + score badge + top-3 issues + install-anc CTA.
 * No full check table; no per-tool meta block.
 */
export function buildScoreSummaryBody(input: SummaryRenderInput): string {
  const { scorecard, binary, ancVersion, toolVersion, freshness } = input;
  const toolName = scorecard.tool?.name ?? binary;
  const pct = scorecard.badge?.score_pct ?? 0;
  const issues = extractTopIssues(scorecard);
  const freshnessMarker =
    freshness === 'cache-hit'
      ? `<span class="live-score-summary__freshness" title="Served from cached scorecard">cached</span>`
      : `<span class="live-score-summary__freshness live-score-summary__freshness--live" title="Just scored">just scored</span>`;

  const issuesBlock =
    issues.length === 0
      ? `<section class="live-score-summary__issues live-score-summary__issues--clean">
  <h2>Status</h2>
  <p>No failing or warning checks in this scorecard.</p>
</section>`
      : `<section class="live-score-summary__issues">
  <h2>Top issues</h2>
  <ul class="issue-list">
${issues
  .map((issue) => {
    const pNum = groupToPrincipleNum(issue.group);
    const statusClass = issue.status === 'fail' ? 'issue--fail' : 'issue--warn';
    const groupLink = pNum ? `<a href="/p${pNum}">${esc(issue.group)}</a>` : esc(issue.group);
    const evidence = issue.evidence ? `<span class="issue__evidence">${esc(issue.evidence)}</span>` : '';
    return `    <li class="issue ${statusClass}">
      <span class="issue__status">${esc(issue.status.toUpperCase())}</span>
      <span class="issue__label">${esc(issue.label)}</span>
      <span class="issue__group">${groupLink}</span>
      ${evidence}
    </li>`;
  })
  .join('\n')}
  </ul>
</section>`;

  return `<nav class="scorecard-breadcrumb" aria-label="Breadcrumb">
  <a href="/">&larr; Score another</a>
</nav>
<header class="live-score-summary__header">
  <h1>${esc(toolName)} <span class="live-score-summary__version">${esc(toolVersion || '—')}</span></h1>
  <p class="live-score-summary__meta">
    Binary <code>${esc(binary)}</code> · scored by anc ${esc(ancVersion)} · spec ${esc(SPEC_VERSION)} ${freshnessMarker}
  </p>
</header>
<section class="live-score-summary__score">
  <div class="scorecard-score-badge">
    <span class="scorecard-score-badge__pct">${pct}%</span>
    <span class="scorecard-score-badge__label">pass rate</span>
  </div>
</section>
${issuesBlock}
<section class="live-score-summary__cta">
  <h2>Get the full picture locally</h2>
  <p>This is a binary/behavioral summary. <a href="/install">Install <code>anc</code></a> and run <code>anc audit .</code> in your project for source-level and project-level audits too.</p>
  <p class="live-score-summary__cta-aside">Re-score this tool from a fresh paste on the <a href="/">homepage</a>, or browse the curated <a href="/scorecards">leaderboard</a>.</p>
</section>`;
}

/**
 * Build the markdown body for `/score/live/<binary>.md`. Same content
 * structure as the HTML body — header, score, top issues, CTA — emitted
 * as plain markdown so agents pasting `Accept: text/markdown` get a
 * clean document with no HTML escapes. Mirrors the markdown-twin
 * pattern used elsewhere on the site.
 */
export function buildScoreSummaryMarkdown(input: SummaryRenderInput): string {
  const { scorecard, binary, ancVersion, toolVersion, freshness } = input;
  const toolName = scorecard.tool?.name ?? binary;
  const pct = scorecard.badge?.score_pct ?? 0;
  const issues = extractTopIssues(scorecard);
  const lines: string[] = [];

  lines.push(`# ${toolName} ${toolVersion ? `(${toolVersion})` : ''}`.trim());
  lines.push('');
  lines.push(
    `Binary \`${binary}\` · scored by anc ${ancVersion} · spec ${SPEC_VERSION} · ${freshness === 'cache-hit' ? 'cached' : 'just scored'}`,
  );
  lines.push('');
  lines.push(`**Score:** ${pct}% pass rate`);
  lines.push('');

  if (issues.length === 0) {
    lines.push('## Status');
    lines.push('');
    lines.push('No failing or warning checks in this scorecard.');
    lines.push('');
  } else {
    lines.push('## Top issues');
    lines.push('');
    // Shared with the static /score/<tool>.md check table — single source
    // of truth for the row format in src/shared/scorecard-format.mjs.
    // Absolute baseUrl because /score/live/<binary>.md is consumed by
    // agents via Accept negotiation and must self-resolve cross-origin
    // (no absolutifyMarkdownLinks pass like the static .md twins get).
    for (const row of formatAuditTableMarkdownLines(issues, { baseUrl: 'https://anc.dev' })) {
      lines.push(row);
    }
    lines.push('');
  }

  lines.push('## Get the full picture locally');
  lines.push('');
  lines.push(
    'This is a binary/behavioral summary. [Install `anc`](https://anc.dev/install) and run `anc audit .` in your project for source-level and project-level audits too.',
  );
  lines.push('');
  lines.push(
    'Re-score this tool from a fresh paste on the [homepage](https://anc.dev/), or browse the curated [leaderboard](https://anc.dev/scorecards).',
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Page renderer + Worker-route handler
// ---------------------------------------------------------------------------

// Same CSP shape applyHeaders sets on static pages — mirrored here because
// /score/live/<binary> bypasses the static asset pipeline. Three Turnstile
// directives (script-src, frame-src, connect-src) are kept even though
// this page itself doesn't load Turnstile, because the share-URL surface
// links back to the homepage form, and a uniform CSP across HTML responses
// is easier to assert than per-page exceptions.
const LIVE_SCORE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
  'frame-src https://challenges.cloudflare.com; ' +
  "connect-src 'self' https://challenges.cloudflare.com; " +
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

  // The DO's cache write uses spec.binary (the parser-derived binary).
  // The handler's share_url uses the same. So a user never visits a
  // /score/live/<alias> URL we'd need to redirect — the URL we emit IS
  // the cache key. Aliases (e.g., the static /score/rg → /score/ripgrep
  // redirect) live on the curated-static side and don't apply here.
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
