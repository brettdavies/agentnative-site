// Declared-host follow: control-bound reciprocity, the trail, and the
// endpoint of record, driven through the engine with a router keyed by
// full URL so every host the audit touches is visible.

import { describe, expect, test } from 'bun:test';
import { runWebAudit } from '../src/worker/audit-web/engine';
import type { DomainBudget } from '../src/worker/audit-web/follow';
import {
  aiCatalog,
  audit,
  cardDocument,
  cardEntry,
  followRegistry,
  html,
  initializeResult,
  json,
  type Route,
  redirect,
  requestsTo,
  router,
  row,
  type Seen,
  sep2127Card,
  siteDeclaring,
  TARGET,
  wireProbesTo,
} from './helpers/follow-fixtures';
import { stubFetch } from './helpers/stub-fetch';

const ENDPOINT = 'https://mcp.example.net/mcp';
const NET = 'mcp.example.net';

describe('follow: admission by an artifact on the endpoint host', () => {
  test('a card at <endpoint>/server-card naming the endpoint makes it the endpoint of record, with no wire probe before that GET', async () => {
    const seen: Seen[] = [];
    const { events, scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(events.find((e) => e.type === 'discovery')).toMatchObject({ endpoint: ENDPOINT });
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: NET });
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/mcp.json',
        kind: 'mcp-endpoint',
        url: ENDPOINT,
        host: NET,
        outcome: 'followed',
        admitted_by: 'card',
      },
    ]);
    const cardGet = seen.findIndex((r) => r.url === `${ENDPOINT}/server-card`);
    const firstWire = seen.findIndex((r) => r.method === 'POST' && r.url === ENDPOINT);
    expect(cardGet).toBeGreaterThan(-1);
    expect(firstWire).toBeGreaterThan(cardGet);
  });

  test("an entry in the endpoint host's own AI catalog admits it", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET https://${NET}/.well-known/ai-catalog.json`]: () =>
            aiCatalog(cardEntry({ data: sep2127Card(ENDPOINT) })),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'followed', admitted_by: 'ai-catalog' });
  });

  test('RFC 9728 metadata whose resource equals the endpoint admits it', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET https://${NET}/.well-known/oauth-protected-resource/mcp`]: () => json({ resource: ENDPOINT }),
          [`GET https://${NET}/.well-known/oauth-protected-resource/anc-web-audit-no-such-resource`]: () =>
            new Response('not found', { status: 404 }),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'followed', admitted_by: 'metadata' });
  });

  test('a card naming a different URL refuses the endpoint, and its rows name the declared host', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(`https://${NET}/other`)),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBeNull();
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'reciprocity-refused' });
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'reciprocity-refused',
      evidence: ENDPOINT,
      host: NET,
    });
    expect(wireProbesTo(seen, NET)).toEqual([]);
  });

  test("the audited site's own AI catalog naming an off-origin endpoint confirms nothing", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(cardEntry({ data: sep2127Card(ENDPOINT) })),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/ai-catalog.json#/entries/0/data',
        kind: 'mcp-endpoint',
        url: ENDPOINT,
        host: NET,
        outcome: 'reciprocity-refused',
      },
    ]);
    expect(wireProbesTo(seen, NET)).toEqual([]);
  });

  test('each admission route records how it confirmed the endpoint', async () => {
    const routes: Array<[string, Record<string, Route>]> = [
      ['card', { [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)) }],
      [
        'ai-catalog',
        {
          [`GET https://${NET}/.well-known/ai-catalog.json`]: () => aiCatalog(cardEntry({ url: '/cards/mcp' })),
          [`GET https://${NET}/cards/mcp`]: () => cardDocument(sep2127Card(ENDPOINT)),
        },
      ],
      ['metadata', { [`GET https://${NET}/.well-known/oauth-protected-resource`]: () => json({ resource: ENDPOINT }) }],
    ];
    for (const [admittedBy, artifact] of routes) {
      const { scorecard } = await audit(router({ ...siteDeclaring(ENDPOINT), ...artifact }, []));
      expect(scorecard.declared_hosts?.[0]?.admitted_by).toBe(admittedBy);
    }
  });
});

