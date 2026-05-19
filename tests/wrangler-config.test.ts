// Regression guards on wrangler.jsonc shape.
//
// Driven by docs/solutions/integration-issues/wrangler-routes-inheritance-
// staging-custom-domain-drift-2026-05-15.md:
//
//   Wrangler's `routes`, `triggers`, `route`, and `assets` are INHERITABLE
//   keys. If env.<env-name> doesn't override them explicitly, the env block
//   silently inherits whatever is at top level. For an account-scoped
//   resource like a Custom Domain (which only one Worker can own), that
//   silent inheritance moves ownership on every deploy. For two weeks
//   `wrangler deploy --env staging` was silently re-binding `anc.dev` to
//   the staging Worker on every dev merge.
//
// The fix is `env.staging.routes: []` and `env.staging.triggers:
// { crons: [] }`. Removing either silently brings the bug back, so this
// test asserts they are present + correctly shaped, and gates against
// adding `route` (singular) or `assets` at the top level without a matching
// staging override.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WRANGLER_PATH = join(import.meta.dir, '..', 'wrangler.jsonc');

function loadWranglerConfig(): Record<string, unknown> {
  const raw = readFileSync(WRANGLER_PATH, 'utf8');
  // Strip JSONC comments + trailing commas before parsing.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as Record<string, unknown>;
}

function getStagingEnv(config: Record<string, unknown>): Record<string, unknown> {
  const env = config.env as Record<string, unknown> | undefined;
  expect(env).toBeDefined();
  const staging = env?.staging as Record<string, unknown> | undefined;
  if (!staging) throw new Error('env.staging missing from wrangler.jsonc');
  return staging;
}

describe('wrangler.jsonc — inherited-property overrides (anc.dev routing-drift regression)', () => {
  const config = loadWranglerConfig();
  const staging = getStagingEnv(config);

  test('env.staging.routes is explicitly set to an empty array (prevents anc.dev inheritance)', () => {
    expect(staging.routes).toBeDefined();
    expect(Array.isArray(staging.routes)).toBe(true);
    expect((staging.routes as unknown[]).length).toBe(0);
  });

  test('env.staging.triggers.crons is explicitly set to an empty array (prophylactic against future cron addition)', () => {
    expect(staging.triggers).toBeDefined();
    const triggers = staging.triggers as Record<string, unknown>;
    expect(triggers.crons).toBeDefined();
    expect(Array.isArray(triggers.crons)).toBe(true);
    expect((triggers.crons as unknown[]).length).toBe(0);
  });

  test('top-level routes points exactly at anc.dev as a custom domain (the canary value)', () => {
    expect(Array.isArray(config.routes)).toBe(true);
    const routes = config.routes as Array<Record<string, unknown>>;
    expect(routes.length).toBe(1);
    expect(routes[0].pattern).toBe('anc.dev');
    expect(routes[0].custom_domain).toBe(true);
  });

  test('top-level `route` singular is NOT used (same hazard shape as `routes`; staging would inherit silently)', () => {
    // The Wrangler config supports both `route` (single) and `routes`
    // (array). Both are inheritable. If a future PR ever switches to the
    // singular form without also overriding it under env.staging, the
    // routing-drift class re-emerges. We commit to the plural form
    // (already overridden under env.staging) and reject the singular.
    expect(config.route).toBeUndefined();
  });

  test('top-level `assets` is set; env.staging must inherit OR override but never disagree silently', () => {
    // `assets` is inheritable. If env.staging adds its own `assets` block
    // that points at a DIFFERENT directory or DIFFERENT binding, that's
    // probably a bug — assets are runtime resources that should match
    // across envs. If it's identical, we tolerate the redundancy.
    expect(config.assets).toBeDefined();
    if (staging.assets) {
      expect(staging.assets).toEqual(config.assets as Record<string, unknown>);
    }
  });
});

