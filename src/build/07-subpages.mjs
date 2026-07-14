// Content-driven sub-pages emit. Section 7 of the build pipeline.
//
// For each entry in `subPages`, reads content/<name>.md, renders the HTML
// via the shared markdown pipeline, wraps in emitShell, and emits both the
// HTML and markdown twin. The twin is the authored source with site-
// relative links absolutified.
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
import { extractDescription, extractTitle } from './content.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell, WEBMCP_SCRIPT } from './shell.mjs';
import { absolutifyMarkdownLinks } from './util.mjs';

// The CLI "score a binary" hero. A plain GET form (works without JS) that
// prefills the homepage demo via ?score=.
const CLI_AUDIT_WIDGET = {
  placeholder: '{{CLI_AUDIT_FORM}}',
  html: `<section class="audit-hero" aria-labelledby="audit-hero-heading">
  <h2 id="audit-hero-heading" class="audit-hero__title">Score a binary, live.</h2>
  <p class="audit-hero__lede">The homepage demo runs binary and behavioral audits in a sandbox. For source and project depth, run <code>anc audit</code> locally.</p>
  <form class="board-try audit-hero__form" method="get" action="/">
    <input name="score" type="text" autocomplete="off" spellcheck="false" placeholder="ripgrep" aria-label="Tool name, install command, or GitHub URL" />
    <button type="submit" class="btn btn--primary">Score</button>
  </form>
</section>`,
  md: 'Score a binary live from the homepage demo at [anc.dev](/), or run `anc audit` locally for source and project depth.',
};

// The web-audit hero. Submitting navigates to /web/scoring/<host>, which
// streams the audit; web-audit.js binds the data-* hooks.
const WEB_AUDIT_WIDGET = {
  placeholder: '{{WEB_AUDIT_FORM}}',
  html: `<section class="audit-hero" aria-labelledby="web-audit-heading" data-web-audit-section>
  <h2 id="web-audit-heading" class="audit-hero__title">Score a website, live.</h2>
  <p class="audit-hero__lede">Enter a public URL. We open an in-progress page that streams each check as it resolves, then forwards to a shareable <code>/web/&lt;domain&gt;</code> scorecard.</p>
  <form class="board-try audit-hero__form" method="get" action="/web/scoring" novalidate data-web-audit-form>
    <input id="web-audit-input" name="url" type="text" autocomplete="off" spellcheck="false" placeholder="anc.dev" required aria-label="Website URL" aria-describedby="web-audit-help" data-web-audit-input />
    <button type="submit" class="btn btn--primary" data-web-audit-submit>Audit</button>
  </form>
  <p id="web-audit-help" class="live-score__help">
    or try
    <button type="button" class="live-score__chip" data-web-audit-example="anc.dev" aria-label="Try example: anc.dev"><code>anc.dev</code></button>,
    <button type="button" class="live-score__chip" data-web-audit-example="modelcontextprotocol.io" aria-label="Try example: modelcontextprotocol.io"><code>modelcontextprotocol.io</code></button>.
  </p>
  <p class="live-score__status" data-web-audit-status role="status" aria-live="polite" hidden></p>
</section>`,
  md: 'Enter a public URL at [anc.dev/web-audit](https://anc.dev/web-audit) to run the audit in your browser.',
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
export async function emitSubPages({ distDir, contentDir, themeInit }) {
  const subPages = [
    { name: 'audit', path: join(contentDir, 'audit.md'), widget: CLI_AUDIT_WIDGET },
    {
      name: 'web-audit',
      path: join(contentDir, 'web-audit.md'),
      extraScripts: ['/js/web-audit.js'],
      widget: WEB_AUDIT_WIDGET,
    },
    { name: 'install', path: join(contentDir, 'install.md') },
    { name: 'about', path: join(contentDir, 'about.md') },
    { name: 'badge', path: join(contentDir, 'badge.md') },
    { name: 'changelog', path: join(contentDir, 'changelog.md') },
    { name: 'contribute', path: join(contentDir, 'contribute.md') },
    { name: 'methodology', path: join(contentDir, 'methodology.md') },
    { name: 'scorecard-schema', path: join(contentDir, 'scorecard-schema.md') },
    { name: 'web-scorecard-schema', path: join(contentDir, 'web-scorecard-schema.md') },
    // /mcp-skill/ is the client-facing skill page advertised by the
    // /.well-known/mcp pointer's `documentation` field and by the MCP
    // server's handshake `instructions` string. The source filename
    // matches the URL stem; outputs are `dist/mcp-skill.html` +
    // `dist/mcp-skill.md`. The canonical URL is `/mcp-skill/`, not
    // `/mcp/` (which is the Worker-served JSON-RPC endpoint). Operator-
    // facing material lives in the in-repo runbook at
    // `docs/runbooks/mcp-operator.md` and is not published.
    { name: 'mcp-skill', path: join(contentDir, 'mcp-skill.md') },
    // /mcp renders as a regular content page (HTML + MD twin) so a
    // human or crawler clicking the literal endpoint URL lands on a
    // shell-wrapped descriptor — same header, theme toggle, footer as
    // every other content page. The Worker intercepts /mcp for POST
    // (JSON-RPC) and for GET + Accept: application/json (proxies
    // /.well-known/mcp). Other GET methods fall through to the asset-
    // first dispatch which serves dist/mcp.html or the .md twin via
    // the site's standard content negotiation.
    { name: 'mcp', path: join(contentDir, 'mcp.md') },
  ];
  const subPageData = [];
  for (const { name, path, extraScripts, widget } of subPages) {
    const source = await readFile(path, 'utf8');
    // The HTML page gets the widget markup; the twin (and llms-full.txt) get
    // the prose pointer, so no dead form controls reach the agent surface.
    const htmlSource = widget ? source.replaceAll(widget.placeholder, widget.html) : source;
    const twinSource = widget ? source.replaceAll(widget.placeholder, widget.md) : source;
    const title = extractTitle(source);
    const description = extractDescription(source);
    const html = await renderMarkdown(htmlSource);
    await writeFile(
      join(distDir, `${name}.html`),
      emitShell({
        title,
        description,
        canonicalPath: `/${name}`,
        // Every subpage renders inside the shared reading treatment.
        bodyHtml: `<article class="container doc">${html}</article>`,
        themeInitJs: themeInit,
        extraScripts: extraScripts ?? (name === 'mcp' ? [WEBMCP_SCRIPT] : []),
      }),
    );
    await writeFile(join(distDir, `${name}.md`), absolutifyMarkdownLinks(twinSource));
    subPageData.push({ name, source: twinSource, title });
  }
  return subPageData;
}
