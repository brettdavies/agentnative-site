#!/usr/bin/env bun
// Writes every generated file of the CLI vendoring contract: `build/` from the
// registry, the fix catalog and the vendored schema, and `test/conformance/`
// from the scenarios in conformance-scenarios.ts. Or checks that the committed
// contract is current. contract-paths.ts owns the layout.
//
//   bun scripts/web-audit/gen-fixtures.ts                 regenerate every file in place
//   bun scripts/web-audit/gen-fixtures.ts --check         exit 1 naming any stale, missing or unpinned file
//   bun scripts/web-audit/gen-fixtures.ts --scenario x    print scenario x's scorecard, write nothing

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadRegistry, runScenario } from './conformance-corpus';
import { SCENARIOS } from './conformance-scenarios';
import { contractDrift, contractDriftMessage, generateContract } from './contract';
import { CONTRACT_DIR, GENERATED_TREES } from './contract-paths';

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

  const files = await generateContract(registry);

  if (argv.includes('--check')) {
    const message = contractDriftMessage(contractDrift(files));
    if (message === null) {
      console.log(`ok: ${files.size} generated contract files match the registry, the fix catalog and the engine`);
      return 0;
    }
    console.error(message);
    return 1;
  }

  for (const tree of GENERATED_TREES) rmSync(join(CONTRACT_DIR, tree), { recursive: true, force: true });
  for (const [name, content] of files) {
    const path = join(CONTRACT_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`wrote ${files.size} generated contract files to ${CONTRACT_DIR}`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
