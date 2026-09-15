// The JSON-LD graph every page carries in <head>. It is the site's only
// machine-readable statement of what it is to a crawler, and nothing else in
// the suite reads it, so a node that silently stops being emitted would reach
// production unnoticed.
//
// Two properties the graph must keep beyond its field list: every node hangs
// off one Organization by `@id` rather than repeating it, and the whole graph
// names the canonical host even on a staging build, because a search engine
// cannot reach an Access-gated preview.

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitShell } from '../src/build/shell.mjs';
import { ANC_VERSION, SITE_SPEC_VERSION } from '../src/build/util.mjs';
import { CANONICAL_SITE_URL } from '../src/shared/site-url';

type Node = Record<string, unknown> & { '@type': string; '@id'?: string };

function graphOf(html: string): Node[] {
  const match = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
  if (!match) throw new Error('no JSON-LD block in the emitted shell');
  const parsed = JSON.parse(match[1]) as { '@context': string; '@graph': Node[] };
  expect(parsed['@context']).toBe('https://schema.org');
  return parsed['@graph'];
}

function shell(overrides: Partial<Parameters<typeof emitShell>[0]> = {}): string {
  return emitShell({
    title: 'About',
    description: 'About anc.dev',
    canonicalPath: '/about',
    bodyHtml: '<article>body</article>',
    themeInitJs: '',
    baseUrl: undefined,
    ...overrides,
  });
}

const nodeOf = (graph: Node[], type: string): Node | undefined => graph.find((n) => n['@type'] === type);

