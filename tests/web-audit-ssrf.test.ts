// SSRF egress-guard tests (plan U3). The guard is the security boundary
// for every probe fetch the web audit makes: private / loopback /
// link-local / CGNAT / cloud-metadata destinations must be blocked in
// every encoding form, redirects must be re-validated per hop, and the
// public happy path must still succeed. The follow phase adds two more
// boundaries: no declared URL, redirect hop, or metadata location reaches
// a private destination, and no wire probe reaches a host that did not
// publish an artifact naming the endpoint, whichever way it failed to.

import { describe, expect, test } from 'bun:test';
import { AUDIT_USER_AGENT } from '../src/shared/user-agents';
import {
  AUDIT_PROBE_MAX_BODY_BYTES,
  blockedHostReason,
  guardedFetch,
  STATUS_ONLY_BODY_BYTES,
  validatePublicUrl,
} from '../src/worker/audit-web/ssrf';
import {
  audit,
  cardDocument,
  html,
  json,
  type Route,
  redirect,
  router,
  type Seen,
  sep2127Card,
  siteDeclaring,
  wireProbesTo,
} from './helpers/follow-fixtures';
import { stubFetch } from './helpers/stub-fetch';

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
    ['localhost with trailing dots', 'http://localhost../'],
    ['metadata hostname with trailing dots', 'http://metadata.google.internal../'],
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

