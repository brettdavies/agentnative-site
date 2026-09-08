// The probe script is the single verdict both the in-job diagnosis and the
// deep-check-crash-retry workflow trust to distinguish an infrastructure
// death of the dev server from a real failure. Nothing executes it at PR
// time, so its two evidence signatures are pinned here the same way
// workflow-gates pins the retry workflow's shape.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const PROBE = join(REPO_ROOT, '.github/actions/wrangler-crash-probe/probe.sh');

function probe(dir: string): number {
  return Bun.spawnSync(['bash', PROBE, dir]).exitCode;
}

function evidenceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const PROXY_CRASH_LOG = [
  'ProxyController got error message',
  'Network connection lost',
  'castErrorCause',
  'handleLoopback',
].join('\n');

const refusalSummary = (n: number) =>
  JSON.stringify({
    errors: Array.from({ length: n }, () => ({
      message: 'page.goto: Could not connect to localhost: Connection refused',
    })),
  });

describe('wrangler-crash-probe probe.sh', () => {
  test('matches the workers-sdk#15317 signature in a wrangler debug log', () => {
    expect(probe(evidenceDir({ 'wrangler.log': PROXY_CRASH_LOG }))).toBe(0);
  });

  test('a partial string set is not the proxy-crash signature', () => {
    expect(probe(evidenceDir({ 'wrangler.log': 'ProxyController\nhandleLoopback' }))).toBe(1);
  });

  test('mass connection refusals in the Playwright summary are server-death evidence on their own', () => {
    expect(probe(evidenceDir({ 'playwright-summary.json': refusalSummary(74) }))).toBe(0);
  });

  test('a handful of refusals stays below the floor: one flaky test earns no retry', () => {
    expect(probe(evidenceDir({ 'playwright-summary.json': refusalSummary(3) }))).toBe(1);
  });

  test('refusal counting reads only JSON evidence, not the debug log', () => {
    expect(probe(evidenceDir({ 'wrangler.log': refusalSummary(74) }))).toBe(1);
  });

  test('clean evidence reports a real failure', () => {
    expect(probe(evidenceDir({ 'wrangler.log': 'routine debug output' }))).toBe(1);
  });
});
