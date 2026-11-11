// POST /api/score for a host and its www sibling: which host a saved audit is
// stored under, what its write deletes and purges, which listing it carries,
// and how a request for either host is keyed once a fold is recorded.

import { beforeEach, describe, expect, test } from 'bun:test';
import { sha256Hex, keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { _resetIndexCache } from '../src/worker/score/core';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { call, makeEnv, newTracker, post, purgeCtx, WEB_RECORD } from './helpers/audit-api-env';
import { html, redirect, router, type Seen } from './helpers/follow-fixtures';

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

const STALE_MS = 10 * 60_000;

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
