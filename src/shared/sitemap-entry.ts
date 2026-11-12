// One `<url>` entry of the sitemap. The build writes every entry; the Worker
// adds the dates only stored scorecards know when it serves the file.

import { newestDay } from './page-date';

/** An entry, with `<lastmod>` only when the page has a day. */
export function sitemapEntry(loc: string, lastmod: string | null): string {
  const lastmodLine = lastmod === null ? '' : `\n    <lastmod>${lastmod}</lastmod>`;
  return `  <url>\n    <loc>${loc}</loc>${lastmodLine}\n  </url>`;
}

const ENTRY_RE = /^ {2}<url>\n {4}<loc>([^<]+)<\/loc>(?:\n {4}<lastmod>([^<]+)<\/lastmod>)?\n {2}<\/url>$/gm;

/**
 * A sitemap with each entry dated by the later of its own `<lastmod>` and the
 * day `dayFor` gives the entry's path. The entries and their order stay as
 * written; an entry neither source dates keeps no `<lastmod>`.
 */
export function raiseSitemapDates(xml: string, dayFor: (pathname: string) => string | null): string {
  return xml.replace(ENTRY_RE, (entry: string, loc: string, lastmod: string | undefined) => {
    const day = newestDay([lastmod, dayFor(new URL(loc).pathname)]);
    return day === null || day === lastmod ? entry : sitemapEntry(loc, day);
  });
}
