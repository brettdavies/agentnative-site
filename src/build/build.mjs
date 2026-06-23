// Orchestrator — turn content/ into dist/.
//
// Pipeline:
//   0. Regenerate src/worker/spec-version.gen.ts from VERSION files.
//   1. Copy static assets + bundle client JS (→ css/, fonts/, js/,
//      og-image.png, robots.txt).
//   2. sortedGlob principle files in numeric order.
//   3. Render each principle; pin H1 id to the locked filename slug.
//   4. Emit per-principle HTML pages wrapped in the production shell.
//   5. Copy each principle's markdown source byte-for-byte.
//   6. Build homepage — hero (title + lede) + principle listing (links to
//      /p{N} pages). No inline principle content on the index page.
//   7. Render audit.md + about.md + the rest of content/*.md into sub-pages
//      (HTML + markdown twins).
//   8. Scorecard pages — leaderboard + per-tool pages from registry.yaml
//      + scorecards/*.json. Emits dist/registry-index.json consumed by
//      stage 11.
//   9. Emit llms.txt + llms-full.txt.
//  10. Emit sitemap.xml.
//  11. Emit dist/_internal/mcp-catalog.json — denormalized projection of
//      registry-index + principles + vendored spec for the Worker's MCP
//      module. Public path 404s; Worker reads via env.ASSETS.fetch.
//  12. Invariant check — no MUST/SHOULD/MAY leaked into <code> / <pre> /
//      <a>, locked anchors present on principle pages, md sha256 matches.
//  13. Minify dist/ HTML, JSON, and CSS as a unified post step.
//
// Fail-fast: the invariant check throws on violation so CI/`bun run build`
// exits non-zero. Regression tests are the verification net.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Pipeline-stage modules sort in execution order via numeric filename
// prefixes (00-… → 06-…). Numbering is decorative; build() below is the
// actual order-enforcer. Shared helpers (content.mjs, render.mjs,
// shell.mjs, util.mjs, etc.) stay unnumbered because they don't represent
// a single pipeline stage.
import { generateSpecVersionModule } from './00-spec-version-gen.mjs';
import { copyAssets } from './01-assets.mjs';
import { emitHomepage } from './06-homepage.mjs';
import { emitSubPages } from './07-subpages.mjs';
import { emitScorecardSurface } from './08-scorecards-emit.mjs';
import { emitLlmsSurface } from './09-llms-emit.mjs';
import { buildSitemap } from './10-sitemap.mjs';
import { emitMcpCatalog } from './11-mcp-catalog.mjs';
import { emitAgentReadiness, emitDiscovery } from './11a-discovery-emit.mjs';
import { minifyDist } from './12-minify-dist.mjs';
import { extractDefinitionParagraph, extractDescription, extractTitle } from './content.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell, emitShellTemplate } from './shell.mjs';
import { absolutifyMarkdownLinks, parseFilename, sortedGlob } from './util.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONTENT_DIR = join(REPO_ROOT, 'content');
const PRINCIPLES_DIR = join(CONTENT_DIR, 'principles');
const DIST_DIR = join(REPO_ROOT, 'dist');
const REGISTRY_PATH = join(REPO_ROOT, 'registry.yaml');
const HINTS_PATH = join(REPO_ROOT, 'discovery-hints.yaml');
const SCORECARDS_DIR = join(REPO_ROOT, 'scorecards');
const COVERAGE_MATRIX_PATH = join(REPO_ROOT, 'src', 'data', 'coverage-matrix.json');
const SKILL_DATA_PATH = join(REPO_ROOT, 'src', 'data', 'skill', 'skill.json');

