// Emit dist/sitemap.xml. One entry per canonical, extension-less URL. No
// trailing slashes (docs/DESIGN.md §3.4.1 "Asset resolution"). The production
// base URL lives here; override via PUBLIC_BASE_URL env during build if
// staging needs a different origin.

import { resolveBaseUrl } from './util.mjs';

/**
 * @param {object} args
 * @param {number[]} args.principleNumbers e.g. [1, 2, 3, 4, 5, 6, 7]
 * @param {string[]=} args.extraPaths additional canonical paths to include
 * @param {string=} args.baseUrl defaults to process.env.PUBLIC_BASE_URL or https://anc.dev
 * @param {string=} args.lastmod ISO-8601 date string; defaults to today UTC.
 * @returns {string} XML body.
 */
export function buildSitemap({ principleNumbers, extraPaths = [], baseUrl, lastmod }) {
  const base = resolveBaseUrl(baseUrl);
  const today = lastmod ?? new Date().toISOString().slice(0, 10);

  const paths = [
    '/',
    ...principleNumbers.map((n) => `/p${n}`),
    '/audit',
    '/about',
    '/changelog',
    '/contribute',
    '/methodology',
    '/scorecard-schema',
    '/mcp-skill',
    '/mcp',
    ...extraPaths,
  ];

  const urls = paths
    .map((p) => {
      const loc = p === '/' ? `${base}/` : base + p;
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
