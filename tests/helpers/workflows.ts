// Shared access to the tracked GitHub workflow files for tests that
// assert directly on their contents.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = new URL('../..', import.meta.url).pathname;
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');

export function listWorkflows(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

export function workflowText(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
}
