// The result envelope is a read-time wrapper: every consumer (the JSON
// representation, the complete event, the MCP read tools, the renderers)
// builds it from the same stored record through the same builder, so the
// scorecard and the freshness fields cannot differ between surfaces.

import { describe, expect, test } from 'bun:test';
import {
  buildCliEnvelope,
  buildRegistryEnvelope,
  buildWebEnvelope,
  freshnessFor,
  LIVE_CLI_LIFECYCLE_MS,
  type RegistryIndexLike,
  WEB_AUDIT_STALE_AFTER_MS,
} from '../src/shared/audit-envelope';
import {
  AUDIT_ERROR_MESSAGES,
  type AuditErrorCode,
  auditError,
  auditErrorCodeFor,
  auditErrorFor,
  completeEvent,
  LEGACY_CLI_ERROR_CODES,
  LEGACY_WEB_ERROR_CODES,
} from '../src/shared/audit-events';
import { REJECTION_MESSAGES } from '../src/shared/audit-routes';
import { webAuditFreshness } from '../src/worker/audit-web/cache';
import type { ScoreError } from '../src/worker/score/response-shape';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const ORIGIN = 'https://staging.example';
const SCORED_AT = '2026-09-10T12:00:00.000Z';

const registry: RegistryIndexLike = {
  by_slug: {
    ripgrep: {
      name: 'ripgrep',
      binary: 'rg',
      scorecard_url: '/score/ripgrep',
      score_pct: 92,
      anc_version: ANC_VERSION,
    },
    ouch: { name: 'ouch', binary: 'ouch-bin', scorecard_url: '/score/ouch', score_pct: 70, anc_version: ANC_VERSION },
  },
};

function cliScorecard(binary: string) {
  return {
    spec_version: SPEC_VERSION,
    tool: { name: binary, binary, version: '1.2.3' },
    badge: { score_pct: 80, eligible: true, embed_markdown: '[![agent-native](badge)](x)' },
    run: { started_at: SCORED_AT, duration_ms: 1200 },
    results: [{ status: 'pass', label: 'help', group: 'P1', evidence: null }],
  };
}

function cliRecord(binary: string) {
  return {
    spec_version: SPEC_VERSION,
    anc_version: ANC_VERSION,
    tool_version: '1.2.3',
    scorecard: cliScorecard(binary),
    sandbox_path: '/tmp/sandbox/run-1',
    stderr: 'boom: install log',
    session_id: 'sid-123',
  };
}

const webRecord = {
  spec_version: SPEC_VERSION,
  target_url: 'https://anc.dev/',
  scorecard: { target_url: 'https://anc.dev/', score_pct: 76, results: [] },
  scored_at: SCORED_AT,
  session_id: 'sid-123',
};