describe('follow: RFC 9728 metadata', () => {
  const challengeTo =
    (metadataUrl: string): Route =>
    () =>
      new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` } });

  test('mismatched resource, a metadata URL on another host, a private one, and a timed-out fetch each refuse', async () => {
    const cases: Array<{ name: string; routes: Record<string, Route>; never?: string }> = [
      {
        name: 'mismatched resource',
        routes: {
          [`GET https://${NET}/.well-known/oauth-protected-resource/mcp`]: () =>
            json({ resource: `https://${NET}/other` }),
        },
      },
      {
        name: 'metadata on another host',
        routes: {
          [`GET ${ENDPOINT}`]: challengeTo('https://auth.example.org/.well-known/oauth-protected-resource'),
          'GET https://auth.example.org/.well-known/oauth-protected-resource': () => json({ resource: ENDPOINT }),
        },
        never: 'auth.example.org',
      },
      {
        name: 'private metadata URL',
        routes: { [`GET ${ENDPOINT}`]: challengeTo('https://10.0.0.7/.well-known/oauth-protected-resource') },
        never: '10.0.0.7',
      },
      {
        name: 'timed-out metadata',
        routes: {
          [`GET https://${NET}/.well-known/oauth-protected-resource/mcp`]: () => {
            const err = new Error('deadline exceeded');
            err.name = 'TimeoutError';
            throw err;
          },
        },
      },
    ];
    for (const { name, routes, never } of cases) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(router({ ...siteDeclaring(ENDPOINT), ...routes }, seen));
      expect({ name, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({
        name,
        outcome: 'reciprocity-refused',
      });
      expect({ name, wire: wireProbesTo(seen, NET) }).toEqual({ name, wire: [] });
      if (never !== undefined) expect({ name, never: requestsTo(seen, never) }).toEqual({ name, never: [] });
    }
  });

  test('a gateway echoing any path-suffixed metadata confirms nothing, and no wire probe follows', async () => {
    const seen: Seen[] = [];
    const prefix = `https://${NET}/.well-known/oauth-protected-resource`;
    const { scorecard } = await audit(
      router(siteDeclaring(ENDPOINT), seen, (init) => {
        const url = seen[seen.length - 1].url;
        void init;
        return url.startsWith(`${prefix}/`)
          ? json({ resource: `https://${NET}${url.slice(prefix.length)}` })
          : new Response('not found', { status: 404 });
      }),
    );
    expect(scorecard.declared_hosts?.[0]?.outcome).toBe('reciprocity-refused');
    expect(seen.some((r) => r.url.endsWith('/oauth-protected-resource/anc-web-audit-no-such-resource'))).toBe(true);
    expect(wireProbesTo(seen, NET)).toEqual([]);
  });

  test('a root-path endpoint admitted by root metadata sends no differential GET', async () => {
    const seen: Seen[] = [];
    const root = `https://${NET}/`;
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(root),
          [`GET https://${NET}/.well-known/oauth-protected-resource`]: () => json({ resource: root }),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(root);
    expect(seen.some((r) => r.url.includes('anc-web-audit-no-such-resource'))).toBe(false);
  });

  test('metadata whose resource omits the trailing slash the card carries still admits the endpoint', async () => {
    const root = `https://${NET}/`;
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(root),
          [`GET ${root}`]: () =>
            new Response(null, {
              status: 401,
              headers: {
                'www-authenticate': `Bearer resource_metadata="https://${NET}/.well-known/oauth-protected-resource"`,
              },
            }),
          [`GET https://${NET}/.well-known/oauth-protected-resource`]: () => json({ resource: `https://${NET}` }),
        },
        [],
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(root);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'followed', admitted_by: 'metadata' });
  });
});

