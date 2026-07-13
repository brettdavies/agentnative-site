// Scoped llms.txt discovery tests (plan-003 U8, R15/KTD-5): candidate
// enumeration is the deduplicated union of the root llms.txt link index
// and sitemap top-level paths, restricted to the audited origin, capped,
// and SSRF-guarded per candidate.

import { describe, expect, test } from 'bun:test';
import { enumerateScopedDirs, runScopedLlms } from '../src/worker/audit-web/handlers/scoped-llms';
import type { HandlerContext } from '../src/worker/audit-web/handlers/types';
import type { WebCheck } from '../src/worker/audit-web/registry';

const BASE = 'https://example.com/';

function scopedCheck(partial: Partial<WebCheck> = {}): WebCheck {
  return {
    id: 'llms-txt-scoped',
    category: 'content-for-agents',
    tier: 'optional',
    keyword: 'may',
    principle: 'P2',
    site_types: ['content'],
    antecedent: 'root-llms-txt',
    eval: 'scoped-discovery',
    weight: 1,
    title: 'scoped llms.txt',
    hint: 'h',
    handler: 'scoped-llms',
    with: { file: 'llms.txt', max_candidates: 8 },
    ...partial,
  };
}

function ctx(fetchImpl: typeof fetch, scopedDirs: string[]): HandlerContext {
  return {
    base: BASE,
    host: 'example.com',
    mcpEndpoint: null,
    protocolVersion: '2025-06-18',
    defaultTimeoutMs: 5000,
    scopedDirs,
    fetchOptions: { fetchImpl },
  };
}

function stubFetch(handler: (url: string) => Response): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('enumerateScopedDirs', () => {
  test('merges llms.txt links and sitemap paths, deduplicated', () => {
    const llms = '# Site\n- [Docs](/docs/guide)\n- [Blog](https://example.com/blog/post-1)';
    const sitemap =
      '<urlset><url><loc>https://example.com/docs/other</loc></url><url><loc>https://example.com/api/reference</loc></url></urlset>';
    const dirs = enumerateScopedDirs(llms, sitemap, BASE);
    expect(dirs.sort()).toEqual(['/api', '/blog', '/docs']);
  });

  test('drops off-origin and private-IP hrefs (never enumerated, never fetched)', () => {
    const llms =
      '- [Evil](https://evil.example.net/docs/x)\n- [Meta](http://169.254.169.254/latest/meta)\n- [Ok](/docs/a)';
    const dirs = enumerateScopedDirs(llms, '', BASE);
    expect(dirs).toEqual(['/docs']);
  });

  test('root-level files produce no section directory', () => {
    const llms = '- [Index](/llms.txt)\n- [Top](/about)';
    expect(enumerateScopedDirs(llms, '', BASE)).toEqual([]);
  });
});

describe('runScopedLlms', () => {
  test('a path appearing in both sources is probed once; a valid scoped file passes', async () => {
    const { fetchImpl, seen } = stubFetch((url) =>
      url === 'https://example.com/docs/llms.txt'
        ? new Response('# Docs\n- [a](/docs/a)', { status: 200 })
        : new Response('no', { status: 404 }),
    );
    const dirs = enumerateScopedDirs('- [Docs](/docs/guide)', '<loc>https://example.com/docs/other</loc>', BASE);
    const outcome = await runScopedLlms(scopedCheck(), ctx(fetchImpl, dirs));
    expect(outcome.status).toBe('pass');
    expect(seen.filter((u) => u === 'https://example.com/docs/llms.txt').length).toBe(1);
  });

  test('a present-but-malformed scoped file is broken', async () => {
    const { fetchImpl } = stubFetch(() => new Response('   ', { status: 200 }));
    const outcome = await runScopedLlms(scopedCheck(), ctx(fetchImpl, ['/docs']));
    expect(outcome.status).toBe('broken');
  });

  test('all candidates 404 is absent (a MAY, so n_a at the engine boundary)', async () => {
    const { fetchImpl } = stubFetch(() => new Response('no', { status: 404 }));
    const outcome = await runScopedLlms(scopedCheck(), ctx(fetchImpl, ['/docs', '/blog']));
    expect(outcome.status).toBe('absent');
  });

  test('the candidate cap bounds the probe count', async () => {
    const { fetchImpl, seen } = stubFetch(() => new Response('no', { status: 404 }));
    const dirs = Array.from({ length: 20 }, (_, i) => `/section-${i}`);
    await runScopedLlms(scopedCheck({ with: { file: 'llms.txt', max_candidates: 3 } }), ctx(fetchImpl, dirs));
    expect(seen.length).toBe(3);
  });

  test('no section directories at all is absent without any fetch', async () => {
    const { fetchImpl, seen } = stubFetch(() => new Response('no', { status: 404 }));
    const outcome = await runScopedLlms(scopedCheck(), ctx(fetchImpl, []));
    expect(outcome.status).toBe('absent');
    expect(seen.length).toBe(0);
  });

  test('llms-full-txt-scoped probes the llms-full.txt twin', async () => {
    const { fetchImpl, seen } = stubFetch((url) =>
      url.endsWith('/docs/llms-full.txt')
        ? new Response('# Docs corpus', { status: 200 })
        : new Response('no', { status: 404 }),
    );
    const outcome = await runScopedLlms(
      scopedCheck({ id: 'llms-full-txt-scoped', antecedent: 'root-llms-full-txt', with: { file: 'llms-full.txt' } }),
      ctx(fetchImpl, ['/docs']),
    );
    expect(outcome.status).toBe('pass');
    expect(seen).toEqual(['https://example.com/docs/llms-full.txt']);
  });
});
