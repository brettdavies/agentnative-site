// Google reads the BreadcrumbList as a claim about the trail the page shows.
// The two are rendered from one trail so they cannot drift, and this asserts
// that across every emitted page rather than on a sample, because the failure
// mode is silent: mismatched markup is ignored, so the rich result simply
// never appears and the page looks fine.

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_SITE_URL } from '../src/shared/site-url';
import { handleScoringPage, type ScoringPageEnv } from '../src/worker/audit/scoring-page';
import { resetWebAuditRegistryCacheForTests } from '../src/worker/audit-web/registry';
import { _resetShellTemplateCache, substituteShell } from '../src/worker/shell-template';
import { webRegistryJson } from './helpers/audit-api-env';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST = join(REPO_ROOT, 'dist');

async function htmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out.sort();
}

/** The trail the reader sees: every crumb's text, in order. */
function visibleTrail(html: string): string[] | null {
  const nav = /<nav class="crumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  if (!nav) return null;
  return [...nav[1].matchAll(/<(?:a|span)\b[^>]*>([^<]*)<\/(?:a|span)>/g)]
    .map((m) => m[1].trim())
    .filter((text) => text.length > 0 && text !== '›');
}

/** The trail the crawler reads, from whichever graph node states it. */
function markupTrail(html: string): string[] | null {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!block) return null;
  const graph = (JSON.parse(block[1]) as { '@graph': Array<Record<string, unknown>> })['@graph'];
  const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
  if (!crumbs) return null;
  return (crumbs.itemListElement as Array<{ name: string }>).map((i) => i.name);
}

const pathOf = (file: string) => {
  const rel = `/${relative(DIST, file).replace(/\\/g, '/')}`;
  return rel === '/index.html' ? '/' : rel.replace(/\.html$/, '');
};

describe('the visible trail and its markup agree', () => {
  test('on every emitted page', async () => {
    const files = (await htmlFiles(DIST)).filter((f) => !f.includes('_internal'));
    expect(files.length).toBeGreaterThan(100);
    const disagreements: string[] = [];
    for (const file of files) {
      const html = await readFile(file, 'utf8');
      const seen = visibleTrail(html);
      const stated = markupTrail(html);
      if (JSON.stringify(seen) !== JSON.stringify(stated)) {
        disagreements.push(`${pathOf(file)}: sees ${JSON.stringify(seen)}, states ${JSON.stringify(stated)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test('every page but the home page draws a trail', async () => {
    const files = (await htmlFiles(DIST)).filter((f) => !f.includes('_internal'));
    const missing = [];
    for (const file of files) {
      const html = await readFile(file, 'utf8');
      const path = pathOf(file);
      const has = visibleTrail(html) !== null;
      if (has !== (path !== '/')) missing.push(`${path}: ${has ? 'unexpected' : 'missing'} trail`);
    }
    expect(missing).toEqual([]);
  });

  // The template's two placeholders resolve from the request's path, so a
  // Worker-rendered page states the same trail it shows.
  test('the Worker fills both placeholders from the request path', async () => {
    const template = await readFile(join(DIST, '_internal', 'score-live-shell.html'), 'utf8');
    const html = substituteShell(template, {
      title: 'anc.dev',
      description: 'a result',
      canonicalPath: '/score/anc.dev',
      breadcrumb: 'anc.dev',
      body: '<article>body</article>',
    });
    expect(html).not.toContain('{{');
    expect(visibleTrail(html)).toEqual(['Home', 'Leaderboard', 'anc.dev']);
    expect(markupTrail(html)).toEqual(['Home', 'Leaderboard', 'anc.dev']);
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    const graph = (JSON.parse(block?.[1] ?? '{}') as { '@graph': Array<Record<string, unknown>> })['@graph'];
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
    expect((crumbs?.itemListElement as Array<{ item: string }>).at(-1)?.item).toBe(
      `${CANONICAL_SITE_URL}/score/anc.dev`,
    );
  });

  // A Worker route emits no file, so the sweep over `dist` above cannot reach
  // it. `/scoring` shipped naming itself `scoring` because its handler passed
  // no label and the segment stood in, which agreed with its own markup and
  // broke nothing any other test measured.
  test('a Worker route names itself, not its URL segment', async () => {
    const template = await readFile(join(DIST, '_internal', 'score-live-shell.html'), 'utf8');
    const env = {
      ASSETS: {
        async fetch(req: Request | string): Promise<Response> {
          const path = new URL(typeof req === 'string' ? req : req.url).pathname;
          if (path === '/_internal/score-live-shell.html') return new Response(template, { status: 200 });
          if (path === '/_internal/web-audit-registry.json')
            return new Response(await webRegistryJson(), { status: 200 });
          return new Response('not found', { status: 404 });
        },
      } as Fetcher,
    } as ScoringPageEnv;
    _resetShellTemplateCache();
    resetWebAuditRegistryCacheForTests();
    const res = await handleScoringPage(
      new Request('https://anc.dev/scoring', { headers: { accept: 'text/html' } }),
      env,
    );
    const html = await res.text();
    expect(html).not.toContain('{{');
    expect(visibleTrail(html)).toEqual(['Home', 'Scoring']);
    expect(markupTrail(html)).toEqual(['Home', 'Scoring']);
  });

  // A path with no trail must leave the graph well-formed rather than a
  // dangling comma where the placeholder used to be.
  test('a pathless render removes the token and its comma', async () => {
    const template = await readFile(join(DIST, '_internal', 'score-live-shell.html'), 'utf8');
    const html = substituteShell(template, {
      title: 'Home',
      description: 'home',
      canonicalPath: '/',
      breadcrumb: 'Home',
      body: '<article>body</article>',
    });
    expect(html).not.toContain('{{');
    expect(markupTrail(html)).toBeNull();
    expect(visibleTrail(html)).toBeNull();
  });
});
