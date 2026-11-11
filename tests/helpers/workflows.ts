// Shared access to the tracked GitHub workflow files for tests that
// assert directly on their contents.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = new URL('../..', import.meta.url).pathname;
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');

/** Every path git tracks. A file removed from the tree stays listed until the removal is staged. */
export function trackedPaths(): string[] {
  const listing = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  return listing.stdout.toString().split('\n').filter(Boolean);
}

export function listWorkflows(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

export function workflowText(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
}
