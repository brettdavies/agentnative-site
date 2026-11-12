// A page's content date: the UTC `YYYY-MM-DD` day its content last changed.
// One value per page feeds the sitemap `<lastmod>`, the JSON-LD
// `dateModified`, `article:modified_time`, and the markdown twin's
// `dateModified` key. The build dates built pages from git history
// (src/build/content-dates.mjs); the Worker dates the pages it fills from
// stored scorecards by the day each scoring ran.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a `YYYY-MM-DD` day string. */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value);
}

/** The latest of some days, or null when none of them is a day. */
export function newestDay(days: Iterable<string | null | undefined>): string | null {
  let newest: string | null = null;
  for (const day of days) {
    if (isDay(day) && (newest === null || day > newest)) newest = day;
  }
  return newest;
}

/** The head meta tag that states a dated page's day. */
export function modifiedTimeMeta(day: string): string {
  return `<meta property="article:modified_time" content="${day}" />`;
}

/**
 * The Worker's shell template takes a page's day at request time. The
 * JSON-LD value is a quoted string in the TechArticle node, so the
 * substituter replaces the whole property, comma included, and a page with
 * no day loses the property rather than carrying an empty one. The meta tag
 * has a token of its own.
 */
export const DATE_MODIFIED_TOKEN = '{{DATE_MODIFIED}}';
export const MODIFIED_TIME_META_TOKEN = '{{MODIFIED_TIME_META}}';

const META_DAY_RE = /(<meta property="?article:modified_time"? content="?)(\d{4}-\d{2}-\d{2})/;

/**
 * A built page's HTML with its day moved to `day` when `day` is later. The
 * build dates a board page by its own inputs, and the rows the Worker fills
 * in can be newer. Only the head is read, so no row text can move the day,
 * and a page the build left undated stays undated.
 */
export function raiseHtmlDate(html: string, day: string | null): string {
  if (!isDay(day)) return html;
  const headEnd = html.indexOf('</head>');
  if (headEnd < 0) return html;
  const head = html.slice(0, headEnd);
  const stated = head.match(META_DAY_RE)?.[2];
  if (stated === undefined || stated >= day) return html;
  const raised = head
    .replace(META_DAY_RE, (_match, prefix: string) => `${prefix}${day}`)
    .replace(`"dateModified":"${stated}"`, `"dateModified":"${day}"`);
  return raised + html.slice(headEnd);
}
