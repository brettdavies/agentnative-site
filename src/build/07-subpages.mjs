// Content-driven sub-pages emit. Section 7 of the build pipeline.
//
// For each entry in `SUB_PAGES`, reads content/<name>.md, renders the HTML
// via the shared markdown pipeline, wraps in emitShell, and emits both the
// HTML and markdown twin. The twin is the authored source with site-
// relative links absolutified, prefixed with title/description/url
// frontmatter derived from the same extractors the HTML <head> uses.
//
// Interactive widgets (forms/inputs/buttons) do NOT belong in content/*.md:
// the markdown twin and llms-full.txt are served verbatim from the source,
// so raw widget markup leaks dead controls into the agent-facing surface. A
// page that needs a browser widget declares a `widget` slot here: the
// placeholder in the content renders as HTML in the page and as a plain
// prose pointer in the twin. Mirrors the homepage form living in
// src/build/06-homepage.mjs rather than in a content file.
//
// Adding a new content/*.md page requires three coordinated registrations:
// this list, src/build/10-sitemap.mjs's hardcoded paths, and src/build/shell.mjs's
// nav. See docs/solutions/conventions/new-content-page-requires-three-registrations-2026-05-21.md.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderAuditForm } from './audit-form.mjs';
import { extractDescription, extractTitle } from './content.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell, WEBMCP_SCRIPT } from './shell.mjs';
import { composeTwin } from './util.mjs';

// The audit page's hero: the shared entry form under the page's heading and
// lede. The content after the slot is the CLI pane and `lanes.web` the
// website pane; the form's segment shows one at a time, the twin carries both.
const AUDIT_WIDGET = {
  placeholder: '{{AUDIT_FORM}}',
  html: `<section class="audit-hero" aria-labelledby="audit-hero-heading">
  <h2 id="audit-hero-heading" class="audit-hero__title">Audit it live.</h2>
  <p class="audit-hero__lede">Pick CLI or Website and enter a target. A CLI tool installs in a sandbox and scores in under a minute; a website audit takes a few seconds. Either way you land on a shareable scorecard.</p>
  ${renderAuditForm({ idPrefix: 'audit' })}
</section>`,
  md: 'The audit runs live from this page in a browser. From an agent, use the MCP tools named below.',
  lanes: { web: '_audit-web.md' },
};

/**
 * Emit content-driven sub-pages (HTML + MD twin via shared pipeline).
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.contentDir
 * @param {string} args.themeInit
 * @returns {Promise<Array<{name: string, source: string, title: string}>>}
 *          Per-page metadata (twin markdown) consumed by llms-full.txt assembly.
 */
export const SUB_PAGES = [
  { name: 'audit', breadcrumb: 'Audit', extraScripts: ['/js/audit-entry.js', WEBMCP_SCRIPT], widget: AUDIT_WIDGET },
  { name: 'install', breadcrumb: 'Install' },
  { name: 'about', breadcrumb: 'About' },
  { name: 'badge', breadcrumb: 'Badge' },
  { name: 'changelog', breadcrumb: 'Changelog' },
  { name: 'contribute', breadcrumb: 'Contribute' },
  { name: 'methodology', breadcrumb: 'Methodology' },
  { name: 'privacy', breadcrumb: 'Privacy' },
  { name: 'scorecard-schema', breadcrumb: 'Scorecard schema' },
  { name: 'web-scorecard-schema', breadcrumb: 'Web scorecard schema' },
  // /mcp-skill/ is the client-facing skill page advertised by the
  // /.well-known/mcp pointer's `documentation` field and by the MCP
  // server's handshake `instructions` string. The source filename
  // matches the URL stem; outputs are `dist/mcp-skill.html` +
  // `dist/mcp-skill.md`. The canonical URL is `/mcp-skill/`, not
  // `/mcp/` (which is the Worker-served JSON-RPC endpoint). Operator-
  // facing material lives in the in-repo runbook at
  // `docs/runbooks/mcp-operator.md` and is not published.
  { name: 'mcp-skill', breadcrumb: 'MCP skill' },
  // /mcp renders as a regular content page (HTML + MD twin) so a
  // human or crawler clicking the literal endpoint URL lands on a
  // shell-wrapped descriptor — same header, theme toggle, footer as
  // every other content page. The Worker intercepts /mcp for POST
  // (JSON-RPC) and for GET + Accept: application/json (proxies
  // /.well-known/mcp). Other GET methods fall through to the asset-
  // first dispatch which serves dist/mcp.html or the .md twin via
  // the site's standard content negotiation.
  { name: 'mcp', breadcrumb: 'MCP' },
];

// The HTML page gets the widget markup; the twin (and llms-full.txt) get
// the prose pointer, so no dead form controls reach the agent surface.
async function renderPage(source, widget) {
  const htmlSource = widget ? source.replaceAll(widget.placeholder, widget.html) : source;
  const twinSource = widget ? source.replaceAll(widget.placeholder, widget.md) : source;
  return { html: await renderMarkdown(htmlSource), twinSource };
}

// A page with lane panes: the content after the widget is the CLI pane and
// the `lanes.web` partial the website pane, inside one `.scope` so the
// form's segment swaps them. The twin carries both panes in order.
async function renderLanes(source, widget, contentDir) {
  const chunks = source.split(widget.placeholder);
  if (chunks.length !== 2) {
    throw new Error(`${widget.placeholder} must appear exactly once; found ${chunks.length - 1}`);
  }
  const [lead, cli] = chunks;
  const web = await readFile(join(contentDir, widget.lanes.web), 'utf8');
  const html = `<div class="scope">${await renderMarkdown(lead)}${widget.html}<div data-s="cli">${await renderMarkdown(cli)}</div><div data-s="web">${await renderMarkdown(web)}</div></div>`;
  return { html, twinSource: `${lead}${widget.md}${cli.trimEnd()}\n\n${web}` };
}

export async function emitSubPages({ distDir, contentDir, themeInit }) {
  const subPageData = [];
  for (const { name, breadcrumb, extraScripts, widget } of SUB_PAGES) {
    const source = await readFile(join(contentDir, `${name}.md`), 'utf8');
    const title = extractTitle(source);
    const description = extractDescription(source);
    const { html, twinSource } = widget?.lanes
      ? await renderLanes(source, widget, contentDir)
      : await renderPage(source, widget);
    await writeFile(
      join(distDir, `${name}.html`),
      emitShell({
        title,
        description,
        canonicalPath: `/${name}`,
        breadcrumb,
        // Every subpage renders inside the shared reading treatment.
        bodyHtml: `<article class="container doc">${html}</article>`,
        themeInitJs: themeInit,
        extraScripts: extraScripts ?? (name === 'mcp' ? [WEBMCP_SCRIPT] : []),
        turnstileSitekey: name === 'web-audit' || name === 'audit',
      }),
    );
    await writeFile(
      join(distDir, `${name}.md`),
      composeTwin({ title, description, canonicalPath: `/${name}` }, twinSource),
    );
    // llms-full.txt consumes `source` and must stay frontmatter-free (the
    // A5 section header already carries the metadata), so push the raw
    // twin source, not the composed twin.
    subPageData.push({ name, source: twinSource, title });
  }
  return subPageData;
}
