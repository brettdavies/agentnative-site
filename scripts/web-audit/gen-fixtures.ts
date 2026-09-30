#!/usr/bin/env bun
// Writes the web-audit conformance corpus (tests/fixtures/web-audit-conformance)
// from the scenarios in conformance-scenarios.ts, or checks that the committed
// corpus is current.
//
//   bun scripts/web-audit/gen-fixtures.ts                 regenerate every file in place
//   bun scripts/web-audit/gen-fixtures.ts --check         exit 1 on any stale or missing file
//   bun scripts/web-audit/gen-fixtures.ts --scenario x    print scenario x's scorecard, write nothing

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CORPUS_DIR, generateCorpus, loadRegistry, runScenario } from './conformance-corpus';
import { SCENARIOS } from './conformance-scenarios';

function committed(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CORPUS_DIR)) return out;
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

async function main(argv: string[]): Promise<number> {
  const registry = loadRegistry();

  const single = argv.indexOf('--scenario');
  if (single !== -1) {
    const name = argv[single + 1];
    const scenario = name === undefined ? undefined : SCENARIOS[name];
    if (!scenario) {
      console.error(`no such scenario: ${name ?? '(missing)'}; known: ${Object.keys(SCENARIOS).sort().join(', ')}`);
      return 2;
    }
    const run = await runScenario(name as string, scenario, registry);
    process.stdout.write(run.output);
    if (run.unmatched.length > 0) console.error(`unmatched requests:\n  ${run.unmatched.join('\n  ')}`);
    return 0;
  }

  const files = await generateCorpus(registry);

  if (argv.includes('--check')) {
    const current = committed();
    const stale: string[] = [];
    for (const [name, content] of files) {
      if (current.get(name) !== content) stale.push(name);
    }
    for (const name of current.keys()) {
      if (!files.has(name)) stale.push(`${name} (no longer generated)`);
    }
    if (stale.length === 0) {
      console.log(`ok: ${files.size} corpus files match the current registry and engine`);
      return 0;
    }
    console.error(`stale corpus files (${stale.length}):\n  ${stale.join('\n  ')}`);
    console.error('run `bun scripts/web-audit/gen-fixtures.ts` and commit the result.');
    return 1;
  }

  const scenariosDir = join(CORPUS_DIR, 'scenarios');
  if (existsSync(scenariosDir)) rmSync(scenariosDir, { recursive: true });
  for (const [name, content] of files) {
    const path = join(CORPUS_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`wrote ${files.size} corpus files to ${CORPUS_DIR}`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
