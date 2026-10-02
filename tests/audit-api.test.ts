import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuditEvent } from '../src/shared/audit-events';
import { streamedResultLine, streamedRowHost } from '../src/shared/scoring-copy';
import { isAuditApiPath } from '../src/worker/audit/api';
import { keyFor as webKeyFor } from '../src/worker/audit-web/cache';
import { rowHostsOf } from '../src/worker/audit-web/provenance';
import { keyFor as cliKeyFor } from '../src/worker/score/cache';
import { _resetIndexCache } from '../src/worker/score/core';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import {
  CLI_RECORD,
  call,
  errorOf,
  makeCtx,
  makeEnv,
  ndjson,
  newTracker,
  post,
  WEB_RECORD,
} from './helpers/audit-api-env';
import { budgetKeyPrefix } from './helpers/domain-budget-fakes';
import { html, requestsTo, router, type Seen, siteDeclaring } from './helpers/follow-fixtures';
import { captureLogs } from './helpers/log-capture';

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

describe('POST /api/score: request contract', () => {
  test('the route predicate matches the endpoint only', () => {
    expect(isAuditApiPath('/api/score')).toBe(true);
    expect(isAuditApiPath('/api/score.md')).toBe(false);
    expect(isAuditApiPath('/api/audit-web')).toBe(false);
  });

  test('a text/plain body is rejected before any gate', async () => {
    const tracker = newTracker();
    const { res } = await call(post('target=anc.dev', { contentType: 'text/plain' }), makeEnv({ tracker }));
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe('invalid_body');
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a 129-character target is rejected with the shared error object before classification', async () => {
    const { res } = await call(post({ target: 'a'.repeat(129), turnstile_token: 'x' }), makeEnv());
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('target_too_long');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.cta.length).toBeGreaterThan(0);
  });

  test('the body names its subject with target; the retired input key is not a target', async () => {
    const viaTarget = await call(post({ target: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    expect(viaTarget.res.status).toBe(200);
    const viaInput = await call(post({ input: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    expect(viaInput.res.status).toBe(400);
    expect((await errorOf(viaInput.res)).code).toBe('target_empty');
  });
});

describe('POST /api/score: unmetered tiers', () => {
  test('a registry hit is one JSON body carrying the envelope and nothing beside it', async () => {
    const tracker = newTracker();
    const { res } = await call(
      post({ target: 'ripgrep', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ tracker }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown> & { scorecard: Record<string, unknown> };
    expect(body).toMatchObject({
      kind: 'cli',
      tier: 'registry',
      target: 'ripgrep',
      scorecard_url: 'https://anc.dev/score/ripgrep',
      json_url: 'https://anc.dev/score/ripgrep/json',
      score_pct: 92,
      spec_version: SPEC_VERSION,
      auditor_url: expect.any(String),
    });
    expect(body).not.toHaveProperty('share_url');
    // The endpoint's registry tier names the curated page; the scorecard body
    // itself comes from that page's json_url, so the envelope carries none.
    expect(body.scorecard).toBeNull();
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a cache-hit target with no client identity and a limiter that throws returns 200 and spends no budget (both lanes)', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      limiterThrows: true,
      cacheContent: {
        [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD('anc.dev'),
        [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD,
      },
    });
    const web = await call(post({ target: 'anc.dev' }, { ip: null }), env);
    expect(web.res.status).toBe(200);
    const webBody = (await web.res.json()) as Record<string, unknown>;
    expect(webBody).toMatchObject({
      kind: 'web',
      tier: 'cache',
      target: 'anc.dev',
      scorecard_url: 'https://anc.dev/score/anc.dev',
    });
    expect((webBody.freshness as { cached: boolean }).cached).toBe(true);
    const cli = await call(post({ target: 'cargo binstall ouch' }, { ip: null }), env);
    expect(cli.res.status).toBe(200);
    const cliBody = (await cli.res.json()) as Record<string, unknown>;
    expect(cliBody).toMatchObject({
      kind: 'cli',
      tier: 'cache',
      target: 'ouch',
      scorecard_url: 'https://anc.dev/score/ouch',
    });
    expect(cliBody).not.toHaveProperty('share_url');
    expect(tracker.limiterCalls).toEqual([]);
    expect(tracker.doCalls).toBe(0);
  });

  test('a website target the SSRF gate refuses returns 400 with no R2 read and no probe', async () => {
    for (const target of ['10.0.0.1', 'localhost', '[::1]', '0x7f000001']) {
      const tracker = newTracker();
      const { res } = await call(post({ target, turnstile_token: 'x' }), makeEnv({ tracker }));
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_target');
      expect(tracker.r2Gets).toEqual([]);
      expect(tracker.probeCalls).toEqual([]);
    }
  });

  test('?fromCache=false skips both cache tiers and still consults the registry', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const hit = await call(post({ target: 'ripgrep', turnstile_token: 'x' }, { query: '?fromCache=false' }), env);
    expect(((await hit.res.json()) as { tier: string }).tier).toBe('registry');
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { query: '?fromCache=false' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(tracker.r2Gets).toEqual([]);
    expect(tracker.doCalls).toBe(1);
  });
});

describe('POST /api/score: admission', () => {
  test('a missing token is 403 turnstile_failed and spends no limiter budget', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ target: 'cargo binstall ouch' }), makeEnv({ tracker }));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('turnstile_failed');
    expect(tracker.limiterCalls).toEqual([]);
  });

  test('a rejected token is 403 turnstile_failed', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'bad' }),
      makeEnv({ turnstile: 'reject' }),
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('turnstile_failed');
  });

  test('a siteverify transport failure, timeout, non-2xx, or malformed response is 503 turnstile_unavailable with retry_after', async () => {
    for (const mode of ['transport', 'timeout', 'non2xx', 'malformed'] as const) {
      const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: mode }));
      expect(res.status).toBe(503);
      const error = await errorOf(res);
      expect(error.code).toBe('turnstile_unavailable');
      expect(typeof error.retry_after).toBe('number');
      expect(res.headers.get('retry-after')).toBe(String(error.retry_after));
    }
  });

  test('a missing Turnstile secret is 503 turnstile_unavailable with retry_after (KTD3)', async () => {
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: 'no-secret' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await errorOf(res)).code).toBe('turnstile_unavailable');
  });

  test('a request with no cf-connecting-ip is denied before siteverify; an IPv6 client is keyed by its /48', async () => {
    const noIp = newTracker();
    const denied = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { ip: null }),
      makeEnv({ tracker: noIp }),
    );
    expect(denied.res.status).toBe(403);
    expect((await errorOf(denied.res)).code).toBe('turnstile_failed');
    expect(noIp.siteverifyCalls).toBe(0);
    const tracker = newTracker();
    const env = makeEnv({ tracker });
    await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { ip: '2001:db8:abcd:0012:0000:0000:0000:0001' }),
      env,
    );
    const hourly = tracker.kvPuts.find((k) => k.startsWith('audit:web:'));
    expect(hourly).toBeDefined();
    expect(hourly).toContain('2001:db8:abcd::/48');
  });

  test('a missing limiter or KV binding is service_misconfigured', async () => {
    const noLimiter = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ noLimiter: true }));
    expect(noLimiter.res.status).toBe(500);
    expect((await errorOf(noLimiter.res)).code).toBe('service_misconfigured');
    const noKv = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ noKv: true }));
    expect(noKv.res.status).toBe(500);
    expect((await errorOf(noKv.res)).code).toBe('service_misconfigured');
  });

  test('a rate-limited request returns JSON with retry_after and never opens a stream', async () => {
    const { res } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ limiter: false }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/json');
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: 'rate_limited', retry_after: 60 });
    expect(res.headers.get('retry-after')).toBe('60');
  });

  test('the two lanes share the shared error object on a limiter denial', async () => {
    const env = makeEnv({ limiter: false });
    const web = await errorOf((await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env)).res);
    const cli = await errorOf((await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env)).res);
    expect(Object.keys(web).sort()).toEqual(Object.keys(cli).sort());
    expect(web.code).toBe('rate_limited');
    expect(cli.code).toBe('rate_limited');
  });

  test('exhausting the CLI hourly window leaves the website window untouched for the same IP', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const env = makeEnv({ kvSeed: { [`audit:cli:203.0.113.9:${bucket}`]: '30' } });
    const cli = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(cli.res.status).toBe(429);
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }), env);
    expect(web.res.status).toBe(200);
  });

  test('the website kill switch denies the website lane while the CLI lane proceeds', async () => {
    const env = makeEnv({ webKill: true });
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(web.res.status).toBe(503);
    expect((await errorOf(web.res)).code).toBe('web_audit_disabled');
    const cli = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(cli.res.status).toBe(200);
  });

  test('the website kill switch still serves a stale hit as data', async () => {
    const stale = { ...WEB_RECORD('anc.dev'), scored_at: new Date(Date.now() - 600_000).toISOString() };
    const env = makeEnv({
      webKill: true,
      cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: stale },
    });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tier: string }).tier).toBe('cache');
  });

  test('the CLI kill switch denies the CLI lane with a Retry-After', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }),
      makeEnv({ cliKill: true }),
    );
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('scoring_disabled');
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  test('a passing admission mints the shared session cookie once', async () => {
    const env = makeEnv();
    const first = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const cookie = first.res.headers.get('set-cookie');
    expect(cookie).toContain('__Host-anc-session=');
    const value = cookie?.split(';')[0] ?? '';
    const second = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { cookie: value }), env);
    expect(second.res.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/score: response mode', () => {
  test('Accept x-ndjson on a website cache miss streams accepted first, then discovery and checks, then complete', async () => {
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = await ndjson(res);
    await Promise.all(ctx._promises);
    expect(lines[0]).toMatchObject({ type: 'accepted', lane: 'web', target: 'anc.dev' });
    expect(lines.some((l) => l.type === 'discovery')).toBe(true);
    expect(lines.some((l) => l.type === 'check')).toBe(true);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({
      type: 'complete',
      kind: 'web',
      tier: 'live',
      target: 'anc.dev',
      scorecard_url: 'https://anc.dev/score/anc.dev',
    });
    expect((last.freshness as { cached: boolean }).cached).toBe(false);
  });

  test('a plain Accept on a website cache miss yields one JSON envelope', async () => {
    const { res, ctx } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    await Promise.all(ctx._promises);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'web', tier: 'live', target: 'anc.dev', target_url: 'https://anc.dev/' });
  });

  test('a CLI cache miss with a plain Accept yields the envelope', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ tracker }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: 'cli',
      tier: 'live',
      target: 'ouch',
      scorecard_url: 'https://anc.dev/score/ouch',
      anc_version: ANC_VERSION,
    });
    expect(body).not.toHaveProperty('share_url');
    expect(tracker.doCalls).toBe(1);
  });

  test('a CLI cache miss with Accept x-ndjson streams accepted then the resolving phase then complete', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const lines = await ndjson(res);
    expect(lines[0]).toMatchObject({ type: 'accepted', lane: 'cli', target: 'cargo binstall ouch' });
    expect(lines[1]).toMatchObject({ type: 'phase', phase: 'resolving' });
    expect(lines[lines.length - 1]).toMatchObject({ type: 'complete', tier: 'live', target: 'ouch' });
  });

  test('a CLI bounce after accepted arrives as a bounce event with the shared error object', async () => {
    const { res } = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ doResponse: { error: 'chain_resolved_install_failed', details: 'cargo exploded' } }),
    );
    const lines = await ndjson(res);
    const last = lines[lines.length - 1] as { type: string; error: { code: string; details: string } };
    expect(last.type).toBe('bounce');
    expect(last.error).toMatchObject({ code: 'chain_resolved_install_failed', details: 'cargo exploded' });
  });
});