describe('follow: exact URL matching', () => {
  test('a card naming https://h/mcp admits neither a longer path, another scheme, nor another port', async () => {
    const declared = [`https://${NET}/mcp/other`, `http://${NET}/mcp`, `https://${NET}:8443/mcp`];
    for (const endpoint of declared) {
      const seen: Seen[] = [];
      const suffix = `${endpoint.replace(/\/$/, '')}/server-card`;
      const { scorecard } = await audit(
        router({ ...siteDeclaring(endpoint), [`GET ${suffix}`]: () => cardDocument(sep2127Card(ENDPOINT)) }, seen),
      );
      expect({ endpoint, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({
        endpoint,
        outcome: 'reciprocity-refused',
      });
      expect(seen.filter((r) => r.method === 'POST' || r.method === 'OPTIONS').map((r) => r.url)).not.toContain(
        endpoint,
      );
    }
  });
});

describe('follow: documents over their cap', () => {
  const oversized = (): Response =>
    new Response(JSON.stringify({ ...sep2127Card(ENDPOINT), padding: 'x'.repeat(300 * 1024) }), {
      status: 200,
      headers: { 'content-type': 'application/mcp-server-card+json' },
    });

  test('an endpoint card over 256 KiB reads as no card, so the endpoint is refused', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router({ ...siteDeclaring(ENDPOINT), [`GET ${ENDPOINT}/server-card`]: oversized }, seen),
    );
    expect(scorecard.declared_hosts?.[0]?.outcome).toBe('reciprocity-refused');
    expect(wireProbesTo(seen, NET)).toEqual([]);
  });

  test('an off-origin card document over 256 KiB collapses to reciprocity-refused', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(cardEntry({ url: 'https://cards.example.org/mcp-card' })),
          'GET https://cards.example.org/mcp-card': oversized,
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/ai-catalog.json#/entries/0',
        kind: 'card-document',
        url: 'https://cards.example.org/mcp-card',
        host: 'cards.example.org',
        outcome: 'reciprocity-refused',
      },
    ]);
    expect(requestsTo(seen, NET)).toEqual([]);
  });
});

describe('follow: catalog entries on the endpoint host', () => {
  test('an entry whose card URL sits on a third host is refused with no request to that host', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET https://${NET}/.well-known/ai-catalog.json`]: () =>
            aiCatalog(cardEntry({ url: 'https://third.example.org/card' })),
          'GET https://third.example.org/card': () => cardDocument(sep2127Card(ENDPOINT)),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.[0]?.outcome).toBe('reciprocity-refused');
    expect(requestsTo(seen, 'third.example.org')).toEqual([]);
  });

  test('a card document the site declares off its origin is read, and the endpoint it names is followed', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(cardEntry({ url: 'https://cards.example.org/mcp-card' })),
          'GET https://cards.example.org/mcp-card': () => cardDocument(sep2127Card(ENDPOINT)),
          [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/ai-catalog.json#/entries/0',
        kind: 'card-document',
        url: 'https://cards.example.org/mcp-card',
        host: 'cards.example.org',
        outcome: 'followed',
      },
      {
        surface: 'https://cards.example.org/mcp-card',
        kind: 'mcp-endpoint',
        url: ENDPOINT,
        host: NET,
        outcome: 'followed',
        admitted_by: 'card',
      },
    ]);
  });
});

describe('follow: documents read once', () => {
  test('a card document that is also the card under its own endpoint is requested once', async () => {
    const card = `${ENDPOINT}/server-card`;
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () => aiCatalog(cardEntry({ url: card })),
          [`GET ${card}`]: () => cardDocument(sep2127Card(ENDPOINT)),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(seen.filter((r) => r.url === card)).toHaveLength(1);
  });
});

