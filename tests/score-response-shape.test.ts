// /api/score response-shape contract tests.
//
// Plan U5 — every variant of the ScoreError discriminated union must:
//   1. Map to the documented HTTP status (statusForError).
//   2. Carry the R11 triad (spec_version + auditor_url) on the wire.
//   3. Honor Retry-After when the variant declares retry_after (rate_limited
//      and scoring_disabled).
//
// Triad enforcement: shapeScoreSuccess refuses to emit a partial response
// (missing anc_version → 500 with `incomplete_response_contract`). The
// exhaustiveness check via assertNever() in statusForError() is exercised
// here by enumerating every variant — adding a new variant without
// extending statusForError() makes this file fail to compile.

import { describe, expect, test } from 'bun:test';
import { buildCliEnvelope, buildWebEnvelope } from '../src/shared/audit-envelope';
import {
  type ScoreError,
  shapeAuditSuccess,
  shapeScoreError,
  shapeScoreSuccess,
  statusForError,
  toAuditError,
} from '../src/worker/score/response-shape';
import { ANC_VERSION, AUDITOR_URL, SITE_SPEC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

// One representative of every ScoreError variant — exhaustiveness here is
// what gives us coverage of the assertNever() guard inside statusForError.
const ALL_ERRORS: readonly ScoreError[] = [
  { code: 'invalid_url', details: 'not a url', cta_text: '...' },
  { code: 'non_https_url', cta_text: '...' },
  { code: 'non_github_host', cta_text: '...' },
  { code: 'invalid_url_path', cta_text: '...' },
  { code: 'unrecognized_input', cta_text: '...' },
  { code: 'unparseable_install_command', details: 'foo', cta_text: '...' },
  { code: 'chain_no_resolve', cta_text: '...' },
  { code: 'github_repo_not_accessible', cta_text: '...' },
  { code: 'discovery_redirect_loop', cta_text: '...' },
  { code: 'rate_limited', retry_after: 42, cta_text: '...' },
  { code: 'install_unsupported', pm: 'brew', cta_text: '...' },
  { code: 'chain_resolved_install_failed', details: 'apt', cta_text: '...' },
  { code: 'chain_resolved_no_binary_produced', details: 'empty', cta_text: '...' },
  { code: 'timeout', phase: 'install', cta_text: '...' },
  { code: 'turnstile_failed', cta_text: '...' },
  { code: 'scoring_disabled', cta_text: '...' },
  { code: 'sandbox_stub_until_u6', cta_text: '...' },
  { code: 'sandbox_unavailable', cta_text: '...' },
  { code: 'incomplete_response_contract', details: 'no anc', cta_text: '...' },
  { code: 'service_misconfigured', details: 'missing secret', cta_text: '...' },
];

describe('statusForError — HTTP status mapping per variant', () => {
  const cases: Array<[ScoreError['code'], number]> = [
    ['invalid_url', 400],
    ['non_https_url', 400],
    ['non_github_host', 400],
    ['invalid_url_path', 400],
    ['unrecognized_input', 400],
    ['unparseable_install_command', 400],
    ['turnstile_failed', 400],
    ['chain_no_resolve', 404],
    ['rate_limited', 429],
    ['install_unsupported', 502],
    ['chain_resolved_install_failed', 502],
    ['chain_resolved_no_binary_produced', 502],
    ['discovery_redirect_loop', 502],
    ['timeout', 504],
    ['scoring_disabled', 503],
    ['sandbox_stub_until_u6', 503],
    ['incomplete_response_contract', 500],
    ['service_misconfigured', 500],
  ];
  for (const [code, want] of cases) {
    test(`${code} → ${want}`, () => {
      const err = ALL_ERRORS.find((e) => e.code === code);
      expect(err).toBeDefined();
      if (!err) return;
      expect(statusForError(err)).toBe(want);
    });
  }
});

describe('shapeScoreError — wire shape + headers', () => {
  test('every variant carries spec_version + auditor_url', async () => {
    for (const e of ALL_ERRORS) {
      const res = shapeScoreError(e);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.spec_version).toBe(SPEC_VERSION);
      expect(body.auditor_url).toBe(AUDITOR_URL);
      expect((body.error as { code: string }).code).toBe(e.code);
    }
  });

  test('rate_limited carries Retry-After matching retry_after', () => {
    const res = shapeScoreError({ code: 'rate_limited', retry_after: 17, cta_text: '...' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
  });

  test('scoring_disabled carries Retry-After: 3600', () => {
    const res = shapeScoreError({ code: 'scoring_disabled', cta_text: '...' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  test('live JSON sets Cache-Control: no-store + CORS *', () => {
    const res = shapeScoreError({ code: 'unrecognized_input', cta_text: '...' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  test('cache-hit freshness sets browser max-age=300 with CDN no-store and no Vary (the handler stamps Vary from the request path)', () => {
    const res = shapeScoreError({ code: 'unrecognized_input', cta_text: '...' }, 'cache-hit');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(res.headers.get('Vary')).toBeNull();
  });
});

describe('shapeScoreSuccess — R11 triad enforcement', () => {
  test('happy path: scorecard + anc_version → 200 with triad', async () => {
    const res = shapeScoreSuccess({ name: 'ripgrep' }, '0.3.0', 'live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.spec_version).toBe(SPEC_VERSION);
    expect(body.anc_version).toBe('0.3.0');
    expect(body.auditor_url).toBe(AUDITOR_URL);
    expect(body.scorecard).toEqual({ name: 'ripgrep' });
  });

  test('missing anc_version → 500 incomplete_response_contract (never a quiet partial)', async () => {
    const res = shapeScoreSuccess({ name: 'ripgrep' }, null, 'live');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('incomplete_response_contract');
  });

  test('cache-hit freshness uses cached cache-control and no Vary', () => {
    const res = shapeScoreSuccess({}, '0.3.0', 'cache-hit');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('live freshness uses no-store', () => {
    const res = shapeScoreSuccess({}, '0.3.0', 'live');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('toAuditError — every ScoreError variant becomes the shared error object', () => {
  test('each variant maps to a shared code with a message and a cta', () => {
    for (const e of ALL_ERRORS) {
      const { error } = toAuditError(e);
      expect(typeof error.code).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.cta).toBe(e.cta_text);
      expect(error).not.toHaveProperty('cta_text');
    }
  });

  test('details, retry_after, and pm survive; the stub code maps to sandbox_unavailable', () => {
    expect(toAuditError({ code: 'rate_limited', retry_after: 42, cta_text: 'c' }).error).toMatchObject({
      code: 'rate_limited',
      retry_after: 42,
    });
    expect(toAuditError({ code: 'install_unsupported', pm: 'brew_only', cta_text: 'c' }).error).toMatchObject({
      code: 'install_unsupported',
      pm: 'brew_only',
    });
    expect(toAuditError({ code: 'chain_resolved_install_failed', details: 'apt', cta_text: 'c' }).error).toMatchObject({
      details: 'apt',
    });
    expect(toAuditError({ code: 'sandbox_stub_until_u6', cta_text: 'c' }).error.code).toBe('sandbox_unavailable');
    expect(toAuditError({ code: 'timeout', phase: 'install', cta_text: 'c' }).error.message).toContain('time budget');
  });
});

describe('shapeAuditSuccess — the envelope beside the legacy triad', () => {
  const envelope = buildCliEnvelope({
    tier: 'cache',
    target: 'fd',
    record: {
      spec_version: SPEC_VERSION,
      anc_version: ANC_VERSION,
      tool_version: '1.0.0',
      scorecard: { badge: { score_pct: 80 }, run: { started_at: '2026-09-10T00:00:00.000Z' } },
    },
    registry: { by_slug: {} },
    origin: 'https://anc.dev',
  });

  test('the body is the envelope plus site_spec_version, anc_version, auditor_url, and share_url', async () => {
    const res = shapeAuditSuccess(envelope, { share_url: 'https://anc.dev/score/live/fd' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: 'cli',
      tier: 'cache',
      target: 'fd',
      scorecard_url: 'https://anc.dev/score/fd',
      spec_version: SPEC_VERSION,
      site_spec_version: SITE_SPEC_VERSION,
      anc_version: ANC_VERSION,
      auditor_url: AUDITOR_URL,
      share_url: 'https://anc.dev/score/live/fd',
    });
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  });

  test('a live envelope is served no-store and omits share_url when none is given', async () => {
    const res = shapeAuditSuccess({ ...envelope, tier: 'live', freshness: { ...envelope.freshness, cached: false } });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('share_url');
  });

  test('a CLI envelope without anc_version is refused with the shared error object', async () => {
    const { anc_version: _omitted, ...bare } = envelope;
    const res = shapeAuditSuccess(bare);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: 'incomplete_response_contract',
      message: expect.any(String),
      cta: expect.any(String),
    });
    expect(body.error).not.toHaveProperty('cta_text');
  });

  test('a website envelope carries no anc_version and is served as-is', async () => {
    const web = buildWebEnvelope({
      tier: 'cache',
      target: 'anc.dev',
      record: {
        spec_version: SPEC_VERSION,
        target_url: 'https://anc.dev/',
        scorecard: { score_pct: 76 },
        scored_at: '2026-09-10T00:00:00.000Z',
      },
      origin: 'https://anc.dev',
    });
    const res = shapeAuditSuccess(web);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'web', target: 'anc.dev', auditor_url: AUDITOR_URL });
    expect(body).not.toHaveProperty('anc_version');
  });

  test('the legacy and the audit shaper agree on the triad, share_url, and headers for one cache hit', async () => {
    const share = 'https://anc.dev/score/live/fd';
    const legacy = shapeScoreSuccess(envelope.scorecard, envelope.anc_version, 'cache-hit', share);
    const audit = shapeAuditSuccess(envelope, { share_url: share });
    const a = (await legacy.json()) as Record<string, unknown>;
    const b = (await audit.json()) as Record<string, unknown>;
    for (const key of ['spec_version', 'site_spec_version', 'anc_version', 'auditor_url', 'share_url', 'scorecard']) {
      expect(b[key]).toEqual(a[key]);
    }
    for (const header of [
      'Cache-Control',
      'Cloudflare-CDN-Cache-Control',
      'Content-Type',
      'Access-Control-Allow-Origin',
    ]) {
      expect(audit.headers.get(header)).toBe(legacy.headers.get(header));
    }
  });

  test('a timeout names its phase in the shared message', () => {
    expect(toAuditError({ code: 'timeout', phase: 'install', cta_text: 'c' }).error.message).toContain('install');
    expect(toAuditError({ code: 'timeout', phase: 'score', cta_text: 'c' }).error.message).toContain('score');
  });
});