describe('IPv4 ranges that hold no public audit target', () => {
  test.each([
    ['224.0.0.1', '224.0.0.0/4'],
    ['239.255.255.250', '224.0.0.0/4'],
    ['240.0.0.1', '240.0.0.0/4'],
    ['255.255.255.255', '240.0.0.0/4'],
    ['198.18.0.1', '198.18.0.0/15'],
    ['198.19.255.255', '198.18.0.0/15'],
    ['192.0.0.170', '192.0.0.0/24'],
    ['192.0.0.192', '192.0.0.0/24'],
    ['192.0.2.1', '192.0.2.0/24'],
    ['192.88.99.1', '192.88.99.0/24'],
    ['198.51.100.1', '198.51.100.0/24'],
    ['203.0.113.1', '203.0.113.0/24'],
    ['168.63.129.16', '168.63.129.16/32'],
  ])('refuses %s', (dotted, range) => {
    expect(blockedHostReason(dotted)).toBe(`ipv4 ${dotted} is in blocked range ${range}`);
  });

  test.each(['8.8.8.8', '1.1.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '168.63.129.17', '192.0.1.1'])(
    'allows the public address %s',
    (dotted) => {
      expect(blockedHostReason(dotted)).toBeNull();
    },
  );
});

describe('IPv6 spellings that carry an IPv4 address', () => {
  const FORMS: Array<[string, (hi: string, lo: string) => string]> = [
    ['NAT64 well-known 64:ff9b::/96', (hi, lo) => `[64:ff9b::${hi}:${lo}]`],
    ['IPv4-translated ::ffff:0:0:0/96', (hi, lo) => `[::ffff:0:${hi}:${lo}]`],
    ['6to4 2002::/16', (hi, lo) => `[2002:${hi}:${lo}::]`],
    ['ISATAP interface identifier', (hi, lo) => `[2607:f8b0::5efe:${hi}:${lo}]`],
    ['ISATAP interface identifier, universal bit set', (hi, lo) => `[2607:f8b0::200:5efe:${hi}:${lo}]`],
    ['IPv4-mapped ::ffff:0:0/96', (hi, lo) => `[::ffff:${hi}:${lo}]`],
    ['IPv4-compatible ::/96', (hi, lo) => `[::${hi}:${lo}]`],
  ];
  const BLOCKED: Array<[string, string, string, string]> = [
    ['169.254.169.254', 'a9fe', 'a9fe', '169.254.0.0/16'],
    ['100.100.100.200', '6464', '64c8', '100.64.0.0/10'],
    ['127.0.0.2', '7f00', '2', '127.0.0.0/8'],
    ['10.1.2.3', 'a01', '203', '10.0.0.0/8'],
    ['172.20.1.1', 'ac14', '101', '172.16.0.0/12'],
    ['192.168.0.5', 'c0a8', '5', '192.168.0.0/16'],
    ['0.1.2.3', '1', '203', '0.0.0.0/8'],
    ['224.0.0.1', 'e000', '1', '224.0.0.0/4'],
    ['198.18.0.1', 'c612', '1', '198.18.0.0/15'],
    ['192.0.0.170', 'c000', 'aa', '192.0.0.0/24'],
    ['168.63.129.16', 'a83f', '8110', '168.63.129.16/32'],
  ];

  describe.each(FORMS)('%s', (_form, spell) => {
    test.each(BLOCKED)('blocks %s, naming the carried address and its range', (dotted, hi, lo, range) => {
      expect(blockedHostReason(spell(hi, lo))).toBe(`ipv4-in-ipv6: ipv4 ${dotted} is in blocked range ${range}`);
    });

    test('a public address stays allowed', () => {
      expect(blockedHostReason(spell('808', '808'))).toBeNull();
    });
  });

  test.each([
    ['a dotted tail', '[64:ff9b::169.254.169.254]'],
    ['uppercase hex', '[64:FF9B::A9FE:A9FE]'],
    ['every zero written out', '[0064:ff9b:0000:0000:0000:0000:a9fe:a9fe]'],
    ['subnet and interface bits after a 6to4 address', '[2002:a9fe:a9fe:1::5]'],
  ])('reads the same address through %s', (_how, host) => {
    expect(blockedHostReason(host)).toBe('ipv4-in-ipv6: ipv4 169.254.169.254 is in blocked range 169.254.0.0/16');
  });

  test('a URL reaches the check in the form its parser writes', () => {
    expect(validatePublicUrl('https://[64:ff9b::169.254.169.254]/').ok).toBe(false);
    expect(validatePublicUrl('https://[2002:a9fe:a9fe::]/').ok).toBe(false);
    expect(validatePublicUrl('https://[2002:808:808::]/').ok).toBe(true);
  });
});

describe('IPv6 outside global unicast and its special-purpose blocks', () => {
  test.each([
    ['ipv6 NAT64 local-use (64:ff9b:1::/48)', '[64:ff9b:1::a9fe:a9fe]'],
    ['ipv6 NAT64 local-use (64:ff9b:1::/48)', '[64:ff9b:1::808:808]'],
    ['ipv6 NAT64 local-use (64:ff9b:1::/48)', '[64:ff9b:1:a9fe:a9:fe00:808:808]'],
    ['ipv6 NAT64 local-use (64:ff9b:1::/48)', '[64:ff9b:1:0:a9:fea9:fe00:0]'],
    ['ipv6 special-purpose (2001::/23)', '[2001:0:4136:e378:8000:63bf:5601:5601]'],
    ['ipv6 special-purpose (2001::/23)', '[2001:0:a9fe:a9fe::1]'],
    ['ipv6 special-purpose (2001::/23)', '[2001:1ff::1]'],
    ['ipv6 documentation (2001:db8::/32)', '[2001:db8::1]'],
    ['ipv6 documentation (3fff::/20)', '[3fff:fff::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[ff02::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[fec0::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[100::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[5f00::a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[1fff:ffff::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[4000::1]'],
    ['ipv6 outside global unicast (2000::/3)', '[64:ff9a::a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[64:ff9b:0:1::a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[64:ff9b:2::a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[::fffe:0:a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[::ffff:1:a9fe:a9fe]'],
    ['ipv6 outside global unicast (2000::/3)', '[::200:5efe:808:808]'],
    ['ipv6 unique-local (fc00::/7)', '[fd00:ec2::254]'],
    ['ipv6 link-local (fe80::/10)', '[fe80::5efe:808:808]'],
  ])('refuses as %s: %s', (reason, host) => {
    expect(blockedHostReason(host)).toBe(reason);
  });

  test.each([
    '[2606:4700:4700::1111]',
    '[2001:4860:4860::8888]',
    '[2a00:1450:4001::1]',
    '[2000::1]',
    '[2001:200::1]',
    '[2003:a9fe:a9fe::]',
    '[3fff:1000::1]',
  ])('allows the public address %s', (host) => {
    expect(blockedHostReason(host)).toBeNull();
    expect(validatePublicUrl(`https://${host}/`).ok).toBe(true);
  });

  test.each([
    '[64:ff9b::a9fe:a9fe]',
    '[64:ff9b:1::a9fe:a9fe]',
    '[64:ff9b:1:0:a9:fea9:fe00:0]',
    '[::ffff:0:a9fe:a9fe]',
    '[2002:a9fe:a9fe::]',
    '[2001:0:a9fe:a9fe::1]',
    '[2607:f8b0::5efe:a9fe:a9fe]',
    '[ff02::1]',
  ])('a redirect from a public target to %s is refused before it is sent', async (host) => {
    const fetched: string[] = [];
    const fetchImpl = stubFetch((url) => {
      fetched.push(url);
      return new Response(null, { status: 302, headers: { Location: `https://${host}/` } });
    });
    const resp = await guardedFetch('https://example.com/', {}, { fetchImpl });
    expect(fetched).toEqual(['https://example.com/']);
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('blocked');
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

  test('an http request URL is refused as insecure-scheme and never sent', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sent.push(url);
      return new Response('plaintext', { status: 200 });
    });
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const resp = await guardedFetch('http://example.com/llms.txt', { method }, { fetchImpl });
      expect({ method, status: resp.status, error: resp.error, refused: resp.refused }).toEqual({
        method,
        status: null,
        error: 'not requested: not https',
        refused: 'insecure-scheme',
      });
    }
    expect(sent).toEqual([]);
  });

  test('a redirect from https to http is not taken: the redirect is the answer, refused as insecure-scheme', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sent.push(url);
      if (url === 'https://example.com/a') return new Response(null, { status: 308, headers: { Location: '/b' } });
      if (url === 'https://example.com/b') {
        return new Response(null, { status: 301, headers: { Location: 'http://example.com/b' } });
      }
      return new Response('plaintext', { status: 200 });
    });
    const resp = await guardedFetch('https://example.com/a', {}, { fetchImpl });
    expect(sent).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(resp).toMatchObject({
      status: 301,
      headers: { location: 'http://example.com/b' },
      body: '',
      error: 'redirect refused: 301 to http://example.com/b: not https',
      refused: 'insecure-scheme',
    });
  });

  test('with redirects refused, a redirect answer is a failure naming its target and no hop is taken', async () => {
    const fetched: string[] = [];
    const fetchImpl = stubFetch((url) => {
      fetched.push(url);
      return url === 'https://example.com/mcp'
        ? new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.org/mcp' } })
        : new Response('final', { status: 200 });
    });
    const resp = await guardedFetch(
      'https://example.com/mcp',
      { method: 'POST' },
      { fetchImpl, refuseRedirects: true },
    );
    expect(fetched).toEqual(['https://example.com/mcp']);
    expect(resp.status).toBeNull();
    expect(resp.error).toBe('redirect refused: 307 to https://elsewhere.example.org/mcp');
  });

  test('with cross-origin redirects returned, same-origin hops are followed and a cross-origin redirect comes back as-is', async () => {
    const sent: Array<{ method: string; url: string; body: string }> = [];
    const fetchImpl = stubFetch((url, init) => {
      sent.push({ method: init?.method ?? 'GET', url, body: String(init?.body ?? '') });
      if (url === 'https://example.com/mcp') return new Response(null, { status: 308, headers: { Location: '/mcp/' } });
      if (url === 'https://example.com/mcp/') {
        return new Response(null, { status: 307, headers: { Location: 'https://victim.example/hook' } });
      }
      return new Response('replayed', { status: 200 });
    });
    const resp = await guardedFetch(
      'https://example.com/mcp',
      { method: 'POST', body: '{"method":"initialize"}' },
      { fetchImpl, crossOriginRedirects: 'return' },
    );
    expect(sent).toEqual([
      { method: 'POST', url: 'https://example.com/mcp', body: '{"method":"initialize"}' },
      { method: 'POST', url: 'https://example.com/mcp/', body: '{"method":"initialize"}' },
    ]);
    expect(resp.status).toBe(307);
    expect(resp.headers.location).toBe('https://victim.example/hook');
    expect(resp.error).toBeNull();
  });

  test('a redirect that keeps the host but changes the scheme or port leaves the origin', async () => {
    for (const location of ['http://example.com/mcp', 'https://example.com:8443/mcp']) {
      const sent: string[] = [];
      const fetchImpl = stubFetch((url) => {
        sent.push(url);
        return url === 'https://example.com/mcp'
          ? new Response(null, { status: 307, headers: { Location: location } })
          : new Response('replayed', { status: 200 });
      });
      const resp = await guardedFetch(
        'https://example.com/mcp',
        { method: 'POST' },
        { fetchImpl, crossOriginRedirects: 'return' },
      );
      expect({ location, sent, status: resp.status }).toEqual({
        location,
        sent: ['https://example.com/mcp'],
        status: 307,
      });
    }
  });

  test('with cross-origin redirects refused, a same-origin hop is followed and a cross-origin one is a failure naming its target', async () => {
    const sent: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sent.push(url);
      if (url === 'https://example.com/mcp') return new Response(null, { status: 308, headers: { Location: '/mcp/' } });
      if (url === 'https://example.com/mcp/') {
        return new Response(null, { status: 302, headers: { Location: 'https://victim.example/hook' } });
      }
      return new Response('replayed', { status: 200 });
    });
    const resp = await guardedFetch(
      'https://example.com/mcp',
      { method: 'POST' },
      { fetchImpl, crossOriginRedirects: 'refuse' },
    );
    expect(sent).toEqual(['https://example.com/mcp', 'https://example.com/mcp/']);
    expect(resp.status).toBeNull();
    expect(resp.error).toBe('redirect refused: 302 to https://victim.example/hook');
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

  test('maxBodyBytes 0 skips the body; a cap truncates oversized responses', async () => {
    const huge = 'x'.repeat(AUDIT_PROBE_MAX_BODY_BYTES + 2048);
    const skip = await guardedFetch(
      'https://example.com/',
      {},
      { fetchImpl: stubFetch(() => new Response(huge)), maxBodyBytes: STATUS_ONLY_BODY_BYTES },
    );
    expect(skip.status).toBe(200);
    expect(skip.body).toBe('');
    const capped = await guardedFetch(
      'https://example.com/',
      {},
      { fetchImpl: stubFetch(() => new Response(huge)), maxBodyBytes: AUDIT_PROBE_MAX_BODY_BYTES },
    );
    expect(capped.status).toBe(200);
    expect(capped.body.length).toBe(AUDIT_PROBE_MAX_BODY_BYTES);
  });

  test('a body stopped at its cap is flagged truncated; one that fits is not', async () => {
    const cap = 1024;
    const streamOf = (...chunks: number[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(120));
          controller.close();
        },
      });
    const read = (body: ReadableStream<Uint8Array> | string) =>
      guardedFetch('https://example.com/', {}, { fetchImpl: stubFetch(() => new Response(body)), maxBodyBytes: cap });

    const oneChunkOver = await read('x'.repeat(cap + 1));
    expect(oneChunkOver.body.length).toBe(cap);
    expect(oneChunkOver.truncated).toBe(true);

    const overAtChunkBoundary = await read(streamOf(cap, 16));
    expect(overAtChunkBoundary.body.length).toBe(cap);
    expect(overAtChunkBoundary.truncated).toBe(true);

    const exactlyCap = await read(streamOf(cap / 2, cap / 2));
    expect(exactlyCap.body.length).toBe(cap);
    expect('truncated' in exactlyCap).toBe(false);

    const underCap = await read('x'.repeat(cap - 1));
    expect('truncated' in underCap).toBe(false);
  });
});

