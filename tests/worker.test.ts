// Content-negotiation + header-policy tests for the Worker.
//
// Covers every row of the decision table in docs/DESIGN.md §3.4 / eng review §3
// diagram, plus the Link/X-Llms-Txt/X-Robots-Tag/Cache-Control assertions
// from A8 and P4, plus the staging-host guard (locked decision #4).
//
// We exercise the handler end-to-end against a stubbed env.ASSETS fetcher —
// no wrangler dev needed.

import { beforeEach, describe, expect, test } from 'bun:test';
import { classifyGatewayRequest, detectPreference } from '../src/worker/accept';
import { applyHeaders, isRepresentationPinned, isStagingHost, resultCacheClass } from '../src/worker/headers';
import worker from '../src/worker/index';
import { _resetIndexCache } from '../src/worker/score/handler';

function req(url: string, accept?: string, ua?: string): Request {
  const headers: Record<string, string> = {};
  if (accept !== undefined) headers.accept = accept;
  if (ua !== undefined) headers['user-agent'] = ua;
  return new Request(url, { headers });
}

// Real production User-Agent shapes (token matched, version boilerplate as
// vendors ship it) so the allowlist regressions catch a real UA drift.
const UA = {
  curl: 'curl/8.7.1',
  browser:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  claudebot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexitybot: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://www.perplexity.ai/perplexitybot)',
  chatgptUser:
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudeUser: 'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  perplexityUser: 'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://www.perplexity.ai/perplexity-user)',
} as const;

/**
 * Return a stub env.ASSETS whose fetch echoes the requested URL back in
 * both body text and a custom header. The handler under test sees this as
 * an opaque upstream response and layers its own headers on top.
 */
function makeEnv(bodyByPath: Record<string, string> = {}, opts: { notFoundUnlessListed?: boolean } = {}) {
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const url = typeof request === 'string' ? request : request.url;
        const path = new URL(url).pathname;
        const listed = Object.hasOwn(bodyByPath, path);
        const status = opts.notFoundUnlessListed && !listed ? 404 : 200;
        const body = bodyByPath[path] ?? (status === 404 ? '' : `asset:${path}`);
        const headers: Record<string, string> = { 'X-Echo-Path': path };
        // Mirror Static Assets: .txt files are text/plain, not HTML. Needed so
        // curl-/llms.txt tests can assert the Worker does not overwrite to markdown.
        if (path.endsWith('.txt')) headers['Content-Type'] = 'text/plain';
        return new Response(body, {
          status,
          headers,
        });
      },
    } as unknown as Fetcher,
  };
}

// ---------------------------------------------------------------------------
// detectPreference — the q-value parsing matrix (eng review §3 diagram).
// ---------------------------------------------------------------------------

describe('detectPreference — content-negotiation decision table', () => {
  test('no Accept header → html (markdown is opt-in)', () => {
    expect(detectPreference(req('https://x/p3'))).toBe('html');
  });

  test('Accept: */* + no UA → html (no markdown-eligible User-Agent)', () => {
    expect(detectPreference(req('https://x/p3', '*/*'))).toBe('html');
  });

  test('Accept: text/html → html', () => {
    expect(detectPreference(req('https://x/p3', 'text/html'))).toBe('html');
  });

  test('Accept: text/markdown → markdown', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown'))).toBe('markdown');
  });

  test('Accept: text/html,text/markdown;q=0.9 → html (higher q)', () => {
    expect(detectPreference(req('https://x/p3', 'text/html,text/markdown;q=0.9'))).toBe('html');
  });

  test('Accept: text/markdown,text/html;q=0.9 → markdown (higher q)', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown,text/html;q=0.9'))).toBe('markdown');
  });

  test('Accept: text/markdown;q=0.9,text/html → html (html implicit q=1 wins)', () => {
    expect(detectPreference(req('https://x/p3', 'text/markdown;q=0.9,text/html'))).toBe('html');
  });

  test('Accept: application/json → html (neither accepted type matches; fallback to html)', () => {
    expect(detectPreference(req('https://x/p3', 'application/json'))).toBe('html');
  });

  test('malformed Accept → html (graceful fallback)', () => {
    expect(detectPreference(req('https://x/p3', 'garbage,,,;;;'))).toBe('html');
  });

  test('Accept: text/plain → markdown (plain-text clients want the source)', () => {
    expect(detectPreference(req('https://x/p3', 'text/plain'))).toBe('markdown');
  });
});

// ---------------------------------------------------------------------------
// detectPreference — User-Agent allowlist (fires only on no-preference
// Accept: absent or `*/*`). Explicit Accept always wins over the UA path.
// ---------------------------------------------------------------------------

describe('detectPreference — User-Agent allowlist', () => {
  test('*/* + curl UA → markdown (CLI allowlist)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.curl))).toBe('markdown');
  });

  test('no Accept + curl UA → markdown', () => {
    expect(detectPreference(req('https://x/p3', undefined, UA.curl))).toBe('markdown');
  });

  test('explicit text/html + curl UA → html (explicit Accept wins over UA)', () => {
    expect(detectPreference(req('https://x/p3', 'text/html', UA.curl))).toBe('html');
  });

  test('*/* + browser UA → html', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.browser))).toBe('html');
  });

  test('*/* + Googlebot UA → html (SEO firewall: Googlebot sends */*)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.googlebot))).toBe('html');
  });

  test('*/* + GPTBot UA → html (training crawler excluded)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.gptbot))).toBe('html');
  });

  test('*/* + ClaudeBot UA → html (training crawler excluded)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.claudebot))).toBe('html');
  });

  test('*/* + PerplexityBot UA → html (search-index crawler excluded)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.perplexitybot))).toBe('html');
  });

  test('*/* + ChatGPT-User UA → markdown (on-demand user-fetcher allowlisted)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.chatgptUser))).toBe('markdown');
  });

  test('*/* + Claude-User UA → markdown (on-demand user-fetcher allowlisted)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.claudeUser))).toBe('markdown');
  });

  test('*/* + Perplexity-User UA → markdown (on-demand user-fetcher allowlisted)', () => {
    expect(detectPreference(req('https://x/p3', '*/*', UA.perplexityUser))).toBe('markdown');
  });
});

