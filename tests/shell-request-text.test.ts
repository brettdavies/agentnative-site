// Text from a request path or query reaches the page shell through a page's
// title, description, breadcrumb and canonical path, and reaches the markdown
// twins through their headings and links. These tests drive the real template
// the build emits, so the JSON-LD block under test is the one that ships.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emitShell, emitShellTemplate } from '../src/build/shell.mjs';
import { escHtml } from '../src/shared/esc-html';
import { _resetResultCaches, handleResultRoute, type ResultEnv } from '../src/worker/audit/result';
import { handleScoringPage, type ScoringPageEnv } from '../src/worker/audit/scoring-page';
import { substituteEndpoint, substituteHost } from '../src/worker/audit-web/handlers/shared';
import { notFoundHtml, notFoundMarkdown } from '../src/worker/not-found';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache, substituteShell } from '../src/worker/shell-template';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TEMPLATE = emitShellTemplate({ themeInitJs: '' });

function env(): ResultEnv & ScoringPageEnv {
  return {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/_internal/score-live-shell.html') return new Response(TEMPLATE, { status: 200 });
        if (path === '/registry-index.json') return new Response('{"by_slug":{},"by_owner_repo":{}}', { status: 200 });
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE_CACHE: {
      async get() {
        return null;
      },
      async head() {
        return null;
      },
    } as unknown as R2Bucket,
    TURNSTILE_SITEKEY: 'sitekey-test',
  } as unknown as ResultEnv & ScoringPageEnv;
}

const request = (path: string, accept = 'text/html') => new Request(`https://anc.dev${path}`, { headers: { accept } });

function score(target: string, suffix = ''): Promise<Response> {
  return handleResultRoute(request(`/score/${encodeURIComponent(target)}${suffix}`), env());
}

type GraphNode = Record<string, unknown>;

function jsonLdBlock(html: string): string {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!block) throw new Error('page carries no JSON-LD block');
  return block[1];
}

const graphOf = (html: string) => (JSON.parse(jsonLdBlock(html)) as { '@graph': GraphNode[] })['@graph'];

function nodeOf(html: string, type: string): GraphNode {
  const node = graphOf(html).find((n) => n['@type'] === type);
  if (!node) throw new Error(`graph carries no ${type} node`);
  return node;
}

function lastCrumbName(html: string): string | undefined {
  const items = nodeOf(html, 'BreadcrumbList').itemListElement as Array<{ name: string }>;
  return items.at(-1)?.name;
}

/** Script elements as a real HTML tokenizer sees them, so one a value closed early counts twice. */
async function scriptCount(html: string): Promise<number> {
  let count = 0;
  await new HTMLRewriter()
    .on('script', {
      element() {
        count += 1;
      },
    })
    .transform(new Response(html))
    .text();
  return count;
}

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  _resetRegistryIndexCache();
  _resetShellTemplateCache();
  _resetResultCaches();
});

describe('a /score/ page whose path carries markup', () => {
  test('a closing script tag stays inside the JSON-LD block', async () => {
    const target = '</script><script>inert-marker</script>';
    const res = await score(target);
    expect(res.status).toBe(404);
    const html = await res.text();
    const baseline = await (await score('plain-name')).text();
    expect(await scriptCount(html)).toBe(await scriptCount(baseline));
    expect(jsonLdBlock(html)).not.toContain('<');
    expect(lastCrumbName(html)).toBe(target);
  });
});

describe('a /score/ page whose path carries substitution syntax', () => {
  const targets = ['{{BODY}}', '{{TITLE}}', '{{BREADCRUMB_NAV}}', '{{BODY}}$&', '$&', "$'", '$`', '$$'];

  for (const target of targets) {
    test(`${target} renders as itself`, async () => {
      const res = await score(target);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(lastCrumbName(html)).toBe(target);
      expect(html).toContain(`<span aria-current="page">${escHtml(target)}</span>`);
      expect(occurrences(html, '</head>')).toBe(1);
      expect(occurrences(html, 'result-missing')).toBe(1);
      expect(occurrences(html, '<!doctype html>')).toBe(1);
    });
  }
});

describe('substituteShell', () => {
  const hostile = 'a\\b"c<d>&e\nf';

  test('a value in the JSON-LD block takes JSON escaping, not HTML escaping', () => {
    const html = substituteShell(TEMPLATE, {
      title: hostile,
      description: hostile,
      canonicalPath: "/score/it's",
      breadcrumb: 'x',
      ogImage: `https://anc.dev/og/it's.png`,
      body: '<article>body</article>',
    });
    const article = nodeOf(html, 'TechArticle');
    expect(article.headline).toBe(hostile);
    expect(article.description).toBe(hostile);
    expect(article.url).toBe("https://anc.dev/score/it's");
    expect(article.image).toBe("https://anc.dev/og/it's.png");
    expect(jsonLdBlock(html)).not.toMatch(/[<>&]/);
    expect(html).toContain(`<title>${escHtml(hostile)}</title>`);
  });

  test('a value spelling a later token is never scanned again', () => {
    const html = substituteShell(TEMPLATE, {
      title: '{{BODY}}',
      description: '{{OG_VIDEO}}',
      canonicalPath: '/score/x',
      breadcrumb: '{{TITLE}}',
      body: '<article id="the-body">{{DESCRIPTION}}</article>',
      ogVideoHtml: '<meta name="the-video" />',
    });
    expect(occurrences(html, 'id="the-body"')).toBe(1);
    expect(occurrences(html, 'name="the-video"')).toBe(1);
    expect(html).toContain('<title>{{BODY}}</title>');
    expect(html).toContain('<article id="the-body">{{DESCRIPTION}}</article>');
  });
});