describe('wrangler.jsonc — env.staging mirrors required non-inheritable bindings', () => {
  // These bindings are NOT inheritable (per spike 01: containers,
  // durable_objects, migrations, ratelimits, r2_buckets, kv_namespaces).
  // Every binding the live-scoring handler reads MUST appear under
  // env.staging or the staging Worker fails at first /api/score request.

  const config = loadWranglerConfig();
  const staging = getStagingEnv(config);

  test('env.staging.kv_namespaces declares the SCORE_KV binding', () => {
    expect(staging.kv_namespaces).toBeDefined();
    const bindings = (staging.kv_namespaces as Array<Record<string, unknown>>).map((b) => b.binding);
    expect(bindings).toContain('SCORE_KV');
  });

  test('env.staging.ratelimits declares both SCORE_LIMITER and SCORE_LIMITER_IP', () => {
    expect(staging.ratelimits).toBeDefined();
    const names = (staging.ratelimits as Array<Record<string, unknown>>).map((r) => r.name);
    expect(names).toContain('SCORE_LIMITER');
    expect(names).toContain('SCORE_LIMITER_IP');
  });

  test('env.staging.durable_objects declares the SCORE binding', () => {
    expect(staging.durable_objects).toBeDefined();
    const bindings = (
      (staging.durable_objects as Record<string, unknown>).bindings as Array<Record<string, unknown>>
    ).map((b) => b.name);
    expect(bindings).toContain('SCORE');
  });

  test('env.staging.r2_buckets declares the SCORE_CACHE binding', () => {
    expect(staging.r2_buckets).toBeDefined();
    const bindings = (staging.r2_buckets as Array<Record<string, unknown>>).map((r) => r.binding);
    expect(bindings).toContain('SCORE_CACHE');
  });
});

// ---------------------------------------------------------------------------
// R2 score-cache lifecycle documentation drift (plan U7)
// ---------------------------------------------------------------------------

// The 7-day TTL on the SCORE_CACHE bucket lives as an R2 bucket lifecycle
// rule, NOT in wrangler.jsonc — R2 lifecycle isn't a wrangler-config
// surface yet. The setup commands live in RELEASES.md so a fresh bucket
// recreate doesn't lose the TTL. Drift on that documentation is silent:
// a future R2 bucket recreate could ship without the lifecycle rule, and
// the cache would grow forever. This test asserts the literal commands
// are present so removal forces a deliberate update.

describe('RELEASES.md — R2 score-cache lifecycle setup commands (plan U7)', () => {
  const releasesPath = join(import.meta.dir, '..', 'RELEASES.md');
  const releases = readFileSync(releasesPath, 'utf8');

  test('documents the 7-day lifecycle command for the prod bucket', () => {
    // Positional args: bucket, rule-name, prefix. Flag: --expire-days.
    // Earlier docs shipped `--prefix scores/ --expiration-days 7`, which
    // wrangler 4.x rejects (Unknown arguments). The drift-guard pins the
    // correct shape so the regression class can't re-emerge silently.
    expect(releases).toMatch(
      /wrangler r2 bucket lifecycle add anc-score-cache scores-7day-ttl scores\/ --expire-days 7/,
    );
  });

  test('documents the 7-day lifecycle command for the staging bucket', () => {
    expect(releases).toMatch(
      /wrangler r2 bucket lifecycle add anc-score-cache-staging scores-7day-ttl scores\/ --expire-days 7/,
    );
  });
});

describe('ARCHITECTURE.md — R2 score-cache key shape (plan U7)', () => {
  // The cache key prefix `scores/{binary}/{anc-version}.json` is the
  // load-bearing fact behind the lifecycle rule's `scores/` filter. The
  // rationale + key shape live in ARCHITECTURE.md (RELEASES.md is the
  // runbook). If the prefix moves, the architecture doc must move with
  // it — this drift-guard makes the prefix change visible in CI.

  const architecturePath = join(import.meta.dir, '..', 'ARCHITECTURE.md');
  const architecture = readFileSync(architecturePath, 'utf8');

  test('mentions the canonical cache key prefix so a future audit can grep for it', () => {
    expect(architecture).toMatch(/scores\/\{binary\}\/\{anc-version\}\.json/);
  });
});
