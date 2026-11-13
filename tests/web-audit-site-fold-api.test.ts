// POST /api/score for a host and its www sibling: which host a saved audit is
// stored under, what its write deletes and purges, which listing it carries,
// and how a request for either host is keyed once a fold is recorded.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '../src/shared/audit-events';
import { rowHostPhrase } from '../src/shared/scoring-copy';
import { sha256Hex, keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';
import type { PairReport } from '../src/worker/audit-web/site-pair';
import { planSiteRecord } from '../src/worker/audit-web/site-record';
import { targetOfHost } from '../src/worker/audit-web/web-target';
import { _resetIndexCache } from '../src/worker/score/core';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { call, makeEnv, ndjson, newTracker, post, purgeCtx, WEB_RECORD } from './helpers/audit-api-env';
import { html, json, redirect, router, type Seen } from './helpers/follow-fixtures';

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

const STALE_MS = 10 * 60_000;
const STREAM = { accept: 'application/x-ndjson' };

type Stored = {
  scored_at?: string;
  target_url: string;
  scorecard: {
    tool?: { name: string; url: string };
    target_url: string;
    public_listing?: boolean;
    site_hosts?: string[];
  };
};

type StoredSpec = { listing?: boolean; siteHosts?: string[]; stale?: boolean; scorecardHost?: string };

/** A stored website audit for `host`, as an earlier audit left it. */
function stored(host: string, spec: StoredSpec = {}): Stored {
  const base = WEB_RECORD(host);
  return {
    ...base,
    scored_at: new Date(Date.now() - (spec.stale === false ? 0 : STALE_MS)).toISOString(),
    scorecard: {
      ...base.scorecard,
      tool: { name: host, url: `https://${host}/` },
      ...(spec.listing === undefined ? {} : { public_listing: spec.listing }),
      ...(spec.siteHosts === undefined ? {} : { site_hosts: spec.siteHosts }),
    },
  };
}

async function keyOf(host: string): Promise<string> {
  return webKeyFor(`https://${host}/`, SPEC_VERSION);
}

async function seed(records: Record<string, Stored>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [host, record] of Object.entries(records)) out[await keyOf(host)] = record;
  return out;
}

type Fold = {
  /** The routes the audit's wire answers, by `METHOD url`. */
  routes: Record<string, () => Response>;
  records?: Record<string, Stored>;
  cachePutThrows?: boolean;
  tracker?: ReturnType<typeof newTracker>;
  kvSeed?: Record<string, string>;
  followSwitch?: string;
};

/** Both roots redirect nowhere and answer 200. */
function bothAnswer(apex: string): Record<string, () => Response> {
  return { [`GET https://${apex}/`]: () => html(), [`GET https://www.${apex}/`]: () => html() };
}

async function harness(fold: Fold) {
  const seen: Seen[] = [];
  const env = makeEnv({
    cacheContent: await seed(fold.records ?? {}),
    cachePutThrows: fold.cachePutThrows,
    tracker: fold.tracker,
    kvSeed: fold.kvSeed,
    followSwitch: fold.followSwitch,
    deps: { probeFetch: router(fold.routes, seen) },
  });
  const deleted: string[] = [];
  const del = env.SCORE_CACHE.delete.bind(env.SCORE_CACHE);
  env.SCORE_CACHE.delete = (async (key: string | string[]) => {
    deleted.push(...(Array.isArray(key) ? key : [key]));
    return del(key as string);
  }) as R2Bucket['delete'];
  return {
    env,
    seen,
    deleted,
    async storedRecord(host: string): Promise<Stored | null> {
      const object = await env.SCORE_CACHE.get(await keyOf(host));
      return object ? ((await object.json()) as Stored) : null;
    },
    async audit(body: Record<string, unknown>) {
      const ctx = purgeCtx();
      const { res } = await call(post({ turnstile_token: 'x', ...body }), env, ctx);
      await Promise.all(ctx._promises);
      return { res, purged: ctx.purged.flat() };
    },
    async stream(body: Record<string, unknown>) {
      const ctx = purgeCtx();
      const { res } = await call(post({ turnstile_token: 'x', ...body }, STREAM), env, ctx);
      const events = (await ndjson(res)) as AuditEvent[];
      await Promise.all(ctx._promises);
      return events;
    },
  };
}

type Envelope = {
  target: string;
  target_url: string;
  scorecard_url: string | null;
  scorecard: Stored['scorecard'];
  summary_html?: string;
};

