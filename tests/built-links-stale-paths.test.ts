// A link a crawler follows should land on a page, not on a 404, a 405, or a
// redirect. /principles and /web have no page behind them, /mcp answers POST
// only, and the other paths answer a redirect to the page a link should name.
// No built page, markdown twin, or llms file links one, in the relative form
// the source writes or the absolute form the twins carry. Anchors and <link>
// elements both count, because a crawler follows either. Two declarations name
// the MCP endpoint on purpose and are skipped: the <link rel="mcp"> head entry,
// which tells MCP clients where to POST, and llms.txt, whose llmstxt.org format
// is a list of links to every entry, not a page a crawler walks. Reads dist/,
// so run `bun run build` first.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(new URL('..', import.meta.url).pathname, 'dist');
const STALE = new Set(['/principles', '/web', '/web-audit', '/mcp-skill/', '/mcp.json', '/.well-known/mcp', '/mcp']);
const ORIGIN = 'https://anc.dev';

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(html|md|txt)$/.test(entry.name)) yield path;
  }
}

/** The path of an internal link target: origin, query, and fragment dropped. */
function internalPath(target: string): string | null {
  const local = target.startsWith(ORIGIN) ? target.slice(ORIGIN.length) : target;
  return local.startsWith('/') ? (local.split(/[?#]/, 1)[0] ?? null) : null;
}

/** The hrefs of the anchors and <link> elements in an HTML page, which the minifier may leave unquoted. */
function htmlTargets(text: string): string[] {
  const targets: string[] = [];
  for (const [, tag, attrs] of text.matchAll(/<(a|link)\s([^>]*)>/g)) {
    if (tag === 'link' && /\brel=["']?mcp["']?(?:\s|$)/.test(attrs ?? '')) continue;
    const href = /\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(attrs ?? '');
    if (href) targets.push(href[1] ?? href[2] ?? href[3] ?? '');
  }
  return targets;
}

/** Every link target a file carries: HTML anchor and <link> hrefs, or markdown targets. */
function linkTargets(path: string, text: string): string[] {
  if (path.endsWith('.html')) return htmlTargets(text);
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target]) => target);
}

describe('built pages link no stale path', () => {
  test('no page, twin, or llms file links a path that 404s, 405s, or redirects', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const path of files(DIST)) {
      scanned += 1;
      for (const target of linkTargets(path, readFileSync(path, 'utf8'))) {
        const local = internalPath(target);
        if (local === '/mcp' && path.endsWith('/llms.txt')) continue;
        if (local !== null && STALE.has(local)) offenders.push(`${path.slice(DIST.length)} -> ${target}`);
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