const LOCKED_SLUGS = [
  'p1-non-interactive-by-default',
  'p2-structured-parseable-output',
  'p3-progressive-help-discovery',
  'p4-fail-fast-actionable-errors',
  'p5-safe-retries-mutation-boundaries',
  'p6-composable-predictable-command-structure',
  'p7-bounded-high-signal-responses',
  'p8-discoverable-skill-bundle',
];

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function runInvariantChecks(distDir, principleSlugs, principleSources) {
  // 1. No MUST / SHOULD / MAY bare words inside <code> / <pre> / <a>.
  //    Check every principle page (the index page no longer has inline
  //    principle content). The `\b` after the tag name keeps the regex
  //    from matching tags whose name merely starts with one of these
  //    letters (e.g. `<aside>` — added by the normative-block plugin).
  const codePreATextRe = /<(code|pre|a)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const { n } of principleSources) {
    const html = await readFile(join(distDir, `p${n}.html`), 'utf8');
    for (const match of html.matchAll(codePreATextRe)) {
      const [, tag, block] = match;
      if (/<strong class="rfc-(must|should|may)"/.test(block)) {
        throw new Error(`invariant: RFC-keyword annotation leaked into <${tag}> in p${n}.html`);
      }
    }
  }

  // 2. Every §3.5 locked slug appears exactly once in its principle page.
  for (let i = 0; i < principleSlugs.length; i++) {
    const slug = principleSlugs[i];
    const n = i + 1;
    const html = await readFile(join(distDir, `p${n}.html`), 'utf8');
    const re = new RegExp(`id="${slug}"`, 'g');
    const count = (html.match(re) ?? []).length;
    if (count !== 1) {
      throw new Error(`invariant: locked slug ${slug} appears ${count}× in p${n}.html (want 1)`);
    }
  }

  // 3. Homepage links to every principle page.
  const indexHtml = await readFile(join(distDir, 'index.html'), 'utf8');
  for (let n = 1; n <= principleSlugs.length; n++) {
    if (!indexHtml.includes(`href="/p${n}"`)) {
      throw new Error(`invariant: index.html missing link to /p${n}`);
    }
  }

  // 4. dist/p<n>.md == absolutifyMarkdownLinks(content/principles/p<n>-*.md).
  // Twin-source equivalence post-link-rewrite: site-relative links in source
  // become absolute https://anc.dev/... in the twin, but no other bytes drift.
  for (const { n, sourcePath } of principleSources) {
    const distContent = await readFile(join(distDir, `p${n}.md`), 'utf8');
    const sourceContent = await readFile(sourcePath, 'utf8');
    if (distContent !== absolutifyMarkdownLinks(sourceContent)) {
      throw new Error(`invariant: dist/p${n}.md does not match absolutified ${sourcePath}`);
    }
  }

  // 5. Markdown-twin silence for the homepage. The homepage HTML
  // gains the live-scoring form; the markdown twin MUST NOT carry any of
  // that surface (no form markup, no JS reference, no Turnstile mention,
  // no /api/score documentation). Agents pasting `Accept: text/markdown`
  // against `/` are expected to use `anc audit` locally; the form is
  // HTML-only by design. A future copy edit that leaks any of these
  // tokens into the homepage markdown fails the build here.
  const indexMd = await readFile(join(distDir, 'index.md'), 'utf8');
  const FORBIDDEN_IN_INDEX_MD = ['live-score', 'turnstile', 'challenges.cloudflare.com', '/api/score'];
  for (const needle of FORBIDDEN_IN_INDEX_MD) {
    if (indexMd.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(
        `invariant: dist/index.md leaked live-scoring surface "${needle}". The homepage markdown twin stays silent on the form by design.`,
      );
    }
  }
}

