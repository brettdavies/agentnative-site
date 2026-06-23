// Content-driven sub-pages emit. Section 7 of the build pipeline.
//
// For each entry in `subPages`, reads content/<name>.md, renders the HTML
// via the shared markdown pipeline, wraps in emitShell, and emits both the
// HTML and markdown twin. The twin is the authored source with site-
// relative links absolutified.
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

/**
 * Emit content-driven sub-pages (HTML + MD twin via shared pipeline).
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.contentDir
 * @param {string} args.themeInit
 * @returns {Promise<Array<{name: string, source: string, title: string}>>}
 *          Per-page metadata consumed by llms-full.txt assembly.
 */
export async function emitSubPages({ distDir, contentDir, themeInit }) {
  const subPages = [
    { name: 'audit', path: join(contentDir, 'audit.md') },
    { name: 'install', path: join(contentDir, 'install.md') },
    { name: 'about', path: join(contentDir, 'about.md') },
    { name: 'badge', path: join(contentDir, 'badge.md') },
    { name: 'changelog', path: join(contentDir, 'changelog.md') },
    { name: 'contribute', path: join(contentDir, 'contribute.md') },
    { name: 'methodology', path: join(contentDir, 'methodology.md') },
    { name: 'scorecard-schema', path: join(contentDir, 'scorecard-schema.md') },
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
  for (const { name, path } of subPages) {
    const source = await readFile(path, 'utf8');
    const title = extractTitle(source);
    const description = extractDescription(source);
    const html = await renderMarkdown(source);
    await writeFile(
      join(distDir, `${name}.html`),
      emitShell({
        title,
        description,
        canonicalPath: `/${name}`,
        bodyHtml: html,
        themeInitJs: themeInit,
        extraScripts: name === 'mcp' ? [WEBMCP_SCRIPT] : [],
      }),
    );
    await writeFile(join(distDir, `${name}.md`), absolutifyMarkdownLinks(source));
    subPageData.push({ name, source, title });
  }
  return subPageData;
}
