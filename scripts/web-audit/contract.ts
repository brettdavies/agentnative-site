// Generates the CLI vendoring contract and reports how the committed copy
// differs from a fresh generation. The CLI reads this directory instead of
// this repo's sources, so a drifted file is a wrong input in another repo; the
// `--check` mode and the contract test both report through this module.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectionBytes, projectWebRemediation } from '../../src/build/13-web-audit-registry.mjs';
import { VENDORED_CARD_SCHEMA_PATH } from '../../src/build/web-audit-card-schema.mjs';
import type { WebAuditRegistry } from '../../src/worker/audit-web/registry';
import { generateCorpus } from './conformance-corpus';
import {
  CONTRACT_BUILD_TREE,
  CONTRACT_CORPUS_TREE,
  CONTRACT_DIR,
  CONTRACT_LISTING,
  GENERATED_TREES,
  REGENERATE_COMMAND,
  REMEDIATION_PATH,
} from './contract-paths';

/** The generated files of `build/`, by file name. */
export function generateContractBuild(registry: WebAuditRegistry): Map<string, string> {
  return new Map([
    ['registry.json', projectionBytes(registry)],
    ['remediation.json', projectionBytes(projectWebRemediation(readFileSync(REMEDIATION_PATH, 'utf8'), registry))],
    ['server-card.schema.json', readFileSync(VENDORED_CARD_SCHEMA_PATH, 'utf8')],
  ]);
}

/** Every generated file of the contract, by its path under the contract root. */
export async function generateContract(registry: WebAuditRegistry): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [name, content] of generateContractBuild(registry)) files.set(`${CONTRACT_BUILD_TREE}/${name}`, content);
  for (const [name, content] of await generateCorpus(registry)) files.set(`${CONTRACT_CORPUS_TREE}/${name}`, content);
  return files;
}

function filesUnder(root: string, tree: string): string[] {
  const dir = join(root, tree);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${tree}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

export type ContractDrift = {
  /** Generated files that a regeneration would change, add, or remove. */
  stale: string[];
  /** Entries that differ from the pinned listing, which a regeneration does not settle. */
  listing: string[];
};

/** How the contract under `root` differs from `generated` and from the pinned listing. */
export function contractDrift(generated: ReadonlyMap<string, string>, root: string = CONTRACT_DIR): ContractDrift {
  const stale: string[] = [];
  for (const [name, content] of generated) {
    const path = join(root, name);
    if (!existsSync(path)) stale.push(`${name} (missing)`);
    else if (!Buffer.from(content).equals(readFileSync(path))) stale.push(name);
  }
  for (const tree of GENERATED_TREES) {
    for (const name of filesUnder(root, tree)) {
      if (!generated.has(name)) stale.push(`${name} (no longer generated)`);
    }
  }

  const listing: string[] = [];
  for (const [dir, pinned] of Object.entries(CONTRACT_LISTING)) {
    const path = dir === '.' ? root : join(root, dir);
    const actual = existsSync(path) ? readdirSync(path) : [];
    const entry = (name: string) => (dir === '.' ? name : `${dir}/${name}`);
    for (const name of actual) {
      if (!pinned.includes(name)) listing.push(`${entry(name)} (not in the pinned listing)`);
    }
    for (const name of pinned) {
      if (!actual.includes(name)) listing.push(`${entry(name)} (pinned but missing)`);
    }
  }
  return { stale: stale.sort(), listing: listing.sort() };
}

/** What a failing check prints: each drifted entry and what settles it. Null when nothing drifted. */
export function contractDriftMessage({ stale, listing }: ContractDrift): string | null {
  const sections: string[] = [];
  if (stale.length > 0) {
    sections.push(
      `stale contract files (${stale.length}):\n  ${stale.join('\n  ')}\nrun \`${REGENERATE_COMMAND}\` and commit the result.`,
    );
  }
  if (listing.length > 0) {
    sections.push(
      `contract listing differs (${listing.length}):\n  ${listing.join('\n  ')}\n` +
        'remove the file, or add it to CONTRACT_LISTING in scripts/web-audit/contract-paths.ts: ' +
        'the CLI vendors these directories whole, so a new file is a change to its inputs.',
    );
  }
  return sections.length > 0 ? sections.join('\n') : null;
}
