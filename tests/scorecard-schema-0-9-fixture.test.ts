// Real `anc audit --command <tool> --output json` scorecards at schema 0.9,
// produced by anc 0.6.0 and run through the registry join, corpus
// invariants, page renderers, and JSON envelope that `bun run build` uses.
// uv was scored with no `.anc.toml`, so its `p6-may-standard-names` warning
// carries a `config_hint`. docker was scored with AGENTNATIVE_HOME_CONFIG
// naming a file whose `[p6] domain_verbs` holds the verbs docker's own
// `config_hint` listed, so its row passes with `using_domain_verbs` and
// `domain_match_count`.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { curatedResultEnvelope } from '../src/build/08-scorecards-emit.mjs';
import {
  computeLeaderboard,
  extractTopIssues,
  loadRegistry,
  loadScoredTools,
  runScorecardInvariants,
} from '../src/build/scorecards.mjs';
import { buildScorecardBody, buildScorecardMarkdown } from '../src/build/scorecards-render.mjs';
import { escHtml } from '../src/build/util.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'cli-scorecards-0.9');
const STANDARD_NAMES_ROW = 'p6-may-standard-names';

type ConfigHint = { files: Array<{ file: string; scope: string }>; domain_verbs: string[]; docs: string };

type ResultRow = {
  id: string;
  label: string;
  status: string;
  confidence: string;
  using_domain_verbs?: boolean;
  domain_match_count?: number;
  config_hint?: ConfigHint;
};

type FixtureScorecard = {
  schema_version: string;
  spec_version: string;
  results: ResultRow[];
  badge: { score_pct: number };
};

type LoadedFixture = {
  tool: { name: string; binary: string; description: string };
  scorecard: FixtureScorecard;
  version: string;
  metadata: { anc: { version: string } };
};

type RankedFixture = LoadedFixture & { rank: number; principleScore: { met: number; total: number } };

async function loadFixtures(): Promise<{ tools: LoadedFixture[]; scorecardOrphans: string[] }> {
  const registry = await loadRegistry(join(REPO_ROOT, 'registry.yaml'));
  await runScorecardInvariants(FIXTURE_DIR, registry);
  const { tools, warnings } = await loadScoredTools(FIXTURE_DIR, registry);
  return { tools: tools as LoadedFixture[], scorecardOrphans: warnings.scorecardOrphans };
}

function fixtureFor(tools: LoadedFixture[], name: string): LoadedFixture {
  const entry = tools.find((t) => t.tool.name === name);
  if (!entry) throw new Error(`fixture for ${name} did not load`);
  return entry;
}

function standardNamesRow(entry: LoadedFixture): ResultRow {
  const row = entry.scorecard.results.find((r) => r.id === STANDARD_NAMES_ROW);
  if (!row) throw new Error(`${entry.tool.name} has no ${STANDARD_NAMES_ROW} row`);
  return row;
}

describe('anc 0.6.0 schema 0.9 scorecards', () => {
  test('load through the registry join and corpus invariants', async () => {
    const { tools, scorecardOrphans } = await loadFixtures();
    expect(tools.map((t) => t.tool.name).sort()).toEqual(['docker', 'uv']);
    expect(tools.map((t) => t.scorecard.schema_version)).toEqual(['0.9', '0.9']);
    expect(scorecardOrphans).toEqual([]);
  });

  test('carry every 0.8 and 0.9 row addition', async () => {
    const { tools } = await loadFixtures();
    const docker = standardNamesRow(fixtureFor(tools, 'docker'));
    expect(docker.status).toBe('pass');
    expect(docker.confidence).toBe('low');
    expect(docker.using_domain_verbs).toBe(true);
    expect(docker.domain_match_count).toBeGreaterThan(0);

    const uv = standardNamesRow(fixtureFor(tools, 'uv'));
    expect(uv.status).toBe('warn');
    expect(uv.using_domain_verbs).toBeUndefined();
    expect(uv.config_hint?.files.map((f) => f.scope)).toEqual(['tool-repository', 'user']);
    expect(uv.config_hint?.domain_verbs.length).toBeGreaterThan(0);
  });

  test('render a scorecard page, a markdown twin, and a JSON envelope', async () => {
    const { tools } = await loadFixtures();
    for (const entry of computeLeaderboard(tools) as RankedFixture[]) {
      const { tool, scorecard, principleScore, version, metadata } = entry;
      const row = standardNamesRow(entry);
      const html = buildScorecardBody(tool, scorecard, extractTopIssues(scorecard), principleScore, version, metadata);
      expect(html).toContain(escHtml(row.label));
      const markdown = buildScorecardMarkdown(tool, scorecard, [], principleScore, version, metadata);
      expect(markdown).toContain(row.label);
      const envelope = curatedResultEnvelope(tool, scorecard, metadata.anc.version, version);
      expect(envelope.scorecard).toEqual(scorecard);
    }
  });
});
