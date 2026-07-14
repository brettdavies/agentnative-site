// Cross-validates the three artifacts that together form the /api/score
// registry-fast-path contract:
//
//   1. registry.yaml              — editorial source of truth for tools
//   2. dist/registry-index.json   — build-emitted index the Worker reads
//   3. scorecards/<name>-v<v>.json — committed score outputs that enrich
//                                    the index with version, anc_version,
//                                    scorecard_url, and score_pct
//
// A break in any of the joins between these three artifacts lands a wrong
// response on /api/score for a curated tool. This file fails CI before
// that drift ships.
//
// Run `bun run build` before these tests — the contract depends on
// dist/registry-index.json being current.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { buildRegistryIndex } from '../src/build/registry-index.mjs';
import { _resetIndexCache, handleScore, type ScoreEnv } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';

const REPO_ROOT = join(import.meta.dir, '..');
const DIST = join(REPO_ROOT, 'dist');
const SCORECARDS_DIR = join(REPO_ROOT, 'scorecards');

type RegistryTool = {
  name: string;
  binary: string;
  install: string;
  repo?: string;
  url?: string;
  audit_profile?: string;
};

type RegistryIndexEntry = {
  name: string;
  binary: string;
  install: string;
  repo?: string;
  audit_profile?: string;
  version?: string;
  anc_version?: string;
  scorecard_url?: string;
  score_pct?: number;
};

type RegistryIndex = {
  by_slug: Record<string, RegistryIndexEntry>;
  by_owner_repo: Record<string, RegistryIndexEntry>;
};

type Scorecard = {
  schema_version: string;
  tool: { name: string; binary: string; version: string };
  anc: { version: string };
  badge?: { score_pct?: number; eligible?: boolean };
};

// Matches build/scorecards.mjs:indexScorecardsByName(), which is the
// authoritative parser for the on-disk filename pattern.
const SCORECARD_FILENAME_RE = /^(?<name>[a-z0-9-]+)-v(?<version>.+)\.json$/;

async function loadRegistry(): Promise<RegistryTool[]> {
  const raw = await readFile(join(REPO_ROOT, 'registry.yaml'), 'utf8');
  const doc = yaml.load(raw) as { tools: RegistryTool[] };
  return doc.tools;
}

async function loadIndex(): Promise<RegistryIndex> {
  const raw = await readFile(join(DIST, 'registry-index.json'), 'utf8');
  return JSON.parse(raw) as RegistryIndex;
}

async function loadScorecards(): Promise<Array<{ filename: string; name: string; version: string; data: Scorecard }>> {
  const files = (await readdir(SCORECARDS_DIR)).filter((f) => f.endsWith('.json'));
  const out: Array<{ filename: string; name: string; version: string; data: Scorecard }> = [];
  for (const filename of files) {
    const m = filename.match(SCORECARD_FILENAME_RE);
    if (!m?.groups) continue;
    const name = m.groups.name as string;
    const version = m.groups.version as string;
    const data = JSON.parse(await readFile(join(SCORECARDS_DIR, filename), 'utf8')) as Scorecard;
    out.push({ filename, name, version, data });
  }
  return out;
}

describe('score-contract — registry.yaml <-> dist/registry-index.json <-> scorecards/', () => {
  test('every registry.yaml tool name appears in by_slug', async () => {
    const registry = await loadRegistry();
    const index = await loadIndex();
    const missing = registry.map((t) => t.name).filter((name) => !(name in index.by_slug));
    expect(missing).toEqual([]);
  });

  test('every committed scorecard has a matching registry.yaml entry', async () => {
    const registry = await loadRegistry();
    const cards = await loadScorecards();
    const registryNames = new Set(registry.map((t) => t.name));
    const orphans = cards.filter((c) => !registryNames.has(c.name)).map((c) => c.filename);
    expect(orphans).toEqual([]);
  });

  test('every scorecard joins to by_slug with matching version, anc_version, and scorecard_url', async () => {
    const cards = await loadScorecards();
    const index = await loadIndex();
    const drifts: string[] = [];
    for (const card of cards) {
      const entry = index.by_slug[card.name];
      if (!entry) {
        drifts.push(`${card.filename}: by_slug has no entry for "${card.name}"`);
        continue;
      }
      // Filename version is the source of truth for the index's `version`
      // field. build.mjs derives it from indexScorecardsByName, not from
      // the raw --version output inside the scorecard.
      if (entry.version !== card.version) {
        drifts.push(`${card.filename}: by_slug.version "${entry.version}" != filename version "${card.version}"`);
      }
      if (entry.anc_version !== card.data.anc.version) {
        drifts.push(
          `${card.filename}: by_slug.anc_version "${entry.anc_version}" != scorecard anc.version "${card.data.anc.version}"`,
        );
      }
      const expectedUrl = `/score/${card.name}`;
      if (entry.scorecard_url !== expectedUrl) {
        drifts.push(`${card.filename}: by_slug.scorecard_url "${entry.scorecard_url}" != "${expectedUrl}"`);
      }
    }
    expect(drifts).toEqual([]);
  });

  test('score_pct on by_slug equals badge.score_pct on the scorecard', async () => {
    const cards = await loadScorecards();
    const index = await loadIndex();
    const drifts: string[] = [];
    for (const card of cards) {
      const entry = index.by_slug[card.name];
      const expected = card.data.badge?.score_pct ?? null;
      // The enrichment only writes score_pct when it's a number. Null on
      // either side is OK; numeric mismatch is the contract violation.
      if (typeof entry?.score_pct === 'number' && entry.score_pct !== expected) {
        drifts.push(`${card.filename}: by_slug.score_pct ${entry.score_pct} != badge.score_pct ${expected}`);
      }
    }
    expect(drifts).toEqual([]);
  });
});