describe('POST /api/score: a folded pair is stored as one site', () => {
  test('a www host whose root redirects to the bare host is stored under the bare host and answers with the bare host', async () => {
    const h = await harness({
      routes: {
        'GET https://www.stripe.com/': () => redirect('https://stripe.com/', 301),
        'GET https://stripe.com/': () => html(),
      },
    });
    const { res, purged } = await h.audit({ target: 'www.stripe.com' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.target).toBe('stripe.com');
    expect(body.scorecard_url).toEndWith('/score/stripe.com');
    expect(body.target_url).toBe('https://stripe.com/');
    const record = await h.storedRecord('stripe.com');
    expect(record?.scorecard.tool?.name).toBe('stripe.com');
    expect(record?.scorecard.site_hosts).toEqual(['stripe.com', 'www.stripe.com']);
    expect(await h.storedRecord('www.stripe.com')).toBeNull();
    expect(purged).toEqual(expect.arrayContaining(['web', 'web:stripe.com', 'web:www.stripe.com']));
  });

  test('a bare host whose root redirects to www is audited at www, and the envelope says where', async () => {
    const h = await harness({
      routes: {
        'GET https://cnn.com/': () => redirect('https://www.cnn.com/', 301),
        'GET https://www.cnn.com/': () => html(),
      },
    });
    const { res } = await h.audit({ target: 'cnn.com' });
    const body = (await res.json()) as Envelope;
    expect(body.target).toBe('cnn.com');
    expect(body.target_url).toBe('https://www.cnn.com/');
    const record = await h.storedRecord('cnn.com');
    expect(record?.target_url).toBe('https://cnn.com/');
    expect(record?.scorecard.target_url).toBe('https://www.cnn.com/');
    expect(record?.scorecard.tool).toEqual({ name: 'cnn.com', url: 'https://cnn.com/' });
    expect(record?.scorecard.site_hosts).toEqual(['cnn.com', 'www.cnn.com']);
  });

  test('an unfolded audit keeps one meaning for target_url: the host that was audited', async () => {
    const h = await harness({ routes: bothAnswer('a.test') });
    const { res, purged } = await h.audit({ target: 'a.test' });
    const body = (await res.json()) as Envelope;
    expect(body.target_url).toBe('https://a.test/');
    expect((await h.storedRecord('a.test'))?.scorecard.site_hosts).toBeUndefined();
    expect(purged).not.toContain('web:www.a.test');
  });

  test('a www host with no redirect either way is audited and stored as its own site', async () => {
    const h = await harness({ routes: bothAnswer('a.test') });
    const { res, purged } = await h.audit({ target: 'www.a.test' });
    expect(((await res.json()) as Envelope).target).toBe('www.a.test');
    expect((await h.storedRecord('www.a.test'))?.scorecard.tool?.name).toBe('www.a.test');
    expect(await h.storedRecord('a.test')).toBeNull();
    expect(purged).toContain('web:www.a.test');
    expect(purged).not.toContain('web:a.test');
  });

  test('a folded write deletes the www host record and no other', async () => {
    const h = await harness({
      routes: {
        'GET https://a.test/': () => redirect('https://www.a.test/', 301),
        'GET https://www.a.test/': () => html(),
      },
      records: { 'www.a.test': stored('www.a.test'), 'other.test': stored('other.test') },
    });
    await h.audit({ target: 'a.test' });
    expect(h.deleted).toEqual([await keyOf('www.a.test')]);
    expect(await h.storedRecord('www.a.test')).toBeNull();
    expect(await h.storedRecord('other.test')).not.toBeNull();
    expect(await h.storedRecord('a.test')).not.toBeNull();
  });

  test('a folded write leaves the www record stored for another spec version', async () => {
    const h = await harness({
      routes: {
        'GET https://a.test/': () => redirect('https://www.a.test/', 301),
        'GET https://www.a.test/': () => html(),
      },
      records: { 'www.a.test': stored('www.a.test') },
    });
    const olderKey = await webKeyFor('https://www.a.test/', '0.0.1');
    await h.env.SCORE_CACHE.put(olderKey, JSON.stringify(stored('www.a.test')));
    await h.audit({ target: 'a.test' });
    expect(h.deleted).toEqual([await keyOf('www.a.test')]);
    expect(await h.env.SCORE_CACHE.get(olderKey)).not.toBeNull();
  });

  test('a folded audit whose bare-host write fails deletes no record', async () => {
    const h = await harness({
      routes: {
        'GET https://a.test/': () => redirect('https://www.a.test/', 301),
        'GET https://www.a.test/': () => html(),
      },
      records: { 'www.a.test': stored('www.a.test') },
      cachePutThrows: true,
    });
    await h.audit({ target: 'a.test' });
    expect(h.deleted).toEqual([]);
    expect(await h.storedRecord('www.a.test')).not.toBeNull();
  });
});

describe('POST /api/score: the listing a folded write carries', () => {
  const folds = {
    'GET https://a.test/': () => redirect('https://www.a.test/', 301),
    'GET https://www.a.test/': () => html(),
  };

  test('a blank request for www.a.test takes the opt-in of its own record when a.test has none', async () => {
    const h = await harness({ routes: folds, records: { 'www.a.test': stored('www.a.test', { listing: true }) } });
    await h.audit({ target: 'www.a.test' });
    expect((await h.storedRecord('a.test'))?.scorecard.public_listing).toBe(true);
    expect(await h.storedRecord('www.a.test')).toBeNull();
  });

  test('a blank audit of a.test takes the opt-in of the www record when a.test has no record', async () => {
    const h = await harness({ routes: folds, records: { 'www.a.test': stored('www.a.test', { listing: true }) } });
    await h.audit({ target: 'a.test' });
    expect((await h.storedRecord('a.test'))?.scorecard.public_listing).toBe(true);
    expect(await h.storedRecord('www.a.test')).toBeNull();
  });

  test('the record of a.test decides over an opt-in of the www record', async () => {
    const h = await harness({
      routes: folds,
      records: {
        'a.test': stored('a.test', { listing: false }),
        'www.a.test': stored('www.a.test', { listing: true }),
      },
    });
    await h.audit({ target: 'a.test' });
    expect((await h.storedRecord('a.test'))?.scorecard.public_listing).toBe(false);
    expect(await h.storedRecord('www.a.test')).toBeNull();
  });

  test('an explicit choice decides over both records', async () => {
    const h = await harness({
      routes: folds,
      records: { 'a.test': stored('a.test', { listing: true }), 'www.a.test': stored('www.a.test', { listing: true }) },
    });
    await h.audit({ target: 'a.test', public_listing: false });
    expect((await h.storedRecord('a.test'))?.scorecard.public_listing).toBe(false);
  });

  test('an explicit choice on www.a.test meters the flip budget once, on www.a.test, and the fold writes a.test with that choice', async () => {
    const tracker = newTracker();
    const h = await harness({ routes: folds, tracker });
    await h.audit({ target: 'www.a.test', public_listing: true });
    const flips = tracker.kvPuts.filter((key) => key.startsWith('web_audit_flip:'));
    expect(flips).toHaveLength(1);
    expect(flips[0]).toContain(await sha256Hex('www.a.test'));
    expect((await h.storedRecord('a.test'))?.scorecard.public_listing).toBe(true);
  });
});

describe('POST /api/score: a streamed audit of a folded site', () => {
  type Check = Extract<AuditEvent, { type: 'check' }>;

  async function checksOf(routes: Record<string, () => Response>, target: string): Promise<Check[]> {
    const h = await harness({ routes, followSwitch: 'true' });
    return (await h.stream({ target })).filter((e): e is Check => e.type === 'check');
  }

  test('a row evaluated on the other host of the pair names no host', async () => {
    const checks = await checksOf(
      {
        'GET https://a.test/': () => redirect('https://www.a.test/', 301),
        'GET https://www.a.test/': () => html(),
        'GET https://www.a.test/.well-known/mcp.json': () =>
          json({ name: 'a', mcp_endpoint: 'https://www.a.test/mcp' }),
      },
      'a.test',
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((c) => c.host !== undefined || c.hosts !== undefined)).toEqual([]);
    expect(checks.map((c) => rowHostPhrase(c, 'a.test', null)).filter((phrase) => phrase !== null)).toEqual([]);
  });

  test('a row evaluated on a host outside the pair still names it', async () => {
    const checks = await checksOf(
      {
        'GET https://a.test/': () => html(),
        'GET https://www.a.test/': () => html(),
        'GET https://a.test/.well-known/mcp.json': () =>
          json({ name: 'a', mcp_endpoint: 'https://mcp.example.net/mcp' }),
      },
      'a.test',
    );
    expect(checks.some((c) => c.host === 'mcp.example.net')).toBe(true);
  });
});

describe('POST /api/score: a recorded fold', () => {
  const FOLD = ['a.test', 'www.a.test'];

  test('an unfolded audit of a.test drops the fold, deletes nothing, and purges the www page', async () => {
    const h = await harness({
      routes: bothAnswer('a.test'),
      records: { 'a.test': stored('a.test', { siteHosts: FOLD }) },
    });
    const { purged } = await h.audit({ target: 'a.test' });
    expect((await h.storedRecord('a.test'))?.scorecard.site_hosts).toBeUndefined();
    expect(h.deleted).toEqual([]);
    expect(purged).toEqual(expect.arrayContaining(['web:a.test', 'web:www.a.test']));
  });

  test('a sibling that gives no answer keeps the fold, deletes nothing, and purges no www page', async () => {
    const h = await harness({
      routes: {
        'GET https://a.test/': () => html(),
        'GET https://www.a.test/': () => new Response('down', { status: 503 }),
      },
      records: { 'a.test': stored('a.test', { siteHosts: FOLD }), 'www.a.test': stored('www.a.test') },
    });
    const { purged } = await h.audit({ target: 'a.test' });
    expect((await h.storedRecord('a.test'))?.scorecard.site_hosts).toEqual(FOLD);
    expect(h.deleted).toEqual([]);
    expect(purged).toContain('web:a.test');
    expect(purged).not.toContain('web:www.a.test');
  });

  test('a request for www.a.test audits from www.a.test and, when the pair is unfolded, stores www.a.test as its own site and ends the recorded fold', async () => {
    const h = await harness({
      routes: bothAnswer('a.test'),
      records: { 'a.test': stored('a.test', { siteHosts: FOLD, listing: true }) },
    });
    const { res, purged } = await h.audit({ target: 'www.a.test' });
    expect(((await res.json()) as Envelope).target).toBe('www.a.test');
    const own = await h.storedRecord('www.a.test');
    expect(own?.scorecard.tool?.name).toBe('www.a.test');
    expect(own?.scorecard.public_listing).toBe(false);
    expect((await h.storedRecord('a.test'))?.scorecard.site_hosts).toBeUndefined();
    expect(h.deleted).toEqual([]);
    expect(purged).toContain('web:www.a.test');
  });

  test('ending a fold leaves the bare host record naming the origin its checks ran at', async () => {
    const folded = stored('a.test', { siteHosts: FOLD });
    folded.scorecard.target_url = 'https://www.a.test/';
    const h = await harness({ routes: bothAnswer('a.test'), records: { 'a.test': folded } });
    await h.audit({ target: 'www.a.test' });
    const kept = (await h.storedRecord('a.test'))?.scorecard;
    expect(kept?.site_hosts).toBeUndefined();
    expect(kept?.target_url).toBe('https://www.a.test/');
    expect(kept?.tool?.url).toBe(kept?.target_url as string);
  });

  test('a request for www.a.test whose pair gives no answer writes a.test with the fold kept', async () => {
    const h = await harness({
      routes: {
        'GET https://www.a.test/': () => html(),
        'GET https://a.test/': () => new Response('down', { status: 503 }),
      },
      records: { 'a.test': stored('a.test', { siteHosts: FOLD }) },
    });
    const { res } = await h.audit({ target: 'www.a.test' });
    expect(((await res.json()) as Envelope).target).toBe('a.test');
    const record = await h.storedRecord('a.test');
    expect(record?.scorecard.tool?.name).toBe('a.test');
    expect(record?.scorecard.site_hosts).toEqual(FOLD);
    expect(await h.storedRecord('www.a.test')).toBeNull();
    expect(h.deleted).toEqual([]);
  });

  test('a fresh record answers a request for www.a.test with the site', async () => {
    const h = await harness({
      routes: bothAnswer('a.test'),
      records: { 'a.test': stored('a.test', { siteHosts: FOLD, stale: false }) },
    });
    const { res } = await h.audit({ target: 'www.a.test' });
    const body = (await res.json()) as Envelope & { tier: string };
    expect({ tier: body.tier, target: body.target }).toEqual({ tier: 'cache', target: 'a.test' });
    expect(h.seen).toEqual([]);
  });

  test('a request for www.a.test attaches to a run in flight for a.test', async () => {
    const h = await harness({
      routes: bothAnswer('a.test'),
      records: { 'a.test': stored('a.test', { siteHosts: FOLD }) },
      kvSeed: { 'inflight:web:a.test': JSON.stringify({ started_at: new Date().toISOString() }) },
    });
    const { res } = await call(post({ target: 'www.a.test' }), h.env);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { in_progress?: boolean }).in_progress).toBe(true);
    expect(h.seen).toEqual([]);
  });

  test('a run that does not follow declared hosts and folds answers with the site and saves nothing', async () => {
    const h = await harness({
      routes: {
        'GET https://www.a.test/': () => redirect('https://a.test/', 301),
        'GET https://a.test/': () => html(),
      },
      records: { 'www.a.test': stored('www.a.test') },
    });
    const { res, purged } = await h.audit({ target: 'www.a.test', follow_declarations: false });
    const body = (await res.json()) as Envelope;
    expect(body.target).toBe('a.test');
    expect(body.scorecard_url).toBeNull();
    expect(h.deleted).toEqual([]);
    expect(await h.storedRecord('a.test')).toBeNull();
    expect(await h.storedRecord('www.a.test')).not.toBeNull();
    expect(purged).toEqual([]);
  });
});