describe('follow: the endpoint of record', () => {
  test('a card with three remotes yields one endpoint of record and two not-followed entries', async () => {
    const remotes = [ENDPOINT, 'https://mcp2.example.net/mcp', 'https://mcp3.example.net/mcp'];
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/mcp/server-card.json': () => json(sep2127Card(...remotes)),
          ...Object.fromEntries(remotes.map((url) => [`GET ${url}/server-card`, () => cardDocument(sep2127Card(url))])),
          [`POST ${ENDPOINT}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts?.map((e) => [e.url, e.outcome, e.reason])).toEqual([
      [ENDPOINT, 'followed', undefined],
      ['https://mcp2.example.net/mcp', 'not-followed', 'beyond-endpoint-of-record'],
      ['https://mcp3.example.net/mcp', 'not-followed', 'beyond-endpoint-of-record'],
    ]);
    expect(requestsTo(seen, 'mcp2.example.net')).toEqual([]);
  });

  test("the audited site's own endpoint wins over an admitted declared one, which is never wire-probed", async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          'POST https://example.com/mcp': () => initializeResult(),
          [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe('https://example.com/mcp');
    expect(scorecard.declared_hosts?.[0]).toMatchObject({
      outcome: 'not-followed',
      reason: 'beyond-endpoint-of-record',
    });
    expect(wireProbesTo(seen, NET)).toEqual([]);
  });
});

describe('follow: caps and budgets', () => {
  test('five distinct declared hosts hit the cap of 4: the fifth is budget-exceeded and nothing is sent to it', async () => {
    const hosts = ['h1', 'h2', 'h3', 'h4'].map((h) => `${h}.example.net`);
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(...hosts.map((h) => cardEntry({ data: sep2127Card(`https://${h}/mcp`) }))),
          'GET https://example.com/.well-known/mcp.json': () => json({ mcp_endpoint: 'https://h5.example.net/mcp' }),
          ...Object.fromEntries(hosts.map((h) => [`GET https://${h}/mcp`, () => redirect('http://10.0.0.1/mcp')])),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.map((e) => [e.host, e.outcome, e.cause])).toEqual([
      ...hosts.map((h) => [h, 'blocked', undefined]),
      ['h5.example.net', 'budget-exceeded', 'per-audit-cap'],
    ]);
    expect(requestsTo(seen, 'h5.example.net')).toEqual([]);
  });

  test('a declared host that never answers spends the slice; the audit completes and the rows read budget-exceeded', async () => {
    let clock = 1_000_000;
    const seen: Seen[] = [];
    const hang = (_init?: RequestInit): Promise<Response> => {
      clock += 7_000;
      return new Promise<Response>((_resolve, reject) =>
        _init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    };
    const fetchImpl = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      seen.push({ method, url });
      if (new URL(url).host === NET) return hang(init);
      const route = siteDeclaring(ENDPOINT)[`${method} ${url}`];
      return route ? route(init) : new Response('not found', { status: 404 });
    });
    const { scorecard, complete } = await audit(fetchImpl, { now: () => clock, perCheckTimeoutMs: 50 });
    expect(complete).toBe(true);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'budget-exceeded', cause: 'slice' });
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-budget-exceeded',
      host: NET,
    });
    expect(requestsTo(seen, NET)).toHaveLength(1);
  });

  test('a declared host redirecting to a domain at its hourly cap is budget-exceeded with nothing sent there', async () => {
    const seen: Seen[] = [];
    const reserved: string[] = [];
    const budget: DomainBudget = {
      keyOf: (hostname) => hostname.split('.').slice(-2).join('.'),
      reserve: async (key) => {
        reserved.push(key);
        return key !== 'capped.org';
      },
    };
    const { scorecard } = await audit(
      router({ ...siteDeclaring(ENDPOINT), [`GET ${ENDPOINT}`]: () => redirect('https://mcp.capped.org/mcp') }, seen),
      { domainBudget: budget },
    );
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(requestsTo(seen, 'mcp.capped.org')).toEqual([]);
    expect(reserved).toEqual(['example.net', 'capped.org']);
  });
});