export async function build() {
  await ensureDir(DIST_DIR);

  // 0. Regenerate src/worker/spec-version.gen.ts from VERSION files BEFORE
  // copyAssets bundles the client/worker JS. The Worker imports the file via
  // a relative module path, so an out-of-date constant would otherwise ship
  // verbatim into the bundle even when the VERSION files have advanced. The
  // drift test (tests/spec-version-gen.test.ts) is the second guardrail.
  await generateSpecVersionModule();

  // 1. Copy static assets + bundle client JS. themeInit inlined into every shell.
  // bundleClient also emits /js/live-score.js used by the homepage form.
  const { themeInit } = await copyAssets({ repoRoot: REPO_ROOT, distDir: DIST_DIR });

  // 2. Sorted principle files.
  const principleFiles = await sortedGlob(PRINCIPLES_DIR);

  // 3. Render each principle.
  const principles = [];
  for (const file of principleFiles) {
    const { n, slug } = parseFilename(file);
    const source = await readFile(file, 'utf8');
    let html = await renderMarkdown(source);
    // Pin H1 id + permalink href to the filename-derived locked slug so
    // authored H1 prose can't drift the §3.5 anchors.
    html = html
      .replace(/<h1 id="[^"]*"/, `<h1 id="p${n}-${slug}"`)
      .replace(/(<h1 id="p\d+-[^"]*">[^<]*<a\s[^>]*href=")#[^"]*"/, `$1#p${n}-${slug}"`);
    const title = extractTitle(source);
    const description = extractDescription(source);

    // 4. Per-principle HTML page.
    const page = emitShell({
      title,
      description,
      canonicalPath: `/p${n}`,
      bodyHtml: html,
      themeInitJs: themeInit,
    });
    await writeFile(join(DIST_DIR, `p${n}.html`), page);

    // 5. Markdown twin — authored bytes with site-relative links absolutified
    // so `Accept: text/markdown` agents fetching /p<n>.md get a self-contained
    // document. Source authors `[text](/p3)`; the twin emits `[text](https://anc.dev/p3)`.
    await writeFile(join(DIST_DIR, `p${n}.md`), absolutifyMarkdownLinks(source));

    const shortDesc = extractDefinitionParagraph(source);
    principles.push({ n, slug, title, description, source, html, filename: file, shortDesc });
  }

  // 6. Homepage — hero + principle listing (links to /p{N} pages).
  const { introTitle, introSummary, introSource, specContextSource, useSource } = await emitHomepage({
    distDir: DIST_DIR,
    contentDir: CONTENT_DIR,
    themeInit,
    principles,
  });

  // 7. content-driven sub-pages (HTML + MD twin via shared pipeline).
  const subPageData = await emitSubPages({
    distDir: DIST_DIR,
    contentDir: CONTENT_DIR,
    themeInit,
  });

  // 8. Scorecard surface — leaderboard, per-tool pages, badges, coverage, skill.
  const { leaderboard, scorecardPaths, badgePaths, coverageMarkdown, skillData, skillMarkdown } =
    await emitScorecardSurface({
      distDir: DIST_DIR,
      registryPath: REGISTRY_PATH,
      hintsPath: HINTS_PATH,
      coverageMatrixPath: COVERAGE_MATRIX_PATH,
      skillDataPath: SKILL_DATA_PATH,
      scorecardsDir: SCORECARDS_DIR,
      themeInit,
    });

  // 9. llms.txt + llms-full.txt (includes scorecard + skill sections).
  await emitLlmsSurface({
    distDir: DIST_DIR,
    introTitle,
    introSummary,
    introSource,
    specContextSource,
    useSource,
    principles,
    subPageData,
    leaderboard,
    coverageMarkdown,
    skillData,
    skillMarkdown,
  });

  // 9b. Live-score shell template. Worker's summary-render.ts fetches
  // this asset to wrap dynamic `/score/live/<binary>` responses in the
  // same shell as static pages. The `/_internal/*` namespace is
  // intercepted by the Worker entry so direct user access returns 404 —
  // the file exists for internal env.ASSETS fetches only. Filename
  // mirrors the URL path so a future reader greps `score-live` and
  // finds both ends.
  await ensureDir(join(DIST_DIR, '_internal'));
  await writeFile(join(DIST_DIR, '_internal', 'score-live-shell.html'), emitShellTemplate({ themeInitJs: themeInit }));

  // 10. Sitemap (includes scorecard paths). /install (CLI) and /skill (skill
  // bundle) are indexed for humans; /skill.json carries X-Robots-Tag: noindex
  // so it stays out of the sitemap.
  const sitemap = buildSitemap({
    principleNumbers: principles.map((p) => p.n),
    extraPaths: ['/scorecards', '/coverage', '/install', '/skill', '/badge', ...scorecardPaths],
  });
  await writeFile(join(DIST_DIR, 'sitemap.xml'), sitemap);

  // 11. MCP catalog — denormalized projection consumed by the Worker's
  // MCP module via env.ASSETS.fetch. Runs AFTER registry-index.json is
  // emitted (08) and AFTER sitemap so its emission cannot race with
  // upstream artifacts. Lives at /_internal/mcp-catalog.json which the
  // Worker's dispatch interceptor hard-404s from public access (the
  // Worker's own ASSETS fetch bypasses by not re-entering dispatch).
  const mcpCatalogStats = await emitMcpCatalog({ distDir: DIST_DIR, repoRoot: REPO_ROOT });

  // 11a. Discoverability — .well-known/{mcp, ai.txt, security.txt}.
  // The MCP JSON pointer's `documentation` field references
  // /mcp-skill.md (rendered at stage 7), so this stage MUST run after
  // the sub-pages stage. The contact address pinned in security.txt
  // and ai.txt is the operator's canonical inbox; the constant lives
  // in 11a-discovery-emit.mjs.
  const discoveryStats = await emitDiscovery({ distDir: DIST_DIR });

  // 11b. Agent-readiness discovery surfaces — .well-known/{api-catalog,
  // mcp/server-card.json, agent-skills/index.json} + auth.md. Answers the
  // protocol-discovery probes a generic agent-readiness scanner runs against
  // the apex. The agent-skills index digests dist/mcp-skill.md, so this MUST
  // run after the sub-pages stage (7). The api-catalog file is extensionless;
  // the Worker stamps its application/linkset+json content-type at request
  // time (src/worker/index.ts).
  const agentReadinessStats = await emitAgentReadiness({ distDir: DIST_DIR });

  // 12. Invariant check — fails fast if any critical contract slips.
  await runInvariantChecks(
    DIST_DIR,
    LOCKED_SLUGS,
    principles.map((p) => ({ n: p.n, sourcePath: p.filename })),
  );

  // 13. Minify dist/ HTML, JSON, and CSS. Runs after invariants so the
  // validators see pristine output and the minifier is the last hand on
  // the wire format.
  const minifyStats = await minifyDist(DIST_DIR);

  const scorecardPageCount = scorecardPaths.length;
  const leaderboardPageCount = 1; // /scorecards index, counted in htmlPages but not scorecardPages
  // 7: check, install, about, badge, changelog, methodology, coverage
  // (scorecard-schema is in subPages but counts under the sub-pages tally
  // emitted alongside; skill.html is also emitted separately. The
  // build-summary shape predates badge/skill/scorecard-schema and is
  // approximate — it exists to confirm "build produced ~the expected
  // number of files," not as a precise contract.)
  const extraPages = 7;
  return {
    principles: principles.length,
    htmlPages: principles.length + extraPages + scorecardPageCount + leaderboardPageCount,
    mdPages: principles.length + extraPages + scorecardPageCount + leaderboardPageCount,
    extras: extraPages,
    scorecardPages: scorecardPageCount,
    badgeSvgs: badgePaths.length,
    mcpCatalog: mcpCatalogStats,
    discovery: discoveryStats,
    agentReadiness: agentReadinessStats,
    minified: minifyStats,
  };
}

if (import.meta.main) {
  const summary = await build();
  console.log('build complete:', summary);
}
