import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { emitShellTemplate } from '../src/build/shell.mjs';
import { BREADCRUMB_JSONLD_TOKEN } from '../src/shared/breadcrumb';
import { escHtml } from '../src/shared/scorecard-format.mjs';
import { _resetResultCaches, handleResultRoute, type ResultEnv } from '../src/worker/audit/result';
import { substituteEndpoint } from '../src/worker/audit-web/handlers/shared';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache, substituteShell } from '../src/worker/shell-template';

const TEMPLATE = [
  '<title>{{TITLE}}</title>',
  '<meta content="{{DESCRIPTION}}">',
  '<link href="{{CANONICAL_PATH}}">',
  '<link href="{{MARKDOWN_TWIN_PATH}}">',
  '{{ALTERNATES}}',
  '<meta content="{{OG_IMAGE}}">',
  '<meta content="{{OG_IMAGE_ALT}}">',
  '{{OG_VIDEO}}',
  '{{BREADCRUMB_NAV}}',
  '<main>{{BODY}}</main>',
].join('\n');

const PATTERNS = ['$&', '$`', "$'", '$$', '$1'];

function render(overrides: Partial<Parameters<typeof substituteShell>[1]>): string {
  return substituteShell(TEMPLATE, {
    title: 'title',
    description: 'description',
    canonicalPath: '/score/tool',
    breadcrumb: 'tool',
    body: 'body',
    ...overrides,
  });
}

describe('substituteShell keeps replacement text literal', () => {
  test('a path and breadcrumb holding a dollar sequence render as written in the link, twin, nav, and JSON-LD slots', () => {
    const html = substituteShell(`${TEMPLATE}\n[{},"${BREADCRUMB_JSONLD_TOKEN}"]`, {
      title: 'title',
      description: 'description',
      canonicalPath: '/score/a$&b',
      markdownTwinPath: '/score/twin$&c',
      breadcrumb: 'crumb$&d',
      body: 'body',
    });
    expect(html).toContain('<link href="/score/a$&amp;b">');
    expect(html).toContain('<link href="/score/twin$&amp;c">');
    expect(html).toContain('crumb$&amp;d');
    expect(html).toContain('"name":"crumb$&d"');
    expect(html).not.toContain('{{');
  });

  test.each(PATTERNS)('a body containing %s', (pattern) => {
    const html = render({ body: `<p>cost ${pattern} here</p>` });
    expect(html).toContain(`<main><p>cost ${pattern} here</p></main>`);
    expect(html.match(/<main>/g)).toHaveLength(1);
  });

  test.each(PATTERNS)('raw alternates and video markup containing %s', (pattern) => {
    const html = render({ alternatesHtml: `<a data-x="${pattern}">`, ogVideoHtml: `<b data-y="${pattern}">` });
    expect(html).toContain(`<a data-x="${pattern}">`);
    expect(html).toContain(`<b data-y="${pattern}">`);
  });

  test('a title holding an apostrophe after a dollar sign renders as its escaped text', () => {
    const html = render({ title: "cost$'s" });
    expect(html).toContain('<title>cost$&#39;s</title>');
    expect(html).not.toContain('{{TITLE}}');
  });

  test('a description, image, and image text holding an apostrophe after a dollar sign render as their escaped text', () => {
    const html = render({ description: "a$'b", ogImage: "/i$'.png", ogImageAlt: "alt$'" });
    expect(html).toContain('<meta content="a$&#39;b">');
    expect(html).toContain('<meta content="/i$&#39;.png">');
    expect(html).toContain('<meta content="alt$&#39;">');
  });
});

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('substituteShell fills a template in one pass', () => {
  test('a value spelling a later token stays as written', () => {
    const html = render({
      title: '{{BODY}}',
      description: '{{OG_VIDEO}}',
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

describe('a /score/ page whose path spells a shell token', () => {
  const shell = emitShellTemplate({ themeInitJs: '' });
  const env = {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/_internal/score-live-shell.html') return new Response(shell);
        if (path === '/registry-index.json') return new Response('{"by_slug":{},"by_owner_repo":{}}');
        return new Response('not found', { status: 404 });
      },
    },
    SCORE_CACHE: { get: async () => null, head: async () => null },
  } as unknown as ResultEnv;

  function lastCrumbName(html: string): string | undefined {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!block) throw new Error('page carries no JSON-LD block');
    const { '@graph': graph } = JSON.parse(block[1]) as { '@graph': Array<Record<string, unknown>> };
    const list = graph.find((node) => node['@type'] === 'BreadcrumbList');
    return (list?.itemListElement as Array<{ name: string }> | undefined)?.at(-1)?.name;
  }

  function resetCaches(): void {
    _resetRegistryIndexCache();
    _resetShellTemplateCache();
    _resetResultCaches();
  }

  beforeEach(resetCaches);
  // These caches are module-level, so the stub registry would otherwise reach a later test file.
  afterAll(resetCaches);

  test.each(['{{BODY}}', '{{TITLE}}', '{{BREADCRUMB_NAV}}', '{{BODY}}$&'])('%s renders as itself', async (target) => {
    const res = await handleResultRoute(
      new Request(`https://anc.dev/score/${encodeURIComponent(target)}`, { headers: { accept: 'text/html' } }),
      env,
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(lastCrumbName(html)).toBe(target);
    expect(html).toContain(`<span aria-current="page">${escHtml(target)}</span>`);
    expect(occurrences(html, '</head>')).toBe(1);
    expect(occurrences(html, 'result-missing')).toBe(1);
  });
});

describe('substituteEndpoint keeps a declared endpoint literal', () => {
  test('a dollar sequence in the endpoint reaches the path as written', () => {
    const endpoint = "https://mcp.example/a$&b$'c";
    expect(substituteEndpoint('{mcp_endpoint}', endpoint)).toBe(endpoint);
  });

  test('a dollar sequence in the origin reaches the path as written', () => {
    expect(substituteEndpoint('{mcp_origin}/x', "https://a$'b.example/y")).toBe("https://a$'b.example/x");
  });

  test('an endpoint spelling the other token stays as written', () => {
    const endpoint = 'https://mcp.example/{mcp_origin}';
    expect(substituteEndpoint('{mcp_endpoint}', endpoint)).toBe(endpoint);
  });
});