describe('JSON-LD graph', () => {
  test('carries a WebSite node the articles belong to', () => {
    const graph = graphOf(shell());
    const site = nodeOf(graph, 'WebSite');
    expect(site).toBeDefined();
    expect(site).toMatchObject({
      '@id': `${CANONICAL_SITE_URL}/#website`,
      url: CANONICAL_SITE_URL,
      inLanguage: 'en',
      publisher: { '@id': `${CANONICAL_SITE_URL}/#organization` },
    });
    // No SearchAction: the site publishes no search endpoint, and claiming one
    // advertises a capability a crawler would follow to nothing.
    expect(JSON.stringify(site)).not.toContain('SearchAction');
  });

  test('the article is part of the site and the organization publishes both', () => {
    const graph = graphOf(shell());
    const article = nodeOf(graph, 'TechArticle');
    expect(article?.isPartOf).toEqual({ '@id': `${CANONICAL_SITE_URL}/#website` });
    expect(article?.publisher).toEqual({ '@id': `${CANONICAL_SITE_URL}/#organization` });
  });

  test('the organization states a contact point', () => {
    const org = nodeOf(graphOf(shell()), 'Organization');
    expect(org?.contactPoint).toMatchObject({ '@type': 'ContactPoint', contactType: 'technical support' });
  });

  test('a subpage carries a breadcrumb trail from the home page to itself', () => {
    const crumbs = nodeOf(graphOf(shell({ canonicalPath: '/about', breadcrumb: 'About' })), 'BreadcrumbList');
    expect(crumbs?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: CANONICAL_SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'About', item: `${CANONICAL_SITE_URL}/about` },
    ]);
  });

  // `/fix` and `/score` are namespaces, not pages: `/score/` bare is a 404. A
  // crumb linking to one would send a reader, and a crawler, to a miss.
  test('a namespace segment is dropped rather than linked', () => {
    const crumbs = nodeOf(
      graphOf(shell({ canonicalPath: '/fix/openapi', breadcrumb: 'OpenAPI description' })),
      'BreadcrumbList',
    );
    expect(crumbs?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: CANONICAL_SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'OpenAPI description', item: `${CANONICAL_SITE_URL}/fix/openapi` },
    ]);
  });

  // A slug has no casing a rule could recover, so the page names itself and
  // the emitter passes that through rather than guessing from the URL.
  test('an emitter-supplied breadcrumb names the page instead of its slug', () => {
    const label = (path: string, breadcrumb?: string) => {
      const crumbs = nodeOf(graphOf(shell({ canonicalPath: path, breadcrumb })), 'BreadcrumbList');
      return (crumbs?.itemListElement as { name: string }[]).at(-1)?.name;
    };
    expect(label('/fix/llms-txt-scoped', 'llms.txt scoped')).toBe('llms.txt scoped');
    expect(label('/fix/oauth-discovery', 'OAuth discovery')).toBe('OAuth discovery');
    // Without one the segment stands as written; the registry is what supplies it.
    expect(label('/fix/oauth-discovery')).toBe('oauth-discovery');
  });

  // A tool name or a host is an identifier, not prose: `ripgrep` is the binary,
  // and title-casing it would name a tool that does not exist.
  test('a result target keeps its exact text', () => {
    for (const [path, name] of [
      ['/score/ripgrep', 'ripgrep'],
      ['/score/anc.dev', 'anc.dev'],
      ['/score/o/r@feature', 'o/r@feature'],
    ] as const) {
      const crumbs = nodeOf(graphOf(shell({ canonicalPath: path })), 'BreadcrumbList');
      // `/score/` has a real parent page, so the target hangs off the board
      // rather than off the home page.
      expect({ path, trail: (crumbs?.itemListElement as { name: string }[]).map((i) => i.name) }).toEqual({
        path,
        trail: ['Home', 'Leaderboard', name],
      });
    }
  });

  // No label map survives anywhere: a page that wants a readable crumb says so,
  // and one that says nothing gets its segment verbatim rather than a guess.
  test('without a supplied label the segment stands verbatim', () => {
    const label = (path: string) => {
      const crumbs = nodeOf(graphOf(shell({ canonicalPath: path })), 'BreadcrumbList');
      return (crumbs?.itemListElement as { name: string }[]).at(-1)?.name;
    };
    expect(label('/p3')).toBe('p3');
    expect(label('/mcp-skill')).toBe('mcp-skill');
    expect(label('/about')).toBe('about');
  });

  test('the home page carries no breadcrumb, because a trail of one names nothing', () => {
    expect(nodeOf(graphOf(shell({ canonicalPath: '/', isIndex: true })), 'BreadcrumbList')).toBeUndefined();
  });

  // The Worker renders result and progress pages from a shell template whose
  // canonical path is a placeholder it substitutes per request. `TechArticle.url`
  // carries that placeholder on purpose and comes back substituted. A trail
  // cannot: its intermediate segments would have to be split at build time from
  // a path that does not exist yet, so the template emits no trail at all.
  // The template has no path at build time, so it carries a placeholder in
  // each position and the Worker fills both from the request.
  test('the Worker shell template defers its breadcrumb to request time', () => {
    const html = shell({ canonicalPath: '{{CANONICAL_PATH}}' });
    expect(html).toContain('{{BREADCRUMB_NAV}}');
    const graph = graphOf(html);
    expect(nodeOf(graph, 'BreadcrumbList')).toBeUndefined();
    // The node's stand-in rides in the graph as a bare string, so the Worker
    // can swap the quoted token for the real node at request time.
    expect(graph as unknown as string[]).toContain('{{BREADCRUMB_JSONLD}}');
    const article = nodeOf(graph, 'TechArticle');
    expect(article?.url).toBe('https://anc.dev{{CANONICAL_PATH}}');
  });

  test('both applications state the version a reader would install', () => {
    const graph = graphOf(shell());
    const cli = graph.find((n) => n['@id'] === `${CANONICAL_SITE_URL}/#anc-cli`);
    const mcp = graph.find((n) => n['@id'] === `${CANONICAL_SITE_URL}/#mcp-server`);
    expect(cli?.softwareVersion).toBe(ANC_VERSION);
    expect(mcp?.softwareVersion).toBe(SITE_SPEC_VERSION);
  });

  test('every node hangs off one organization rather than repeating it', () => {
    const graph = graphOf(shell());
    const orgs = graph.filter((n) => n['@type'] === 'Organization');
    expect(orgs).toHaveLength(1);
    for (const node of graph) {
      if (node['@type'] === 'Organization' || node['@type'] === 'BreadcrumbList') continue;
      expect({ type: node['@type'], publisher: node.publisher }).toEqual({
        type: node['@type'],
        publisher: { '@id': `${CANONICAL_SITE_URL}/#organization` },
      });
    }
  });

  // Crawler-facing identity ignores PUBLIC_BASE_URL on purpose: a search engine
  // cannot reach the Access-gated staging host, so the staging build still
  // names production throughout. `canonicalBaseUrl` is the half of the pair
  // that ignores the env var; `resolveBaseUrl` is the half that reads it, and
  // no shell caller passes a base at all.
  test('a staging build still names the canonical host across the whole graph', () => {
    const prior = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://agentnative-site-staging.brettdavies.workers.dev';
    try {
      const graph = graphOf(shell());
      expect(JSON.stringify(graph)).not.toContain('workers.dev');
      expect(JSON.stringify(graph)).toContain(CANONICAL_SITE_URL);
    } finally {
      if (prior === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prior;
    }
  });
});

