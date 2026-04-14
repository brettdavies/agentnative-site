// Orchestrator — turn content/ into dist/.
//
// Pipeline (steps 1–9; M5 will append steps 10–17 for CSS, shell, client JS,
// asset copy, and invariant checks):
//   1. sortedGlob principle files in numeric order.
//   2. For each principle: render markdown → HTML and copy bytes.
//   3. Render _intro.md to HTML.
//   4. Concat intro + all principles for the index page.
//   5. Render check.md + about.md.
//   6. Emit markdown twins (byte-equivalent copies) for each HTML page.
//   7. Emit llms.txt + llms-full.txt.
//   8. Emit sitemap.xml.
//   9. Return counts so callers (tests, CI) can assert file counts.
//
// For M3 the HTML is a minimal document shell — enough to parse, validate,
// and satisfy anchor-slug assertions. M5 replaces the shell with the
// production chrome (header/footer/mini-TOC/theme toggle).

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLlmsFull, buildLlmsIndex, extractIntroSummary, extractTitle } from './llms.mjs';
import { renderMarkdown } from './render.mjs';
import { buildSitemap } from './sitemap.mjs';
import { parseFilename, sortedGlob } from './util.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONTENT_DIR = join(REPO_ROOT, 'content');
const PRINCIPLES_DIR = join(CONTENT_DIR, 'principles');
const DIST_DIR = join(REPO_ROOT, 'dist');

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

// Minimal HTML shell for M3. Full chrome lands in M5.
function wrapShell({ title, bodyHtml, canonicalPath }) {
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="canonical" href="${canonicalPath}" />
  </head>
  <body>
    <main>
${bodyHtml}
    </main>
  </body>
</html>
`;
}

export async function build() {
  await ensureDir(DIST_DIR);

  // 1. Sorted principle files.
  const principleFiles = await sortedGlob(PRINCIPLES_DIR);

  // 2. Render each principle and copy its source bytes.
  const principles = [];
  for (const file of principleFiles) {
    const { n, slug } = parseFilename(file);
    const source = await readFile(file, 'utf8');
    let html = await renderMarkdown(source);
    // The H1 id and its permalink href are derived by rehype-slug from the
    // H1 text. If the authored H1 ("P4: Fail Fast *with* Actionable Errors")
    // slugifies to something different from the filename-derived locked slug
    // (DESIGN.md §3.5), the citation primitive drifts. Pin the first H1 id
    // and the first anchor href to the filename slug so the locked anchors
    // remain authoritative even if the H1 prose evolves.
    html = html
      .replace(/<h1 id="[^"]*"/, `<h1 id="p${n}-${slug}"`)
      .replace(/(<h1 id="p\d+-[^"]*">[^<]*<a\s[^>]*href=")#[^"]*"/, `$1#p${n}-${slug}"`);
    const title = extractTitle(source);

    await writeFile(join(DIST_DIR, `p${n}.html`), wrapShell({ title, bodyHtml: html, canonicalPath: `/p${n}` }));
    await copyFile(file, join(DIST_DIR, `p${n}.md`));

    principles.push({ n, slug, title, source, html, filename: file });
  }

  // 3. Intro.
  const introPath = join(CONTENT_DIR, '_intro.md');
  const introSource = await readFile(introPath, 'utf8');
  const introTitle = extractTitle(introSource);
  const introSummary = extractIntroSummary(introSource);
  const introHtml = await renderMarkdown(introSource);

  // 4. Index page = intro + all principles concatenated.
  const indexBody = [introHtml, ...principles.map((p) => p.html)].join('\n');
  await writeFile(
    join(DIST_DIR, 'index.html'),
    wrapShell({ title: introTitle, bodyHtml: indexBody, canonicalPath: '/' }),
  );

  // index.md is the concat of intro + every principle's source, byte-equivalent
  // to the authored markdown (no re-rendering, no re-wrapping).
  const indexMd = [introSource, ...principles.map((p) => p.source)].join('\n');
  await writeFile(join(DIST_DIR, 'index.md'), indexMd);

  // 5. check.md + about.md.
  const subPages = [
    { name: 'check', path: join(CONTENT_DIR, 'check.md') },
    { name: 'about', path: join(CONTENT_DIR, 'about.md') },
  ];
  const subPageData = [];
  for (const { name, path } of subPages) {
    const source = await readFile(path, 'utf8');
    const title = extractTitle(source);
    const html = await renderMarkdown(source);
    await writeFile(join(DIST_DIR, `${name}.html`), wrapShell({ title, bodyHtml: html, canonicalPath: `/${name}` }));
    await copyFile(path, join(DIST_DIR, `${name}.md`));
    subPageData.push({ name, source, title });
  }

  // 7. llms.txt + llms-full.txt.
  const llmsIndex = buildLlmsIndex({
    introTitle,
    summary: introSummary,
    principles: principles.map((p) => ({ n: p.n, slug: p.slug, title: p.title })),
  });
  await writeFile(join(DIST_DIR, 'llms.txt'), llmsIndex);

  const llmsFull = buildLlmsFull({
    sections: [
      {
        title: introTitle,
        body: introSource,
        htmlPath: '/',
        mdPath: '/index.md',
      },
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

  // 8. Sitemap.
  const sitemap = buildSitemap({
    principleNumbers: principles.map((p) => p.n),
  });
  await writeFile(join(DIST_DIR, 'sitemap.xml'), sitemap);

  // 9. Return counts for assertions.
  return {
    principles: principles.length,
    htmlPages: principles.length + 3, // + index + check + about
    mdPages: principles.length + 3,
    extras: 3, // llms.txt + llms-full.txt + sitemap.xml
  };
}

// Allow `bun src/build/build.mjs` to run the pipeline directly.
if (import.meta.main) {
  const summary = await build();
  console.log('build complete:', summary);
}
