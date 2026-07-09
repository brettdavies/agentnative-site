// get_web_remediation + catalog coverage tests (plan U13).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  EVIDENCE_TEMPLATE_CHECKS,
  normalizeWebAuditRegistry,
  normalizeWebRemediation,
} from '../src/build/13-web-audit-registry.mjs';

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
  test('every registry check id has a remediation entry (no misses across all 34)', async () => {
    const { checkIds, remediation } = await load();
    expect(checkIds.length).toBe(34);
    for (const id of checkIds) {
      expect(remediation[id]).toBeDefined();
      expect(remediation[id].title.length).toBeGreaterThan(0);
      expect(remediation[id].body.length).toBeGreaterThan(0);
    }
  });

  test('MCP-shape checks carry the {{evidence}} template slot', async () => {
    const { remediation } = await load();
    for (const id of EVIDENCE_TEMPLATE_CHECKS) {
      expect(remediation[id].evidence_template).toBe(true);
      expect(remediation[id].body).toContain('{{evidence}}');
    }
  });

  test('non-MCP-shape checks are static (no evidence template)', async () => {
    const { remediation } = await load();
    expect(remediation['llms-txt'].evidence_template).toBe(false);
    expect(remediation['robots'].body).not.toContain('{{evidence}}');
  });

  test('an unknown check id aborts normalization (orphan guard)', async () => {
    const doc = { remediation: { 'not-a-check': { title: 't', body: 'b' } } };
    expect(() => normalizeWebRemediation(doc, ['llms-txt'])).toThrow(/orphan|no remediation/);
  });

  test('a missing remediation entry aborts normalization', async () => {
    const doc = { remediation: {} };
    expect(() => normalizeWebRemediation(doc, ['llms-txt'])).toThrow(/no remediation entry/);
  });

  test('an MCP-shape check without the evidence slot aborts', async () => {
    const doc = {
      remediation: { 'mcp-initialize': { title: 't', body: 'no slot here', evidence_template: true } },
    };
    expect(() => normalizeWebRemediation(doc, ['mcp-initialize'])).toThrow(/evidence slot/);
  });
});
