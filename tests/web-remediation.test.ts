// Remediation catalog coverage tests (plan U13, reshaped per plan-003
// U12): every check carries title/goal/fix plus optional resources, and
// the normalizer rejects the retired body/evidence-template shape.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from '../src/build/13-web-audit-registry.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(REPO_ROOT, 'src', 'data', 'web-audit');

async function load() {
  const registry = normalizeWebAuditRegistry(yaml.load(await readFile(join(DATA, 'registry.yaml'), 'utf8')));
  const checkIds = registry.checks.map((c: { id: string }) => c.id);
  const remediation = normalizeWebRemediation(
    yaml.load(await readFile(join(DATA, 'remediation.yaml'), 'utf8')),
    checkIds,
  );
  return { checkIds, remediation };
}

describe('web remediation catalog coverage', () => {
  test('every registry check id has a remediation entry (no misses across all 36)', async () => {
    const { checkIds, remediation } = await load();
    expect(checkIds.length).toBe(36);
    for (const id of checkIds) {
      expect(remediation[id]).toBeDefined();
      expect(remediation[id].title.length).toBeGreaterThan(0);
      expect(remediation[id].goal.length).toBeGreaterThan(0);
      expect(remediation[id].fix.length).toBeGreaterThan(0);
      expect(Array.isArray(remediation[id].resources)).toBe(true);
    }
  });

  test('no entry carries an evidence slot (evidence is assembled at audit time)', async () => {
    const { remediation } = await load();
    for (const entry of Object.values(remediation)) {
      expect(entry.fix).not.toContain('{{evidence}}');
    }
  });

  test('every resource link is an absolute URL with a label', async () => {
    const { remediation } = await load();
    for (const entry of Object.values(remediation)) {
      for (const resource of entry.resources) {
        expect(resource.label.length).toBeGreaterThan(0);
        expect(resource.url).toMatch(/^https?:\/\//);
      }
    }
  });

  test('an unknown check id aborts normalization (orphan guard)', async () => {
    const doc = { remediation: { 'not-a-check': { title: 't', goal: 'g', fix: 'f' } } };
    expect(() => normalizeWebRemediation(doc, ['llms-txt'])).toThrow(/orphan|no remediation/);
  });

  test('a missing remediation entry aborts normalization', async () => {
    const doc = { remediation: {} };
    expect(() => normalizeWebRemediation(doc, ['llms-txt'])).toThrow(/no remediation entry/);
  });

  test('the retired body/evidence_template shape aborts normalization', async () => {
    const doc = {
      remediation: { 'llms-txt': { title: 't', goal: 'g', fix: 'f', body: 'legacy' } },
    };
    expect(() => normalizeWebRemediation(doc, ['llms-txt'])).toThrow(/retired/);
  });

  test('an entry missing goal or fix aborts normalization', async () => {
    expect(() =>
      normalizeWebRemediation({ remediation: { 'llms-txt': { title: 't', fix: 'f' } } }, ['llms-txt']),
    ).toThrow(/goal/);
  });
});