describe('follow: redirects', () => {
  test('a declared URL redirecting to a private address is refused on the hop and recorded blocked', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        { ...siteDeclaring(ENDPOINT), [`GET ${ENDPOINT}`]: () => redirect('http://169.254.169.254/latest') },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'blocked' });
    expect(requestsTo(seen, '169.254.169.254')).toEqual([]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ na_reason: 'declared-host-unreachable', host: NET });
  });

  test('a redirect to another public host whose card names itself pins the final URL and records both', async () => {
    const final = 'https://mcp.example.org/mcp';
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}`]: () => redirect(final),
          [`GET ${final}/server-card`]: () => cardDocument(sep2127Card(final)),
          [`POST ${final}`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(final);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ url: ENDPOINT, final_url: final, outcome: 'followed' });
    expect(wireProbesTo(seen, NET)).toEqual([]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: 'mcp.example.org' });
  });

  test('the redirect target counts toward the host cap', async () => {
    // Three hosts settle in one request each, so the request cap is far
    // off and only the host cap can refuse the redirect target.
    const blocked = ['h1', 'h2', 'h3'].map((h) => `https://${h}.example.net/mcp`);
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(...blocked.map((url) => cardEntry({ data: sep2127Card(url) }))),
          'GET https://example.com/.well-known/mcp.json': () => json({ mcp_endpoint: ENDPOINT }),
          ...Object.fromEntries(blocked.map((url) => [`GET ${url}`, () => redirect('http://10.0.0.1/mcp')])),
          [`GET ${ENDPOINT}`]: () => redirect('https://mcp.example.org/mcp'),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.map((e) => e.outcome)).toEqual([
      'blocked',
      'blocked',
      'blocked',
      'budget-exceeded',
    ]);
    expect(scorecard.declared_hosts?.[3]).toMatchObject({ url: ENDPOINT, cause: 'per-audit-cap' });
    expect(requestsTo(seen, 'mcp.example.org')).toEqual([]);
  });

  test('a chain of hops is refused at the second hop', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}`]: () => redirect('https://hop1.example.org/mcp'),
          'GET https://hop1.example.org/mcp': () => redirect('https://hop2.example.org/mcp'),
          'GET https://hop2.example.org/mcp': () => redirect('https://hop3.example.org/mcp'),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.[0]).toMatchObject({
      final_url: 'https://hop1.example.org/mcp',
      outcome: 'reciprocity-refused',
    });
    expect(requestsTo(seen, 'hop2.example.org')).toEqual([]);
  });

  test('an admitted endpoint answering a wire probe with a 307 is not followed', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}/server-card`]: () => cardDocument(sep2127Card(ENDPOINT)),
          [`POST ${ENDPOINT}`]: () => redirect('https://elsewhere.example.org/mcp', 307),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(requestsTo(seen, 'elsewhere.example.org')).toEqual([]);
    expect(row(scorecard, 'mcp-initialize').status).toBe('error');
  });

  test('a card location answering 302 to another host serving a matching card confirms nothing', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(ENDPOINT),
          [`GET ${ENDPOINT}/server-card`]: () => redirect('https://cards.example.org/card'),
          'GET https://cards.example.org/card': () => cardDocument(sep2127Card(ENDPOINT)),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.[0]?.outcome).toBe('reciprocity-refused');
    expect(seen.filter((r) => r.method === 'POST' && new URL(r.url).host !== 'example.com')).toEqual([]);
    expect(requestsTo(seen, 'cards.example.org')).toEqual([]);
  });
});

describe('follow: hosts that are never requested', () => {
  test("a declaration naming one of the auditor's own paths is refused before reciprocity; the canonical MCP path is admitted", async () => {
    const tokenPath = 'https://anc.dev/api/web-rescore?token=x';
    const seen: Seen[] = [];
    const refused = await audit(router(siteDeclaring(tokenPath), seen));
    expect(refused.scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'not-followed', reason: 'self-path' });
    expect(requestsTo(seen, 'anc.dev')).toEqual([]);

    const canonical = 'https://anc.dev/mcp';
    const admitted = await audit(
      router(
        {
          ...siteDeclaring(canonical),
          [`GET ${canonical}/server-card`]: () => cardDocument(sep2127Card(canonical)),
          [`POST ${canonical}`]: () => initializeResult(),
        },
        [],
      ),
    );
    expect(admitted.scorecard.mcp_endpoint).toBe(canonical);
  });

  test('IPv4 and IPv6 literal endpoints are never fetched and are recorded blocked', async () => {
    for (const literal of ['https://93.184.216.34/mcp', 'https://[2606:2800:220:1::]/mcp']) {
      const seen: Seen[] = [];
      const { scorecard } = await audit(router(siteDeclaring(literal), seen));
      expect({ literal, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({ literal, outcome: 'blocked' });
      expect(requestsTo(seen, new URL(literal).host)).toEqual([]);
    }
  });

  test('with the follow flag false no off-origin request is made and the rows read follow-disabled', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(router(siteDeclaring(ENDPOINT), seen), { followDeclarations: false });
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com' && !r.url.includes('dns'))).toEqual([]);
    expect(scorecard.follow_declarations).toBe(false);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ outcome: 'not-followed', reason: 'follow-disabled' });
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'follow-disabled' });
  });
});

describe('follow: workers.dev hosts', () => {
  test('a declared workers.dev host whose fetches fail at the edge produces no broken row', async () => {
    const edge = 'https://blocked.acct.workers.dev/mcp';
    const { scorecard } = await audit(
      router(siteDeclaring(edge), [], () => new Response('error code: 1042', { status: 530 })),
    );
    expect(scorecard.results.some((r) => r.status === 'broken')).toBe(false);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'reciprocity-refused' });
  });

  test('a third-party workers.dev host is followed', async () => {
    const worker = 'https://mcp.vendor.workers.dev/mcp';
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(worker),
          [`GET ${worker}/server-card`]: () => cardDocument(sep2127Card(worker)),
          [`POST ${worker}`]: () => initializeResult(),
        },
        [],
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(worker);
    expect(row(scorecard, 'mcp-initialize').status).toBe('pass');
  });
});

