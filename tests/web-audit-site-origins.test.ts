// A folded pair is one audited site: every comparison that asks whether a URL
// is on the audited origin asks whether it is on the site instead, so the
// other host of the pair is never a declared third party and a redirect
// between the two hosts is an ordinary same-site hop. Hosts outside the pair
// stay off the site, and the egress guard still validates every hop.

import { describe, expect, test } from 'bun:test';
import type { CatalogAnchor } from '../src/worker/audit-web/api-catalog';
import { apiTargets } from '../src/worker/audit-web/api-targets';
import { declaresHost } from '../src/worker/audit-web/follow-trail';
import { enumerateScopedDirs } from '../src/worker/audit-web/handlers/scoped-llms';
import { sameOriginRecoveryLink } from '../src/worker/audit-web/handlers/shared';
import { onSite, sameSiteOrigin } from '../src/worker/audit-web/site-origins';
import { guardedFetch } from '../src/worker/audit-web/ssrf';
import {
  audit,
  html,
  initializeResult,
  json,
  redirect,
  router,
  row,
  type Seen,
  wireProbesTo,
} from './helpers/follow-fixtures';
import { stubFetch } from './helpers/stub-fetch';

const APEX = 'https://n.test';
const WWW = 'https://www.n.test';
const SITE = [APEX, WWW];

describe('the on-site predicate', () => {
  test('a one-origin site is exactly its origin', () => {
    expect(onSite('https://n.test/x', 'https://n.test/')).toBe(true);
    expect(onSite('https://www.n.test/x', 'https://n.test/')).toBe(false);
    expect(onSite('http://n.test/x', 'https://n.test/')).toBe(false);
    expect(onSite('https://n.test:8443/x', 'https://n.test/')).toBe(false);
  });

  test('both origins of a folded pair are on the site, and nothing else is', () => {
    expect(onSite('https://n.test/x', 'https://www.n.test/', SITE)).toBe(true);
    expect(onSite('https://www.n.test/x', 'https://n.test/', SITE)).toBe(true);
    expect(onSite('https://third.test/x', 'https://n.test/', SITE)).toBe(false);
    expect(sameSiteOrigin(APEX, 'https://third.test', SITE)).toBe(false);
  });

  test('an unparseable URL is off the site', () => {
    expect(onSite('not a url', 'https://n.test/', SITE)).toBe(false);
  });
});

describe('the hop rule of the egress guard', () => {
  const sent: string[] = [];
  const hop = (location: string) =>
    stubFetch((url) => {
      sent.push(url);
      return url === `${APEX}/mcp`
        ? new Response(null, { status: 308, headers: { Location: location } })
        : new Response('arrived', { status: 200 });
    });

  test('a hop between the two hosts of the site is taken when cross-origin hops are refused', async () => {
    sent.length = 0;
    const resp = await guardedFetch(
      `${APEX}/mcp`,
      { method: 'POST', body: '{}' },
      { fetchImpl: hop(`${WWW}/mcp`), crossOriginRedirects: 'refuse', siteOrigins: SITE },
    );
    expect(sent).toEqual([`${APEX}/mcp`, `${WWW}/mcp`]);
    expect(resp.status).toBe(200);
  });

  test('without the site origins the same hop is refused', async () => {
    sent.length = 0;
    const resp = await guardedFetch(
      `${APEX}/mcp`,
      { method: 'POST', body: '{}' },
      { fetchImpl: hop(`${WWW}/mcp`), crossOriginRedirects: 'refuse' },
    );
    expect(sent).toEqual([`${APEX}/mcp`]);
    expect(resp.error).toBe(`redirect refused: 308 to ${WWW}/mcp`);
  });

  test('a hop to a host outside the site is still refused', async () => {
    sent.length = 0;
    const resp = await guardedFetch(
      `${APEX}/mcp`,
      { method: 'POST', body: '{}' },
      { fetchImpl: hop('https://third.test/mcp'), crossOriginRedirects: 'refuse', siteOrigins: SITE },
    );
    expect(sent).toEqual([`${APEX}/mcp`]);
    expect(resp.error).toBe('redirect refused: 308 to https://third.test/mcp');
  });

  test('a hop inside the site is still validated as a public destination', async () => {
    sent.length = 0;
    const resp = await guardedFetch(
      `${APEX}/mcp`,
      { method: 'POST', body: '{}' },
      {
        fetchImpl: hop('https://localhost/mcp'),
        crossOriginRedirects: 'refuse',
        siteOrigins: [APEX, 'https://localhost'],
      },
    );
    expect(sent).toEqual([`${APEX}/mcp`]);
    expect(resp.status).toBeNull();
    expect(resp.error).toContain('blocked');
  });

  test('a redirect from a host outside the site into it is handed back, not followed', async () => {
    const sentUrls: string[] = [];
    const fetchImpl = stubFetch((url) => {
      sentUrls.push(url);
      return new Response(null, { status: 307, headers: { Location: `${WWW}/` } });
    });
    const resp = await guardedFetch(
      'https://api.other.test/hook',
      { method: 'GET' },
      { fetchImpl, crossOriginRedirects: 'return', siteOrigins: SITE },
    );
    expect(sentUrls).toEqual(['https://api.other.test/hook']);
    expect(resp.status).toBe(307);
    expect(resp.headers.location).toBe(`${WWW}/`);
  });
});