// ---------------------------------------------------------------------------
// classifyGatewayRequest — format-class cache key (edge HIT restore U2 / AE4)
// ---------------------------------------------------------------------------

describe('classifyGatewayRequest — format-class table', () => {
  test('a result path keeps a JSON class: Accept application/json survives the gateway, markdown and HTML classify as elsewhere', () => {
    const json = classifyGatewayRequest(req('https://anc.dev/score/ouch', 'application/json', UA.browser));
    expect(json.headers.get('accept')).toBe('application/json');
    const md = classifyGatewayRequest(req('https://anc.dev/score/ouch', 'text/markdown', UA.browser));
    expect(md.headers.get('accept')).toBe('text/markdown');
    const html = classifyGatewayRequest(req('https://anc.dev/score/ouch', 'text/html', UA.browser));
    expect(html.headers.get('accept')).toBe('text/html');
    const curl = classifyGatewayRequest(req('https://anc.dev/score/ouch', '*/*', UA.curl));
    expect(curl.headers.get('accept')).toBe('text/markdown');
    const elsewhere = classifyGatewayRequest(req('https://anc.dev/about', 'application/json', UA.browser));
    expect(elsewhere.headers.get('accept')).toBe('text/html');
  });

  test('Chrome text/html and Chrome */* share one HTML class after normalize', () => {
    const html = classifyGatewayRequest(req('https://anc.dev/about', 'text/html', UA.browser));
    const star = classifyGatewayRequest(req('https://anc.dev/about', '*/*', UA.browser));
    expect(html.headers.get('accept')).toBe('text/html');
    expect(star.headers.get('accept')).toBe('text/html');
    expect(html.headers.get('user-agent')).toBeNull();
    expect(star.headers.get('user-agent')).toBeNull();
  });

  test('Safari vs Chrome HTML shards collapse to the same UA class', () => {
    const chrome = classifyGatewayRequest(req('https://anc.dev/about', 'text/html', UA.browser));
    const safari = classifyGatewayRequest(
      req(
        'https://anc.dev/about',
        'text/html',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    );
    expect(chrome.headers.get('accept')).toBe(safari.headers.get('accept'));
    expect(chrome.headers.get('user-agent')).toBe(safari.headers.get('user-agent'));
  });

  test('curl */* is the markdown class; Chrome text/html is not', () => {
    const curl = classifyGatewayRequest(req('https://anc.dev/', '*/*', UA.curl));
    const chrome = classifyGatewayRequest(req('https://anc.dev/', 'text/html', UA.browser));
    expect(curl.headers.get('accept')).toBe('text/markdown');
    expect(curl.headers.get('user-agent')).toBe('curl/');
    expect(chrome.headers.get('accept')).toBe('text/html');
    expect(chrome.headers.get('user-agent')).toBeNull();
  });

  test('Accept: text/markdown with a browser UA is markdown (explicit Accept wins)', () => {
    const classified = classifyGatewayRequest(req('https://anc.dev/', 'text/markdown', UA.browser));
    expect(classified.headers.get('accept')).toBe('text/markdown');
    expect(classified.headers.get('user-agent')).toBe('curl/');
  });

  test('header-less GET / is the HTML class (no-UA → HTML)', () => {
    const classified = classifyGatewayRequest(req('https://anc.dev/'));
    expect(classified.headers.get('accept')).toBe('text/html');
    expect(classified.headers.get('user-agent')).toBeNull();
  });

  test('GET /mcp with Accept: application/json keeps JSON Accept (not the site HTML/markdown pair)', () => {
    const json = classifyGatewayRequest(req('https://anc.dev/mcp', 'application/json'));
    const html = classifyGatewayRequest(req('https://anc.dev/mcp', 'text/html', UA.browser));
    expect(json.headers.get('accept')).toBe('application/json');
    expect(html.headers.get('accept')).toBe('text/html');
  });

  test('GET /mcp with curl UA and */* is markdown, not HTML', () => {
    const curl = classifyGatewayRequest(req('https://anc.dev/mcp', '*/*', UA.curl));
    const browser = classifyGatewayRequest(req('https://anc.dev/mcp', '*/*', UA.browser));
    expect(curl.headers.get('accept')).toBe('text/markdown');
    expect(browser.headers.get('accept')).toBe('text/html');
  });

  test('www.anc.dev coalesces to anc.dev; staging hosts are left alone', () => {
    const www = classifyGatewayRequest(req('https://www.anc.dev/about', 'text/html', UA.browser));
    expect(new URL(www.url).hostname).toBe('anc.dev');
    const staging = classifyGatewayRequest(
      req('https://agentnative-site-staging.example.workers.dev/about', 'text/html', UA.browser),
    );
    expect(new URL(staging.url).hostname).toBe('agentnative-site-staging.example.workers.dev');
  });

  test('POST /mcp does not smash Accept into the site-surface pair', () => {
    const post = classifyGatewayRequest(
      new Request('https://anc.dev/mcp', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream' },
      }),
    );
    expect(post.headers.get('accept')).toBe('application/json, text/event-stream');
  });

  test('/api/score keeps inbound Accept q-values (not smashed to the HTML/markdown pair)', () => {
    const classified = classifyGatewayRequest(
      req('https://anc.dev/api/score', 'text/markdown;q=0.1, application/json;q=0.9'),
    );
    expect(classified.headers.get('accept')).toBe('text/markdown;q=0.1, application/json;q=0.9');
  });
});