describe('the /scoring page', () => {
  test('a target with JSON syntax in it leaves the JSON-LD block parseable', async () => {
    const target = 'back\\slash"quote';
    const res = await handleScoringPage(request(`/scoring?target=${encodeURIComponent(target)}`), env());
    expect(res.status).toBe(200);
    const article = nodeOf(await res.text(), 'TechArticle');
    expect(article.headline).toBe(`Auditing ${target}… — anc.dev`);
    expect(article.description).toBe(`The live CLI audit of ${target}.`);
  });

  test('the twin keeps a backtick inside its code span', async () => {
    const res = await handleScoringPage(request('/scoring.md?target=a%60b', 'text/markdown'), env());
    expect(await res.text()).toContain('The saved result for `` a`b ``, once');
  });

  test('the twin keeps a parenthesis inside its link', async () => {
    const res = await handleScoringPage(request('/scoring.md?target=a)b', 'text/markdown'), env());
    expect(await res.text()).toContain('(https://anc.dev/score/a%29b/md)');
  });
});

describe('the /score/ 404 markdown twin', () => {
  test('a newline in the target cannot start a line of its own', async () => {
    const target = 'x\n# Forged heading\n```\n- forged item';
    const res = await score(target, '/md');
    expect(res.status).toBe(404);
    const lines = (await res.text()).split('\n');
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '# No audit exists for ```` x # Forged heading ``` - forged item ```` yet.',
    ]);
    expect(lines.filter((line) => line.startsWith('```'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('- '))).toEqual([]);
  });

  test('a line separator other than a newline is flattened too', async () => {
    const res = await score('x # Forged\u0085# Forged', '/md');
    expect(await res.text()).toContain('`x # Forged # Forged`');
  });

  test('a backtick in the target cannot close the code span', async () => {
    const md = await (await score('a`b', '/md')).text();
    expect(md).toContain('# No audit exists for `` a`b `` yet.');
    expect(md).toContain('[Audit `` a`b ``](');
  });

  test('a parenthesis in the target cannot close the link destination', async () => {
    const md = await (await score('a)b', '/md')).text();
    expect(md).toContain('(https://anc.dev/audit?lane=cli&target=a%29b)');
  });
});

describe('the site-wide 404', () => {
  test('the origin is escaped in the HTML body', () => {
    const html = notFoundHtml('https://a"b.dev');
    expect(html).toContain('href="https://a&quot;b.dev/sitemap.xml"');
    expect(html).not.toContain('a"b.dev');
  });

  test('a parenthesis in the origin cannot close a markdown link', () => {
    expect(notFoundMarkdown('https://a)b.dev')).toContain('[Sitemap](https://a%29b.dev/sitemap.xml)');
  });
});

describe('emitShell', () => {
  test('a built page serializes its JSON-LD through the script-safe helper', () => {
    const html = emitShell({
      title: 'a<b>c&d',
      description: 'e<f>g&h',
      canonicalPath: '/x',
      breadcrumb: 'i<j>k&l',
      bodyHtml: '',
      themeInitJs: '',
    });
    expect(jsonLdBlock(html)).not.toMatch(/[<>&]/);
    expect(nodeOf(html, 'TechArticle').headline).toBe('a<b>c&d');
    expect(lastCrumbName(html)).toBe('i<j>k&l');
  });
});

describe('the audit handlers', () => {
  test('a declared endpoint reaches a probe path unchanged', () => {
    const endpoint = "https://mcp.example/a$&b$'c";
    expect(substituteEndpoint('{mcp_endpoint}', endpoint)).toBe(endpoint);
    expect(substituteHost('_dns.{host}', 'a$&b')).toBe('_dns.a$&b');
  });

  test('an endpoint spelling the other token is not scanned again', () => {
    const endpoint = 'https://mcp.example/{mcp_origin}';
    expect(substituteEndpoint('{mcp_endpoint}', endpoint)).toBe(endpoint);
    expect(substituteEndpoint('{mcp_origin}/x', "https://a$'b.example/y")).toBe("https://a$'b.example/x");
  });
});

describe('source guards', () => {
  async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) out.push(join(entry.parentPath, entry.name));
    }
    return out;
  }

  async function offenders(pattern: RegExp): Promise<string[]> {
    const files = (await Promise.all(['src/build', 'src/worker', 'src/shared'].map(sources))).flat();
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(pattern)) hits.push(`${file.slice(REPO_ROOT.length)}: ${match[0]}`);
    }
    return hits;
  }

  test('JSON reaches a script element only through jsonForScript', async () => {
    expect(await offenders(/<script[^>]*>\$\{JSON\.stringify\([^)]*\)/g)).toEqual([]);
  });

  test('a shell placeholder is filled by a function replacement', async () => {
    const stringReplacement =
      /\.replace(?:All)?\(\s*['"`][^'"`]*\{\{[A-Z_]+\}\}[^'"`]*['"`]\s*,(?!\s*(?:\(|\w+\s*=>))[^\n]*/g;
    expect(await offenders(stringReplacement)).toEqual([]);
  });
});
