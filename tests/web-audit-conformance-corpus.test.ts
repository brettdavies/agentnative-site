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
