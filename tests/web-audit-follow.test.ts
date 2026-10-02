// Declared-host follow: control-bound reciprocity, the trail, and the
// endpoint of record, driven through the engine with a router keyed by
// full URL so every host the audit touches is visible.

import { describe, expect, test } from 'bun:test';
import { resultLine } from '../src/shared/web-audit-result-line';
import { instrumentAuditEvents } from '../src/worker/audit-web/audit-log';
import { declaredDomainBudget, registrableDomainOf } from '../src/worker/audit-web/domain-budget';
import { runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET, type DomainBudget } from '../src/worker/audit-web/follow-requests';
import { endpointRedirects, mcpEndpointRedirects } from '../src/worker/audit-web/handlers/shared';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';
import { budgetKeyPrefix, memoryKv, memoryRateLimit } from './helpers/domain-budget-fakes';
import {
  aiCatalog,
  audit,
  cardDocument,
  cardEntry,
  DISCOVERY,
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
import { captureLogs } from './helpers/log-capture';
import { stubFetch } from './helpers/stub-fetch';

const ENDPOINT = 'https://mcp.example.net/mcp';
const NET = 'mcp.example.net';

const hangUntilAbort = (init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  );

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

  test('mismatched resource, a metadata URL on another host, a plain-http one, a private one, and a timed-out fetch each refuse', async () => {
    // `never` is a URL prefix no request may start with.
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
        never: 'https://auth.example.org/',
      },
      {
        name: 'plain-http metadata URL on the endpoint host',
        routes: {
          [`GET ${ENDPOINT}`]: challengeTo(`http://${NET}/.well-known/oauth-protected-resource`),
          [`GET http://${NET}/.well-known/oauth-protected-resource`]: () => json({ resource: ENDPOINT }),
        },
        never: `http://${NET}/`,
      },
      {
        name: 'private metadata URL',
        routes: { [`GET ${ENDPOINT}`]: challengeTo('https://10.0.0.7/.well-known/oauth-protected-resource') },
        never: 'https://10.0.0.7/',
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
      if (never !== undefined) {
        expect({ name, never: seen.filter((r) => r.url.startsWith(never)) }).toEqual({ name, never: [] });
      }
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

describe('follow: card document hosts that give no response', () => {
  test('a card host that refuses the connection, fails DNS, times out, or is answered for by the edge records unreachable, and the rows name it', async () => {
    const dead = 'https://dead.example.org/card';
    // A Worker's fetch to a host that does not resolve or never answers
    // returns Cloudflare's own 530 or 52x rather than throwing.
    const failures: Array<[string, Route]> = [
      [
        'connection refused',
        () => {
          throw new TypeError('connection refused');
        },
      ],
      [
        'dns failure',
        () => {
          throw new TypeError('getaddrinfo ENOTFOUND dead.example.org');
        },
      ],
      [
        'timed out',
        () => {
          const err = new Error('deadline exceeded');
          err.name = 'TimeoutError';
          throw err;
        },
      ],
      ['edge 530, origin DNS error', () => new Response('error code: 1016', { status: 530 })],
      ['edge 522, connection timed out', () => new Response('error code: 522', { status: 522 })],
    ];
    for (const [name, failure] of failures) {
      const { scorecard } = await audit(
        router(
          {
            [`GET ${TARGET}`]: () => html(),
            'GET https://example.com/.well-known/ai-catalog.json': () => aiCatalog(cardEntry({ url: dead })),
            [`GET ${dead}`]: failure,
          },
          [],
        ),
      );
      expect({ name, trail: scorecard.declared_hosts }).toEqual({
        name,
        trail: [
          {
            surface: '/.well-known/ai-catalog.json#/entries/0',
            kind: 'card-document',
            url: dead,
            host: 'dead.example.org',
            outcome: 'unreachable',
          },
        ],
      });
      expect({ name, row: row(scorecard, 'mcp-initialize') }).toMatchObject({
        name,
        row: { status: 'n_a', na_reason: 'declared-host-unreachable', host: 'dead.example.org' },
      });
    }
  });

  test('a card host that answers with no card still reads reciprocity-refused', async () => {
    const cards = 'https://cards.example.org/card';
    const answers: Array<[string, Route]> = [
      ['404', () => new Response('not found', { status: 404 })],
      [
        'unparseable',
        () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      ],
      ['names no endpoint', () => cardDocument({ name: 'net.example/mcp', version: '1.0.0' })],
    ];
    for (const [name, answer] of answers) {
      const { scorecard } = await audit(
        router(
          {
            [`GET ${TARGET}`]: () => html(),
            'GET https://example.com/.well-known/ai-catalog.json': () => aiCatalog(cardEntry({ url: cards })),
            [`GET ${cards}`]: answer,
          },
          [],
        ),
      );
      expect({ name, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({
        name,
        outcome: 'reciprocity-refused',
      });
      expect({ name, reason: row(scorecard, 'mcp-initialize').na_reason }).toEqual({
        name,
        reason: 'reciprocity-refused',
      });
    }
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

describe('follow: card documents and the endpoint of record', () => {
  const catalogDeclaring = (...entries: unknown[]): Record<string, Route> => ({
    [`GET ${TARGET}`]: () => html(),
    'GET https://example.com/.well-known/ai-catalog.json': () => aiCatalog(...entries),
  });
  const confirmable = (endpoint: string): Record<string, Route> => ({
    [`GET ${endpoint}/server-card`]: () => cardDocument(sep2127Card(endpoint)),
    [`POST ${endpoint}`]: () => initializeResult(),
  });

  test('an endpoint declared ahead of a card host that never answers is admitted', async () => {
    const slow = 'https://slow.example.org/card';
    let clock = 1_000_000;
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...catalogDeclaring(cardEntry({ data: sep2127Card(ENDPOINT) }), cardEntry({ url: slow })),
          ...confirmable(ENDPOINT),
          [`GET ${slow}`]: (init) => {
            clock += 7_000;
            return hangUntilAbort(init);
          },
        },
        seen,
      ),
      { now: () => clock, perCheckTimeoutMs: 50 },
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ url: ENDPOINT, outcome: 'followed', admitted_by: 'card' });
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: NET });
  });

  test('a card document declared after the admitted endpoint is never requested; one after a refused endpoint is read in place', async () => {
    const cards = 'https://cards.example.org/card';
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...catalogDeclaring(cardEntry({ data: sep2127Card(ENDPOINT) }), cardEntry({ url: cards })),
          ...confirmable(ENDPOINT),
          [`GET ${cards}`]: () => cardDocument(sep2127Card('https://mcp2.example.org/mcp')),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(ENDPOINT);
    expect(scorecard.declared_hosts?.map((e) => [e.url, e.outcome, e.reason])).toEqual([
      [ENDPOINT, 'followed', undefined],
      [cards, 'not-followed', 'beyond-endpoint-of-record'],
    ]);
    expect(requestsTo(seen, 'cards.example.org')).toEqual([]);

    const second = 'https://mcp2.example.org/mcp';
    const inPlace = await audit(
      router(
        {
          ...catalogDeclaring(cardEntry({ data: sep2127Card(ENDPOINT) }), cardEntry({ url: cards })),
          [`GET ${cards}`]: () => cardDocument(sep2127Card(second)),
          ...confirmable(second),
        },
        [],
      ),
    );
    expect(inPlace.scorecard.mcp_endpoint).toBe(second);
    expect(inPlace.scorecard.declared_hosts?.map((e) => [e.url, e.outcome])).toEqual([
      [ENDPOINT, 'reciprocity-refused'],
      [cards, 'followed'],
      [second, 'followed'],
    ]);
  });

  test('card documents redirecting to new hosts take the last host slot in declaration order, whichever answers first', async () => {
    const cards = ['https://c1.example.org/card', 'https://c2.example.org/card', 'https://c3.example.org/card'];
    const hops = ['https://r1.example.org/card', 'https://r2.example.org/card'];
    const run = async (delays: number[]) => {
      const seen: Seen[] = [];
      const fetchImpl = stubFetch(async (url, init) => {
        const method = init?.method ?? 'GET';
        seen.push({ method, url });
        const at = cards.indexOf(url);
        if (at !== -1) {
          await new Promise((resolve) => setTimeout(resolve, delays[at]));
          return at < hops.length ? redirect(hops[at]) : new Response('not found', { status: 404 });
        }
        const route = catalogDeclaring(...cards.map((card) => cardEntry({ url: card })))[`${method} ${url}`];
        return route ? route(init) : new Response('not found', { status: 404 });
      });
      return { scorecard: (await audit(fetchImpl)).scorecard, seen };
    };
    const first = await run([30, 1, 1]);
    const second = await run([1, 30, 1]);
    expect(JSON.stringify(first.scorecard)).toBe(JSON.stringify(second.scorecard));
    expect(first.scorecard.declared_hosts?.map((e) => [e.url, e.final_url, e.outcome, e.cause])).toEqual([
      [cards[0], hops[0], 'reciprocity-refused', undefined],
      [cards[1], undefined, 'budget-exceeded', 'per-audit-cap'],
      [cards[2], undefined, 'reciprocity-refused', undefined],
    ]);
    for (const { seen } of [first, second]) expect(requestsTo(seen, 'r2.example.org')).toEqual([]);
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

  test('three endpoints on one host stop at the request cap: twelve requests reach it and the third is budget-exceeded', async () => {
    // One host keeps the host cap out of reach. The first endpoint's
    // reciprocity costs nine requests (its GET, its card, the host catalog,
    // four catalog cards, two metadata locations); the second reuses the
    // catalog, its cards, and the root metadata, so it costs three.
    const endpoints = ['mcp', 'mcp2', 'mcp3'].map((path) => `https://${NET}/${path}`);
    const cards = [1, 2, 3, 4].map((n) => `https://${NET}/cards/${n}`);
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(...endpoints.map((url) => cardEntry({ data: sep2127Card(url) }))),
          [`GET https://${NET}/.well-known/ai-catalog.json`]: () =>
            aiCatalog(...cards.map((url) => cardEntry({ url }))),
          ...Object.fromEntries(
            cards.map((url) => [`GET ${url}`, () => cardDocument(sep2127Card(`https://${NET}/other`))]),
          ),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.map((e) => [e.url, e.outcome, e.cause])).toEqual([
      [endpoints[0], 'reciprocity-refused', undefined],
      [endpoints[1], 'reciprocity-refused', undefined],
      [endpoints[2], 'budget-exceeded', 'per-audit-cap'],
    ]);
    expect(requestsTo(seen, NET)).toHaveLength(12);
  });

  test('a declared host that never answers spends the slice; the audit completes and the rows read budget-exceeded', async () => {
    let clock = 1_000_000;
    const seen: Seen[] = [];
    const hang = (init?: RequestInit): Promise<Response> => {
      clock += 7_000;
      return hangUntilAbort(init);
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
        return { admitted: key !== 'capped.org' };
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
  test('a declared URL redirecting to a private address is refused on the hop, recorded blocked, and its rows name the hop', async () => {
    const hop = 'http://169.254.169.254/latest';
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router({ ...siteDeclaring(ENDPOINT), [`GET ${ENDPOINT}`]: () => redirect(hop) }, seen),
    );
    expect(scorecard.declared_hosts?.[0]).toMatchObject({ final_url: hop, outcome: 'blocked' });
    expect(requestsTo(seen, '169.254.169.254')).toEqual([]);
    const initialize = row(scorecard, 'mcp-initialize');
    expect(initialize).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-blocked',
      host: '169.254.169.254',
      evidence: hop,
    });
    expect(resultLine(initialize.status, initialize.evidence, initialize.na_reason, initialize.host ?? '')).toBe(
      `Not evaluated: 169.254.169.254 is a private or IP address (${hop})`,
    );
  });

  test('a declared URL redirecting to a Location that does not parse is unconfirmed, and its rows name the declared host', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router({ ...siteDeclaring(ENDPOINT), [`GET ${ENDPOINT}`]: () => redirect('//[unparseable') }, seen),
    );
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/mcp.json',
        kind: 'mcp-endpoint',
        url: ENDPOINT,
        host: NET,
        outcome: 'reciprocity-refused',
      },
    ]);
    expect(seen.filter((r) => r.url.includes('unparseable'))).toEqual([]);
    const initialize = row(scorecard, 'mcp-initialize');
    expect(resultLine(initialize.status, null, initialize.na_reason, initialize.host ?? '')).toBe(
      `Not evaluated: ${NET} did not confirm this endpoint`,
    );
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

describe("follow: the audited site's own endpoint redirecting off its origin", () => {
  const OWN = 'https://example.com/mcp';
  const VICTIM = 'https://victim.example/hook';
  const MOVED = 'https://mcp.example.org/mcp';
  const ELSEWHERE = 'https://elsewhere.example.org/mcp';

  test('a common path answering a POST with a 307 to another host sends that host no POST and confirms nothing', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router({ [`GET ${TARGET}`]: () => html(), [`POST ${OWN}`]: () => redirect(VICTIM, 307) }, seen),
    );
    expect(wireProbesTo(seen, 'victim.example')).toEqual([]);
    expect(scorecard.mcp_endpoint).toBeNull();
    expect(scorecard.declared_hosts).toEqual([
      { surface: '/mcp', kind: 'mcp-endpoint', url: VICTIM, host: 'victim.example', outcome: 'reciprocity-refused' },
    ]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'reciprocity-refused',
      host: 'victim.example',
      evidence: VICTIM,
    });
    expect(scorecard.mcp_discovery.filter((item) => item.source === '/mcp')).toEqual([
      { source: '/mcp', status: 307, probed: 'initialize (off-origin redirect)', redirect: VICTIM },
      { source: '/mcp', status: 307, probed: 'modern-tools-list (off-origin redirect)', redirect: VICTIM },
    ]);
  });

  test('with following off, a redirect target reads follow-disabled and receives nothing', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router({ [`GET ${TARGET}`]: () => html(), [`POST ${OWN}`]: () => redirect(VICTIM, 307) }, seen),
      { followDeclarations: false },
    );
    expect(requestsTo(seen, 'victim.example')).toEqual([]);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/mcp',
        kind: 'mcp-endpoint',
        url: VICTIM,
        host: 'victim.example',
        outcome: 'not-followed',
        reason: 'follow-disabled',
      },
    ]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'follow-disabled' });
  });

  test('a redirect target whose own card names it becomes the endpoint of record, and its wire probes refuse redirects', async () => {
    const seen: Seen[] = [];
    const { events, scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          [`POST ${OWN}`]: () => redirect(MOVED, 307),
          [`GET ${MOVED}/server-card`]: () => cardDocument(sep2127Card(MOVED)),
          [`POST ${MOVED}`]: () => initializeResult(),
          [`OPTIONS ${MOVED}`]: () => redirect(ELSEWHERE, 307),
        },
        seen,
      ),
    );
    expect(events.find((e) => e.type === 'discovery')).toMatchObject({ endpoint: MOVED });
    expect(scorecard.mcp_endpoint).toBe(MOVED);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/mcp',
        kind: 'mcp-endpoint',
        url: MOVED,
        host: 'mcp.example.org',
        outcome: 'followed',
        admitted_by: 'card',
      },
    ]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: 'mcp.example.org' });
    const cardRead = seen.findIndex((r) => r.method === 'GET' && r.url === `${MOVED}/server-card`);
    const firstWireProbe = seen.findIndex((r) => r.method !== 'GET' && new URL(r.url).host === 'mcp.example.org');
    expect(cardRead).toBeGreaterThan(-1);
    expect(firstWireProbe).toBeGreaterThan(cardRead);
    expect(requestsTo(seen, 'elsewhere.example.org')).toEqual([]);
    expect(row(scorecard, 'mcp-cors-preflight').status).toBe('error');
  });

  test('a same-origin redirect on a common path still discovers the endpoint there, and its wire probes take the hop', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          [`POST ${OWN}`]: () => redirect('/mcp/', 308),
          [`POST ${OWN}/`]: () => initializeResult(),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBe(OWN);
    expect(scorecard.declared_hosts).toEqual([]);
    expect(scorecard.mcp_discovery.filter((item) => item.source === '/mcp')).toEqual([
      { source: '/mcp', endpoint: OWN, probed: 'initialize' },
    ]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass', host: 'example.com' });
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com' && !r.url.includes('dns'))).toEqual([]);
  });

  test('where a common path redirects is recorded not followed once another common path answers, and nothing is sent there', async () => {
    const registry = followRegistry();
    registry.mcp_discovery = { ...DISCOVERY, common_paths: ['/mcp', '/sse'] };
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          [`POST ${OWN}`]: () => redirect(VICTIM, 307),
          'POST https://example.com/sse': () => initializeResult(),
        },
        seen,
      ),
      { registry },
    );
    expect(scorecard.mcp_endpoint).toBe('https://example.com/sse');
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/mcp',
        kind: 'mcp-endpoint',
        url: VICTIM,
        host: 'victim.example',
        outcome: 'not-followed',
        reason: 'beyond-endpoint-of-record',
      },
    ]);
    expect(requestsTo(seen, 'victim.example')).toEqual([]);
  });

  test("a cross-origin redirect answered to a wire probe of the site's own endpoint is never replayed", async () => {
    const registry = followRegistry();
    registry.checks.push(
      {
        ...registry.checks[0],
        id: 'mcp-get-fast-fail',
        handler: 'http',
        with: { path: '{mcp_endpoint}', method: 'GET', timeout: 8, expect: { status_below: 500 } },
      },
      { ...registry.checks[0], id: 'mcp-tools-list', with: { op: 'tools-list' } },
    );
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...siteDeclaring(OWN),
          [`POST ${OWN}`]: (init) =>
            String(init?.body).includes('"initialize"')
              ? json(
                  { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'own' }, protocolVersion: '2025-06-18' } },
                  200,
                  { 'mcp-session-id': 's1' },
                )
              : redirect(ELSEWHERE, 307),
          [`OPTIONS ${OWN}`]: () => redirect(ELSEWHERE, 307),
          [`GET ${OWN}`]: () => redirect(ELSEWHERE, 302),
        },
        seen,
      ),
      { registry },
    );
    expect(scorecard.mcp_endpoint).toBe(OWN);
    expect(row(scorecard, 'mcp-initialize').status).toBe('pass');
    expect(seen.filter((r) => r.method === 'POST' && r.url === OWN).length).toBeGreaterThanOrEqual(3);
    expect(requestsTo(seen, 'elsewhere.example.org')).toEqual([]);
    expect(row(scorecard, 'mcp-cors-preflight').status).toBe('error');
    expect(row(scorecard, 'mcp-tools-list').status).toBe('error');
    expect(row(scorecard, 'mcp-get-fast-fail')).toMatchObject({ status: 'pass', host: 'example.com' });
    expect(seen.filter((r) => r.method === 'GET' && r.url === OWN)).toHaveLength(1);
  });

  test('a GET or HEAD probe of the endpoint takes an off-origin redirect as its answer; other methods fail on it, and a followed endpoint takes none', () => {
    for (const method of ['GET', 'HEAD']) {
      expect({ method, own: mcpEndpointRedirects(false, method) }).toEqual({
        method,
        own: { crossOriginRedirects: 'return' },
      });
      expect({ method, own: endpointRedirects('{mcp_endpoint}', undefined, method) }).toEqual({
        method,
        own: { crossOriginRedirects: 'return' },
      });
    }
    for (const method of ['POST', 'OPTIONS', 'DELETE', undefined]) {
      expect({ method, own: mcpEndpointRedirects(false, method) }).toEqual({
        method,
        own: { crossOriginRedirects: 'refuse' },
      });
    }
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      expect({ method, followed: mcpEndpointRedirects(true, method) }).toEqual({
        method,
        followed: { refuseRedirects: true },
      });
    }
    expect(endpointRedirects('/llms.txt', true, 'HEAD')).toEqual({});
  });

  test('an apex whose root and endpoint both redirect to www confirms nothing there: the www endpoint is a declaration, receives no POST, and its rows name it', async () => {
    const WWW = 'https://www.example.com/mcp';
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => redirect('https://www.example.com/', 301),
          'GET https://www.example.com/': () => html(),
          [`POST ${OWN}`]: () => redirect(WWW, 301),
        },
        seen,
      ),
    );
    expect(scorecard.mcp_endpoint).toBeNull();
    expect(scorecard.declared_hosts).toEqual([
      { surface: '/mcp', kind: 'mcp-endpoint', url: WWW, host: 'www.example.com', outcome: 'reciprocity-refused' },
    ]);
    expect(wireProbesTo(seen, 'www.example.com')).toEqual([]);
    for (const id of ['mcp-initialize', 'mcp-cors-preflight']) {
      expect({ id, row: row(scorecard, id) }).toMatchObject({
        id,
        row: { status: 'n_a', na_reason: 'reciprocity-refused', host: 'www.example.com' },
      });
    }
  });

  test("redirect targets settle after the declarations discovery read, under the slice's own host cap", async () => {
    const hosts = ['h1', 'h2', 'h3', 'h4'].map((h) => `${h}.example.net`);
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(...hosts.map((h) => cardEntry({ data: sep2127Card(`https://${h}/mcp`) }))),
          ...Object.fromEntries(hosts.map((h) => [`GET https://${h}/mcp`, () => redirect('http://10.0.0.1/mcp')])),
          [`POST ${OWN}`]: () => redirect('https://h5.example.net/mcp', 307),
        },
        seen,
      ),
    );
    expect(scorecard.declared_hosts?.map((e) => [e.surface, e.host, e.outcome, e.cause])).toEqual([
      ...hosts.map((h, i) => [`/.well-known/ai-catalog.json#/entries/${i}/data`, h, 'blocked', undefined]),
      ['/mcp', 'h5.example.net', 'budget-exceeded', 'per-audit-cap'],
    ]);
    expect(requestsTo(seen, 'h5.example.net')).toEqual([]);
  });

  test('a redirect target meets the guards a declaration meets: an IP literal is blocked and an auditor path is not followed', async () => {
    const literal = 'https://93.184.216.34/mcp';
    const literalSeen: Seen[] = [];
    const blocked = await audit(
      router({ [`GET ${TARGET}`]: () => html(), [`POST ${OWN}`]: () => redirect(literal, 307) }, literalSeen),
    );
    expect(blocked.scorecard.declared_hosts).toEqual([
      { surface: '/mcp', kind: 'mcp-endpoint', url: literal, host: '93.184.216.34', outcome: 'blocked' },
    ]);
    expect(row(blocked.scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-blocked',
      host: '93.184.216.34',
    });
    expect(requestsTo(literalSeen, '93.184.216.34')).toEqual([]);

    const selfPath = 'https://anc.dev/api/web-rescore?token=x';
    const selfSeen: Seen[] = [];
    const refused = await audit(
      router({ [`GET ${TARGET}`]: () => html(), [`POST ${OWN}`]: () => redirect(selfPath, 307) }, selfSeen),
    );
    expect(refused.scorecard.declared_hosts?.[0]).toMatchObject({
      surface: '/mcp',
      url: selfPath,
      outcome: 'not-followed',
      reason: 'self-path',
    });
    expect(requestsTo(selfSeen, 'anc.dev')).toEqual([]);
  });

  test('a redirect target the slice has no time left for is budget-exceeded with nothing sent there and no budget drawn', async () => {
    let clock = 1_000_000;
    const seen: Seen[] = [];
    const reserved: string[] = [];
    const budget: DomainBudget = {
      keyOf: (hostname) => hostname,
      reserve: async (key) => {
        reserved.push(key);
        return { admitted: true };
      },
    };
    const { scorecard, complete } = await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          [`POST ${OWN}`]: () => {
            clock += 7_000;
            return redirect(MOVED, 307);
          },
          [`GET ${MOVED}/server-card`]: () => cardDocument(sep2127Card(MOVED)),
        },
        seen,
      ),
      { now: () => clock, domainBudget: budget },
    );
    expect(complete).toBe(true);
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/mcp',
        kind: 'mcp-endpoint',
        url: MOVED,
        host: 'mcp.example.org',
        outcome: 'budget-exceeded',
        cause: 'slice',
      },
    ]);
    expect(requestsTo(seen, 'mcp.example.org')).toEqual([]);
    expect(reserved).toEqual([]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-budget-exceeded',
      host: 'mcp.example.org',
    });
  });
});