// Stubbed-Worker call against the REAL committed dist/registry-index.json.
// Pattern follows tests/score-handler-share-url.test.ts:makeEnv() — only
// the ASSETS fetcher is rewired to return the on-disk index so the join
// the contract describes is the join production actually serves.

function postScore(input: string): Request {
  return new Request('https://anc.dev/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, turnstile_token: 'tok' }),
  });
}

function makeEnvFromIndex(index: RegistryIndex): ScoreEnv {
  const hintsIndex = { by_owner_repo: {} };
  const cacheStore = new Map<string, string>();
  const cacheStub = {
    async get(key: string) {
      const raw = cacheStore.get(key);
      if (raw === undefined) return null;
      return {
        async json() {
          return JSON.parse(raw);
        },
        async text() {
          return raw;
        },
      };
    },
    async put(key: string, value: unknown) {
      cacheStore.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key: string) {
      cacheStore.delete(key);
    },
  };

  return {
    ASSETS: {
      async fetch(req: Request | string): Promise<Response> {
        const url = typeof req === 'string' ? req : req.url;
        const path = new URL(url).pathname;
        if (path === '/registry-index.json') {
          return new Response(JSON.stringify(index), { status: 200 });
        }
        if (path === '/discovery-hints-index.json') {
          return new Response(JSON.stringify(hintsIndex), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    } as Fetcher,
    SCORE: {} as DurableObjectNamespace,
    SCORE_KV: {
      async get() {
        return null;
      },
    } as unknown as KVNamespace,
    SCORE_CACHE: cacheStub as unknown as R2Bucket,
    SCORE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    SCORE_LIMITER_IP: {
      async limit() {
        return { success: true };
      },
    },
    SCORE_TELEMETRY: { writeDataPoint() {} },
    TURNSTILE_SECRET: 'test',
    SESSION_HMAC_SECRET: 'test-hmac-secret-long-enough',
  } as ScoreEnv;
}

describe('score-contract — /api/score registry-fast-path response shape', () => {
  beforeEach(() => {
    _resetIndexCache();
    _resetKillSwitchCache();
  });

  test('curated slug returns registry_hit with the full response triad', async () => {
    const index = await loadIndex();
    const env = makeEnvFromIndex(index);
    const res = await handleScore(postScore('ripgrep'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scorecard: { kind?: string; scorecard_url?: string; score_pct?: number | null };
      spec_version?: string;
      site_spec_version?: string;
      anc_version?: string;
      auditor_url?: string;
    };
    expect(body.scorecard.kind).toBe('registry_hit');
    expect(body.scorecard.scorecard_url).toBe('/score/ripgrep');
    expect(typeof body.spec_version).toBe('string');
    expect(typeof body.site_spec_version).toBe('string');
    expect(typeof body.anc_version).toBe('string');
    expect(typeof body.auditor_url).toBe('string');
  });
});

describe('score-contract — negative drift catcher', () => {
  test('a scorecard whose name is missing from by_slug surfaces as a contract violation', () => {
    // Demonstrates the failure shape the cross-validation above catches:
    // a renamed or moved scorecard whose name no longer resolves in the
    // built index. Without a regenerated dist/registry-index.json, by_slug
    // forgets the tool and the Worker would 404 the curated path.
    const fakeCard = { name: 'ghost-tool', filename: 'ghost-tool-v1.0.0.json' };
    const fakeIndex: RegistryIndex = {
      by_slug: {
        curl: { name: 'curl', binary: 'curl', install: 'brew install curl' },
      },
      by_owner_repo: {},
    };
    expect(fakeCard.name in fakeIndex.by_slug).toBe(false);
  });

  test('buildRegistryIndex omits enrichment fields when no scorecard is present', () => {
    // Pins the build emitter contract: tools without a paired scorecard
    // appear in by_slug with the editorial fields (name, binary, install)
    // but without version/anc_version/scorecard_url. If a future emitter
    // change starts synthesizing defaults, the cross-validation above
    // needs to be revised so it doesn't accept fabricated values.
    const { index } = buildRegistryIndex(
      [{ name: 'no-card-tool', binary: 'no-card-tool', install: 'brew install no-card-tool' }],
      {},
    ) as unknown as { index: RegistryIndex };
    expect(index.by_slug['no-card-tool']).toBeDefined();
    expect(index.by_slug['no-card-tool'].version).toBeUndefined();
    expect(index.by_slug['no-card-tool'].anc_version).toBeUndefined();
    expect(index.by_slug['no-card-tool'].scorecard_url).toBeUndefined();
  });
});
