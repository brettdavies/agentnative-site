// Orchestrator — turn content/ into dist/.
//
// Pipeline:
//   1. Copy static assets + bundle client JS (→ css/, fonts/, js/,
//      og-image.png, robots.txt).
//   2. sortedGlob principle files in numeric order.
//   3. Render each principle; pin H1 id to the locked filename slug.
//   4. Emit per-principle HTML pages wrapped in the production shell.
//   5. Copy each principle's markdown source byte-for-byte.
//   6. Build homepage — hero (title + lede) + principle listing (links to
//      /p{N} pages). No inline principle content on the index page.
//   7. Render check.md + about.md into sub-pages.
//   8. Scorecard pages — leaderboard + per-tool pages from registry.yaml
//      + scorecards/*.json.
//   9. Emit llms.txt + llms-full.txt (A5 format).
//  10. Emit sitemap.xml.
//  11. Invariant check — no MUST/SHOULD/MAY leaked into <code> / <pre> /
//      <a>, locked anchors present on principle pages, md sha256 matches.
//
// Fail-fast: the invariant check throws on violation so CI/`bun run build`
// exits non-zero. Regression tests are the verification net.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAssets } from './assets.mjs';
import { renderBadgeSvg } from './badge.mjs';
import {
  extractDefinitionParagraph,
  extractDescription,
  extractFirstParagraph,
  extractIntroSummary,
  extractTitle,
} from './content.mjs';
import { buildCoverageBody, buildCoverageMarkdown, loadCoverageMatrix } from './coverage.mjs';
import { buildLlmsFull, buildLlmsIndex } from './llms.mjs';
import { renderMarkdown } from './render.mjs';
import {
  computeLeaderboard,
  extractTopIssues,
  loadRegistry,
  loadScoredTools,
  runScorecardInvariants,
} from './scorecards.mjs';
import {
  buildLeaderboardBody,
  buildLeaderboardMarkdown,
  buildScorecardBody,
  buildScorecardMarkdown,
} from './scorecards-render.mjs';
import { emitShell } from './shell.mjs';
import { buildSitemap } from './sitemap.mjs';
import { emitSkillJson, emitSkillMarkdown, loadSkillData, renderSkillPage } from './skill.mjs';
import { absolutifyMarkdownLinks, escHtml, parseFilename, sortedGlob } from './util.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONTENT_DIR = join(REPO_ROOT, 'content');
const PRINCIPLES_DIR = join(CONTENT_DIR, 'principles');
const DIST_DIR = join(REPO_ROOT, 'dist');
const REGISTRY_PATH = join(REPO_ROOT, 'registry.yaml');
const SCORECARDS_DIR = join(REPO_ROOT, 'scorecards');
const COVERAGE_MATRIX_PATH = join(REPO_ROOT, 'src', 'data', 'coverage-matrix.json');
const SKILL_DATA_PATH = join(REPO_ROOT, 'src', 'data', 'skill.json');

const LOCKED_SLUGS = [
  'p1-non-interactive-by-default',
  'p2-structured-parseable-output',
  'p3-progressive-help-discovery',
  'p4-fail-fast-actionable-errors',
  'p5-safe-retries-mutation-boundaries',
  'p6-composable-predictable-command-structure',
  'p7-bounded-high-signal-responses',
];

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the homepage body HTML — hero section (title + lede) followed by
 * the seven-principle listing with links to individual pages.
 */
function buildHomepageBody(introTitle, introLede, principles) {
  const entries = principles
    .map((p) => {
      const num = String(p.n).padStart(2, '0');
      const title = escHtml(p.title.replace(/^P\d+:\s*/, ''));
      const desc = escHtml(p.shortDesc);
      return `    <li class="principle-entry">
      <a href="/p${p.n}" class="principle-entry__link">
        <span class="principle-entry__num">${num}</span>
        <span class="principle-entry__title">${title}</span>
        <span class="principle-entry__desc">${desc}</span>
      </a>
    </li>`;
    })
    .join('\n');

  return `<section class="hero">
  <h1 class="hero__title">${escHtml(introTitle)}</h1>
  <p class="hero__lede">${escHtml(introLede)}</p>
</section>
<section class="principles-index" aria-label="The seven principles">
  <ol class="principles-index__list">
${entries}
  </ol>
</section>`;
}

