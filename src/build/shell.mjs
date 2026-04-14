// HTML shell emitter. Wraps a rendered body fragment in the production
// document — head with JSON-LD + OG + theme-init + preloads + stylesheet
// links, body with skip-link + header + footer + deferred client JS.
//
// Inputs are plain data (no filesystem). assets.mjs reads the inline
// theme-init script from disk and passes it in.

const SITE_NAME = 'agentnative.dev';
const SITE_TAGLINE = 'The agent-native CLI standard';

const DEFAULT_BASE = 'https://agentnative.dev';

function esc(s) {
  return String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

/**
 * @param {object} args
 * @param {string} args.title                — document <title> + og:title.
 * @param {string} args.description          — meta description + og:description.
 * @param {string} args.canonicalPath        — site-relative path, e.g. '/p3'.
 * @param {string} args.bodyHtml             — rendered principle / page HTML.
 * @param {string} args.themeInitJs          — inline head script source.
 * @param {boolean=} args.isIndex            — true on '/', adds mini-TOC rail.
 * @param {Array<{n:number,slug:string,title:string}>=} args.principles
 *        Used by the mini-TOC on '/'.
 * @param {string=} args.baseUrl             — absolute base (default prod).
 * @returns {string} full HTML document.
 */
export function emitShell({
  title,
  description,
  canonicalPath,
  bodyHtml,
  themeInitJs,
  isIndex = false,
  principles = [],
  baseUrl,
}) {
  const base = (baseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');
  const canonical = base + canonicalPath;
  const ogImage = `${base}/og-image.png`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description,
    url: canonical,
    image: ogImage,
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: base,
    },
  };

  const miniToc =
    isIndex && principles.length > 0
      ? `<nav class="mini-toc" aria-label="Principles">
  <h2 class="mini-toc__heading">Principles</h2>
  <ol class="mini-toc__list">
${principles
  .map((p) => `    <li><a href="#p${p.n}-${p.slug}">P${p.n}. ${esc(p.title.replace(/^P\d+:\s*/, ''))}</a></li>`)
  .join('\n')}
  </ol>
</nav>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${canonical}" />

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${ogImage}" />

    <link rel="icon" href="/og-image.png" type="image/png" />

    <link rel="preload" href="/fonts/uncut-sans-variable.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/monaspace-xenon-variable.woff2" as="font" type="font/woff2" crossorigin />

    <link rel="stylesheet" href="/css/foundation.css" />
    <link rel="stylesheet" href="/css/site.css" />

    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <script>${themeInitJs}</script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <a class="site-brand" href="/">
        <span class="site-brand__name">${SITE_NAME}</span>
        <span class="site-brand__tag">${SITE_TAGLINE}</span>
      </a>
      <nav class="site-nav" aria-label="Primary">
        <a href="/check">Check your CLI</a>
        <a href="/about">About</a>
      </nav>
      <div class="theme-toggle" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
        <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
        <button type="button" data-theme-set="system" aria-pressed="true">System</button>
      </div>
    </header>
    <main id="main">
${miniToc}
${bodyHtml}
    </main>
    <footer class="site-footer">
      <p class="site-footer__meta">
        <span>${SITE_NAME}</span>
        <span> · </span>
        <a href="/llms.txt">llms.txt</a>
        <span> · </span>
        <a href="/llms-full.txt">llms-full.txt</a>
        <span> · </span>
        <a href="${canonicalPath === '/' ? '/index.md' : canonicalPath + '.md'}">This page as markdown</a>
      </p>
    </footer>
    <script src="/js/theme.js" defer></script>
    <script src="/js/clipboard.js" defer></script>
  </body>
</html>
`;
}
