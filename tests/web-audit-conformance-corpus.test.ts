// The conformance corpus is the golden contract between this engine and the
// CLI's Rust port: every scenario's committed scorecard must be what the
// engine produces today, every registry check must be the subject of a
// scenario, and generation must be deterministic. A registry or engine
// change without a regeneration fails here rather than in the other repo.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORPUS_DIR,
  generateCorpus,
  loadRegistry,
  REGISTRY_PATH,
  SCENARIOS_DIR,
} from '../scripts/web-audit/conformance-corpus';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import { scoreWebAudit, universeMaxOf } from '../src/worker/audit-web/score';
import type { WebScorecard } from '../src/worker/audit-web/scorecard';

function committedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, relPath);
      else out.set(relPath, readFileSync(path, 'utf8'));
    }
  };
  walk(CORPUS_DIR, '');
  return out;
}

describe('web-audit conformance corpus', () => {
  const registry = loadRegistry();
  const ids = registry.checks.map((c) => c.id);

  test('every registry check is the subject of at least one scenario', () => {
    const covered = new Set<string>();
    for (const scenario of Object.values(SCENARIOS)) for (const id of scenario.covers) covered.add(id);
    const missing = ids.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  test('every covers entry names a registry check', () => {
    const known = new Set(ids);
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const unknown = scenario.covers.filter((id) => !known.has(id));
      expect({ name, unknown }).toEqual({ name, unknown: [] });
    }
  });

  // The port reproduces live checks; a retired id names nothing it scores.
  test('no scenario names a retired check id, and the server card check is a subject', () => {
    const retired = Object.keys(registry.retired ?? {});
    expect(retired).toContain('well-known-mcp-card');
    const naming = Object.entries(SCENARIOS)
      .filter(([, scenario]) => scenario.covers.some((id) => retired.includes(id)))
      .map(([name]) => name);
    expect(naming).toEqual([]);
    expect(Object.values(SCENARIOS).some((scenario) => scenario.covers.includes('mcp-server-card'))).toBe(true);
  });

  test('the committed corpus is byte-identical to a fresh generation', async () => {
    expect(existsSync(SCENARIOS_DIR)).toBe(true);
    const generated = await generateCorpus(registry);
    const committed = committedFiles();
    const generatedNames = [...generated.keys()].sort();
    expect([...committed.keys()].sort()).toEqual(generatedNames);
    for (const name of generatedNames) {
      if (committed.get(name) !== generated.get(name)) {
        throw new Error(`${name} is stale; run bun scripts/web-audit/gen-fixtures.ts and commit the result`);
      }
    }
  });

  // Saving an audit stamps the registry fingerprint; the engine never does,
  // so the Rust port reproduces the goldens without hashing a registry.
  test('no golden carries a registry fingerprint', () => {
    const stamped = [...committedFiles()]
      .filter(([, text]) => text.includes('registry_fingerprint'))
      .map(([name]) => name);
    expect(stamped).toEqual([]);
  });

  // The index exists so a regeneration that moves a score reads as a short
  // diff of one file; it is only worth reading if it agrees with the goldens.
  test('scores.json indexes each golden: its scores and every row id, status, and na_reason', () => {
    const committed = committedFiles();
    const index = JSON.parse(committed.get('scores.json') ?? 'null') as Record<string, unknown>;
    expect(Object.keys(index)).toEqual(Object.keys(SCENARIOS).sort());
    for (const name of Object.keys(index)) {
      const golden = JSON.parse(committed.get(`scenarios/${name}/scorecard.json`) ?? 'null') as {
        unreachable?: string;
        score_pct: number;
        score: { relative: number; global: number };
        results: Array<{ id: string; status: string; na_reason?: string }>;
      };
      const expected =
        golden.unreachable !== undefined
          ? { unreachable: true }
          : {
              score_pct: golden.score_pct,
              score: { relative: golden.score.relative, global: golden.score.global },
              results: golden.results.map((row) => ({
                id: row.id,
                status: row.status,
                ...(row.na_reason !== undefined ? { na_reason: row.na_reason } : {}),
              })),
            };
      expect({ name, entry: index[name] }).toEqual({ name, entry: expected });
    }
  });

  // Which alternatives a site presents is read from its rows, so a stored
  // scorecard, a re-render, and the CLI's port all reach the global the
  // engine published without rerunning the audit.
  test("every golden's scores recompute from its stored rows and the registry", () => {
    for (const name of Object.keys(SCENARIOS).sort()) {
      const golden = JSON.parse(readFileSync(join(SCENARIOS_DIR, name, 'scorecard.json'), 'utf8')) as
        | WebScorecard
        | { unreachable: string };
      if ('unreachable' in golden) continue;
      const score = scoreWebAudit(golden.results, universeMaxOf(registry, golden.results));
      expect({ name, relative: score.relative, global: score.global }).toEqual({ name, ...golden.score });
    }
  });

  test('two generations produce identical bytes (determinism)', async () => {
    const first = await generateCorpus(registry);
    const second = await generateCorpus(registry);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [name, content] of first) {
      if (second.get(name) !== content) throw new Error(`${name} differs between two generations`);
    }
  });

  test('the registry carries no lookaround or backreference (the CLI compiles every pattern)', () => {
    const source = readFileSync(REGISTRY_PATH, 'utf8');
    expect(source).not.toMatch(/\(\?[=!<]/);
    for (const check of registry.checks) {
      const expectBlock = (check.with as { expect?: Record<string, unknown> }).expect ?? {};
      const patterns = [
        expectBlock.content_type,
        (expectBlock.header_regex as { pattern?: string } | undefined)?.pattern,
        expectBlock.body_regex,
        expectBlock.body_not_regex,
      ].filter((p): p is string => typeof p === 'string');
      for (const pattern of patterns) {
        expect({ id: check.id, pattern }).not.toMatchObject({ pattern: expect.stringMatching(/\(\?[=!<]|\\[1-9]/) });
      }
    }
  });
});