describe('POST /api/score: refresh and branch snapshots', () => {
  test('refresh: true with a cached binary record skips the cache and dispatches one run', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const { res } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x', refresh: true }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tier: string }).tier).toBe('live');
    expect(tracker.doCalls).toBe(1);
  });

  test('refresh: true without a valid token is 403 like any transact', async () => {
    const tracker = newTracker();
    const env = makeEnv({ tracker, cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } });
    const { res } = await call(post({ target: 'cargo binstall ouch', refresh: true }), env);
    expect(res.status).toBe(403);
    expect(tracker.doCalls).toBe(0);
  });

  test('refresh: true is a no-op on a registry hit and on the website lane', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: WEB_RECORD('anc.dev') },
    });
    const hit = await call(post({ target: 'ripgrep', turnstile_token: 'x', refresh: true }), env);
    expect(((await hit.res.json()) as { tier: string }).tier).toBe('registry');
    const web = await call(post({ target: 'anc.dev', turnstile_token: 'x', refresh: true }), env);
    expect(((await web.res.json()) as { tier: string }).tier).toBe('cache');
    expect(tracker.probeCalls).toEqual([]);
  });

  test('a tokened branch-target POST dispatches even with a snapshot; a tokenless one is 403 and reads no R2', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      cacheContent: { [cliKeyFor('o/r@main', SPEC_VERSION)]: CLI_RECORD },
      doResponse: {
        scorecard: { tool: { name: 'r', binary: 'r', version: null }, badge: { score_pct: 50, eligible: false } },
        anc_version: ANC_VERSION,
        source_sha: 'abc1234',
      },
    });
    const tokenless = await call(post({ target: 'o/r@main' }), env);
    expect(tokenless.res.status).toBe(403);
    expect(tracker.r2Gets).toEqual([]);
    const tokened = await call(post({ target: 'o/r@main', turnstile_token: 'x' }), env);
    expect(tokened.res.status).toBe(200);
    const body = (await tokened.res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tier: 'live',
      target: 'o/r@main',
      scorecard_url: 'https://anc.dev/score/o/r@main',
    });
    expect(tracker.doCalls).toBe(1);
  });
});

