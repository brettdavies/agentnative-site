// HTML shell emitter. Wraps a rendered body fragment in the production
// document — head with JSON-LD + OG + theme-init + preloads + stylesheet
// links, body with skip-link + header + footer + deferred client JS.
//
// Inputs are plain data (no filesystem). assets.mjs reads the inline
// theme-init script from disk and passes it in.

const SITE_NAME = 'agentnative.dev';
const SITE_TAGLINE = 'The agent-native CLI standard';

const DEFAULT_BASE = 'https://agentnative.dev';

const AI_SUMMARY_PROMPT =
  'Summarize the agent-native CLI standard from https://agentnative.dev/llms-full.txt — what are the seven principles and why do they matter for AI agents using CLI tools?';

const AI_PROVIDERS = [
  {
    name: 'ChatGPT',
    url: (q) => `https://chat.openai.com/?q=${q}`,
    // Official OpenAI mark (Simple Icons)
    svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>',
  },
  {
    name: 'Claude',
    url: (q) => `https://claude.ai/new?q=${q}`,
    // Official Anthropic mark (Simple Icons)
    svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456z"/></svg>',
  },
  {
    name: 'Gemini',
    url: (q) => `https://gemini.google.com/app?q=${q}`,
    // Official Google Gemini mark (Simple Icons)
    svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
  },
  {
    name: 'Grok',
    url: (q) => `https://x.com/i/grok?text=${q}`,
    // Official X mark (Simple Icons) — Grok lives at x.com/i/grok
    svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>',
  },
  {
    name: 'Perplexity',
    url: (q) => `https://www.perplexity.ai/?q=${q}`,
    // Official Perplexity mark (Simple Icons)
    svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/></svg>',
  },
];

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
      <div class="ai-summary">
        <p class="ai-summary__heading">Ask an AI about this standard</p>
        <div class="ai-summary__icons">
${AI_PROVIDERS.map(
  (p) =>
    `          <a href="${p.url(encodeURIComponent(AI_SUMMARY_PROMPT))}" target="_blank" rel="noopener noreferrer" class="ai-summary__link" aria-label="Ask ${p.name}">${p.svg}</a>`,
).join('\n')}
        </div>
      </div>
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