describe('envelope builders', () => {
  test('a cached CLI record and a cached web record wrap the stored scorecard byte-identically', () => {
    const record = cliRecord('fd');
    const cli = buildCliEnvelope({ tier: 'cache', target: 'fd', record, registry, origin: ORIGIN });
    expect(cli.scorecard).toBe(record.scorecard);
    expect(JSON.stringify(cli.scorecard)).toBe(JSON.stringify(record.scorecard));
    const web = buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: webRecord, origin: ORIGIN });
    expect(web.scorecard).toBe(webRecord.scorecard);
    expect(JSON.stringify(web.scorecard)).toBe(JSON.stringify(webRecord.scorecard));
  });

  test('tier names whichever tier produced the result', () => {
    expect(
      buildRegistryEnvelope({ entry: registry.by_slug.ripgrep, origin: ORIGIN, specVersion: SPEC_VERSION }).tier,
    ).toBe('registry');
    expect(
      buildCliEnvelope({ tier: 'cache', target: 'fd', record: cliRecord('fd'), registry, origin: ORIGIN }).tier,
    ).toBe('cache');
    expect(
      buildCliEnvelope({ tier: 'live', target: 'fd', record: cliRecord('fd'), registry, origin: ORIGIN }).tier,
    ).toBe('live');
    expect(buildWebEnvelope({ tier: 'live', target: 'anc.dev', record: webRecord, origin: ORIGIN }).tier).toBe('live');
  });

  test('a live binary that is a curated tool binary is a registry hit and completes with tier registry', () => {
    const env = buildCliEnvelope({ tier: 'live', target: 'rg', record: cliRecord('rg'), registry, origin: ORIGIN });
    expect(env.tier).toBe('registry');
    expect(env.target).toBe('ripgrep');
    expect(env.scorecard_url).toBe(`${ORIGIN}/score/ripgrep`);
    expect(env.markdown_url).toBe(`${ORIGIN}/score/ripgrep/md`);
    expect(env.json_url).toBe(`${ORIGIN}/score/ripgrep/json`);
    expect(env.score_pct).toBe(92);
    expect(completeEvent(env)).toMatchObject({
      type: 'complete',
      tier: 'registry',
      scorecard_url: `${ORIGIN}/score/ripgrep`,
    });
  });

  test('a live CLI result carries the three URLs from its binary', () => {
    const env = buildCliEnvelope({ tier: 'live', target: 'fd', record: cliRecord('fd'), registry, origin: ORIGIN });
    expect(env).toMatchObject({
      kind: 'cli',
      target: 'fd',
      scorecard_url: `${ORIGIN}/score/fd`,
      markdown_url: `${ORIGIN}/score/fd/md`,
      json_url: `${ORIGIN}/score/fd/json`,
      spec_version: SPEC_VERSION,
      anc_version: ANC_VERSION,
      tool_version: '1.2.3',
    });
    expect(env.summary_html).toBeUndefined();
  });

  test('a branch-scoped run yields branch URLs, a source_sha, and no summary_html', () => {
    const env = buildCliEnvelope({
      tier: 'live',
      target: 'o/r@feature',
      record: cliRecord('r'),
      registry,
      origin: ORIGIN,
      sourceSha: 'abc1234',
    });
    expect(env).toMatchObject({
      kind: 'cli',
      target: 'o/r@feature',
      scorecard_url: `${ORIGIN}/score/o/r@feature`,
      markdown_url: `${ORIGIN}/score/o/r@feature/md`,
      json_url: `${ORIGIN}/score/o/r@feature/json`,
      source_sha: 'abc1234',
    });
    expect(env.summary_html).toBeUndefined();
  });

  test('refresh_after follows the lane window and is null for a curated result', () => {
    const t = Date.parse(SCORED_AT);
    const web = buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: webRecord, origin: ORIGIN });
    expect(web.freshness).toEqual({
      cached: true,
      scored_at: SCORED_AT,
      refresh_after: new Date(t + WEB_AUDIT_STALE_AFTER_MS).toISOString(),
    });
    const cli = buildCliEnvelope({ tier: 'cache', target: 'fd', record: cliRecord('fd'), registry, origin: ORIGIN });
    expect(cli.freshness).toEqual({
      cached: true,
      scored_at: SCORED_AT,
      refresh_after: new Date(t + LIVE_CLI_LIFECYCLE_MS).toISOString(),
    });
    expect(LIVE_CLI_LIFECYCLE_MS).toBe(7 * 24 * 60 * 60_000);
    const curated = buildRegistryEnvelope({
      entry: registry.by_slug.ripgrep,
      origin: ORIGIN,
      specVersion: SPEC_VERSION,
    });
    expect(curated.freshness).toEqual({ cached: true, scored_at: null, refresh_after: null });
  });

  test('the web cache module derives its freshness from the shared table', () => {
    expect(webAuditFreshness(true, SCORED_AT)).toEqual(freshnessFor('web', true, SCORED_AT));
    expect(webAuditFreshness(false, null)).toEqual(freshnessFor('web', false, null));
    expect(WEB_AUDIT_STALE_AFTER_MS).toBe(60_000);
  });

  test('a live binary equal to a curated slug that is not that tool binary has no URL and an inline body', () => {
    const env = buildCliEnvelope({ tier: 'live', target: 'ouch', record: cliRecord('ouch'), registry, origin: ORIGIN });
    expect(env.tier).toBe('live');
    expect(env.scorecard_url).toBeNull();
    expect(env.markdown_url).toBeNull();
    expect(env.json_url).toBeNull();
    const html = env.summary_html ?? '';
    expect(html).toContain('bigscore');
    expect(html).not.toContain('class="crumb"');
    expect(html).not.toContain('/md');
    expect(html).not.toContain('scorecard-embed');
    expect(html).not.toContain('badge');
  });

  test('no envelope field carries a sandbox path, stderr, or session identifier', () => {
    for (const env of [
      buildCliEnvelope({ tier: 'cache', target: 'fd', record: cliRecord('fd'), registry, origin: ORIGIN }),
      buildCliEnvelope({ tier: 'live', target: 'ouch', record: cliRecord('ouch'), registry, origin: ORIGIN }),
      buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: webRecord, origin: ORIGIN }),
    ]) {
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain('/tmp/sandbox');
      expect(serialized).not.toContain('boom: install log');
      expect(serialized).not.toContain('sid-123');
    }
  });
});

