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
import { type CachedWebAudit, webAuditFreshness } from '../src/worker/audit-web/cache';
import type { CachedScorecard } from '../src/worker/score/cache';
import { type RegistryIndex, resolveCuratedSlug } from '../src/worker/score/registry-lookup';
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
      anc_version: '0.4.9',
      version: '14.0.0',
    },
    ouch: { name: 'ouch', binary: 'ouch-bin', scorecard_url: '/score/ouch', score_pct: 70, anc_version: ANC_VERSION },
    // Metadata-only entries: listed in the registry, no committed scorecard.
    delta: { name: 'delta', binary: 'delta' },
    hexyl: { name: 'hexyl', binary: 'hx' },
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
    expect(env.score_pct).toBe(80);
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

describe('review fixtures: envelope composition', () => {
  const live = (target: string, record = cliRecord(target)) =>
    buildCliEnvelope({ tier: 'live', target, record, registry, origin: ORIGIN });

  test('a binary the route cannot serve takes the no-URL branch instead of throwing', () => {
    for (const target of ['api', 'fix', 'foo.bar']) {
      const env = live(target);
      expect(env.tier).toBe('live');
      expect(env.scorecard_url).toBeNull();
      expect(env.json_url).toBeNull();
      expect(env.summary_html).toContain('bigscore');
    }
  });

  test('a binary named after an Object.prototype member is an ordinary live result', () => {
    const env = live('constructor');
    expect(env).toMatchObject({ tier: 'live', scorecard_url: `${ORIGIN}/score/constructor` });
    expect(env.summary_html).toBeUndefined();
  });

  test('a registry entry without a committed scorecard is neither a hit nor a shadow', () => {
    expect(live('delta')).toMatchObject({ tier: 'live', scorecard_url: `${ORIGIN}/score/delta` });
    expect(live('hx')).toMatchObject({ tier: 'live', scorecard_url: `${ORIGIN}/score/hx` });
    expect(live('hexyl')).toMatchObject({ tier: 'live', scorecard_url: `${ORIGIN}/score/hexyl` });
  });

  test('a registry hit built from a record reports the versions and score of what was scored', () => {
    const env = live('rg');
    expect(env.tier).toBe('registry');
    expect(env.anc_version).toBe(ANC_VERSION);
    expect(env.tool_version).toBe('1.2.3');
    expect(env.score_pct).toBe(80);
    const curated = buildRegistryEnvelope({
      entry: registry.by_slug.ripgrep,
      origin: ORIGIN,
      specVersion: SPEC_VERSION,
    });
    expect(curated).toMatchObject({ score_pct: 92, anc_version: '0.4.9', tool_version: '14.0.0' });
  });

  test('input resolution and result classification order the slug and binary checks differently', () => {
    // resolveCuratedSlug reads user text, where a slug names its tool;
    // the envelope reads a resolved binary, where a slug it did not earn is a shadow.
    expect(resolveCuratedSlug('ouch', registry as RegistryIndex)).toBe('ouch');
    expect(live('ouch').scorecard_url).toBeNull();
    expect(resolveCuratedSlug('rg', registry as RegistryIndex)).toBe('ripgrep');
    expect(live('rg').scorecard_url).toBe(`${ORIGIN}/score/ripgrep`);
  });

  test('each builder outcome emits exactly its key set', () => {
    const keys = (env: object) => Object.keys(env).sort();
    const common = [
      'freshness',
      'json_url',
      'kind',
      'markdown_url',
      'scorecard',
      'scorecard_url',
      'spec_version',
      'target',
      'tier',
    ];
    const cli = [...common, 'anc_version', 'score_pct', 'tool_version'].sort();
    expect(keys(live('fd'))).toEqual(cli);
    expect(keys(live('ouch'))).toEqual([...cli, 'summary_html'].sort());
    expect(keys(live('rg'))).toEqual(cli);
    const branch = (sourceSha?: string) =>
      buildCliEnvelope({
        tier: 'live',
        target: 'o/r@feature',
        record: cliRecord('r'),
        registry,
        origin: ORIGIN,
        sourceSha,
      });
    expect(keys(branch('abc'))).toEqual([...cli, 'source_sha'].sort());
    expect(keys(branch())).toEqual(cli);
    expect(keys(buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: webRecord, origin: ORIGIN }))).toEqual(
      [...common, 'score_pct', 'target_url'].sort(),
    );
    expect(
      keys(buildRegistryEnvelope({ entry: registry.by_slug.ripgrep, origin: ORIGIN, specVersion: SPEC_VERSION })),
    ).toEqual([...common, 'anc_version', 'score_pct', 'tool_version'].sort());
  });

  test('a record-level scored_at wins over the scorecard run instant', () => {
    const later = '2026-09-11T00:00:00.000Z';
    const record = { ...cliRecord('fd'), scored_at: later };
    const env = buildCliEnvelope({ tier: 'cache', target: 'fd', record, registry, origin: ORIGIN });
    expect(env.freshness.scored_at).toBe(later);
  });

  test('the inline collision body escapes scorecard text', () => {
    const record = cliRecord('ouch');
    record.scorecard.tool.name = '<script>alert(1)</script>';
    const html = live('ouch', record).summary_html ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the worker record and registry types satisfy the envelope inputs', () => {
    const cached: CachedScorecard = {
      spec_version: SPEC_VERSION,
      anc_version: ANC_VERSION,
      tool_version: '1',
      scorecard: cliScorecard('fd'),
    };
    const web: CachedWebAudit = { spec_version: SPEC_VERSION, target_url: 'https://anc.dev/', scorecard: {} };
    const index: RegistryIndex = { by_slug: {}, by_owner_repo: {} };
    expect(
      buildCliEnvelope({ tier: 'cache', target: 'fd', record: cached, registry: index, origin: ORIGIN }).kind,
    ).toBe('cli');
    expect(buildWebEnvelope({ tier: 'cache', target: 'anc.dev', record: web, origin: ORIGIN }).kind).toBe('web');
  });
});

describe('review fixtures: error conversion edges', () => {
  test('the same legacy string maps by lane: invalid_url stays a CLI parse code and becomes invalid_target on the web', () => {
    expect(auditErrorCodeFor('cli', 'invalid_url')).toBe('invalid_url');
    expect(auditErrorCodeFor('web', 'invalid_url')).toBe('invalid_target');
  });
});