async function runInvariantChecks(distDir, principleSlugs, principleSources) {
  // 1. No MUST / SHOULD / MAY bare words inside <code> / <pre> / <a>.
  //    Check every principle page (the index page no longer has inline
  //    principle content).
  const codePreATextRe = /<(code|pre|a)[^>]*>([\s\S]*?)<\/\1>/gi;
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
}

export async function build() {
  await ensureDir(DIST_DIR);

  // 1. Copy static assets + bundle client JS. themeInit inlined into every shell.
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
  const introPath = join(CONTENT_DIR, '_intro.md');
  const introSource = await readFile(introPath, 'utf8');
  const introTitle = extractTitle(introSource);
  const introSummary = extractIntroSummary(introSource);
  const introDescription = extractDescription(introSource);
  const introLede = extractFirstParagraph(introSource);

  const indexBody = buildHomepageBody(introTitle, introLede, principles);
  await writeFile(
    join(DIST_DIR, 'index.html'),
    emitShell({
      title: introTitle,
      description: introDescription,
      canonicalPath: '/',
      bodyHtml: indexBody,
      themeInitJs: themeInit,
      isIndex: true,
    }),
  );

  // index.md — trimmed to match the HTML homepage.
  const indexMdLines = [
    `# ${introTitle}`,
    '',
    introLede,
    '',
    '## Principles',
    '',
    ...principles.map((p) => `- [${p.title}](/p${p.n}) — ${p.shortDesc}`),
    '',
  ];
  await writeFile(join(DIST_DIR, 'index.md'), absolutifyMarkdownLinks(indexMdLines.join('\n')));

  // 7. content-driven sub-pages (HTML + MD twin via shared pipeline).
  const subPages = [
    { name: 'check', path: join(CONTENT_DIR, 'check.md') },
    { name: 'install', path: join(CONTENT_DIR, 'install.md') },
    { name: 'about', path: join(CONTENT_DIR, 'about.md') },
    { name: 'badge', path: join(CONTENT_DIR, 'badge.md') },
    { name: 'changelog', path: join(CONTENT_DIR, 'changelog.md') },
    { name: 'methodology', path: join(CONTENT_DIR, 'methodology.md') },
    { name: 'scorecard-schema', path: join(CONTENT_DIR, 'scorecard-schema.md') },
  ];
  const subPageData = [];
  for (const { name, path } of subPages) {
    const source = await readFile(path, 'utf8');
    const title = extractTitle(source);
    const description = extractDescription(source);
    const html = await renderMarkdown(source);
    await writeFile(
      join(DIST_DIR, `${name}.html`),
      emitShell({
        title,
        description,
        canonicalPath: `/${name}`,
        bodyHtml: html,
        themeInitJs: themeInit,
      }),
    );
    await writeFile(join(DIST_DIR, `${name}.md`), absolutifyMarkdownLinks(source));
    subPageData.push({ name, source, title });
  }

  // 8. Scorecard pages — leaderboard + per-tool pages.
  const registry = await loadRegistry(REGISTRY_PATH);
  // v0.4 corpus invariants run before rendering: any scorecard below the
  // schema floor, missing a registry entry, scoring the wrong binary, or
  // carrying a non-RFC-3339 timestamp aborts the build before producing
  // bad output.
  await runScorecardInvariants(SCORECARDS_DIR, registry);
  // Scorecard-driven discovery + registry editorial join (U3 inversion).
  // Both directions of mismatch are warnings, not errors: a scorecard with
  // no registry entry → excluded; a registry entry with no scorecard →
  // excluded. The build emits a stable WARNINGS_JSON line so CI can parse
  // it (U8 PR-comment annotation).
  const { tools: toolsWithScorecards, warnings: scorecardWarnings } = await loadScoredTools(SCORECARDS_DIR, registry);
  for (const filename of scorecardWarnings.scorecardOrphans) {
    console.warn(`warning: scorecard ${filename} has no matching registry entry — excluded from leaderboard.`);
  }
  for (const name of scorecardWarnings.registryOrphans) {
    console.warn(`warning: registry entry "${name}" has no matching scorecard — excluded from leaderboard.`);
  }
  console.log(`WARNINGS_JSON: ${JSON.stringify(scorecardWarnings)}`);
  const leaderboard = computeLeaderboard(toolsWithScorecards);

  const methodologyHtml = `  <p>Every score is the output of <code>anc check &lt;binary&gt;</code> against a real CLI tool.
  The <strong>score</strong> column is the pass rate <code>pass / (pass + warn + fail)</code>;
  the <strong>principles met</strong> column counts how many of the seven principles have every
  check passing. The <strong>audience</strong> classification — when present — is informational,
  not authoritative; the per-tool page's evidence list is the ground truth.</p>
  <p>For the full explanation of scoring, audience classification, audit profiles, and how to
  request a re-score, see the <a href="/methodology">methodology page</a>.</p>
  <p>To reproduce any row locally, <a href="/install">install <code>anc</code></a> and run
  <code>anc check &lt;binary&gt;</code>.</p>`;

  const leaderboardBody = buildLeaderboardBody(leaderboard, methodologyHtml);
  await writeFile(
    join(DIST_DIR, 'scorecards.html'),
    emitShell({
      title: 'ANC 100 — Agent-Native CLI Leaderboard',
      description:
        'Automated agent-readiness scores for real CLI tools, scored against the seven agent-native principles.',
      canonicalPath: '/scorecards',
      bodyHtml: leaderboardBody,
      themeInitJs: themeInit,
      extraScripts: ['/js/leaderboard.js'],
    }),
  );
  await writeFile(join(DIST_DIR, 'scorecards.md'), absolutifyMarkdownLinks(buildLeaderboardMarkdown(leaderboard)));

  // Per-tool scorecard pages → dist/score/<tool-name>.html + .md
  // Badge SVGs               → dist/badge/<tool-name>.svg
  // Binary-name redirects    → dist/score/<binary>.html + .md (when
  //                            registry.binary !== registry.name; U7)
  await ensureDir(join(DIST_DIR, 'score'));
  await ensureDir(join(DIST_DIR, 'badge'));
  // Drop stale per-tool pages and badge SVGs from prior builds. When a tool
  // is removed from the registry (e.g., aider, plandex, fabric in PR #40),
  // its old html/md/svg would otherwise linger in dist/ and ship as broken
  // links / orphaned badges referencing a tool the leaderboard no longer
  // knows about. The allowlist also includes binary slugs for the
  // name-vs-binary tools (ripgrep/rg, ast-grep/sg, …) so the redirect pages
  // U7 emits aren't unlinked on every build (P0: without this the reaper
  // deletes them every time, defeating the redirect entirely).
  const expectedNames = new Set(leaderboard.map((e) => e.tool.name));
  for (const e of leaderboard) {
    if (e.tool.binary && e.tool.binary !== e.tool.name) {
      expectedNames.add(e.tool.binary);
    }
  }
  for (const file of await readdir(join(DIST_DIR, 'score')).catch(() => [])) {
    const m = file.match(/^([a-z0-9-]+)\.(html|md)$/);
    if (m && !expectedNames.has(m[1])) {
      await unlink(join(DIST_DIR, 'score', file));
    }
  }
  // Badge SVGs are emitted for the canonical name only (no binary-slug
  // SVG). A reader following /score/rg → /score/ripgrep ends up on the
  // canonical page, where /badge/ripgrep.svg renders correctly.
  const expectedBadgeNames = new Set(leaderboard.map((e) => e.tool.name));
  for (const file of await readdir(join(DIST_DIR, 'badge')).catch(() => [])) {
    const m = file.match(/^([a-z0-9-]+)\.svg$/);
    if (m && !expectedBadgeNames.has(m[1])) {
      await unlink(join(DIST_DIR, 'badge', file));
    }
  }
  const scorecardPaths = [];
  const badgePaths = [];
  for (const entry of leaderboard) {
    const { tool, scorecard, score, principleScore, version, metadata } = entry;
    const topIssues = extractTopIssues(scorecard);

    const scorecardBody = buildScorecardBody(tool, scorecard, topIssues, principleScore, score, version, metadata);
    await writeFile(
      join(DIST_DIR, 'score', `${tool.name}.html`),
      emitShell({
        title: `${tool.name} — Agent-Native Scorecard`,
        description: `Agent-readiness scorecard for ${tool.name}: ${tool.description}`,
        canonicalPath: `/score/${tool.name}`,
        bodyHtml: scorecardBody,
        themeInitJs: themeInit,
      }),
    );
    await writeFile(
      join(DIST_DIR, 'score', `${tool.name}.md`),
      absolutifyMarkdownLinks(buildScorecardMarkdown(tool, scorecard, topIssues, principleScore, score, version, metadata)),
    );
    scorecardPaths.push(`/score/${tool.name}`);

    // Badge SVG — emitted for every scored tool, even those below the
    // eligibility floor. The /score/<tool> page gates the embed snippet
    // (above-floor only); the SVG itself stays available so a tool's
    // existing embed continues to render the current score after a
    // regression. Unscored tools (scorecard === null) skip the SVG —
    // there's no meaningful score to render.
    if (scorecard) {
      const svg = renderBadgeSvg(score);
      await writeFile(join(DIST_DIR, 'badge', `${tool.name}.svg`), svg);
      badgePaths.push(`/badge/${tool.name}.svg`);
    }

    // Binary-name redirect: tools where registry.binary !== registry.name
    // (e.g., ripgrep/rg, ast-grep/sg, bottom/btm — 11 entries today) get a
    // second pair of files at /score/<binary>.html + .md that point at the
    // canonical /score/<name>. Closes the URL fragmentation a reader hits
    // when guessing the URL from the binary they typed at a shell prompt.
    if (tool.binary && tool.binary !== tool.name) {
      const targetPath = `/score/${tool.name}`;
      const titleSafe = escHtml(tool.name);
      const redirectHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Redirecting to ${titleSafe}</title>
  <link rel="canonical" href="${targetPath}">
  <meta http-equiv="refresh" content="0; url=${targetPath}">
</head>
<body>
  <p>Redirecting to <a href="${targetPath}">${titleSafe}</a>. If your browser does not redirect, follow the link.</p>
</body>
</html>
`;
      await writeFile(join(DIST_DIR, 'score', `${tool.binary}.html`), redirectHtml);
      await writeFile(
        join(DIST_DIR, 'score', `${tool.binary}.md`),
        `See [${targetPath}](${targetPath}).\n`,
      );
    }
  }

  // 8b. Coverage matrix page — /coverage.
  const coverageMatrix = await loadCoverageMatrix(COVERAGE_MATRIX_PATH);
  const coverageBody = buildCoverageBody(coverageMatrix);
  const coverageMarkdown = buildCoverageMarkdown(coverageMatrix);
  await writeFile(
    join(DIST_DIR, 'coverage.html'),
    emitShell({
      title: 'Spec Coverage Matrix — anc.dev',
      description: 'Which agent-native CLI requirements have automated checks and which remain uncovered.',
      canonicalPath: '/coverage',
      bodyHtml: coverageBody,
      themeInitJs: themeInit,
    }),
  );
  await writeFile(join(DIST_DIR, 'coverage.md'), absolutifyMarkdownLinks(coverageMarkdown));

  // 8c. /skill.json + /skill + /skill.md — skill-distribution surface.
  // The same manifest is emitted as canonical JSON, rendered HTML (via the
  // shared unified pipeline), and a markdown twin. Drift is structurally
  // impossible because all three derive from the same data file.
  const skillData = await loadSkillData(SKILL_DATA_PATH);
  await emitSkillJson(skillData, DIST_DIR);
  const { markdown: skillMarkdown, html: skillBodyHtml } = await renderSkillPage(skillData);
  await writeFile(
    join(DIST_DIR, 'skill.html'),
    emitShell({
      title: `Install ${skillData.name}`,
      description: skillData.description,
      canonicalPath: '/skill',
      bodyHtml: skillBodyHtml,
      themeInitJs: themeInit,
    }),
  );
  await emitSkillMarkdown(absolutifyMarkdownLinks(skillMarkdown), DIST_DIR);

  // 9. llms.txt + llms-full.txt (includes scorecard + skill sections).
  const llmsIndex = buildLlmsIndex({
    introTitle,
    summary: introSummary,
    principles: principles.map((p) => ({ n: p.n, slug: p.slug, title: p.title })),
    subPages: subPageData.map((s) => ({ name: s.name, title: s.title })),
    scorecardLinks: [
      { name: 'Leaderboard', path: '/scorecards.md' },
      { name: 'Coverage Matrix', path: '/coverage.md' },
      // Per-tool scorecards alphabetical so the llms.txt index reads as a
      // browseable directory; the leaderboard itself owns rank-order presentation.
      ...leaderboard
        .map((e) => ({ name: e.tool.name, path: `/score/${e.tool.name}.md` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ],
    skillLinks: [
      { name: 'Skill (HTML)', path: '/skill.md' },
      { name: 'Skill (canonical JSON)', path: '/skill.json' },
    ],
  });
  await writeFile(join(DIST_DIR, 'llms.txt'), llmsIndex);

  // llms-full.txt embeds each page's markdown body verbatim. Apply the same
  // .md-twin absolutification policy so site-relative links resolve when an
  // agent fetches /llms-full.txt directly.
  const llmsFull = buildLlmsFull({
    sections: [
      { title: introTitle, body: absolutifyMarkdownLinks(introSource), htmlPath: '/', mdPath: '/index.md' },
      ...principles.map((p) => ({
        title: p.title,
        body: absolutifyMarkdownLinks(p.source),
        htmlPath: `/p${p.n}`,
        mdPath: `/p${p.n}.md`,
      })),
      ...subPageData.map((s) => ({
        title: s.title,
        body: absolutifyMarkdownLinks(s.source),
        htmlPath: `/${s.name}`,
        mdPath: `/${s.name}.md`,
      })),
      {
        title: 'ANC 100 — Agent-Native CLI Leaderboard',
        body: absolutifyMarkdownLinks(buildLeaderboardMarkdown(leaderboard)),
        htmlPath: '/scorecards',
        mdPath: '/scorecards.md',
      },
      {
        title: 'Spec Coverage Matrix',
        body: absolutifyMarkdownLinks(coverageMarkdown),
        htmlPath: '/coverage',
        mdPath: '/coverage.md',
      },
      {
        title: `Install ${skillData.name}`,
        body: absolutifyMarkdownLinks(skillMarkdown),
        htmlPath: '/skill',
        mdPath: '/skill.md',
      },
    ],
  });
  await writeFile(join(DIST_DIR, 'llms-full.txt'), llmsFull);

  // 10. Sitemap (includes scorecard paths). /install (CLI) and /skill (skill
  // bundle) are indexed for humans; /skill.json carries X-Robots-Tag: noindex
  // so it stays out of the sitemap.
  const sitemap = buildSitemap({
    principleNumbers: principles.map((p) => p.n),
    extraPaths: ['/scorecards', '/coverage', '/install', '/skill', '/badge', ...scorecardPaths],
  });
  await writeFile(join(DIST_DIR, 'sitemap.xml'), sitemap);

  // 11. Invariant check — fails fast if any critical contract slips.
  await runInvariantChecks(
    DIST_DIR,
    LOCKED_SLUGS,
    principles.map((p) => ({ n: p.n, sourcePath: p.filename })),
  );

  const scorecardPageCount = scorecardPaths.length + 1; // +1 for leaderboard
  // 7: check, install, about, badge, changelog, methodology, coverage
  // (scorecard-schema is in subPages but counts under the sub-pages tally
  // emitted alongside; skill.html is also emitted separately. The
  // build-summary shape predates badge/skill/scorecard-schema and is
  // approximate — it exists to confirm "build produced ~the expected
  // number of files," not as a precise contract.)
  const extraPages = 7;
  return {
    principles: principles.length,
    htmlPages: principles.length + extraPages + scorecardPageCount,
    mdPages: principles.length + extraPages + scorecardPageCount,
    extras: extraPages,
    scorecardPages: scorecardPageCount,
    badgeSvgs: badgePaths.length,
  };
}

if (import.meta.main) {
  const summary = await build();
  console.log('build complete:', summary);
}
