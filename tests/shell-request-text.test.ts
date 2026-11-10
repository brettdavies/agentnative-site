import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { emitShellTemplate } from '../src/build/shell.mjs';
import { _resetResultCaches, handleResultRoute, type ResultEnv } from '../src/worker/audit/result';
import { handleScoringPage, type ScoringPageEnv } from '../src/worker/audit/scoring-page';
import { _resetRegistryIndexCache } from '../src/worker/score/registry-lookup';
import { _resetShellTemplateCache } from '../src/worker/shell-template';

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

function resetCaches(): void {
  _resetRegistryIndexCache();
  _resetShellTemplateCache();
  _resetResultCaches();
}

beforeEach(resetCaches);
// These caches are module-level, so the stub registry would otherwise reach a later test file.
afterAll(resetCaches);

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

describe('the /scoring page', () => {
  test('the twin keeps a backtick inside its code span', async () => {
    const res = await handleScoringPage(request('/scoring.md?target=a%60b', 'text/markdown'), env());
    expect(await res.text()).toContain('The saved result for `` a`b ``, once');
  });
});

describe('the /score/ 404 markdown twin', () => {
  test('a newline in the target cannot start a line of its own', async () => {
    const target = 'x\n# Stray heading\n```\n- stray item';
    const res = await score(target, '/md');
    expect(res.status).toBe(404);
    const lines = (await res.text()).split('\n');
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '# No audit exists for ```` x # Stray heading ``` - stray item ```` yet.',
    ]);
    expect(lines.filter((line) => line.startsWith('```'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('- '))).toEqual([]);
  });

  test('a backtick in the target cannot close the code span', async () => {
    const md = await (await score('a`b', '/md')).text();
    expect(md).toContain('# No audit exists for `` a`b `` yet.');
    expect(md).toContain('[Audit `` a`b ``](');
  });
});
