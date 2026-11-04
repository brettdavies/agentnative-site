// The one owner of every path in the CLI vendoring contract, so a script or a
// test imports a contract path instead of deriving it. The contract's layout
// is what the CLI's sync maps, so a moved path here is a change to that repo's
// vendoring too.

import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '..', '..');
const WEB_AUDIT_DATA_DIR = join(REPO_ROOT, 'src', 'data', 'web-audit');

export const REGISTRY_PATH = join(WEB_AUDIT_DATA_DIR, 'registry.yaml');

export const CONTRACT_DIR = join(WEB_AUDIT_DATA_DIR, 'contract');
export const CORPUS_DIR = join(CONTRACT_DIR, 'test', 'conformance');
export const SCENARIOS_DIR = join(CORPUS_DIR, 'scenarios');
export const SCORE_PARITY_PATH = join(CONTRACT_DIR, 'test', 'score-parity.json');
