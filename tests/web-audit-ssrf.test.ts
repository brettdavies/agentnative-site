// SSRF egress-guard tests (plan U3). The guard is the security boundary
// for every probe fetch the web audit makes: private / loopback /
// link-local / CGNAT / cloud-metadata destinations must be blocked in
// every encoding form, redirects must be re-validated per hop, and the
// public happy path must still succeed.

import { describe, expect, test } from 'bun:test';
import { guardedFetch, validatePublicUrl } from '../src/worker/audit-web/ssrf';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

describe('validatePublicUrl', () => {
  test('allows a public https URL', () => {
    const v = validatePublicUrl('https://example.com/');
    expect(v.ok).toBe(true);
  });

  test('allows a public http URL', () => {
    expect(validatePublicUrl('http://example.com/path').ok).toBe(true);
  });

  test.each([
    ['loopback ipv6', 'http://[::1]/'],
    ['loopback ipv4', 'http://127.0.0.1/'],
    ['cloud metadata ip', 'http://169.254.169.254/latest/meta-data/'],
    ['rfc1918 10/8', 'http://10.1.2.3/'],
    ['rfc1918 192.168/16', 'http://192.168.0.5/'],
    ['rfc1918 172.16/12', 'http://172.20.1.1/'],
    ['gcp metadata hostname', 'http://metadata.google.internal/'],
    ['localhost hostname', 'http://localhost:8787/'],
    ['decimal ip literal (127.0.0.1)', 'http://2130706433/'],
    ['octal ip literal (127.0.0.1)', 'http://0177.0.0.1/'],
    ['hex ip literal (127.0.0.1)', 'http://0x7f.0.0.1/'],
    ['unspecified 0.0.0.0', 'http://0.0.0.0/'],
    ['ipv4-mapped ipv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['cgnat 100.64/10', 'http://100.64.0.1/'],
    ['link-local ipv4', 'http://169.254.1.1/'],
    ['ipv6 unique-local fc00::/7', 'http://[fd00::1]/'],
    ['ipv6 link-local fe80::/10', 'http://[fe80::1]/'],
    ['ipv6 unspecified', 'http://[::]/'],
  ])('blocks %s with a typed reason', (_label, url) => {
    const v = validatePublicUrl(url);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
  });

  test('rejects non-http(s) schemes', () => {
    expect(validatePublicUrl('ftp://example.com/').ok).toBe(false);
    expect(validatePublicUrl('file:///etc/passwd').ok).toBe(false);
  });

  test('rejects unparseable input', () => {
    expect(validatePublicUrl('not a url').ok).toBe(false);
    expect(validatePublicUrl('').ok).toBe(false);
  });

  test('canonicalizes before range-checking: mixed-radix dotted forms', () => {
    expect(validatePublicUrl('http://0x0a.1.2.3/').ok).toBe(false);
    expect(validatePublicUrl('http://0300.0250.0.1/').ok).toBe(false);
  });
});

describe('guardedFetch', () => {
  test('public URL fetches through and returns the response shape', async () => {
    const fetchImpl = stubFetch(
      () => new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('hello');
    expect(resp.headers['content-type']).toBe('text/plain');
    expect(resp.error).toBeNull();
  });

  test('blocked URL never reaches the fetch implementation', async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return new Response('nope');
    });
    const resp = await guardedFetch('http://169.254.169.254/', {}, { fetchImpl });
    expect(called).toBe(0);
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('blocked');
  });

  test('a redirect into a blocked range is refused mid-chain', async () => {
    const fetched: string[] = [];
    const fetchImpl = stubFetch((url) => {
      fetched.push(url);
      if (url === 'https://example.com/') {
        return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest' } });
      }
      return new Response('secret', { status: 200 });
    });
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl });
    expect(fetched).toEqual(['https://example.com/']);
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('blocked');
  });

  test('follows allowed redirects and returns the final response', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url === 'https://example.com/a') {
        return new Response(null, { status: 301, headers: { Location: '/b' } });
      }
      return new Response('final', { status: 200 });
    });
    const resp = await guardedFetch('https://example.com/a', {}, { fetchImpl });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('final');
  });

  test('hop count exceeding the cap aborts with an error', async () => {
    let n = 0;
    const fetchImpl = stubFetch(() => {
      n++;
      return new Response(null, { status: 302, headers: { Location: `https://example.com/${n}` } });
    });
    const resp = await guardedFetch('https://example.com/0', {}, { fetchImpl, maxRedirects: 3 });
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('redirect');
    expect(n).toBeLessThanOrEqual(4);
  });

  test('deadline exceeded aborts with an error', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('slow')), 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl, timeoutMs: 30 });
    expect(resp.status).toBeNull();
    expect(resp.error).not.toBeNull();
  });

  test('network failure returns an error response instead of throwing', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl });
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('fetch failed');
  });

  test('4xx/5xx statuses are a normal informative outcome, not an error', async () => {
    const fetchImpl = stubFetch(() => new Response('gone', { status: 404 }));
    const resp = await guardedFetch('https://example.com/missing', {}, { fetchImpl });
    expect(resp.status).toBe(404);
    expect(resp.error).toBeNull();
  });

  test('redirect without a Location header returns the redirect response as-is', async () => {
    const fetchImpl = stubFetch(() => new Response('odd', { status: 302 }));
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl });
    expect(resp.status).toBe(302);
  });
});