describe('planSiteRecord: the listing a save with no explicit choice carries', () => {
  const FOLD = ['a.test', 'www.a.test'];
  const unfolded: PairReport = { outcome: 'unfolded', requestedStatus: 200, siblingStatus: 200 };
  const noAnswer: PairReport = { outcome: 'no-answer', requestedStatus: 200, siblingStatus: null };
  const scorecardOf = (listing: boolean) =>
    ({ target_url: 'https://a.test/', score_pct: 64, results: [], public_listing: listing }) as unknown as WebScorecard;

  async function store(records: Record<string, Stored>, opts: { reads?: 'fail' } = {}) {
    const objects = new Map<string, string>();
    for (const [host, record] of Object.entries(records)) objects.set(await keyOf(host), JSON.stringify(record));
    const SCORE_CACHE = {
      async get(key: string) {
        if (opts.reads === 'fail') throw new Error('r2 unavailable');
        const value = objects.get(key);
        return value ? { json: async () => JSON.parse(value) } : null;
      },
    } as unknown as R2Bucket;
    return { SCORE_CACHE };
  }

  function plan(
    env: { SCORE_CACHE: R2Bucket },
    input: { pair: PairReport | null; explicit?: boolean; listing: boolean; target?: string; requested?: string },
  ) {
    const requested = targetOfHost(input.requested ?? 'a.test');
    return planSiteRecord(env, {
      target: targetOfHost(input.target ?? input.requested ?? 'a.test'),
      requested,
      pair: input.pair,
      scorecard: scorecardOf(input.listing),
      explicit: input.explicit,
      listing: input.listing,
    });
  }

  test('a blank save takes the listing stored when it writes, in the plan and in the scorecard', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: false }) });
    const site = await plan(env, { pair: null, listing: true });
    expect(site.listing).toBe(false);
    expect(site.scorecard.public_listing).toBe(false);
  });

  test('an explicit choice is written as given over a different stored listing', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: false }) });
    const site = await plan(env, { pair: unfolded, explicit: true, listing: true });
    expect(site.listing).toBe(true);
    expect(site.scorecard.public_listing).toBe(true);
  });

  test('with no stored record the plan carries the listing resolved before the run', async () => {
    const site = await plan(await store({}), { pair: null, listing: true });
    expect(site.listing).toBe(true);
    expect(site.scorecard.public_listing).toBe(true);
  });

  test('a pair that could not be told apart, with the fold recorded, carries the stored listing', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: false, siteHosts: FOLD }) });
    const site = await plan(env, { pair: noAnswer, listing: true });
    expect(site.target.host).toBe('a.test');
    expect(site.listing).toBe(false);
    expect(site.scorecard.public_listing).toBe(false);
  });

  test('an unfolded pair saved at the requested host carries that host stored listing', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: false }) });
    const site = await plan(env, { pair: unfolded, listing: true });
    expect(site.listing).toBe(false);
    expect(site.scorecard.public_listing).toBe(false);
  });

  test('a save-time read that fails leaves the listing resolved before the run, and the save still plans', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: false }) }, { reads: 'fail' });
    const site = await plan(env, { pair: null, listing: true });
    expect(site.listing).toBe(true);
    expect(site.scorecard.public_listing).toBe(true);
  });

  test('a www host saved as its own site after a recorded fold is unlisted when it has no record of its own', async () => {
    const env = await store({ 'a.test': stored('a.test', { listing: true, siteHosts: FOLD }) });
    const site = await plan(env, { pair: unfolded, listing: true, target: 'a.test', requested: 'www.a.test' });
    expect(site.target.host).toBe('www.a.test');
    expect(site.listing).toBe(false);
    expect(site.scorecard.public_listing).toBe(false);
  });

  test('a www host saved as its own site takes the listing its own record stores', async () => {
    const env = await store({
      'a.test': stored('a.test', { listing: true, siteHosts: FOLD }),
      'www.a.test': stored('www.a.test', { listing: true }),
    });
    const site = await plan(env, { pair: unfolded, listing: false, target: 'a.test', requested: 'www.a.test' });
    expect(site.listing).toBe(true);
  });
});