describe('POST /api/score: in-flight flags', () => {
  test('the input-keyed flag is written at accepted and deleted at the terminal line', async () => {
    const env = makeEnv();
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"accepted"');
    expect(env._kv.get('inflight:web:anc.dev')).toBeDefined();
    expect(JSON.parse(env._kv.get('inflight:web:anc.dev') ?? '{}')).toMatchObject({ started_at: expect.any(String) });
    while (!(await reader?.read())?.done) {}
    await Promise.all(ctx._promises);
    expect(env._kv.get('inflight:web:anc.dev')).toBeUndefined();
  });

  test('a tokenless POST returns 202 in_progress while the input is in flight and spends no budget', async () => {
    const tracker = newTracker();
    const env = makeEnv({
      tracker,
      kvSeed: { 'inflight:cli:cargo binstall ouch': JSON.stringify({ started_at: new Date().toISOString() }) },
    });
    const { res } = await call(post({ target: 'cargo binstall ouch' }), env);
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      in_progress: true,
      started_at: expect.any(String),
    });
    expect(tracker.limiterCalls).toEqual([]);
  });
});

describe('POST /api/score: telemetry', () => {
  test('the CLI lane emits one score.tier line per request on every branch that answers before a run', async () => {
    const seen = captureLogs();
    try {
      const tiers = async (req: Request, env: ReturnType<typeof makeEnv>) => {
        const before = seen.records.length;
        await call(req, env);
        return seen.records
          .slice(before)
          .filter((r) => r.record.scope === 'score.tier')
          .map((r) => r.record);
      };
      expect(await tiers(post({ target: 'cargo binstall ouch' }), makeEnv())).toEqual([
        expect.objectContaining({ tier: 'error_turnstile_failed', input_kind: 'install-command' }),
      ]);
      expect(
        await tiers(
          post({ target: 'cargo binstall ouch' }),
          makeEnv({ kvSeed: { 'inflight:cli:cargo binstall ouch': JSON.stringify({ started_at: 'x' }) } }),
        ),
      ).toEqual([expect.objectContaining({ tier: 'inflight' })]);
      expect(
        await tiers(
          post({ target: 'cargo binstall ouch', turnstile_token: 'x' }),
          makeEnv({ cacheContent: { [cliKeyFor('ouch', SPEC_VERSION)]: CLI_RECORD } }),
        ),
      ).toEqual([expect.objectContaining({ tier: 'cache_pre', cache_pre_hit: true, binary: 'ouch' })]);
      expect(
        await tiers(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ limiter: false })),
      ).toEqual([expect.objectContaining({ tier: 'error_rate_limited' })]);
      expect(await tiers(post({ target: 'apt install foo', turnstile_token: 'x' }), makeEnv())).toEqual([
        expect.objectContaining({ tier: expect.stringMatching(/^error_/), input_kind: 'unknown' }),
      ]);
    } finally {
      seen.restore();
    }
  });

  test('one audit.request line per call with lane, tier, and outcome', async () => {
    const seen = captureLogs();
    try {
      await call(post({ target: 'ripgrep', turnstile_token: 'x' }), makeEnv());
    } finally {
      seen.restore();
    }
    const rows = seen.records.filter((r) => r.record.scope === 'audit.request').map((r) => r.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'cli', tier: 'registry', outcome: 'hit' });
  });
});

