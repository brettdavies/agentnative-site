// The Bun toolchain version is declared exactly once, in .bun-version.
// Every setup-bun step resolves it via bun-version-file; nothing may
// restate it inline or through env indirection, because setup-bun falls
// through to a silent `latest` when unconfigured and a restated copy is
// a second declaration free to drift. Only the Bun.version assertion can
// see a CI-versus-local split: the workflow checks compare tracked files
// to each other and can be uniformly wrong, while the interpreter check
// compares the runtime actually executing this suite against the pin.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkflows, REPO_ROOT, workflowText } from './helpers/workflows';

const pinned = readFileSync(join(REPO_ROOT, '.bun-version'), 'utf8').trim();
const workflows = listWorkflows();

describe('the Bun version is declared once, in the tree', () => {
  test('.bun-version holds a bare semver', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('no workflow restates the version inline', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const file of workflows) {
      // Matches a bun-version key with any value: a literal, `latest`,
      // or `${{ env.BUN_VERSION }}` indirection are all second
      // declarations. bun-version-file is the one sanctioned key and
      // does not match (the colon must follow "version" directly).
      expect(
        workflowText(file),
        `${file} must not set bun-version; point setup-bun at .bun-version via bun-version-file`,
      ).not.toMatch(/bun-version:\s*\S/);
    }
  });

  test('no workflow defines BUN_VERSION env', () => {
    for (const file of workflows) {
      expect(
        workflowText(file),
        `${file} must not define BUN_VERSION; delete the env entry and read .bun-version via bun-version-file`,
      ).not.toMatch(/^\s*BUN_VERSION:/m);
    }
  });

  test('every setup-bun step reads .bun-version', () => {
    for (const file of workflows) {
      const lines = workflowText(file).split('\n');
      const steps = lines.filter((l) => l.includes('oven-sh/setup-bun')).length;
      const reads = lines.filter((l) => l.includes('bun-version-file: .bun-version')).length;
      expect(
        reads,
        `${file} has ${steps} setup-bun step(s) but ${reads} reading .bun-version; add bun-version-file: .bun-version to each`,
      ).toBe(steps);
    }
  });

  test('the lockfile-resolved bun-types tracks the pinned minor', () => {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8');
    const resolved = lock.match(/"bun-types@(\d+\.\d+\.\d+)"/)?.[1];
    const [major, minor] = pinned.split('.');
    expect(resolved, 'bun.lock must resolve a bun-types version').toBeDefined();
    expect(
      resolved?.startsWith(`${major}.${minor}.`),
      `bun-types resolves to ${resolved} but .bun-version pins ${pinned}; bump bun-types to ^${major}.${minor}.0 and refresh bun.lock`,
    ).toBe(true);
  });

  test('the runtime running this suite is the pinned one', () => {
    expect(
      Bun.version,
      `this suite runs under Bun ${Bun.version} but .bun-version pins ${pinned}; install the pinned Bun or bump .bun-version deliberately`,
    ).toBe(pinned);
  });
});