describe('the declared-hosts decision', () => {
  const declaration = (url: string) => ({ kind: 'mcp-endpoint' as const, url, source: '/.well-known/mcp.json' });

  test('the other host of a folded pair is not declared, and a third host is', () => {
    expect(declaresHost(declaration(`${APEX}/mcp`), `${WWW}/`, SITE)).toBe(false);
    expect(declaresHost(declaration('https://third.test/mcp'), `${WWW}/`, SITE)).toBe(true);
  });

  test('without a fold the other host is a declared host as before', () => {
    expect(declaresHost(declaration(`${APEX}/mcp`), `${WWW}/`)).toBe(true);
  });
});

describe('API anchors on the other host of the pair', () => {
  test('an anchor on the other host groups as the audited site, not a declared host', () => {
    const anchor: CatalogAnchor = {
      url: `${APEX}/api`,
      source: '/.well-known/api-catalog#/linkset/0',
      description: { url: `${APEX}/openapi.json`, source: '/.well-known/api-catalog#/linkset/0/service-desc/0' },
    };
    const folded = apiTargets(`${WWW}/`, [anchor], { entries: [], descriptions: new Map() }, SITE);
    expect(folded?.hosts).toEqual([
      { origin: APEX, anchors: [{ url: anchor.url, description: `${APEX}/openapi.json` }], declared: false },
    ]);
    const unfolded = apiTargets(`${WWW}/`, [anchor], { entries: [], descriptions: new Map() });
    expect(unfolded?.hosts ?? []).toEqual([]);
  });
});

describe('same-site links on a folded site probed at the www host', () => {
  test('an llms.txt link to the bare host names a section directory to fetch', () => {
    const llms = '- [Docs](https://n.test/docs/intro.md)\n- [Elsewhere](https://third.test/blog/post.md)\n';
    expect(enumerateScopedDirs(llms, '', `${WWW}/`, SITE)).toEqual(['/docs']);
    expect(enumerateScopedDirs(llms, '', `${WWW}/`)).toEqual([]);
  });

  test('a root link to the bare host counts as a same-site recovery link', () => {
    const body = '- [About](https://n.test/docs)\n';
    expect(sameOriginRecoveryLink(body, `${WWW}/`, SITE).ok).toBe(true);
    expect(sameOriginRecoveryLink(body, `${WWW}/`).ok).toBe(false);
  });
});

describe('a folded audit never names the other host as a declared host', () => {
  const FOLD = {
    'GET https://n.test/': () => redirect(`${WWW}/`, 301),
    'GET https://www.n.test/': () => html(),
  };

  test('a server card on the probed host that names an endpoint on the other host resolves it as the site own endpoint', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...FOLD,
          'GET https://www.n.test/.well-known/mcp.json': () => json({ name: 'n', mcp_endpoint: `${APEX}/mcp` }),
          'POST https://n.test/mcp': () => initializeResult(),
        },
        seen,
      ),
      { url: `${APEX}/` },
    );
    expect(scorecard.mcp_endpoint).toBe(`${APEX}/mcp`);
    expect(scorecard.declared_hosts).toEqual([]);
    expect(row(scorecard, 'mcp-initialize')).toMatchObject({ status: 'pass' });
  });

  test('a common-path POST that the probed host redirects to the other host is followed, not declared', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          ...FOLD,
          'POST https://www.n.test/mcp': () => redirect(`${APEX}/mcp`, 308),
          'POST https://n.test/mcp': () => initializeResult(),
        },
        seen,
      ),
      { url: `${APEX}/` },
    );
    expect(scorecard.declared_hosts).toEqual([]);
    expect(scorecard.mcp_endpoint).toBe(`${WWW}/mcp`);
    expect(wireProbesTo(seen, 'n.test').some((r) => r.method === 'POST')).toBe(true);
  });

  test('an unfolded site whose common-path POST redirects to the www host records it as a declaration', async () => {
    const seen: Seen[] = [];
    const { scorecard } = await audit(
      router(
        {
          'GET https://n.test/': () => html(),
          'POST https://n.test/mcp': () => redirect(`${WWW}/mcp`, 308),
        },
        seen,
      ),
      { url: `${APEX}/` },
    );
    expect(scorecard.declared_hosts).toEqual([
      expect.objectContaining({ kind: 'mcp-endpoint', url: `${WWW}/mcp`, host: 'www.n.test' }),
    ]);
    expect(wireProbesTo(seen, 'www.n.test')).toEqual([]);
  });
});