describe('POST /api/score: review pins', () => {
  test('the website lane ignores ?fromCache=false: a fresh listed record is served with its listing kept and no flip budget spent', async () => {
    const tracker = newTracker();
    const listed = {
      ...WEB_RECORD('anc.dev'),
      scorecard: { ...WEB_RECORD('anc.dev').scorecard, public_listing: true },
    };
    const env = makeEnv({ tracker, cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: listed } });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }, { query: '?fromCache=false' }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tier: string; scorecard: { public_listing?: boolean } };
    expect(body.tier).toBe('cache');
    expect(body.scorecard.public_listing).toBe(true);
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.limiterCalls).toEqual([]);
    expect(tracker.kvPuts.some((k) => k.startsWith('web_audit_flip:'))).toBe(false);
  });

  test('?fromCache=false bypasses the in-flight flag on the CLI lane (KTD14) while refresh: true attaches', async () => {
    const flag = JSON.stringify({ started_at: new Date().toISOString() });
    const env = makeEnv({ kvSeed: { 'inflight:cli:cargo binstall ouch': flag } });
    const attached = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x', refresh: true }), env);
    expect(attached.res.status).toBe(202);
    const hatch = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { query: '?fromCache=false' }),
      makeEnv({ kvSeed: { 'inflight:cli:cargo binstall ouch': flag } }),
    );
    expect(hatch.res.status).toBe(200);
    expect(((await hatch.res.json()) as { tier: string }).tier).toBe('live');
  });

  test('a body carrying only the retired input key is refused before any probe, R2 read, or budget', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ input: 'anc.dev', turnstile_token: 'x' }), makeEnv({ tracker }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('target_empty');
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.r2Gets).toEqual([]);
    expect(tracker.limiterCalls).toEqual([]);
    const viaTarget = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv());
    expect(viaTarget.res.status).toBe(200);
  });

  test('body validation: invalid JSON, a non-object body, no target, a bad site_type, and a non-boolean public_listing are each 400 with their code and no top-level status', async () => {
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['not json', 'invalid_body'],
      ['null', 'invalid_body'],
      ['[]', 'invalid_body'],
      [{}, 'target_empty'],
      [{ target: 'anc.dev', site_type: 'bogus' }, 'invalid_site_type'],
      [{ target: 'anc.dev', public_listing: 'yes' }, 'invalid_public_listing'],
    ];
    for (const [body, code] of cases) {
      const { res } = await call(post(body), makeEnv());
      expect(res.status).toBe(400);
      const json = (await res.json()) as { status?: unknown; error: { code: string } };
      expect(json.error.code).toBe(code);
      expect(json.status).toBeUndefined();
    }
  });

  test('a streamed run emits its audit.request row from the relay with the terminal outcome', async () => {
    const seen = captureLogs();
    try {
      const { res, ctx } = await call(
        post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
        makeEnv(),
      );
      await res.text();
      await Promise.all(ctx._promises);
    } finally {
      seen.restore();
    }
    const rows = seen.records.filter((r) => r.record.scope === 'audit.request').map((r) => r.record);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'web', tier: 'live', outcome: 'complete', status: 200, stream: true });
  });

  test('a throw from the CLI core yields a terminal error line on the stream, a 500 error object on the JSON path, and clears the flag', async () => {
    const env = makeEnv({ doThrows: true });
    const stream = await call(
      post({ target: 'cargo binstall ouch', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const lines = await ndjson(stream.res);
    await Promise.all(stream.ctx._promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'incomplete_response_contract' } });
    expect([...env._kv.keys()].some((k) => k.startsWith('inflight:'))).toBe(false);
    const json = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), makeEnv({ doThrows: true }));
    expect(json.res.status).toBe(500);
    expect((await errorOf(json.res)).code).toBe('incomplete_response_contract');
  });

  test('a heartbeat never follows the terminal line', async () => {
    const { res, ctx } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv(),
    );
    const lines = await ndjson(res);
    await Promise.all(ctx._promises);
    expect(lines[lines.length - 1].type).toBe('complete');
  });

  test('an unreachable website target ends the stream with an error event and answers 502 on the JSON path', async () => {
    const stream = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      makeEnv({ probe: 'unreachable' }),
    );
    const lines = await ndjson(stream.res);
    await Promise.all(stream.ctx._promises);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', error: { code: 'unreachable' } });
    const json = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ probe: 'unreachable' }));
    expect(json.res.status).toBe(502);
    expect((await errorOf(json.res)).code).toBe('unreachable');
  });

  test('a differing explicit public_listing on a fresh website record is patched in place; the flip ceiling answers 429; a failed write answers 500', async () => {
    const key = await webKeyFor('https://anc.dev/', SPEC_VERSION);
    const listed = {
      ...WEB_RECORD('anc.dev'),
      scorecard: { ...WEB_RECORD('anc.dev').scorecard, public_listing: true },
    };
    const tracker = newTracker();
    const patched = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ tracker, cacheContent: { [key]: listed } }),
    );
    expect(patched.res.status).toBe(200);
    const body = (await patched.res.json()) as { tier: string; scorecard: { public_listing?: boolean } };
    expect(body.tier).toBe('cache');
    expect(body.scorecard.public_listing).toBe(false);
    expect(tracker.probeCalls).toEqual([]);
    expect(tracker.kvPuts.some((k) => k.startsWith('web_audit_flip:'))).toBe(true);

    const bucket = Math.floor(Date.now() / 3_600_000);
    const flipKey = tracker.kvPuts.find((k) => k.startsWith('web_audit_flip:')) ?? '';
    expect(flipKey.endsWith(`:${bucket}`)).toBe(true);
    const capped = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ cacheContent: { [key]: listed }, kvSeed: { [flipKey]: '5' } }),
    );
    expect(capped.res.status).toBe(429);
    expect((await errorOf(capped.res)).code).toBe('flip_rate_limited');

    const failed = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', public_listing: false }),
      makeEnv({ cacheContent: { [key]: listed }, cachePutThrows: true }),
    );
    expect(failed.res.status).toBe(500);
    expect((await errorOf(failed.res)).code).toBe('patch_failed');
  });

  test('the website lane draws from the hourly bucket the legacy route and the MCP tool share', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const env = makeEnv({ kvSeed: { [`audit:web:203.0.113.9:${bucket}`]: '30' } });
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
  });

  test('the result-keyed in-flight twin exists before the sandbox dispatch', async () => {
    let twinAtDispatch = false;
    const env = makeEnv({
      onDoFetch: () => {
        twinAtDispatch = env._kv.has('inflight:cli:ouch');
      },
    });
    const { res, ctx } = await call(post({ target: 'cargo binstall ouch', turnstile_token: 'x' }), env);
    expect(res.status).toBe(200);
    await Promise.all(ctx._promises);
    expect(twinAtDispatch).toBe(true);
    expect(env._kv.has('inflight:cli:ouch')).toBe(false);
  });

  test('a post-mint denial still sets the session cookie and its body carries no server detail', async () => {
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ limiter: false }));
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toContain('__Host-anc-session=');
    const noSecret = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), makeEnv({ turnstile: 'no-secret' }));
    expect(await noSecret.res.text()).not.toMatch(/TURNSTILE_SECRET|binding missing|limiter failed|no client address/);
    const unavailable = await call(
      post({ target: 'anc.dev', turnstile_token: 'x' }),
      makeEnv({ turnstile: 'transport' }),
    );
    const unavailableBody = (await unavailable.res.json()) as { error: { details?: string } };
    expect(unavailableBody.error.details).toBeUndefined();
  });
});

