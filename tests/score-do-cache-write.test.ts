// DO-side R2 cache-write contract.
//
// Plan U7 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "U7 Approach", post-success cache write bullet). After a successful
// `Sandbox.score()`, the DO writes to SCORE_CACHE so the next request
// for the same binary short-circuits at the handler's cache tier.
//
// The cache write fires inside `Sandbox.fetch()` via the exported
// `writeCacheBestEffort()` helper. Testing that helper directly pins
// the same contract without the workerd-shim cost of instantiating a
// Sandbox class. The helper carries every precondition (binding present,
// tool version extractable) and every failure-handling guarantee
// (R2 write failure logged but not surfaced) that fetch() relies on.

import { describe, expect, test } from 'bun:test';
import { buildCliEnvelope } from '../src/shared/audit-envelope';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { extractToolVersion, type ScoreSandboxEnv, writeCacheBestEffort } from '../src/worker/score/do';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { fakeRender, siteEnv } from './helpers/og-site-fakes';

// ---------------------------------------------------------------------------
// R2 stub mirroring the cache.ts test stub
// ---------------------------------------------------------------------------

type Recorded = { key: string; value: string };

function makeR2Stub(opts: { throwOnPut?: boolean } = {}) {
  const writes: Recorded[] = [];
  const env: ScoreSandboxEnv = {
    ASSETS: { fetch: async () => new Response('not used') } as unknown as Fetcher,
    SCORE_CACHE: {
      async put(key: string, value: unknown) {
        if (opts.throwOnPut) throw new Error('r2_put_failed');
        writes.push({ key, value: typeof value === 'string' ? value : String(value) });
      },
      async get() {
        return null;
      },
      async delete() {
        // no-op for write tests
      },
    } as unknown as R2Bucket,
  };
  return { env, writes };
}

const SPEC: InstallSpec = { pm: 'npm', package: 'cowsay', binary: 'cowsay' };

const SCORECARD_WITH_VERSION = {
  schema_version: '0.5',
  tool: { name: 'cowsay', version: '1.6.0' },
  score: { value: 88 },
};

// ---------------------------------------------------------------------------
// extractToolVersion
// ---------------------------------------------------------------------------