describe('gateway dispatch — inner Cached is the fetch target', () => {
  test('ctx.exports.Cached.fetch receives the classified request', async () => {
    const seen: Request[] = [];
    const ctx = {
      exports: {
        Cached: {
          fetch(request: Request) {
            seen.push(request);
            return new Response('inner', { headers: { 'content-type': 'text/html' } });
          },
        },
      },
    } as unknown as ExecutionContext;
    const res = await worker.fetch(req('https://anc.dev/about', '*/*', UA.browser), makeEnv(), ctx);
    expect(await res.text()).toBe('inner');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('accept')).toBe('text/html');
    expect(seen[0]?.headers.get('user-agent')).toBeNull();
  });

  test('GET /mcp JSON 301 is classified separately from an HTML GET /mcp', async () => {
    const seen: string[] = [];
    const ctx = {
      exports: {
        Cached: {
          fetch(request: Request) {
            seen.push(request.headers.get('accept') ?? '');
            return new Response('inner');
          },
        },
      },
    } as unknown as ExecutionContext;
    await worker.fetch(req('https://anc.dev/mcp', 'application/json'), makeEnv(), ctx);
    await worker.fetch(req('https://anc.dev/mcp', 'text/html', UA.browser), makeEnv(), ctx);
    expect(seen).toEqual(['application/json', 'text/html']);
  });
});

// ---------------------------------------------------------------------------
// isStagingHost — the three-line guard.
// ---------------------------------------------------------------------------

describe('isStagingHost', () => {
  test('matches *.workers.dev', () => {
    expect(isStagingHost('agentnative-site.brett.workers.dev')).toBe(true);
    expect(isStagingHost('something.workers.dev')).toBe(true);
  });

  test('does not match production domain', () => {
    expect(isStagingHost('anc.dev')).toBe(false);
    expect(isStagingHost('localhost:8787')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Header policy (A8 + P4).
// ---------------------------------------------------------------------------

describe('applyHeaders — HTML branch', () => {
  test('/p3 HTML: Link rel=alternate + X-Llms-Txt + HIT-1d browser TTL', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('Link')).toBe('</p3.md>; rel="alternate"; type="text/markdown"');
    expect(res.headers.get('X-Llms-Txt')).toBe('/llms.txt');
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });

  // Negotiated HIT-1d uses CDN max-age=86400 without s-maxage on Cache-Control
  // so the custom-domain zone cache cannot store a Vary-stripped copy.
  // Homepage `/` is HIT-min (tested below), not this class.
  test('negotiated /about HTML is HIT-1d: Vary, no s-maxage, CDN 86400, not no-store', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/about'),
      servedMarkdown: false,
      pathname: '/about',
    });
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Vary')?.toLowerCase()).not.toContain('accept-encoding');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).not.toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('/ HTML: Link carries the twin alternate plus the machine-surface discovery rels', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/'),
      servedMarkdown: false,
      pathname: '/',
    });
    expect(res.headers.get('Link')).toBe(
      '</index.md>; rel="alternate"; type="text/markdown", ' +
        '</.well-known/api-catalog>; rel="api-catalog", ' +
        '</.well-known/mcp/server-card.json>; rel="service-desc", ' +
        '</mcp-skill>; rel="service-doc", ' +
        '</.well-known/ai.txt>; rel="service-meta"',
    );
  });
});

describe('applyHeaders — markdown branch', () => {
  test('/p3.md: Content-Type + X-Robots-Tag noindex + no Vary (path-keyed HIT-1d)', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/p3.md'),
      servedMarkdown: true,
      pathname: '/p3.md',
    });
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Vary')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('/about.md has no Vary and HIT-1d CDN TTL', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/about.md'),
      servedMarkdown: true,
      pathname: '/about.md',
    });
    expect(res.headers.get('Vary')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('negotiated /about markdown keeps Vary and does not send CDN no-store', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/about'),
      servedMarkdown: true,
      pathname: '/about',
    });
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).not.toBe('no-store');
  });
});

describe('applyHeaders — HIT-min live boards', () => {
  test('/ HTML is HIT-min: home tag, split TTL, Vary', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/'),
      servedMarkdown: false,
      pathname: '/',
    });
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Cache-Tag')).toBe('home');
  });

  test('negotiated / markdown is HIT-min with Vary and the home tag', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/'),
      servedMarkdown: true,
      pathname: '/',
    });
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Cache-Tag')).toBe('home');
  });

  test('/index.md has no Vary and HIT-min home tag', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/index.md'),
      servedMarkdown: true,
      pathname: '/index.md',
    });
    expect(res.headers.get('Vary')).toBeNull();
    expect(res.headers.get('Cache-Tag')).toBe('home');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
  });

  test('/scorecards, its twin, and its lane and view queries share the homepage tag', () => {
    for (const url of [
      'https://anc.dev/scorecards',
      'https://anc.dev/scorecards.md',
      'https://anc.dev/scorecards?lane=web&view=all',
    ]) {
      const res = applyHeaders(new Response('board'), {
        request: req(url),
        servedMarkdown: url.endsWith('.md'),
        pathname: '/scorecards',
      });
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
      expect(res.headers.get('Cache-Tag')).toBe('home');
    }
  });

  // The legacy /web board is served by its route, which names its class;
  // the path alone no longer carries a tag.
  test('/web.md with the served web tag is no-Vary HIT-min even when Link pathname is HTML-canonical /web', () => {
    const res = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/web.md'),
      servedMarkdown: true,
      pathname: '/web',
      cache: { klass: 'hit-min', tag: 'web' },
    });
    expect(res.headers.get('Vary')).toBeNull();
    expect(res.headers.get('Cache-Tag')).toBe('web');
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
  });

  test('/web?view=all and /web?view=curated carry the served web tag', () => {
    for (const url of ['https://anc.dev/web?view=all', 'https://anc.dev/web?view=curated']) {
      const res = applyHeaders(new Response('html'), {
        request: req(url),
        servedMarkdown: false,
        pathname: '/web',
        cache: { klass: 'hit-min', tag: 'web' },
      });
      expect(res.headers.get('Cache-Tag')).toBe('web');
      expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    }
  });

  test('a legacy /web/<domain> path without a served class is untagged HIT-1d', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/web/example.com'),
      servedMarkdown: false,
      pathname: '/web/example.com',
    });
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
  });
});