describe('follow: sequencing and determinism', () => {
  const STRIPE_SITE = 'https://stripe.example/';
  const STRIPE_MCP = 'https://mcp.stripe.example/';

  test('the discovery event carries the followed endpoint and precedes the first result', async () => {
    const { events } = await audit(
      router(
        {
          [`GET ${STRIPE_SITE}`]: () => html(),
          [`GET ${STRIPE_SITE}.well-known/mcp/server-card.json`]: () =>
            json({ name: 'stripe', transport: { type: 'streamable-http', url: STRIPE_MCP } }),
          [`GET ${STRIPE_MCP}`]: () =>
            new Response(null, {
              status: 401,
              headers: {
                'www-authenticate': `Bearer resource_metadata="${STRIPE_MCP}.well-known/oauth-protected-resource"`,
              },
            }),
          [`GET ${STRIPE_MCP}.well-known/oauth-protected-resource`]: () =>
            json({ resource: 'https://mcp.stripe.example', authorization_servers: ['https://access.stripe.example'] }),
        },
        [],
      ),
      { url: STRIPE_SITE },
    );
    const discoveryAt = events.findIndex((e) => e.type === 'discovery');
    const firstResult = events.findIndex((e) => e.type === 'result');
    expect(events[discoveryAt]).toMatchObject({ endpoint: STRIPE_MCP });
    expect(discoveryAt).toBeLessThan(firstResult);
  });

  test('the trail follows declaration order whatever order the hosts answer in', async () => {
    const cards = ['https://c1.example.org/card', 'https://c2.example.org/card', 'https://c3.example.org/card'];
    const run = async (delays: number[]) => {
      const fetchImpl = stubFetch(async (url, init) => {
        const method = init?.method ?? 'GET';
        const at = cards.indexOf(url);
        if (at !== -1) {
          await new Promise((resolve) => setTimeout(resolve, delays[at]));
          return cardDocument(sep2127Card(`https://m${at + 1}.example.org/mcp`));
        }
        if (url === 'https://example.com/.well-known/ai-catalog.json') {
          return aiCatalog(...cards.map((card) => cardEntry({ url: card })));
        }
        if (method === 'GET' && url === TARGET) return html();
        return new Response('not found', { status: 404 });
      });
      return (await audit(fetchImpl)).scorecard;
    };
    const first = await run([30, 1, 15]);
    const second = await run([1, 30, 15]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.declared_hosts?.map((e) => e.url)).toEqual([
      cards[0],
      'https://m1.example.org/mcp',
      cards[1],
      'https://m2.example.org/mcp',
      cards[2],
      'https://m3.example.org/mcp',
    ]);
  });

  test('hanging POSTs on the audited site and a slow declared host cost the longer phase, not their sum', async () => {
    const hangUntilAbort = (init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const fetchImpl = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === 'https://example.com/mcp') return hangUntilAbort(init);
      if (url === `${ENDPOINT}/server-card`) return hangUntilAbort(init);
      const route = siteDeclaring(ENDPOINT)[`${method} ${url}`];
      return route ? route(init) : new Response('not found', { status: 404 });
    });
    const started = Date.now();
    const { complete } = await audit(fetchImpl, { perCheckTimeoutMs: 600 });
    const elapsed = Date.now() - started;
    expect(complete).toBe(true);
    // Each phase hangs for one 600 ms timeout and no endpoint survives, so
    // the waves send nothing that hangs: about 600 ms side by side, at
    // least 1200 ms one after the other.
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1_000);
  });

  test('a site that answered nothing starts no request to the hosts it declares', async () => {
    const seen: Seen[] = [];
    const events: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      seen.push({ method: init?.method ?? 'GET', url });
      if (new URL(url).host === 'example.com') throw new TypeError('connection refused');
      return cardDocument(sep2127Card(ENDPOINT));
    });
    for await (const event of runWebAudit({ url: TARGET, registry: followRegistry(), fetchOptions: { fetchImpl } })) {
      events.push(event.type);
    }
    expect(events).toContain('unreachable');
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com' && !r.url.includes('dns'))).toEqual([]);
  });
});