describe('extractToolVersion', () => {
  test('returns scorecard.tool.version when present', () => {
    expect(extractToolVersion(SCORECARD_WITH_VERSION)).toBe('1.6.0');
  });

  test('null scorecard → null', () => {
    expect(extractToolVersion(null)).toBeNull();
  });

  test('missing tool field → null', () => {
    expect(extractToolVersion({ schema_version: '0.5' })).toBeNull();
  });

  test('missing tool.version field → null', () => {
    expect(extractToolVersion({ tool: { name: 'cowsay' } })).toBeNull();
  });

  test('empty-string tool.version → null (refusal-to-cache-half-state precondition)', () => {
    expect(extractToolVersion({ tool: { name: 'cowsay', version: '' } })).toBeNull();
  });

  test('non-string tool.version → null', () => {
    expect(extractToolVersion({ tool: { version: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeCacheBestEffort — precondition guards
// ---------------------------------------------------------------------------

describe('writeCacheBestEffort — preconditions', () => {
  test('no SCORE_CACHE binding → skips write silently (no throw, no log-as-error)', async () => {
    const env: ScoreSandboxEnv = {
      ASSETS: { fetch: async () => new Response('') } as unknown as Fetcher,
      // SCORE_CACHE intentionally absent — matches the optional binding
      // shape on ScoreSandboxEnv (DO test envs without R2 wired up).
    };
    await writeCacheBestEffort(env, SPEC, { scorecard: SCORECARD_WITH_VERSION, anc_version: ANC_VERSION });
    // No assertion possible on the side-effect; the contract is "does
    // not throw and does not crash". Reaching the next line is the test.
  });

  test('scorecard missing tool.version → skips write (refusal-to-cache-half-state)', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, {
      scorecard: { schema_version: '0.5', tool: { name: 'cowsay' } },
      anc_version: ANC_VERSION,
    });
    expect(writes).toHaveLength(0);
  });

  test('null scorecard → skips write', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, { scorecard: null, anc_version: ANC_VERSION });
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// writeCacheBestEffort — happy path
// ---------------------------------------------------------------------------

describe('writeCacheBestEffort — happy path', () => {
  test('writes the canonical scores/{binary}/{SPEC_VERSION}.json key', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, { scorecard: SCORECARD_WITH_VERSION, anc_version: ANC_VERSION });
    expect(writes).toHaveLength(1);
    // SPEC_VERSION as the partition slot — handoff Decision 2 + gotcha 3
    // in .context/handoffs/2026-05-19-001-feat-live-scoring-cf-sandbox.md.
    // The expectation tracks SPEC_VERSION via the gen.ts import so it
    // moves automatically when the spec advances.
    expect(writes[0].key).toBe(`scores/cowsay/${SPEC_VERSION}.json`);
  });

  test('payload carries spec_version, anc_version, tool_version, scorecard', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, { scorecard: SCORECARD_WITH_VERSION, anc_version: ANC_VERSION });
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0].value) as {
      spec_version: string;
      anc_version: string;
      tool_version: string;
      scorecard: { tool: { name: string } };
    };
    expect(parsed.spec_version).toBe(SPEC_VERSION);
    expect(parsed.anc_version).toBe(ANC_VERSION);
    expect(parsed.tool_version).toBe('1.6.0');
    expect(parsed.scorecard.tool.name).toBe('cowsay');
  });

  test('different binaries write to different cache keys (no aliasing)', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, { scorecard: SCORECARD_WITH_VERSION, anc_version: ANC_VERSION });
    await writeCacheBestEffort(
      env,
      { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' },
      { scorecard: { tool: { name: 'ripgrep', version: '15.1.0' } }, anc_version: ANC_VERSION },
    );
    expect(writes.map((w) => w.key)).toEqual([`scores/cowsay/${SPEC_VERSION}.json`, `scores/rg/${SPEC_VERSION}.json`]);
  });

  test('parser-driven binary derivation does not alias to curated slug (cargo binstall ripgrep → scores/ripgrep/...)', async () => {
    // parse-install.ts maps `cargo binstall ripgrep` to binary='ripgrep'
    // (package name), NOT to the registry's curated 'rg'. So an
    // install-command POST writes under `scores/ripgrep/...` while a
    // curated-registry POST for slug=ripgrep would (if it were live-
    // scored, which it isn't because the registry path short-circuits)
    // write under `scores/rg/...`. The two never alias. This pin
    // captures the design choice so a future parser change that
    // "normalizes" package→binary surfaces here.
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(
      env,
      { pm: 'cargo-binstall', package: 'ripgrep', binary: 'ripgrep' },
      { scorecard: { tool: { name: 'ripgrep', version: '15.1.0' } }, anc_version: ANC_VERSION },
    );
    expect(writes[0].key).toBe(`scores/ripgrep/${SPEC_VERSION}.json`);
    expect(writes[0].key).not.toBe(`scores/rg/${SPEC_VERSION}.json`);
  });
});

// ---------------------------------------------------------------------------
// writeCacheBestEffort — failure isolation
// ---------------------------------------------------------------------------

describe('writeCacheBestEffort — failure isolation', () => {
  test('R2 put failure is swallowed (best-effort write contract)', async () => {
    const { env } = makeR2Stub({ throwOnPut: true });
    // Must not throw — the caller (Sandbox.fetch) MUST return the user's
    // score regardless of whether the cache write landed.
    await writeCacheBestEffort(env, SPEC, { scorecard: SCORECARD_WITH_VERSION, anc_version: ANC_VERSION });
  });
});

// ---------------------------------------------------------------------------
// render request
// ---------------------------------------------------------------------------

describe('writeCacheBestEffort — render request', () => {
  test('a written scorecard asks the render Worker for its clip; a failed write asks for none', async () => {
    const render = fakeRender();
    const scored = { ...SCORECARD_WITH_VERSION, badge: { score_pct: 88 } };
    await writeCacheBestEffort(siteEnv({ render, ogVideo: 'true' }), SPEC, {
      scorecard: scored,
      anc_version: ANC_VERSION,
    });
    expect(render.calls).toEqual([
      {
        method: 'request',
        inputs: expect.objectContaining({ target: 'cowsay', key: expect.stringContaining('-t1.6.0-') }),
      },
    ]);

    const failedRender = fakeRender();
    const { env: failing } = makeR2Stub({ throwOnPut: true });
    await writeCacheBestEffort({ ...failing, RENDER: failedRender, OG_VIDEO_ENABLED: 'true' }, SPEC, {
      scorecard: scored,
      anc_version: ANC_VERSION,
    });
    expect(failedRender.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeCacheBestEffort — errored audits
// ---------------------------------------------------------------------------

describe('writeCacheBestEffort — errored audits', () => {
  const errored = { ...SCORECARD_WITH_VERSION, badge: { score_pct: 88 }, summary: { error: 2 } };

  test('a scorecard that reports an errored audit is not written, purged, or rendered', async () => {
    const { env, writes } = makeR2Stub();
    const purged: string[][] = [];
    const render = fakeRender();
    await writeCacheBestEffort(
      { ...env, RENDER: render, OG_VIDEO_ENABLED: 'true' },
      SPEC,
      { scorecard: errored, anc_version: ANC_VERSION },
      async (tags) => {
        purged.push(tags);
      },
    );
    expect(writes).toHaveLength(0);
    expect(purged).toEqual([]);
    expect(render.calls).toEqual([]);
  });

  test('a branch run that reports an errored audit is not written either', async () => {
    const { env, writes } = makeR2Stub();
    const branch: InstallSpec = { pm: 'git-clone', owner: 'o', repo: 'r', branch: 'feature', binary: 'r' };
    await writeCacheBestEffort(env, branch, { scorecard: errored, anc_version: ANC_VERSION, source_sha: 'abc1234' });
    expect(writes).toHaveLength(0);
  });

  test('the cache write and the envelope agree on which runs have a page', async () => {
    for (const scorecard of [SCORECARD_WITH_VERSION, errored]) {
      const { env, writes } = makeR2Stub();
      await writeCacheBestEffort(env, SPEC, { scorecard, anc_version: ANC_VERSION });
      const envelope = buildCliEnvelope({
        tier: 'live',
        target: 'cowsay',
        record: { spec_version: SPEC_VERSION, anc_version: ANC_VERSION, tool_version: '1.6.0', scorecard },
        registry: { by_slug: {} },
        origin: 'https://staging.example',
      });
      expect(envelope.scorecard_url !== null).toBe(writes.length === 1);
    }
  });

  test('a scorecard whose error count is zero is written', async () => {
    const { env, writes } = makeR2Stub();
    await writeCacheBestEffort(env, SPEC, {
      scorecard: { ...SCORECARD_WITH_VERSION, summary: { error: 0 } },
      anc_version: ANC_VERSION,
    });
    expect(writes).toHaveLength(1);
  });
});