describe('follow: hosts that are never requested', () => {
  test("a declaration naming one of the auditor's own paths is refused before reciprocity; the canonical MCP path is admitted", async () => {
    const selfPaths = [
      'https://anc.dev/api/web-rescore?token=x',
      'https://anc.dev./api/web-rescore?token=x',
      'https://ANC.dev./api/web-rescore?token=x',
      'https://staging.anc.dev./x',
      'https://anc.dev./mcp',
      'https://anc.dev../mcp',
      'https://www.anc.dev../x',
    ];
    const toSelfZone = (r: Seen): boolean => new URL(r.url).hostname.replace(/\.+$/, '').endsWith('anc.dev');
    for (const selfPath of selfPaths) {
      const seen: Seen[] = [];
      const refused = await audit(router(siteDeclaring(selfPath), seen));
      expect({ selfPath, entry: refused.scorecard.declared_hosts?.[0] }).toMatchObject({
        selfPath,
        entry: { outcome: 'not-followed', reason: 'self-path' },
      });
      expect({ selfPath, sent: seen.filter(toSelfZone) }).toEqual({ selfPath, sent: [] });
    }

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

  test('IPv4 and IPv6 literal endpoints are never fetched, are recorded blocked, and their rows read declared-host-blocked', async () => {
    for (const literal of ['https://93.184.216.34/mcp', 'https://[2606:2800:220:1::]/mcp']) {
      const host = new URL(literal).host;
      const seen: Seen[] = [];
      const { scorecard } = await audit(router(siteDeclaring(literal), seen));
      expect({ literal, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({ literal, outcome: 'blocked' });
      expect(requestsTo(seen, host)).toEqual([]);
      const initialize = row(scorecard, 'mcp-initialize');
      expect({ literal, row: initialize }).toMatchObject({
        literal,
        row: { status: 'n_a', na_reason: 'declared-host-blocked', host },
      });
      expect(resultLine(initialize.status, null, initialize.na_reason, initialize.host ?? '')).toBe(
        `Not evaluated: ${host} is a private or IP address`,
      );
    }
  });

  test('an endpoint anc cannot request is one its host cannot confirm, never a private or IP address', async () => {
    const wss = 'wss://mcp.example.com/ws';
    const seen: Seen[] = [];
    const { scorecard } = await audit(router(siteDeclaring(wss), seen));
    expect(scorecard.declared_hosts).toEqual([
      {
        surface: '/.well-known/mcp.json',
        kind: 'mcp-endpoint',
        url: wss,
        host: 'mcp.example.com',
        outcome: 'reciprocity-refused',
      },
    ]);
    expect(requestsTo(seen, 'mcp.example.com')).toEqual([]);
    const initialize = row(scorecard, 'mcp-initialize');
    expect(initialize).toMatchObject({ status: 'n_a', na_reason: 'reciprocity-refused', host: 'mcp.example.com' });
    expect(resultLine(initialize.status, null, initialize.na_reason, initialize.host ?? '')).toBe(
      'Not evaluated: mcp.example.com did not confirm this endpoint',
    );
  });

  test('an endpoint URL with no host names no host in its rows', async () => {
    for (const hostless of ['mailto:mcp@example.org', 'data:text/plain,mcp']) {
      const { scorecard } = await audit(router(siteDeclaring(hostless), []));
      expect({ hostless, outcome: scorecard.declared_hosts?.[0]?.outcome }).toEqual({
        hostless,
        outcome: 'reciprocity-refused',
      });
      const initialize = row(scorecard, 'mcp-initialize');
      expect({ hostless, reason: initialize.na_reason, host: initialize.host }).toEqual({
        hostless,
        reason: 'antecedent-unmet',
        host: undefined,
      });
      expect(resultLine(initialize.status, null, initialize.na_reason, initialize.host ?? '')).toBe('Not applicable');
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
    for await (const event of runWebAudit({
      url: TARGET,
      registry: followRegistry(),
      fetchOptions: { fetchImpl },
      domainBudget: ALWAYS_ADMIT_BUDGET,
    })) {
      events.push(event.type);
    }
    expect(events).toContain('unreachable');
    expect(seen.filter((r) => new URL(r.url).host !== 'example.com' && !r.url.includes('dns'))).toEqual([]);
  });
});

describe('follow: the hourly budget of each declared registrable domain', () => {
  /** One audit declaring `endpoint`, with what the follow slice settled for it and what reached its host. */
  async function declaring(endpoint: string, domainBudget: DomainBudget) {
    const seen: Seen[] = [];
    const { events, scorecard } = await audit(router(siteDeclaring(endpoint), seen), { domainBudget });
    const host = new URL(endpoint).host;
    const complete = events.find((event) => event.type === 'complete');
    return {
      entry: scorecard.declared_hosts?.[0],
      scorecard,
      sent: requestsTo(seen, host).length,
      budgetErrors: complete?.type === 'complete' ? complete.follow.budgetErrors : null,
    };
  }

  /** `declaring`, with the audit's `web-audit.run` record. The log capture is global, so two never run at once. */
  async function recorded(endpoint: string, domainBudget: DomainBudget) {
    const seen: Seen[] = [];
    const logs = captureLogs();
    try {
      let scorecard: WebScorecard | null = null;
      const events = instrumentAuditEvents(
        runWebAudit({
          url: TARGET,
          registry: followRegistry(),
          fetchOptions: { fetchImpl: router(siteDeclaring(endpoint), seen) },
          domainBudget,
        }),
        {},
        { target: TARGET, surface: 'stream', followDeclarations: true },
      );
      for await (const event of events) if (event.type === 'complete') scorecard = event.scorecard;
      return {
        entry: scorecard?.declared_hosts?.[0],
        scorecard,
        sent: requestsTo(seen, new URL(endpoint).host).length,
        record: logs.records.map((r) => r.record).find((record) => record.scope === 'web-audit.run'),
      };
    } finally {
      logs.restore();
    }
  }

  test('registrable domains come from the public suffix list with its private section', () => {
    expect(
      ['a1.victim.example', 'victim.example.', 'a.github.io', 'y.x.example.co.uk', 'mcp.vendor.workers.dev'].map(
        registrableDomainOf,
      ),
    ).toEqual(['victim.example', 'victim.example', 'a.github.io', 'example.co.uk', 'vendor.workers.dev']);
  });

  test('a host with a label the hostname rules reject is still charged to its registrable domain', () => {
    const invalid = [
      '-a.victim.example',
      'a-.victim.example',
      'a!b.victim.example',
      `${'x'.repeat(64)}.victim.example`,
    ];
    expect(invalid.map(registrableDomainOf)).toEqual(invalid.map(() => 'victim.example'));
    expect(['github.io', 'a.github.io', '192.0.2.1', '[2001:db8::1]'].map(registrableDomainOf)).toEqual([
      'github.io',
      'a.github.io',
      '192.0.2.1',
      '[2001:db8::1]',
    ]);
  });

  test('a domain at its hourly ceiling is refused on the next audit before wave 1, and nothing is sent to it', async () => {
    const log: string[] = [];
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv(log) }, { hourlyCeiling: 1 });
    const first = await declaring(ENDPOINT, budget);
    expect(first.entry).toMatchObject({ outcome: 'reciprocity-refused' });
    expect(first.sent).toBeGreaterThan(0);

    log.length = 0;
    const seen: Seen[] = [];
    let scorecard: WebScorecard | null = null;
    for await (const event of runWebAudit({
      url: TARGET,
      registry: followRegistry(),
      fetchOptions: { fetchImpl: router(siteDeclaring(ENDPOINT), seen) },
      domainBudget: budget,
    })) {
      log.push(`event:${event.type}`);
      if (event.type === 'complete') scorecard = event.scorecard;
    }
    // The one read of a spent budget comes before the discovery event, so before wave 1, and nothing is written.
    const reads = [expect.stringMatching(new RegExp(`^kv:get ${await budgetKeyPrefix('example.net')}\\d+$`))];
    expect(log.filter((line) => line.startsWith('kv:'))).toEqual(reads);
    expect(log.slice(0, log.indexOf('event:discovery')).filter((line) => line.startsWith('kv:'))).toEqual(reads);
    expect(scorecard?.declared_hosts?.[0]).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(scorecard === null ? null : row(scorecard, 'mcp-initialize')).toMatchObject({
      status: 'n_a',
      na_reason: 'declared-host-budget-exceeded',
      host: NET,
    });
    expect(requestsTo(seen, NET)).toEqual([]);
  });

  test('a followed audit writes the budget once per registrable domain, however many of its hosts it reaches', async () => {
    const log: string[] = [];
    const seen: Seen[] = [];
    const endpoints = ['https://a1.victim.example/mcp', 'https://a2.victim.example/mcp'];
    const card = 'https://cards.other.example/card.json';
    await audit(
      router(
        {
          [`GET ${TARGET}`]: () => html(),
          'GET https://example.com/.well-known/ai-catalog.json': () =>
            aiCatalog(cardEntry({ url: card }), ...endpoints.map((url) => cardEntry({ data: sep2127Card(url) }))),
        },
        seen,
      ),
      { domainBudget: declaredDomainBudget({ SCORE_KV: memoryKv(log) }) },
    );
    for (const host of ['a1.victim.example', 'a2.victim.example', 'cards.other.example']) {
      expect({ host, reached: requestsTo(seen, host).length > 0 }).toEqual({ host, reached: true });
    }
    const puts = log.filter((line) => line.startsWith('kv:put'));
    const victim = await budgetKeyPrefix('victim.example');
    const other = await budgetKeyPrefix('other.example');
    expect(puts).toHaveLength(2);
    expect(puts.filter((line) => line.startsWith(`kv:put ${victim}`))).toHaveLength(1);
    expect(puts.filter((line) => line.startsWith(`kv:put ${other}`))).toHaveLength(1);
  });

  test('hosts under one registrable domain share its budget, whatever their scheme, port, or trailing dot', async () => {
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv() }, { hourlyCeiling: 1 });
    expect((await declaring('https://a1.victim.example/mcp', budget)).entry).toMatchObject({
      outcome: 'reciprocity-refused',
    });
    for (const endpoint of [
      'https://a2.victim.example/mcp',
      'https://victim.example/mcp',
      'https://victim.example:8443/mcp',
      'http://victim.example/mcp',
      'https://victim.example./mcp',
    ]) {
      const { entry, sent } = await declaring(endpoint, budget);
      expect({ endpoint, outcome: entry?.outcome, cause: entry?.cause, sent }).toEqual({
        endpoint,
        outcome: 'budget-exceeded',
        cause: 'domain-budget',
        sent: 0,
      });
    }
  });

  test('tenants of a private suffix hold separate budgets; subdomains of one registrable domain share one', async () => {
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv() }, { hourlyCeiling: 1 });
    const outcomes: Array<[string, unknown]> = [];
    for (const host of ['a.github.io', 'b.github.io', 'x.example.co.uk', 'y.x.example.co.uk']) {
      outcomes.push([host, (await declaring(`https://${host}/mcp`, budget)).entry?.outcome]);
    }
    expect(outcomes).toEqual([
      ['a.github.io', 'reciprocity-refused'],
      ['b.github.io', 'reciprocity-refused'],
      ['x.example.co.uk', 'reciprocity-refused'],
      ['y.x.example.co.uk', 'budget-exceeded'],
    ]);
  });

  test("audits running at once are admitted up to the burst floor, though KV refuses all but one write to the domain's key", async () => {
    let clock = 1_000_000;
    const log: string[] = [];
    const kv = memoryKv(log, { sameKeyWriteClock: () => clock });
    const budget = declaredDomainBudget({ SCORE_KV: kv, WEB_AUDIT_DOMAIN_LIMITER: memoryRateLimit(10, () => clock) });
    const endpoint = 'https://mcp.burst.example/mcp';
    const runs = await Promise.all(Array.from({ length: 12 }, () => declaring(endpoint, budget)));
    const refused = runs.filter((run) => run.entry?.outcome === 'budget-exceeded');
    expect(runs.length - refused.length).toBe(10);
    expect(refused.map((run) => [run.entry?.cause, run.sent])).toEqual([
      ['domain-budget', 0],
      ['domain-budget', 0],
    ]);
    // One write lands; the nine after it inside the same second are KV's
    // 429, and each of those audits is admitted, so the hour under-counts.
    const writes = log.filter((line) => line.startsWith('kv:put '));
    expect(writes).toHaveLength(1);
    expect(log.filter((line) => line.startsWith('kv:429 '))).toHaveLength(9);
    expect(await kv.get(writes[0].slice('kv:put '.length))).toBe('1');
    // Nine audits admitted on a failed write, one on the write that landed, two refused by the burst floor.
    expect(runs.map((run) => JSON.stringify(run.budgetErrors)).sort()).toEqual([
      ...Array(9).fill('{"put-admitted":1}'),
      ...Array(3).fill('{}'),
    ]);
    clock += 60_000;
    expect((await declaring(endpoint, budget)).entry?.outcome).toBe('reciprocity-refused');
  });

  test('without KV the hourly window admits', async () => {
    const { entry, record } = await recorded(ENDPOINT, declaredDomainBudget({}));
    expect(entry?.outcome).toBe('reciprocity-refused');
    expect(record?.follow_budget_errors).toEqual({});
  });

  test('an hourly read that throws refuses the domain, the audit still completes, and the run record counts it', async () => {
    const failing = {
      async get(): Promise<string | null> {
        throw new Error('kv unavailable');
      },
    } as unknown as KVNamespace;
    const { entry, scorecard, sent, record } = await recorded(ENDPOINT, declaredDomainBudget({ SCORE_KV: failing }));
    expect(entry).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(sent).toBe(0);
    expect(scorecard === null ? null : row(scorecard, 'mcp-initialize')).toMatchObject({
      na_reason: 'declared-host-budget-exceeded',
    });
    expect(record).toMatchObject({ terminal: 'complete', follow_budget_causes: { 'domain-budget': 1 } });
    expect(record?.follow_budget_errors).toEqual({ 'read-refused': 1 });
  });

  test('a burst floor that throws refuses the domain before KV is read, and the run record counts it', async () => {
    const log: string[] = [];
    const failing = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error('rate limiter unavailable');
      },
    };
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv(log), WEB_AUDIT_DOMAIN_LIMITER: failing });
    const { entry, sent, record } = await recorded(ENDPOINT, budget);
    expect(entry).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(sent).toBe(0);
    expect(log).toEqual([]);
    expect(record?.follow_budget_errors).toEqual({ 'burst-refused': 1 });
  });

  test('a write that throws after the read showed room admits the domain, and the run record counts it', async () => {
    const log: string[] = [];
    const kv = memoryKv(log);
    const failing = {
      get: (key: string) => kv.get(key),
      async put(): Promise<void> {
        throw new Error('KV PUT failed: 429 Too Many Requests');
      },
    } as unknown as KVNamespace;
    const { entry, sent, record } = await recorded(ENDPOINT, declaredDomainBudget({ SCORE_KV: failing }));
    expect(entry?.outcome).toBe('reciprocity-refused');
    expect(sent).toBeGreaterThan(0);
    expect(log).toEqual([expect.stringMatching(new RegExp(`^kv:get ${await budgetKeyPrefix('example.net')}\\d+$`))]);
    expect(record?.follow_budget_errors).toEqual({ 'put-admitted': 1 });
    expect(record?.follow_budget_causes).toEqual({});
  });

  test("the auditor's own zone draws on its own budget like any host; a refused self path spends none", async () => {
    const log: string[] = [];
    const canonical = 'https://anc.dev/mcp';
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv(log) }, { hourlyCeiling: 1 });
    await declaring('https://anc.dev/api/web-rescore', budget);
    expect(log).toEqual([]);
    expect((await declaring(canonical, budget)).entry?.outcome).toBe('reciprocity-refused');
    expect(log.filter((line) => line.startsWith('kv:put'))).toEqual([
      expect.stringMatching(new RegExp(`^kv:put ${await budgetKeyPrefix('anc.dev')}\\d+$`)),
    ]);
    const { entry, sent } = await declaring(canonical, budget);
    expect({ outcome: entry?.outcome, cause: entry?.cause, sent }).toEqual({
      outcome: 'budget-exceeded',
      cause: 'domain-budget',
      sent: 0,
    });
  });

  test('workers.dev hosts take the ordinary path, each account under its own budget', async () => {
    const budget = declaredDomainBudget({ SCORE_KV: memoryKv() }, { hourlyCeiling: 1 });
    const edge = 'https://blocked.acct.workers.dev/mcp';
    const seen: Seen[] = [];
    const { scorecard: blocked } = await audit(
      router(siteDeclaring(edge), seen, () => new Response('error code: 1042', { status: 530 })),
      { domainBudget: budget },
    );
    expect(blocked.results.some((r) => r.status === 'broken')).toBe(false);
    expect(row(blocked, 'mcp-initialize')).toMatchObject({ status: 'n_a', na_reason: 'reciprocity-refused' });

    const worker = 'https://mcp.vendor.workers.dev/mcp';
    const { scorecard: followed } = await audit(
      router(
        {
          ...siteDeclaring(worker),
          [`GET ${worker}/server-card`]: () => cardDocument(sep2127Card(worker)),
          [`POST ${worker}`]: () => initializeResult(),
        },
        [],
      ),
      { domainBudget: budget },
    );
    expect(followed.mcp_endpoint).toBe(worker);
    expect(row(followed, 'mcp-initialize').status).toBe('pass');

    const sameAccount = await declaring('https://api.vendor.workers.dev/mcp', budget);
    expect({ outcome: sameAccount.entry?.outcome, sent: sameAccount.sent }).toEqual({
      outcome: 'budget-exceeded',
      sent: 0,
    });
  });
});