describe('POST /api/score: the follow kill switch', () => {
  type Stored = {
    scorecard: { follow_declarations?: boolean; declared_hosts?: Array<{ outcome: string; reason?: string }> };
  };

  async function storedRecord(env: ReturnType<typeof makeEnv>, url: string): Promise<Stored> {
    const object = await env.SCORE_CACHE.get(await webKeyFor(url, SPEC_VERSION));
    if (!object) throw new Error(`nothing stored for ${url}`);
    return (await object.json()) as Stored;
  }

  test('with the switch off or absent, a followed request stores follow_declarations false and an empty trail', async () => {
    for (const followSwitch of [undefined, 'false', 'TRUE']) {
      const env = makeEnv(followSwitch === undefined ? {} : { followSwitch });
      const { res, ctx } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), env);
      expect(res.status).toBe(200);
      await Promise.all(ctx._promises);
      const stored = await storedRecord(env, 'https://anc.dev/');
      expect({ followSwitch, follow: stored.scorecard.follow_declarations }).toEqual({ followSwitch, follow: false });
      expect(stored.scorecard.declared_hosts).toEqual([]);
    }
    const on = makeEnv({ followSwitch: 'true' });
    const { ctx } = await call(post({ target: 'anc.dev', turnstile_token: 'x' }), on);
    await Promise.all(ctx._promises);
    expect((await storedRecord(on, 'https://anc.dev/')).scorecard.follow_declarations).toBe(true);
  });

  test('with the switch off, a host the site declares receives no request', async () => {
    const endpoint = 'https://mcp.example.net/mcp';
    const run = async (followSwitch: string) => {
      const seen: Seen[] = [];
      const env = makeEnv({ followSwitch, deps: { probeFetch: router(siteDeclaring(endpoint), seen) } });
      const { res, ctx } = await call(post({ target: 'example.com', turnstile_token: 'x' }), env);
      expect(res.status).toBe(200);
      await Promise.all(ctx._promises);
      const stored = await storedRecord(env, 'https://example.com/');
      return { requests: requestsTo(seen, 'mcp.example.net').length, trail: stored.scorecard.declared_hosts ?? [] };
    };
    const off = await run('false');
    expect(off.requests).toBe(0);
    expect(off.trail.length).toBeGreaterThan(0);
    expect(off.trail.every((entry) => entry.reason === 'follow-disabled')).toBe(true);
    // Control: with the switch on, the same site's declared host is reached.
    expect((await run('true')).requests).toBeGreaterThan(0);
  });
});

