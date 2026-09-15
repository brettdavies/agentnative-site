// The one breadcrumb trail, rendered twice: as the nav a reader sees and as
// the BreadcrumbList a crawler reads. Both come from this trail, so the two
// cannot disagree, which is what Google's structured-data guidance asks for
// and what a page rendering its own bespoke crumb could not promise.
//
// Imported by three module graphs with incompatible type environments: the
// build, the Worker, and the browser client. Only pure functions over strings
// live here, so all three accept it.
//
// A trail is empty for the home page, where one item names only itself.
//
// A namespace prefix is not a page. `/score/` and `/fix/` are prefixes the
// route module owns, and their bare paths are 404s, so a crumb linking to one
// would send a reader, and a crawler, to a miss. Where the namespace has a
// real parent the trail names that page instead; where it has none the
// namespace is dropped and its target hangs off the home page.

import { FIX_PREFIX, SCORE_PREFIX, SCORECARDS_PATH } from './audit-routes';
import { escHtml } from './esc-html';

// A crumb holds the site-relative path, never an absolute URL: the nav a
// reader clicks is site navigation and stays relative, so a staging page links
// to staging. Only the JSON-LD absolutizes, because a crawler needs a resolvable
// URL and crawler-facing identity names the canonical host either way.
export type Crumb = { name: string; path: string };

/**
 * The stand-in the Worker's shell template carries in place of a
 * BreadcrumbList. It is a bare string inside the graph, so it serializes to a
 * quoted token that `substituteShell` swaps for the real node, or removes
 * along with its separating comma when the path has no trail.
 */
export const BREADCRUMB_JSONLD_TOKEN = '{{BREADCRUMB_JSONLD}}';

const segmentOf = (prefix: string) => prefix.replaceAll('/', '');

/** The page a namespace's targets belong under, or null when it has none. */
const NAMESPACE_PARENT: Readonly<Record<string, Crumb | null>> = {
  [segmentOf(SCORE_PREFIX)]: { name: 'Leaderboard', path: SCORECARDS_PATH },
  [segmentOf(FIX_PREFIX)]: null,
};

const namespaceOf = (segment: string): string | null => (Object.hasOwn(NAMESPACE_PARENT, segment) ? segment : null);

/**
 * The trail from the home page to `path`, or an empty array when the page has
 * none to draw.
 *
 * `label` names the last crumb. A page supplies it when it knows better than
 * the URL does, which every page with a readable name does: a slug carries no
 * casing a rule could recover. Without one the segment stands verbatim, which
 * is right for a target under a namespace, where the segment is already an
 * identifier a reader recognizes.
 */
export function breadcrumbTrail(path: string, label?: string | null): Crumb[] {
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (segments.length === 0) return [];

  const trail: Crumb[] = [{ name: 'Home', path: '/' }];
  const namespace = namespaceOf(segments[0]);
  if (namespace !== null) {
    const parent = NAMESPACE_PARENT[namespace];
    if (parent) trail.push(parent);
    // One crumb for the whole target however many segments it spans: a
    // branch-scoped result is `owner/repo@branch`, one identifier with a slash.
    const target = decodeURIComponentSafe(segments.slice(1).join('/'));
    trail.push({ name: label ?? target, path });
    return trail;
  }

  let href = '';
  segments.forEach((segment, i) => {
    href += `/${segment}`;
    const last = i === segments.length - 1;
    trail.push({ name: last && label ? label : segment, path: href });
  });
  return trail;
}

/**
 * Whether `path` must be given a label of its own.
 *
 * A page with a trail states its own name in the last crumb, and a URL segment
 * carries no casing a rule could recover from it. Without this the omission is
 * silent: the slug renders, the two renderings still agree, and every test
 * that compares them passes.
 */
export function breadcrumbLabelRequired(path: string): boolean {
  return breadcrumbTrail(path).length > 0;
}

/** The BreadcrumbList node for a trail, or null when there is nothing to state. */
export function breadcrumbJsonLd(trail: readonly Crumb[], base: string): Record<string, unknown> | null {
  if (trail.length === 0) return null;
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      // The home page is the base itself; every other crumb hangs off it.
      item: crumb.path === '/' ? base : `${base}${crumb.path}`,
    })),
  };
}

/**
 * The nav a reader sees. The last crumb is the page itself, so it is text
 * rather than a link to where the reader already is.
 */
export function renderBreadcrumbNav(trail: readonly Crumb[]): string {
  if (trail.length === 0) return '';
  const items = trail.map((crumb, i) =>
    i === trail.length - 1
      ? `<span aria-current="page">${escHtml(crumb.name)}</span>`
      : `<a href="${escHtml(crumb.path)}">${escHtml(crumb.name)}</a>`,
  );
  return `<nav class="crumb" aria-label="Breadcrumb">${items.join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
