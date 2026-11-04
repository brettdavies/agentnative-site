// The one owner of every path in the CLI vendoring contract and of the listing
// that pins its shape, so a script or a test imports a contract path instead of
// deriving it. The CLI's sync maps `build/` and `test/` whole, so a moved path or
// a new entry here is a change to that repo's inputs too.

import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '..', '..');
const WEB_AUDIT_DATA_DIR = join(REPO_ROOT, 'src', 'data', 'web-audit');

export const REGISTRY_PATH = join(WEB_AUDIT_DATA_DIR, 'registry.yaml');
export const REMEDIATION_PATH = join(WEB_AUDIT_DATA_DIR, 'remediation.yaml');

export const CONTRACT_DIR = join(WEB_AUDIT_DATA_DIR, 'contract');
export const CONTRACT_BUILD_TREE = 'build';
export const CONTRACT_CORPUS_TREE = 'test/conformance';
/** The trees under the contract root that hold only generated files, which a regeneration replaces whole. */
export const GENERATED_TREES = [CONTRACT_BUILD_TREE, CONTRACT_CORPUS_TREE] as const;

export const CONTRACT_BUILD_DIR = join(CONTRACT_DIR, CONTRACT_BUILD_TREE);
export const CORPUS_DIR = join(CONTRACT_DIR, CONTRACT_CORPUS_TREE);
export const SCENARIOS_DIR = join(CORPUS_DIR, 'scenarios');
export const SCORE_PARITY_PATH = join(CONTRACT_DIR, 'test', 'score-parity.json');

export const REGENERATE_COMMAND = 'bun scripts/web-audit/gen-fixtures.ts';

/**
 * The entries of the contract root, `build/` and `test/`. The corpus subtree is
 * held to its generator's file set instead, since its scenarios change often
 * and none of them changes the layout the CLI maps.
 */
export const CONTRACT_LISTING: Readonly<Record<'.' | 'build' | 'test', readonly string[]>> = {
  '.': ['.editorconfig', 'README.md', 'build', 'test'],
  build: ['registry.json', 'remediation.json', 'server-card.schema.json'],
  test: ['conformance', 'score-parity.json'],
};