describe('guardedFetch user-agent', () => {
  test('sends the audit user-agent when the caller sets none', async () => {
    let seen: Record<string, string> | undefined;
    await guardedFetch(
      'https://example.com/',
      {},
      {
        fetchImpl: stubFetch((_url, init) => {
          seen = init?.headers as Record<string, string> | undefined;
          return new Response('ok');
        }),
      },
    );
    expect(seen?.['user-agent']).toBe(AUDIT_USER_AGENT);
  });

  test('a caller-supplied user-agent wins, regardless of header casing', async () => {
    let seen: Record<string, string> | undefined;
    await guardedFetch(
      'https://example.com/',
      { headers: { 'User-Agent': 'custom-probe/1' } },
      {
        fetchImpl: stubFetch((_url, init) => {
          seen = init?.headers as Record<string, string> | undefined;
          return new Response('ok');
        }),
      },
    );
    expect(seen?.['User-Agent']).toBe('custom-probe/1');
    expect(seen?.['user-agent']).toBeUndefined();
  });
});

describe('follow phase egress', () => {
  function timeout(): never {
    const err = new Error('deadline exceeded');
    err.name = 'TimeoutError';
    throw err;
  }

  // One way each for the declared host to fail to confirm the endpoint.
  const collapses: Array<[string, (endpoint: string, host: string) => Record<string, Route>, Route?]> = [
    ['DNS failure', () => ({}), () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND'))],
    ['404 card', () => ({})],
    [
      'card naming another URL',
      (endpoint, host) => ({
        [`GET ${endpoint}/server-card`]: () => cardDocument(sep2127Card(`https://${host}/other`)),
      }),
    ],
    [
      'unparseable card',
      (endpoint) => ({ [`GET ${endpoint}/server-card`]: () => new Response('{"remotes": [', { status: 200 }) }),
    ],
    [
      'mismatched metadata',
      (_endpoint, host) => ({
        [`GET https://${host}/.well-known/oauth-protected-resource/mcp`]: () =>
          json({ resource: `https://${host}/elsewhere` }),
      }),
    ],
    [
      'metadata timeout',
      (_endpoint, host) => ({ [`GET https://${host}/.well-known/oauth-protected-resource/mcp`]: timeout }),
    ],
    ['HTML GET answer', (endpoint) => ({ [`GET ${endpoint}`]: () => html() })],
    [
      '405 with Allow: POST and no card',
      (endpoint) => ({
        [`GET ${endpoint}`]: () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } }),
      }),
    ],
  ];

  test('every reciprocity failure leaves the same trail entry and row reason, and no wire probe', async () => {
    const shapes = new Set<string>();
    for (const [index, [name, routes, fallback]] of collapses.entries()) {
      const host = `h${index + 1}.example.net`;
      const endpoint = `https://${host}/mcp`;
      const seen: Seen[] = [];
      const fetchImpl = router({ ...siteDeclaring(endpoint), ...routes(endpoint, host) }, seen, (init) => {
        const last = seen[seen.length - 1];
        if (fallback !== undefined && new URL(last.url).host === host) return fallback(init);
        return new Response('not found', { status: 404 });
      });
      const { scorecard } = await audit(fetchImpl);
      const initialize = scorecard.results.find((r) => r.id === 'mcp-initialize');
      const shape = JSON.stringify({ trail: scorecard.declared_hosts, initialize }).replaceAll(host, 'HOST');
      shapes.add(shape);
      expect({ name, wire: wireProbesTo(seen, host) }).toEqual({ name, wire: [] });
      expect({ name, reason: initialize?.na_reason }).toEqual({ name, reason: 'reciprocity-refused' });
    }
    expect(shapes.size).toBe(1);
  });

  test('no declared URL, redirect hop, or metadata location reaches a private destination', async () => {
    const privateUrls = [
      'http://127.0.0.1/mcp',
      'http://localhost/mcp',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata',
      'http://[::1]/mcp',
      'http://10.1.2.3/mcp',
    ];
    const isPrivate = (url: string) => privateUrls.some((p) => new URL(p).host === new URL(url).host);
    for (const target of privateUrls) {
      const viaDeclaration: Seen[] = [];
      await audit(router(siteDeclaring(target), viaDeclaration));
      const viaHop: Seen[] = [];
      await audit(
        router(
          {
            ...siteDeclaring('https://mcp.example.net/mcp'),
            'GET https://mcp.example.net/mcp': () => redirect(target),
          },
          viaHop,
        ),
      );
      const viaChallenge: Seen[] = [];
      await audit(
        router(
          {
            ...siteDeclaring('https://mcp.example.net/mcp'),
            'GET https://mcp.example.net/mcp': () =>
              new Response(null, {
                status: 401,
                headers: { 'www-authenticate': `Bearer resource_metadata="${target}"` },
              }),
          },
          viaChallenge,
        ),
      );
      for (const seen of [viaDeclaration, viaHop, viaChallenge]) {
        expect({ target, reached: seen.filter((r) => isPrivate(r.url)) }).toEqual({ target, reached: [] });
      }
    }
  });
});
