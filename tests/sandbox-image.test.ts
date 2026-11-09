import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = readFileSync(join(import.meta.dir, '..', 'docker/sandbox/Dockerfile'), 'utf8');

describe('sandbox image permissions', () => {
  test('the auditor is installed execute-only', () => {
    expect(dockerfile).toMatch(/install -m 0111 \S+\/anc \/usr\/local\/bin\/anc/);
  });

  test('the audit user has a fixed UID and its own install directory', () => {
    expect(dockerfile).toMatch(/useradd --uid 1000 .*anc-audit/);
    expect(dockerfile).toMatch(/install -d -o anc-audit -g anc-audit .*\/home\/anc-audit\/\.local\/bin/);
  });

  test('the empty config directory is root-owned', () => {
    expect(dockerfile).toMatch(/install -d -o root -g root -m 0755 \/opt\/anc-empty/);
  });

  test('the image declares no USER, so the control server stays root', () => {
    expect(dockerfile).not.toMatch(/^\s*USER\s/m);
  });
});
