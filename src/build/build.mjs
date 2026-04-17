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
//   8. Emit llms.txt + llms-full.txt (A5 format).
//   9. Emit sitemap.xml.
//  10. Invariant check — no MUST/SHOULD/MAY leaked into <code> / <pre> /
//      <a>, locked anchors present on principle pages, md sha256 matches.
//
// Fail-fast: the invariant check throws on violation so CI/`bun run build`
// exits non-zero. Regression tests are the verification net.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAssets } from './assets.mjs';
import { buildLlmsFull, buildLlmsIndex, extractIntroSummary, extractTitle } from './llms.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell } from './shell.mjs';
import { buildSitemap } from './sitemap.mjs';
import { escHtml, parseFilename, sortedGlob } from './util.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONTENT_DIR = join(REPO_ROOT, 'content');
const PRINCIPLES_DIR = join(CONTENT_DIR, 'principles');
const DIST_DIR = join(REPO_ROOT, 'dist');

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

/**
 * Extract the first paragraph after the H1 as a short description for
 * meta tags. Works on the raw markdown, pre-render.
 */
function extractDescription(markdown, fallback = '') {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].match(/^#\s+/)) i++;
  i++; // past H1
  // Skip blank lines AND subsequent headings (`## Definition` etc.) until
  // the first real prose paragraph.
  while (i < lines.length && (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i].trim()))) {
    i++;
  }
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  const full = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (full.length === 0) return fallback;
  // Cap at 180 chars for OG/description meta.
  return full.length <= 180 ? full : full.slice(0, 177).replace(/\s+\S*$/, '') + '…';
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Extract the first prose paragraph after the H1 — the lede for the
 * homepage hero. Returns the paragraph as a single string.
 */
function extractFirstParagraph(markdown) {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].match(/^#\s+/)) i++;
  i++; // past H1
  while (i < lines.length && lines[i].trim() === '') i++;
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  return buf.join(' ');
}

/**
 * Extract the full `## Definition` paragraph — used as the description
 * in the homepage principle listing. Strips markdown formatting (bold,
 * links, inline code) for plain-text output.
 */
function extractDefinitionParagraph(markdown) {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !/^##\s+Definition/.test(lines[i])) i++;
  i++; // past heading
  while (i < lines.length && lines[i].trim() === '') i++;
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  return buf
    .join(' ')
    .replace(/\*\*/g, '') // strip bold markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links → label only
    .replace(/`([^`]+)`/g, '$1'); // strip inline code → content only
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

  // 4. sha256(dist/p<n>.md) === sha256(content/principles/p<n>-*.md).
  for (const { n, sourcePath } of principleSources) {
    const distBuf = await readFile(join(distDir, `p${n}.md`));
    const srcBuf = await readFile(sourcePath);
    if (sha256(distBuf) !== sha256(srcBuf)) {
      throw new Error(`invariant: dist/p${n}.md bytes do not match source ${sourcePath}`);
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

    // 5. Markdown twin — byte-equivalent copy.
    await copyFile(file, join(DIST_DIR, `p${n}.md`));

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
  await writeFile(join(DIST_DIR, 'index.md'), indexMdLines.join('\n'));

  // 7. check.md + about.md.
  const subPages = [
    { name: 'check', path: join(CONTENT_DIR, 'check.md') },
    { name: 'about', path: join(CONTENT_DIR, 'about.md') },
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
    await copyFile(path, join(DIST_DIR, `${name}.md`));
    subPageData.push({ name, source, title });
  }

  // 8. llms.txt + llms-full.txt.
  const llmsIndex = buildLlmsIndex({
    introTitle,
    summary: introSummary,
    principles: principles.map((p) => ({ n: p.n, slug: p.slug, title: p.title })),
    subPages: subPageData.map((s) => ({ name: s.name, title: s.title })),
  });
  await writeFile(join(DIST_DIR, 'llms.txt'), llmsIndex);

  const llmsFull = buildLlmsFull({
    sections: [
      { title: introTitle, body: introSource, htmlPath: '/', mdPath: '/index.md' },
      ...principles.map((p) => ({
        title: p.title,
        body: p.source,
        htmlPath: `/p${p.n}`,
        mdPath: `/p${p.n}.md`,
      })),
      ...subPageData.map((s) => ({
        title: s.title,
        body: s.source,
        htmlPath: `/${s.name}`,
        mdPath: `/${s.name}.md`,
      })),
    ],
  });
  await writeFile(join(DIST_DIR, 'llms-full.txt'), llmsFull);

  // 9. Sitemap.
  const sitemap = buildSitemap({
    principleNumbers: principles.map((p) => p.n),
  });
  await writeFile(join(DIST_DIR, 'sitemap.xml'), sitemap);

  // 10. Invariant check — fails fast if any critical contract slips.
  await runInvariantChecks(
    DIST_DIR,
    LOCKED_SLUGS,
    principles.map((p) => ({ n: p.n, sourcePath: p.filename })),
  );

  return {
    principles: principles.length,
    htmlPages: principles.length + 3,
    mdPages: principles.length + 3,
    extras: 3,
  };
}

if (import.meta.main) {
  const summary = await build();
  console.log('build complete:', summary);
}
