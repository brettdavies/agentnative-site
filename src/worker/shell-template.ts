// The page shell every Worker-rendered HTML page fills. The template is
// `dist/_internal/score-live-shell.html`, emitted by the build from the
// same `emitShell()` that builds the static pages, so a Worker page and a
// static page share one layout. It is fetched once per isolate and held.
//
// Placeholders: {{TITLE}}, {{HEAD_TITLE}}, {{DESCRIPTION}}, {{CANONICAL_PATH}}, {{BODY}},
// {{MARKDOWN_TWIN_PATH}} (the footer's twin link), {{ALTERNATES}} (the
// `<link rel="alternate">` lines in the head), and the page's day in the
// JSON-LD and the `article:modified_time` tag. A page that names no twin
// gets `<canonical>.md`; a result page passes its `/md` and `/json`
// representations.

import { BREADCRUMB_JSONLD_TOKEN, breadcrumbJsonLd, breadcrumbTrail, renderBreadcrumbNav } from '../shared/breadcrumb';
import { SITE_OG_IMAGE_ALT, SITE_OG_IMAGE_PATH } from '../shared/og-card';
import { DATE_MODIFIED_TOKEN, isDay, MODIFIED_TIME_META_TOKEN, modifiedTimeMeta } from '../shared/page-date';
import { markdownAlternateLink } from '../shared/result-head';
import { escHtml } from '../shared/scorecard-format.mjs';
import { headTitle } from '../shared/search-head';
import { CANONICAL_SITE_URL } from '../shared/site-url';

const BREADCRUMB_JSONLD_SLOT = `,"${BREADCRUMB_JSONLD_TOKEN}"`;
const DATE_MODIFIED_JSONLD_SLOT = `,"dateModified":"${DATE_MODIFIED_TOKEN}"`;
const SHELL_TOKEN = new RegExp(
  `${[BREADCRUMB_JSONLD_SLOT, DATE_MODIFIED_JSONLD_SLOT].map((slot) => slot.replace(/[{}]/g, '\\$&')).join('|')}|\\{\\{[A-Z_]+\\}\\}`,
  'g',
);

// The HTML tokenizer ends a script element at `</script` whatever the JSON around
// it says, and `\u003c` reads back as `<`.
function jsonForScript(value: object): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

let shellTemplatePromise: Promise<string> | null = null;

export async function loadShellTemplate(env: { ASSETS: Fetcher }): Promise<string> {
  if (!shellTemplatePromise) {
    shellTemplatePromise = (async () => {
      const res = await env.ASSETS.fetch(new Request('https://assets.internal/_internal/score-live-shell.html'));
      if (!res.ok) throw new Error(`shell template missing (status ${res.status})`);
      return await res.text();
    })().catch((err) => {
      shellTemplatePromise = null;
      throw err;
    });
  }
  return shellTemplatePromise;
}

/** Test-only: drop the cached template. */
export function _resetShellTemplateCache(): void {
  shellTemplatePromise = null;
}

export type ShellFields = {
  title: string;
  /** The document `<title>`; defaults to the title and the brand. */
  headTitle?: string;
  description: string;
  canonicalPath: string;
  /** Rendered body HTML; every visitor-controlled value is already escaped. */
  body: string;
  /** The page's markdown twin; defaults to `<canonical>.md`. */
  markdownTwinPath?: string;
  /** The head's alternate links; defaults to the markdown twin alone. */
  alternatesHtml?: string;
  /**
   * This page's label in its breadcrumb trail. Required, because a URL segment
   * carries no casing a rule could recover, and a page that omits one states a
   * slug where its name belongs without ever failing.
   */
  breadcrumb: string;
  /** Absolute card URL. Omitted pages keep the site-wide card. */
  ogImage?: string;
  /** Alt text for that card. */
  ogImageAlt?: string;
  /** The og:video meta tags when the page's clip exists; omitted pages name no video. */
  ogVideoHtml?: string;
  /** The page's `YYYY-MM-DD` content date; a page without one states none. */
  dateModified?: string | null;
};

export function substituteShell(template: string, fields: ShellFields): string {
  const twin = fields.markdownTwinPath ?? `${fields.canonicalPath}.md`;
  const ogImage = fields.ogImage ?? `${CANONICAL_SITE_URL}${SITE_OG_IMAGE_PATH}`;
  // The template deferred its breadcrumb to request time, because a trail
  // cannot be split out of a path that does not exist at build time. Both
  // renderings come from one trail here, the same way a built page's do.
  const trail = breadcrumbTrail(fields.canonicalPath, fields.breadcrumb);
  const crumbNode = breadcrumbJsonLd(trail, CANONICAL_SITE_URL);
  const day = isDay(fields.dateModified) ? fields.dateModified : null;
  const values: Readonly<Record<string, string>> = {
    '{{BREADCRUMB_NAV}}': renderBreadcrumbNav(trail),
    // Removing the quoted token and its comma together leaves the graph
    // well-formed when a path has no trail to state.
    [BREADCRUMB_JSONLD_SLOT]: crumbNode ? `,${jsonForScript(crumbNode)}` : '',
    [DATE_MODIFIED_JSONLD_SLOT]: day ? `,"dateModified":${JSON.stringify(day)}` : '',
    [MODIFIED_TIME_META_TOKEN]: day ? modifiedTimeMeta(day) : '',
    '{{TITLE}}': escHtml(fields.title),
    '{{HEAD_TITLE}}': escHtml(fields.headTitle ?? headTitle(fields.title)),
    '{{DESCRIPTION}}': escHtml(fields.description),
    '{{CANONICAL_PATH}}': escHtml(fields.canonicalPath),
    '{{MARKDOWN_TWIN_PATH}}': escHtml(twin),
    '{{ALTERNATES}}': fields.alternatesHtml ?? markdownAlternateLink(twin),
    '{{OG_IMAGE}}': escHtml(ogImage),
    '{{OG_IMAGE_ALT}}': escHtml(fields.ogImageAlt ?? SITE_OG_IMAGE_ALT),
    '{{OG_VIDEO}}': fields.ogVideoHtml ?? '',
    '{{BODY}}': fields.body,
  };
  // One pass with a function replacement, because these values carry request
  // text: a string replacement expands `$&` and its siblings, and a later pass
  // would fill any token a value spells out.
  return template.replace(SHELL_TOKEN, (token) => values[token] ?? token);
}
