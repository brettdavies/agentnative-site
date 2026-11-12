// Emit dist/sitemap.xml. One entry per canonical, extension-less URL. No
// trailing slashes (docs/DESIGN.md §3.4.1 "Asset resolution").
//
// <loc> is a canonical declaration, so it pins to the canonical host and
// ignores PUBLIC_BASE_URL. A staging sitemap advertising staging URLs
// would invite crawlers to index the staging deployment.
//
// <lastmod> is the page's content date (content-dates.mjs), the same value
// its JSON-LD and markdown twin carry. A page the build cannot date (one the
// Worker renders from stored records) is listed without one, and the Worker
// dates it when it serves the file (src/worker/sitemap.ts).

import { AUDIT_PATH } from '../shared/audit-routes.ts';
import { isDay } from '../shared/page-date';
import { sitemapEntry } from '../shared/sitemap-entry';
import { canonicalBaseUrl } from './util.mjs';

/**
 * @param {object} args
 * @param {number[]} args.principleNumbers e.g. [1, 2, 3, 4, 5, 6, 7]
 * @param {string[]=} args.extraPaths additional canonical paths to include
 * @param {string=} args.baseUrl explicit override; defaults to the canonical host
 * @param {(path: string) => string | null | undefined} args.lastmodOf a listed
 *   path's `YYYY-MM-DD` content date, or `null` for a path the build cannot
 *   date. `undefined` is an unmapped path and fails the build.
 * @returns {string} XML body.
 */
export function buildSitemap({ principleNumbers, extraPaths = [], baseUrl, lastmodOf }) {
  const base = canonicalBaseUrl(baseUrl);

  const paths = [
    '/',
    ...principleNumbers.map((n) => `/p${n}`),
    AUDIT_PATH,
    '/about',
    '/changelog',
    '/contribute',
    '/methodology',
    '/scorecard-schema',
    '/mcp-skill',
    '/mcp-docs',
    ...extraPaths,
  ];

  const urls = paths
    .map((p) => {
      const loc = p === '/' ? `${base}/` : base + p;
      const lastmod = lastmodOf(p);
      if (lastmod === undefined) throw new Error(`buildSitemap: no content date for ${p}`);
      if (lastmod !== null && !isDay(lastmod)) throw new Error(`buildSitemap: ${p} lastmod "${lastmod}" is not a day`);
      return sitemapEntry(loc, lastmod);
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