describe('error codes', () => {
  // Compile-time exhaustiveness: every ScoreError variant has a row.
  const cliTable: Record<ScoreError['code'], AuditErrorCode> = LEGACY_CLI_ERROR_CODES;

  test('every CLI error code and web error string maps to exactly one code', () => {
    for (const [legacy, code] of Object.entries(cliTable)) {
      expect(auditErrorCodeFor('cli', legacy)).toBe(code);
    }
    for (const [legacy, code] of Object.entries(LEGACY_WEB_ERROR_CODES)) {
      expect(auditErrorCodeFor('web', legacy)).toBe(code);
    }
    expect(auditErrorCodeFor('web', 'rate_limit')).toBe('rate_limited');
    expect(auditErrorCodeFor('cli', 'rate_limited')).toBe('rate_limited');
    expect(auditErrorCodeFor('web', 'turnstile_failed')).toBe('turnstile_failed');
  });

  test('an unknown legacy code throws', () => {
    expect(() => auditErrorCodeFor('cli', 'made_up')).toThrow(/made_up/);
    expect(() => auditErrorCodeFor('web', 'made_up')).toThrow(/made_up/);
  });

  test('every shared code has a message and the classifier rejections share theirs', () => {
    for (const code of [...Object.values(LEGACY_CLI_ERROR_CODES), ...Object.values(LEGACY_WEB_ERROR_CODES)]) {
      expect(AUDIT_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    for (const [code, message] of Object.entries(REJECTION_MESSAGES)) {
      expect(AUDIT_ERROR_MESSAGES[code as AuditErrorCode]).toBe(message);
    }
    expect(auditErrorFor('turnstile_unavailable', { retry_after: 30, cta: 'c' })).toEqual({
      error: {
        code: 'turnstile_unavailable',
        message: AUDIT_ERROR_MESSAGES.turnstile_unavailable,
        retry_after: 30,
        cta: 'c',
      },
    });
  });

  test('the error object keeps retry_after, details, pm, and cta', () => {
    expect(
      auditError('rate_limited', 'Too many audits from this address.', { retry_after: 42, cta: 'Try again later.' }),
    ).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many audits from this address.',
        retry_after: 42,
        cta: 'Try again later.',
      },
    });
    expect(auditError('install_unsupported', 'x', { pm: 'brew', details: 'd', cta: 'c' }).error).toMatchObject({
      pm: 'brew',
      details: 'd',
    });
    expect(auditError('turnstile_unavailable', 'x', { retry_after: 30, cta: 'c' }).error.retry_after).toBe(30);
  });
});