describe('applyHeaders — cache class served by the result route', () => {
  const web = (representation: 'html' | 'md' | 'json') =>
    resultCacheClass({ curated: false, lane: 'web', target: 'anc.dev', representation });
  const curated = (representation: 'html' | 'md' | 'json') =>
    resultCacheClass({ curated: true, lane: 'cli', target: 'ripgrep', representation });

  test('a website result is HIT-min under web:<host> in every representation', () => {
    const html = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/score/anc.dev'),
      servedMarkdown: false,
      pathname: '/score/anc.dev',
      cache: web('html'),
    });
    expect(html.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(html.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(html.headers.get('Cache-Tag')).toBe('web:anc.dev');
    expect(html.headers.get('Vary')).toBe('Accept, User-Agent');

    const md = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/score/anc.dev/md'),
      servedMarkdown: true,
      pathname: '/score/anc.dev',
      cache: web('md'),
    });
    expect(md.headers.get('Cache-Tag')).toBe('web:anc.dev');
    expect(md.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(md.headers.get('Vary')).toBeNull();

    const json = applyHeaders(new Response('{}'), {
      request: req('https://anc.dev/score/anc.dev/json'),
      servedMarkdown: false,
      servedJson: true,
      pathname: '/score/anc.dev',
      cache: web('json'),
    });
    expect(json.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(json.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(json.headers.get('Cache-Tag')).toBe('web:anc.dev');
    expect(json.headers.get('Vary')).toBeNull();
  });

  test('a live binary carries cli:<binary> and a branch run cli:<owner>/<repo>@<branch>', () => {
    expect(resultCacheClass({ curated: false, lane: 'cli', target: 'ouch', representation: 'json' })).toEqual({
      klass: 'hit-min',
      tag: 'cli:ouch',
    });
    expect(resultCacheClass({ curated: false, lane: 'cli', target: 'o/r@feature', representation: 'html' })).toEqual({
      klass: 'hit-min',
      tag: 'cli:o/r@feature',
    });
    const res = applyHeaders(new Response('{}'), {
      request: req('https://anc.dev/score/ouch/json'),
      servedMarkdown: false,
      servedJson: true,
      pathname: '/score/ouch',
      cache: { klass: 'hit-min', tag: 'cli:ouch' },
    });
    expect(res.headers.get('Cache-Tag')).toBe('cli:ouch');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  test('a curated slug is HIT-1d with no tag and its build-emitted JSON is the path-keyed short class', () => {
    expect(curated('html')).toEqual({ klass: 'hit-1d' });
    expect(curated('md')).toEqual({ klass: 'hit-1d' });
    expect(curated('json')).toEqual({ klass: 'short' });
    const html = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/score/ripgrep'),
      servedMarkdown: false,
      pathname: '/score/ripgrep',
      cache: curated('html'),
    });
    expect(html.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');
    expect(html.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(html.headers.get('Cache-Tag')).toBeNull();
    const json = applyHeaders(new Response('{}'), {
      request: req('https://anc.dev/score/ripgrep/json'),
      servedMarkdown: false,
      servedJson: true,
      pathname: '/score/ripgrep',
      cache: curated('json'),
    });
    expect(json.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=86400, stale-while-revalidate=60');
    expect(json.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
    expect(json.headers.get('Cache-Tag')).toBeNull();
  });

  test('a 4xx or 5xx is MISS and untagged even when the route named a class', () => {
    for (const status of [404, 503]) {
      const res = applyHeaders(new Response('nope', { status }), {
        request: req('https://anc.dev/score/anc.dev/json'),
        servedMarkdown: false,
        servedJson: true,
        pathname: '/score/anc.dev',
        cache: web('json'),
      });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
      expect(res.headers.get('Cache-Tag')).toBeNull();
    }
  });

  test('a served MISS class makes a 200 uncacheable and drops the tag', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/score/anc.dev?v=123'),
      servedMarkdown: false,
      pathname: '/score/anc.dev',
      cache: { klass: 'miss' },
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });
});

describe('applyHeaders — Link alternates on result pages', () => {
  const MD = '</score/anc.dev/md>; rel="alternate"; type="text/markdown"';
  const JSON_ALT = '</score/anc.dev/json>; rel="alternate"; type="application/json"';

  test('the HTML page and both markdown forms carry the twin and the JSON alternate', () => {
    const html = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/score/anc.dev'),
      servedMarkdown: false,
      pathname: '/score/anc.dev',
    });
    expect(html.headers.get('Link')).toBe(`${MD}, ${JSON_ALT}`);
    const negotiated = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/score/anc.dev'),
      servedMarkdown: true,
      pathname: '/score/anc.dev',
    });
    expect(negotiated.headers.get('Link')).toBe(`${MD}, ${JSON_ALT}`);
    expect(negotiated.headers.get('Vary')).toBe('Accept, User-Agent');
    const pinned = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/score/anc.dev/md'),
      servedMarkdown: true,
      pathname: '/score/anc.dev',
    });
    expect(pinned.headers.get('Link')).toBe(`${MD}, ${JSON_ALT}`);
    expect(pinned.headers.get('Vary')).toBeNull();
  });

  test('the JSON representation carries no Link and no Vary', () => {
    const res = applyHeaders(new Response('{}', { headers: { Link: '</stale>; rel="alternate"' } }), {
      request: req('https://anc.dev/score/anc.dev/json'),
      servedMarkdown: false,
      servedJson: true,
      pathname: '/score/anc.dev',
    });
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('a page outside the result namespace keeps the single markdown alternate and no Link on its twin', () => {
    const html = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/about'),
      servedMarkdown: false,
      pathname: '/about',
    });
    expect(html.headers.get('Link')).toBe('</about.md>; rel="alternate"; type="text/markdown"');
    const md = applyHeaders(new Response('md'), {
      request: req('https://anc.dev/about.md'),
      servedMarkdown: true,
      pathname: '/about.md',
    });
    expect(md.headers.get('Link')).toBeNull();
  });
});