// The suite above drives the emitter directly. This drives the build's own
// output, because the emitter being right does not prove every page reached it:
// a caller can pass a wrong path, and one did.
describe('the emitted graph on every page', () => {
  const DIST = join(fileURLToPath(import.meta.url), '..', '..', 'dist');

  async function htmlFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await htmlFiles(path)));
      else if (entry.name.endsWith('.html')) out.push(path);
    }
    return out.sort();
  }

  const pathOf = (file: string) => {
    const rel = `/${relative(DIST, file).replace(/\\/g, '/')}`;
    return rel === '/index.html' ? '/' : rel.replace(/\.html$/, '');
  };

  test('every page states a well-formed graph naming itself', async () => {
    const files = (await htmlFiles(DIST)).filter((f) => !f.includes('_internal'));
    // A glob that matched nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);

    const problems: string[] = [];
    for (const file of files) {
      const page = pathOf(file);
      const graph = graphOf(await readFile(file, 'utf8'));
      const count = (type: string) => graph.filter((n) => n['@type'] === type).length;
      for (const [type, want] of [
        ['Organization', 1],
        ['WebSite', 1],
        ['TechArticle', 1],
        ['SoftwareApplication', 2],
        ['SoftwareSourceCode', 1],
      ] as const) {
        if (count(type) !== want) problems.push(`${page}: ${type} x${count(type)}, want ${want}`);
      }

      // Every @id a node references resolves inside the same graph.
      const ids = new Set(graph.map((n) => n['@id']).filter(Boolean));
      for (const match of JSON.stringify(graph).matchAll(/\{"@id":"([^"]+)"\}/g)) {
        if (!ids.has(match[1])) problems.push(`${page}: dangling @id ${match[1]}`);
      }

      for (const node of graph) {
        if (node['@type'] === 'Organization' || node['@type'] === 'BreadcrumbList') continue;
        if ((node.publisher as { '@id'?: string })?.['@id'] !== `${CANONICAL_SITE_URL}/#organization`) {
          problems.push(`${page}: ${node['@type']} does not name the organization as publisher`);
        }
      }

      const article = graph.find((n) => n['@type'] === 'TechArticle');
      const wantUrl = CANONICAL_SITE_URL + (page === '/' ? '/' : page);
      if (article?.url !== wantUrl) problems.push(`${page}: article url ${String(article?.url)}, want ${wantUrl}`);
      if ((article?.isPartOf as { '@id'?: string })?.['@id'] !== `${CANONICAL_SITE_URL}/#website`) {
        problems.push(`${page}: article is not part of the website`);
      }

      const serialized = JSON.stringify(graph);
      // Crawler-facing identity names production even on a staging build, and
      // a built page has no placeholder left to substitute.
      if (serialized.includes('workers.dev')) problems.push(`${page}: names a workers.dev host`);
      if (/\{\{[A-Z_]+\}\}/.test(serialized)) problems.push(`${page}: carries an unsubstituted placeholder`);
    }
    expect(problems).toEqual([]);
  });
});
