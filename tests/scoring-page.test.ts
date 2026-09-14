import { beforeEach, describe, expect, test } from 'bun:test';
import { handleScoringPage, type ScoringPageEnv } from '../src/worker/audit/scoring-page';
import { resetWebAuditRegistryCacheForTests } from '../src/worker/audit-web/registry';
import { _resetShellTemplateCache } from '../src/worker/shell-template';
import { webRegistryJson } from './helpers/audit-api-env';

// GET /scoring renders the progress page's first paint from the target
// alone. These tests drive the handler against a stub shell and the real
// website registry, and pin the page's contract with its client, its
// headers, and its prose pointer.

const SHELL = `<!doctype html><html><head><title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}" /><link rel="canonical" href="https://anc.dev{{CANONICAL_PATH}}" />
    {{ALTERNATES}}
</head><body><main>{{BODY}}</main><footer><a href="{{MARKDOWN_TWIN_PATH}}">This page as markdown</a></footer></body></html>`;

const SITEKEY = '1x00000000000000000000AA';

function env(sitekey: string | null = SITEKEY): ScoringPageEnv {
  return {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/_internal/score-live-shell.html') return new Response(SHELL, { status: 200 });
        if (path === '/_internal/web-audit-registry.json')
          return new Response(await webRegistryJson(), { status: 200 });
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    TURNSTILE_SITEKEY: sitekey ?? undefined,
  } as ScoringPageEnv;
}

// A bare request can route to the markdown twin through the User-Agent
// heuristic, so every HTML request names its Accept.
function get(path: string, headers: Record<string, string> = { accept: 'text/html' }): Request {
  return new Request(`https://anc.dev${path}`, { headers });
}

async function page(path: string, e: ScoringPageEnv = env()): Promise<{ res: Response; html: string }> {
  const res = await handleScoringPage(get(path), e);
  return { res, html: await res.text() };
}

beforeEach(() => {
  _resetShellTemplateCache();
  resetWebAuditRegistryCacheForTests();
});

describe('GET /scoring?target=', () => {
  test('a CLI target renders its page: lane, target, sitekey meta, the page script, and the probe line, and never WebMCP', async () => {
    const { res, html } = await page('/scoring?target=ripgrep');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('data-lane="cli"');
    expect(html).toContain('data-target="ripgrep"');
    expect(html).toContain(`name="turnstile-sitekey" content="${SITEKEY}"`);
    expect(html).toContain('src="/js/scoring.js"');
    expect(html).not.toContain('webmcp');
    expect(html).toContain('Auditing <code>ripgrep</code>');
    expect(html).toContain('Installs the tool in a sandbox; usually under a minute.');
    expect(html).toContain('Checking for a recent result');
    expect(html).toContain('<noscript>');
    expect(html).toContain('/score/ripgrep/md');
    expect(html).toContain('get_scorecard');
  });

  test('a website target is normalized to its host and carries the registry check count and the website sentence', async () => {
    const total = (JSON.parse(await webRegistryJson()) as { checks: unknown[] }).checks.length;
    const { html } = await page(`/scoring?target=${encodeURIComponent('https://Anc.dev/docs')}`);
    expect(html).toContain('data-lane="web"');
    expect(html).toContain('data-target="anc.dev"');
    expect(html).toContain(`data-check-total="${total}"`);
    expect(html).toContain('Usually a few seconds.');
    expect(html).toContain('get_website_audit');
  });

  test('a target carrying markup renders escaped', async () => {
    const { html } = await page(`/scoring?target=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  test('a refused target is a 400 pointer carrying the reason, with no page for the client', async () => {
    const { res, html } = await page(`/scoring?target=${'a'.repeat(129)}`);
    expect(res.status).toBe(400);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-scoring');
    expect(html).not.toContain('/js/scoring.js');
  });

  test('a target the classifier accepts but no result page can express is the pointer, not a throw', async () => {
    // An owner/repo shorthand classifies fine, yet the result-path builder
    // refuses it. An unauthenticated GET must not reach that RangeError.
    const { res, html } = await page(`/scoring?target=${encodeURIComponent('nlohmann/json')}`);
    expect(res.status).toBe(400);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-scoring');
    expect(html).not.toContain('/js/scoring.js');
  });

  test('refresh=1 carries through to the page, and a plain target carries none', async () => {
    expect((await page('/scoring?target=ouch&refresh=1')).html).toContain('data-refresh="1"');
    expect((await page('/scoring?target=ouch')).html).not.toContain('data-refresh');
  });

  test('an unprovisioned sitekey renders an empty meta, which the client reads as no Start', async () => {
    expect((await page('/scoring?target=ripgrep', env(null))).html).toContain('name="turnstile-sitekey" content=""');
  });
});

describe('GET /scoring: the pointer and the representations', () => {
  test('no target renders the prose pointer to the audit page, with no sitekey and no page script', async () => {
    const { res, html } = await page('/scoring');
    expect(res.status).toBe(200);
    expect(html).toContain('href="/audit"');
    expect(html).not.toContain('turnstile-sitekey');
    expect(html).not.toContain('/js/scoring.js');
  });

  test('every representation is no-store and noindex, with no cache tag', async () => {
    const requests = [
      get('/scoring?target=ripgrep'),
      get('/scoring'),
      get('/scoring.md?target=anc.dev', {}),
      get('/scoring?target=anc.dev', { accept: 'text/markdown' }),
    ];
    for (const req of requests) {
      const res = await handleScoringPage(req, env());
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('cache-tag')).toBeNull();
    }
  });

  test('the markdown twin and Accept: text/markdown answer the prose pointer naming both read tools, never Turnstile', async () => {
    for (const req of [
      get('/scoring.md?target=anc.dev', {}),
      get('/scoring?target=anc.dev', { accept: 'text/markdown' }),
    ]) {
      const res = await handleScoringPage(req, env());
      expect(res.headers.get('content-type')).toContain('text/markdown');
      const md = await res.text();
      expect(md).toContain('get_scorecard');
      expect(md).toContain('get_website_audit');
      expect(md).toContain('/score/anc.dev/md');
      expect(md.toLowerCase()).not.toContain('turnstile');
    }
  });

  test('the twin answers a refused target with the status the page gives it, and names the reason', async () => {
    // An agent negotiating markdown would otherwise read a rejection as a
    // successful answer.
    const res = await handleScoringPage(get(`/scoring.md?target=${'a'.repeat(129)}`, {}), env());
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('128 characters');
  });

  test('a POST is 405', async () => {
    const res = await handleScoringPage(
      new Request('https://anc.dev/scoring?target=ripgrep', { method: 'POST' }),
      env(),
    );
    expect(res.status).toBe(405);
  });
});