describe('applyHeaders — MISS class', () => {
  test('Worker 404 is no-store and untagged', () => {
    const res = applyHeaders(new Response('missing', { status: 404 }), {
      request: req('https://anc.dev/anc-web-audit-no-such-page'),
      servedMarkdown: false,
      pathname: '/anc-web-audit-no-such-page',
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('Worker 5xx is no-store and untagged so it cannot become a skip-Worker HIT', () => {
    const res = applyHeaders(new Response('boom', { status: 500 }), {
      request: req('https://anc.dev/about'),
      servedMarkdown: false,
      pathname: '/about',
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('pre-audit /web/<domain> 404 is no-store and untagged so the first audit is visible', () => {
    const res = applyHeaders(new Response('not audited', { status: 404 }), {
      request: req('https://anc.dev/web/never-audited.dev'),
      servedMarkdown: false,
      pathname: '/web/never-audited.dev',
      cache: { klass: 'hit-min', tag: 'web:never-audited.dev' },
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('/web/scoring* is MISS even on 200', () => {
    const res = applyHeaders(new Response('scoring'), {
      request: req('https://anc.dev/web/scoring/example.com'),
      servedMarkdown: false,
      pathname: '/web/scoring/example.com',
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  test('/scoring with a target and /scoring.md are MISS on 200', () => {
    const page = applyHeaders(new Response('progress'), {
      request: req('https://anc.dev/scoring?target=ripgrep'),
      servedMarkdown: false,
      pathname: '/scoring',
    });
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(page.headers.get('Cache-Tag')).toBeNull();
    const twin = applyHeaders(new Response('progress'), {
      request: req('https://anc.dev/scoring.md'),
      servedMarkdown: true,
      pathname: '/scoring.md',
    });
    expect(twin.headers.get('Cache-Control')).toBe('no-store');
    expect(twin.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });
});

describe('applyHeaders — /audit prefill demotion', () => {
  test('/audit with a query is the short edge class with no tag; bare /audit stays HIT-1d', () => {
    const prefilled = applyHeaders(new Response('form'), {
      request: req('https://anc.dev/audit?lane=web&target=example.com'),
      servedMarkdown: false,
      pathname: '/audit',
    });
    expect(prefilled.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(prefilled.headers.get('Cache-Control')).not.toContain('s-maxage');
    expect(prefilled.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300');
    expect(prefilled.headers.get('Cache-Tag')).toBeNull();
    expect(prefilled.headers.get('Vary')).toBe('Accept, User-Agent');
    const bare = applyHeaders(new Response('form'), {
      request: req('https://anc.dev/audit'),
      servedMarkdown: false,
      pathname: '/audit',
    });
    expect(bare.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');
    expect(bare.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
    expect(bare.headers.get('Cache-Tag')).toBeNull();
  });
});

describe('applyHeaders — untwinned source (.txt / .xml)', () => {
  test('/llms.txt keeps upstream text/plain, edge TTL, and no HTML/markdown chrome', () => {
    const res = applyHeaders(new Response('# index\n', { headers: { 'Content-Type': 'text/plain' } }), {
      request: req('https://anc.dev/llms.txt', '*/*', UA.curl),
      servedMarkdown: false,
      pathname: '/llms.txt',
    });
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');
    expect(res.headers.get('Vary')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('X-Llms-Txt')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
  });
});

describe('applyHeaders — JSON branch (skill-distribution)', () => {
  test('/skill.json: application/json + CORS + noindex + short cache + no Link', () => {
    const res = applyHeaders(new Response('{}'), {
      request: req('https://anc.dev/skill.json'),
      servedMarkdown: false,
      pathname: '/skill.json',
    });
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate=60');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
    // No markdown-twin advertisement on JSON paths.
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('X-Llms-Txt')).toBeNull();
  });

  test('synthetic /foo.json also matches the JSON-extension branch (forward-compat for any /<slug>.json)', () => {
    const res = applyHeaders(new Response('{}'), {
      request: req('https://anc.dev/foo.json'),
      servedMarkdown: false,
      pathname: '/foo.json',
    });
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('non-.json path keeps HTML-branch headers (Link rel=alternate present)', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/installer'),
      servedMarkdown: false,
      pathname: '/installer',
    });
    expect(res.headers.get('Content-Type')).not.toBe('application/json; charset=utf-8');
    expect(res.headers.get('Link')).toContain('rel="alternate"');
  });
});

describe('applyHeaders — SVG branch (badge surface)', () => {
  test('/badge/<tool>.svg: image/svg+xml + CORS + short cache + no noindex + no Link', () => {
    const res = applyHeaders(new Response('<svg></svg>'), {
      request: req('https://anc.dev/badge/rg.svg'),
      servedMarkdown: false,
      pathname: '/badge/rg.svg',
    });
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate=60');
    // SVGs are public-by-default — no noindex (production hosts; staging
    // gets noindex via the .workers.dev guard regardless of branch).
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
    // No markdown-twin advertisement on SVG paths.
    expect(res.headers.get('Link')).toBeNull();
    expect(res.headers.get('X-Llms-Txt')).toBeNull();
  });

  test('badge SVG on staging (.workers.dev) still gets noindex via the staging guard', () => {
    const res = applyHeaders(new Response('<svg></svg>'), {
      request: req('https://agentnative-site-staging.workers.dev/badge/rg.svg'),
      servedMarkdown: false,
      pathname: '/badge/rg.svg',
    });
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('non-.svg path does not get the SVG content-type', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/badge'),
      servedMarkdown: false,
      pathname: '/badge',
    });
    expect(res.headers.get('Content-Type')).not.toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('Link')).toContain('rel="alternate"');
  });
});

describe('applyHeaders — hashed assets', () => {
  test('/fonts/* gets immutable cache', () => {
    const res = applyHeaders(new Response('woff2'), {
      request: req('https://anc.dev/fonts/uncut-sans-variable.woff2'),
      servedMarkdown: false,
      pathname: '/fonts/uncut-sans-variable.woff2',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('/og-image.png gets immutable cache', () => {
    const res = applyHeaders(new Response('png'), {
      request: req('https://anc.dev/og-image.png'),
      servedMarkdown: false,
      pathname: '/og-image.png',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('applyHeaders — staging-host guard (locked decision #4)', () => {
  test('HTML on .workers.dev gets X-Robots-Tag: noindex', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://agentnative-site.brett.workers.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    // Link + X-Llms-Txt still present on HTML.
    expect(res.headers.get('Link')).toContain('rel="alternate"');
  });

  test('fonts on .workers.dev still immutable-cached AND noindex', () => {
    const res = applyHeaders(new Response('woff2'), {
      request: req('https://agentnative-site.brett.workers.dev/fonts/uncut-sans-variable.woff2'),
      servedMarkdown: false,
      pathname: '/fonts/uncut-sans-variable.woff2',
    });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('production host does NOT get noindex on HTML', () => {
    const res = applyHeaders(new Response('html'), {
      request: req('https://anc.dev/p3'),
      servedMarkdown: false,
      pathname: '/p3',
    });
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end handler: asset-lookup rewrite for the markdown branch.
// ---------------------------------------------------------------------------

describe('worker.fetch — CN rewrite + asset lookup', () => {
  test('/p3 no Accept → fetches /p3 (HTML, auto-trailing-slash resolves to p3.html)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/p3'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
    expect(res.headers.get('Link')).toContain('</p3.md>');
  });

  test('/p3 with Accept: text/markdown → fetches /p3.md (rewritten)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/p3', 'text/markdown'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3.md');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('/p3.md any Accept → fetches /p3.md (suffix wins)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/p3.md', 'text/html'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3.md');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  test('/ with Accept: text/markdown → fetches /index.md', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/', 'text/markdown'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/index.md');
  });

  test('/ with */* + curl UA → fetches /index.md (bare `curl anc.dev`)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/', '*/*', UA.curl), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Echo-Path')).toBe('/index.md');
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
  });

  // Regression: markdown-UA rewrite used to look up /llms.txt.md and 404.
  // Bare `curl /llms.txt` must return the file as text/plain; `curl /` still
  // negotiates the homepage twin (test above).
  test('/llms.txt with */* + curl UA is 200 text/plain, not a rewritten 404', async () => {
    const env = makeEnv({ '/llms.txt': '# The agent-native standard\n' }, { notFoundUnlessListed: true });
    const res = await worker.fetch(req('https://anc.dev/llms.txt', '*/*', UA.curl), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Echo-Path')).toBe('/llms.txt');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Type')).not.toContain('markdown');
    expect(await res.text()).toContain('# The agent-native standard');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');
  });

  test('/robots.txt and /sitemap.xml skip the markdown twin rewrite', async () => {
    const env = makeEnv(
      { '/robots.txt': 'User-agent: *\n', '/sitemap.xml': '<urlset/>' },
      { notFoundUnlessListed: true },
    );
    const robots = await worker.fetch(req('https://anc.dev/robots.txt', '*/*', UA.curl), env, {} as ExecutionContext);
    const sitemap = await worker.fetch(req('https://anc.dev/sitemap.xml', '*/*', UA.curl), env, {} as ExecutionContext);
    expect(robots.status).toBe(200);
    expect(robots.headers.get('X-Echo-Path')).toBe('/robots.txt');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('X-Echo-Path')).toBe('/sitemap.xml');
  });

  test('/ with */* + browser UA → HTML branch (fetches /)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/', '*/*', UA.browser), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/');
  });

  test('/p3 with Accept: text/html,text/markdown;q=0.9 → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req('https://anc.dev/p3', 'text/html,text/markdown;q=0.9'),
      env,
      {} as ExecutionContext,
    );
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('/p3 with */* → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/p3', '*/*'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('/p3 with malformed Accept → HTML branch', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://anc.dev/p3', 'garbage,,,;;;'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/p3');
  });

  test('staging .workers.dev: HTML branch still adds noindex', async () => {
    const env = makeEnv();
    const res = await worker.fetch(req('https://agentnative-site.brett.workers.dev/p3'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Link')).toContain('</p3.md>');
  });

  test('/skill.json with Accept: text/markdown returns the JSON, not a 404 from CN rewrite', async () => {
    const env = makeEnv({ '/skill.json': '{"schema_version":1}' });
    const res = await worker.fetch(req('https://anc.dev/skill.json', 'text/markdown'), env, {} as ExecutionContext);
    // CN rewrite must skip .json paths so the asset lookup stays on /skill.json.
    expect(res.headers.get('X-Echo-Path')).toBe('/skill.json');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await res.text()).toBe('{"schema_version":1}');
  });

  test('/skill.json no Accept header: JSON branch headers applied', async () => {
    const env = makeEnv({ '/skill.json': '{}' });
    const res = await worker.fetch(req('https://anc.dev/skill.json'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/skill.json');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Shared negotiation predicate. The CN rewrite and the Vary writer must
// classify the same path set; expectations derive from the exported
// predicate rather than a duplicated path list so a drift in either layer
// fails here.
// ---------------------------------------------------------------------------

describe('negotiation predicate — CN rewrite and applyHeaders agree', () => {
  const paths = [
    '/p3',
    '/about',
    '/p3.md',
    '/skill.json',
    '/badge/rg.svg',
    '/llms.txt',
    '/robots.txt',
    '/sitemap.xml',
    '/og-image.png',
    '/fonts/uncut-sans-variable.woff2',
  ];

  test('applyHeaders stamps Vary exactly on the paths the predicate leaves negotiable', () => {
    for (const path of paths) {
      const res = applyHeaders(new Response('body'), {
        request: req(`https://anc.dev${path}`),
        servedMarkdown: path.endsWith('.md'),
        pathname: path,
      });
      expect(`${path} vary=${res.headers.get('Vary') !== null}`).toBe(`${path} vary=${!isRepresentationPinned(path)}`);
    }
  });

  test('the CN rewrite negotiates exactly the paths the predicate leaves negotiable', async () => {
    const env = makeEnv();
    for (const path of paths) {
      const res = await worker.fetch(req(`https://anc.dev${path}`, 'text/markdown'), env, {} as ExecutionContext);
      const expected = isRepresentationPinned(path) ? path : `${path}.md`;
      expect(`${path} → ${res.headers.get('X-Echo-Path')}`).toBe(`${path} → ${expected}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent-readiness discovery surfaces. Worker tests cover descriptor aliases
// (all paths serve the same /.well-known/mcp body) plus OAuth metadata.
// ---------------------------------------------------------------------------

describe('worker.fetch — agent-readiness discovery surfaces', () => {
  test('GET /.well-known/api-catalog → application/linkset+json + CORS + noindex', async () => {
    const env = makeEnv({ '/.well-known/api-catalog': '{"linkset":[]}' });
    const res = await worker.fetch(req('https://anc.dev/.well-known/api-catalog'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/linkset+json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    const body = JSON.parse(await res.text()) as { linkset: unknown[] };
    expect(body.linkset).toEqual([]);
  });

  test('GET /.well-known/mcp pointer alias 301s to the canonical server card', async () => {
    const seed = JSON.stringify({
      mcp_endpoint: 'https://anc.dev/mcp',
      url: 'https://anc.dev/mcp',
      documentation: 'https://anc.dev/mcp-skill.md',
      transport: { type: 'streamable-http', endpoint: 'https://anc.dev/mcp' },
    });
    const env = makeEnv({ '/_internal/mcp-server-card.json': seed });
    const canonical = await worker.fetch(
      req('https://staging.example/.well-known/mcp/server-card.json'),
      env,
      {} as ExecutionContext,
    );
    const alias = await worker.fetch(req('https://staging.example/.well-known/mcp'), env, {} as ExecutionContext);
    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(301);
    expect(alias.headers.get('Location')).toBe('https://staging.example/.well-known/mcp/server-card.json');
  });

  test('GET /mcp.json alias 301s to the canonical server card', async () => {
    const env = makeEnv();
    const alias = await worker.fetch(req('https://staging.example/mcp.json'), env, {} as ExecutionContext);
    expect(alias.status).toBe(301);
    expect(alias.headers.get('Location')).toBe('https://staging.example/.well-known/mcp/server-card.json');
  });

  test('GET /.well-known/agent-skills/index.json → application/json', async () => {
    const env = makeEnv({ '/.well-known/agent-skills/index.json': '{"skills":[]}' });
    const res = await worker.fetch(
      req('https://anc.dev/.well-known/agent-skills/index.json'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('{"skills":[]}');
  });

  test('GET /.well-known/oauth-protected-resource rewrites resource + documentation URLs', async () => {
    const seed = JSON.stringify({
      resource: 'https://anc.dev/mcp',
      authorization_servers: ['https://anc.dev'],
      resource_documentation: 'https://anc.dev/auth.md',
    });
    const env = makeEnv({ '/.well-known/oauth-protected-resource': seed });
    const res = await worker.fetch(
      req('https://staging.example/.well-known/oauth-protected-resource'),
      env,
      {} as ExecutionContext,
    );
    const body = JSON.parse(await res.text()) as {
      resource: string;
      authorization_servers: string[];
      resource_documentation: string;
    };
    expect(body.resource).toBe('https://staging.example/mcp');
    expect(body.authorization_servers).toEqual(['https://staging.example']);
    expect(body.resource_documentation).toBe('https://staging.example/auth.md');
  });

  test('GET /.well-known/oauth-authorization-server rewrites issuer + agent_auth URLs', async () => {
    const seed = JSON.stringify({
      issuer: 'https://anc.dev',
      token_endpoint: 'https://anc.dev/oauth2/token',
      jwks_uri: 'https://anc.dev/.well-known/jwks.json',
      service_documentation: 'https://anc.dev/auth.md',
      agent_auth: {
        skill: 'https://anc.dev/auth.md',
        register_uri: 'https://anc.dev/auth.md',
        anonymous: { claim_uri: 'https://anc.dev/auth.md' },
      },
    });
    const env = makeEnv({ '/.well-known/oauth-authorization-server': seed });
    const res = await worker.fetch(
      req('https://staging.example/.well-known/oauth-authorization-server'),
      env,
      {} as ExecutionContext,
    );
    const body = JSON.parse(await res.text()) as {
      issuer: string;
      service_documentation: string;
      agent_auth: { skill: string; anonymous: { claim_uri: string } };
    };
    expect(body.issuer).toBe('https://staging.example');
    expect(body.service_documentation).toBe('https://staging.example/auth.md');
    expect(body.agent_auth.skill).toBe('https://staging.example/auth.md');
    expect(body.agent_auth.anonymous.claim_uri).toBe('https://staging.example/auth.md');
  });

  test('POST /oauth2/token returns a typed public-catalog error', async () => {
    const env = makeEnv({});
    const res = await worker.fetch(
      new Request('https://anc.dev/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(await res.text()) as { error: string; mcp_endpoint: string };
    expect(body.error).toBe('public_catalog');
    expect(body.mcp_endpoint).toBe('https://anc.dev/mcp');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /api/score routing (plan U5). The handler's own behavior is covered by
// tests/score-handler.test.ts; these tests confirm:
//   1. /api/score requests are intercepted BEFORE the asset call (the stub
//      ASSETS fetcher is never reached for /api/score*).
//   2. Asset-first invariant for every other path is preserved.
//   3. q-value content negotiation works on the /api/score* surface.
//      Plan-required test: `text/markdown;q=0.1, application/json;q=0.9`
//      must resolve to JSON, not markdown — guards against substring-
//      match regressions per the `accept-header-q-value` learning.
// ---------------------------------------------------------------------------

describe('worker.fetch — /api/score routing', () => {
  // The handler caches the registry + hints indexes at module scope, so
  // tests that depend on the stubbed env.ASSETS being reached must reset
  // the cache before each test — otherwise a prior test's data is served
  // from memory and the stub is never called.
  beforeEach(() => {
    _resetIndexCache();
  });

  test('/api/score response carries the JSON envelope (not asset content)', async () => {
    // Confirms index.ts routes /api/score to handleScore rather than the
    // asset path. The handler always returns JSON; the asset path would
    // return the stubbed asset body. Asserting on the response shape is
    // both more robust and more meaningful than the previous fragile
    // assetCalled flag check.
    const env = makeEnv({
      '/registry-index.json': '{"by_slug":{},"by_owner_repo":{}}',
      '/discovery-hints-index.json': '{"by_owner_repo":{}}',
    });
    const url = 'https://anc.dev/api/score?input=unknown-tool';
    const res = await worker.fetch(req(url), env, {} as ExecutionContext);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as { error?: unknown; spec_version?: unknown; auditor_url?: unknown };
    expect(body.spec_version).toBeTruthy();
    expect(body.auditor_url).toBeTruthy();
  });

  test('asset-first invariant: /scorecards/ripgrep still proxies to env.ASSETS', async () => {
    const env = makeEnv({ '/scorecards/ripgrep': 'scorecard html' });
    const res = await worker.fetch(req('https://anc.dev/scorecards/ripgrep'), env, {} as ExecutionContext);
    expect(res.headers.get('X-Echo-Path')).toBe('/scorecards/ripgrep');
  });

  test('q-value: Accept: text/markdown;q=0.1, application/json;q=0.9 → JSON content-type', async () => {
    // Plan-required test (accept-header-q-value learning). Substring
    // matching would pick markdown because the header *contains*
    // 'text/markdown'. The accepts package + q-value parsing picks JSON.
    const env = makeEnv({
      '/registry-index.json': '{"by_slug":{},"by_owner_repo":{}}',
      '/discovery-hints-index.json': '{"by_owner_repo":{}}',
    });
    const url = new URL('https://anc.dev/api/score');
    url.searchParams.set('input', 'unknown-tool');
    const res = await worker.fetch(
      new Request(url.toString(), { headers: { accept: 'text/markdown;q=0.1, application/json;q=0.9' } }),
      env,
      {} as ExecutionContext,
    );
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});

describe('worker.fetch — agent-friendly 404', () => {
  test('unknown HTML path returns 404 with origin-absolute recovery links and Vary', async () => {
    const env = makeEnv({}, { notFoundUnlessListed: true });
    const res = await worker.fetch(req('https://anc.dev/anc-web-audit-no-such-page'), env, {} as ExecutionContext);
    expect(res.status).toBe(404);
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    const html = await res.text();
    expect(html).toContain('<h1>Not found</h1>');
    expect(html).toContain('https://anc.dev/sitemap.xml');
    expect(html).toContain('https://anc.dev/llms.txt');
    expect(html).not.toContain('href="/sitemap.xml"');
  });

  test('unknown path with Accept markdown returns 404 markdown linking both recovery URLs', async () => {
    const env = makeEnv({}, { notFoundUnlessListed: true });
    const res = await worker.fetch(
      req('https://anc.dev/anc-web-audit-no-such-page', 'text/markdown'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toBe('Accept, User-Agent');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    const md = await res.text();
    expect(md).toContain('[Sitemap](https://anc.dev/sitemap.xml)');
    expect(md).toContain('[llms.txt](https://anc.dev/llms.txt)');
  });

  test('staging origin does not emit the production host in 404 markdown', async () => {
    const env = makeEnv({}, { notFoundUnlessListed: true });
    const res = await worker.fetch(
      req('https://agentnative-site-staging.workers.dev/missing', 'text/markdown'),
      env,
      {} as ExecutionContext,
    );
    const md = await res.text();
    expect(md).toContain('[Sitemap](https://agentnative-site-staging.workers.dev/sitemap.xml)');
    expect(md).not.toContain('https://anc.dev');
  });
});