describe('POST /api/score: streamed checks name their host and reason', () => {
  test('a check on a host that did not confirm its endpoint streams both, and the line the saved result shows', async () => {
    const env = makeEnv({
      followSwitch: 'true',
      deps: { probeFetch: router(siteDeclaring('https://mcp.example.net/mcp'), []) },
    });
    const { res, ctx } = await call(
      post({ target: 'example.com', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const lines = (await ndjson(res)) as AuditEvent[];
    await Promise.all(ctx._promises);
    const refused = lines.filter(
      (l): l is Extract<AuditEvent, { type: 'check' }> => l.type === 'check' && l.na_reason === 'reciprocity-refused',
    );
    expect(refused.length).toBeGreaterThan(0);
    expect([...new Set(refused.map((c) => c.host))]).toEqual(['mcp.example.net']);
    const complete = lines.at(-1) as Extract<AuditEvent, { type: 'complete' }>;
    const saved = (complete.scorecard as { results: Array<{ id: string; result: string }> }).results;
    for (const check of refused) {
      expect({ id: check.id, line: streamedResultLine(check, 'example.com') }).toEqual({
        id: check.id,
        line: saved.find((r) => r.id === check.id)?.result ?? null,
      });
    }
    expect(streamedResultLine(refused[0], 'example.com')).toStartWith(
      'Not evaluated: mcp.example.net did not confirm this endpoint',
    );
  });

  test('a check over two API hosts that did not answer streams both, the line the saved result shows, and its hosts', async () => {
    const description = (host: string) => `https://${host}/openapi.json`;
    const anchors = ['api.example.net', 'files.example.net'].map((host) => ({
      anchor: `https://${host}/`,
      'service-desc': [{ href: description(host), type: 'application/openapi+json' }],
    }));
    const down = () => {
      throw new Error('connection refused');
    };
    const routes = {
      'GET https://example.com/': () => html(),
      'GET https://example.com/.well-known/api-catalog': () =>
        new Response(JSON.stringify({ linkset: anchors }), { headers: { 'content-type': 'application/linkset+json' } }),
      [`GET ${description('api.example.net')}`]: down,
      [`GET ${description('files.example.net')}`]: down,
    };
    const env = makeEnv({ followSwitch: 'true', deps: { probeFetch: router(routes, []) } });
    const { res, ctx } = await call(
      post({ target: 'example.com', turnstile_token: 'x' }, { accept: 'application/x-ndjson' }),
      env,
    );
    const lines = (await ndjson(res)) as AuditEvent[];
    await Promise.all(ctx._promises);
    const complete = lines.at(-1) as Extract<AuditEvent, { type: 'complete' }>;
    type SavedRow = { id: string; result: string; hosts?: Array<{ host: string }> };
    const saved = (complete.scorecard as { results: SavedRow[] }).results;
    const overTwo = saved.filter((r) => (r.hosts?.length ?? 0) > 1);
    const checks = lines.filter(
      (l): l is Extract<AuditEvent, { type: 'check' }> => l.type === 'check' && overTwo.some((r) => r.id === l.id),
    );
    expect(checks.map((c) => c.id)).toContain('openapi');
    for (const check of checks) {
      const row = overTwo.find((r) => r.id === check.id);
      expect({ id: check.id, line: streamedResultLine(check, 'example.com') }).toEqual({
        id: check.id,
        line: row?.result ?? null,
      });
      expect({ id: check.id, host: streamedRowHost(check, 'example.com') }).toEqual({
        id: check.id,
        host: rowHostsOf(row ?? {}, 'example.com').join(' '),
      });
    }
    const openapi = checks.find((c) => c.id === 'openapi');
    expect(openapi === undefined ? null : streamedResultLine(openapi, 'example.com')).toBe(
      'Not evaluated: api.example.net did not answer (https://api.example.net/openapi.json); api.example.net: n/a, files.example.net: n/a',
    );
  });
});

describe('POST /api/score: the declared-domain budget', () => {
  const endpoint = 'https://mcp.example.net/mcp';

  async function followed(overrides: Parameters<typeof makeEnv>[0] = {}) {
    const seen: Seen[] = [];
    const env = makeEnv({
      followSwitch: 'true',
      deps: { probeFetch: router(siteDeclaring(endpoint), seen) },
      ...overrides,
    });
    const { res, ctx } = await call(post({ target: 'example.com', turnstile_token: 'x' }), env);
    expect(res.status).toBe(200);
    await Promise.all(ctx._promises);
    const object = await env.SCORE_CACHE.get(await webKeyFor('https://example.com/', SPEC_VERSION));
    const stored = (await object?.json()) as { scorecard: { declared_hosts?: Array<Record<string, unknown>> } };
    const prefix = await budgetKeyPrefix('example.net');
    const units = [...env._kv.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    return { trail: stored.scorecard.declared_hosts ?? [], sent: requestsTo(seen, 'mcp.example.net').length, units };
  }

  test("a followed audit reserves one unit of the declared domain's hour before reaching it", async () => {
    const { units, sent } = await followed();
    expect(units).toEqual(['1']);
    expect(sent).toBeGreaterThan(0);
  });

  test('a declared domain whose hour is spent is budget-exceeded and receives nothing', async () => {
    const prefix = await budgetKeyPrefix('example.net');
    const hour = Math.floor(Date.now() / 3_600_000);
    // The next hour too, so a run that crosses the hour boundary still finds it spent.
    const kvSeed = { [`${prefix}${hour}`]: '9999', [`${prefix}${hour + 1}`]: '9999' };
    const { trail, sent } = await followed({ kvSeed });
    expect(trail[0]).toMatchObject({ outcome: 'budget-exceeded', cause: 'domain-budget' });
    expect(sent).toBe(0);
  });
});

describe('POST /api/score: a run that does not follow declared hosts', () => {
  const NOT_SAVED = 'Not saved: declared hosts were not followed for this run.';

  type Watched = ReturnType<typeof makeEnv> & { puts: string[] };

  // The endpoint env with every R2 write recorded.
  function watchedEnv(overrides: Parameters<typeof makeEnv>[0] = {}): Watched {
    const env = makeEnv(overrides);
    const puts: string[] = [];
    const bucket = env.SCORE_CACHE;
    const put = bucket.put.bind(bucket);
    bucket.put = ((key: string, ...rest: Parameters<R2Bucket['put']> extends [string, ...infer R] ? R : never) => {
      puts.push(key);
      return put(key, ...rest);
    }) as R2Bucket['put'];
    return Object.assign(env, { puts });
  }

  // A context whose purge RPC records every tag batch the run queued.
  function purgeCtx(): ReturnType<typeof makeCtx> & { purged: string[][] } {
    const purged: string[][] = [];
    const ctx = makeCtx();
    return Object.assign(ctx, {
      purged,
      exports: {
        Cached: {
          async purgeHitMinTags(tags: string[]) {
            purged.push(tags);
            return { success: true, errors: [] };
          },
        },
      },
    });
  }

  const fresh = () => ({
    ...WEB_RECORD('anc.dev'),
    scorecard: { ...WEB_RECORD('anc.dev').scorecard, public_listing: true },
  });

  test('the parser rejects a non-boolean follow_declarations with a 400 naming the field', async () => {
    for (const value of ['false', 0, null]) {
      const { res } = await call(
        post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: value }),
        makeEnv(),
      );
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('invalid_follow_declarations');
      expect(error.message).toContain('follow_declarations');
    }
  });

  test('a fresh stored scorecard does not answer it: the run audits, returns no URLs, and writes nothing', async () => {
    const env = watchedEnv({ cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: fresh() } });
    const ctx = purgeCtx();
    const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false }), env, ctx);
    expect(res.status).toBe(200);
    await Promise.all(ctx._promises);
    const body = (await res.json()) as Record<string, unknown> & { scorecard: Record<string, unknown> };
    expect(body).toMatchObject({ kind: 'web', tier: 'live', scorecard_url: null, markdown_url: null, json_url: null });
    expect(body.scorecard.follow_declarations).toBe(false);
    expect(body.scorecard.public_listing).toBe(true);
    expect(String(body.summary_html)).toContain(NOT_SAVED);
    expect(env.puts).toEqual([]);
    expect(ctx.purged).toEqual([]);
  });

  test('with audits disabled it gets the disabled error, never the stored followed scorecard', async () => {
    const stale = { ...fresh(), scored_at: new Date(Date.now() - 600_000).toISOString() };
    for (const record of [fresh(), stale]) {
      const env = makeEnv({
        webKill: true,
        cacheContent: { [await webKeyFor('https://anc.dev/', SPEC_VERSION)]: record },
      });
      const { res } = await call(post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false }), env);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('web_audit_disabled');
    }
  });

  test('with no turnstile_token it gets the tokenless answer and spends nothing: no siteverify, no limiter, no engine', async () => {
    const tracker = newTracker();
    const { res } = await call(post({ target: 'anc.dev', follow_declarations: false }), makeEnv({ tracker }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: 'turnstile_failed', cta: 'Start the audit from the page.' });
    expect(tracker).toMatchObject({ siteverifyCalls: 0, limiterCalls: [], probeCalls: [] });
  });

  test('a request admission refuses gets that refusal and runs no engine', async () => {
    const bucket = Math.floor(Date.now() / 3_600_000);
    const refusals: Array<{ overrides: Parameters<typeof makeEnv>[0]; status: number; code: string }> = [
      { overrides: { limiter: false }, status: 429, code: 'rate_limited' },
      { overrides: { ipLimiter: false }, status: 429, code: 'rate_limited' },
      { overrides: { kvSeed: { [`audit:web:203.0.113.9:${bucket}`]: '30' } }, status: 429, code: 'rate_limited' },
      { overrides: { turnstile: 'reject' }, status: 403, code: 'turnstile_failed' },
      { overrides: { turnstile: 'transport' }, status: 503, code: 'turnstile_unavailable' },
    ];
    for (const refusal of refusals) {
      const tracker = newTracker();
      const { res } = await call(
        post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false }),
        makeEnv({ tracker, ...refusal.overrides }),
      );
      const body = (await res.json()) as { error?: { code: string } };
      expect({ status: res.status, code: body.error?.code, probes: tracker.probeCalls }).toEqual({
        status: refusal.status,
        code: refusal.code,
        probes: [],
      });
    }
  });

  test('it streams its rows and ends on a complete line with no URLs, marking no in-flight flag', async () => {
    const env = watchedEnv();
    const ctx = purgeCtx();
    const { res } = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false }, { accept: 'application/x-ndjson' }),
      env,
      ctx,
    );
    const lines = await ndjson(res);
    await Promise.all(ctx._promises);
    expect(lines[0]).toMatchObject({ type: 'accepted', lane: 'web', target: 'anc.dev' });
    expect(lines.some((l) => l.type === 'check')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'complete', scorecard_url: null, markdown_url: null, json_url: null });
    expect(String(lines.at(-1)?.summary_html)).toContain(NOT_SAVED);
    expect([...env._kv.keys()].filter((key) => key.startsWith('inflight:'))).toEqual([]);
    expect(env.puts).toEqual([]);
    expect(ctx.purged).toEqual([]);
  });

  test('a public_listing that differs from the stored choice is rejected; the stored choice runs', async () => {
    const key = await webKeyFor('https://anc.dev/', SPEC_VERSION);
    const listed = makeEnv({ cacheContent: { [key]: fresh() } });
    const refused = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false, public_listing: false }),
      listed,
    );
    expect(refused.res.status).toBe(400);
    expect((await errorOf(refused.res)).code).toBe('listing_requires_follow');
    const same = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false, public_listing: true }),
      listed,
    );
    expect(same.res.status).toBe(200);
    await Promise.all(same.ctx._promises);
    // No stored record: the standing choice is unlisted, so asking to list is a change.
    const first = await call(
      post({ target: 'anc.dev', turnstile_token: 'x', follow_declarations: false, public_listing: true }),
      makeEnv(),
    );
    expect(first.res.status).toBe(400);
    expect((await errorOf(first.res)).code).toBe('listing_requires_follow');
  });
});
