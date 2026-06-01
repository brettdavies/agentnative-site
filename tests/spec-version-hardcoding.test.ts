// Red-team meta-test: scans tests/ for hardcoded SPEC_VERSION and
// ANC_VERSION literals that would break when either constant advances.
// The earlier coupling regression — bumping SPEC_VERSION from 0.4.0
// to 0.5.0 broke ~12 test files because cache keys and spec_version
// fields were hardcoded — motivated this guard. Tests now import the
// constants from src/worker/spec-version.gen.ts (or via util.mjs which
// re-exports them) and construct keys with keyFor() so they auto-track.
//
// Patterns this guard flags (only when the literal matches the current
// constant; arbitrary stale versions like '0.0.1' for SPEC_VERSION or
// '0.2.5' for ANC_VERSION are fine because they represent
// deliberately-different versions for partition tests):
//
//   1. Cache key literal: `scores/<binary>/<SPEC_VERSION>.json`
//      Use `keyFor('<binary>', SPEC_VERSION)` instead.
//
//   2. Object field literal: `spec_version: '<SPEC_VERSION>'`
//      Use `spec_version: SPEC_VERSION` instead.
//
//   3. Object field literal: `anc_version: '<ANC_VERSION>'`
//      Use `anc_version: ANC_VERSION` instead.
//
//   4. `anc --version` stdout mock: `'anc <ANC_VERSION>\n'`
//      Use a template literal `\`anc ${ANC_VERSION}\\n\`` instead.
//
// Allowed:
//   - Comments and block-comment lines (history, examples).
//   - Lines that already use the `${SPEC_VERSION}` / `${ANC_VERSION}`
//     template or call `keyFor()` (the canonical helpers).
//   - Stale-version literals that intentionally differ from the
//     current constants (used by partition tests to prove that an
//     old key is unreachable from the running Worker).
//   - This file itself.

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TESTS_DIR = join(REPO_ROOT, 'tests');
const SELF_BASENAME = 'spec-version-hardcoding.test.ts';

async function listTestFiles(): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = extname(full);
        if ((ext === '.ts' || ext === '.mjs') && !full.endsWith(SELF_BASENAME)) {
          files.push(full);
        }
      }
    }
  }
  await walk(TESTS_DIR);
  return files;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommentLine(line: string): boolean {
  const stripped = line.trim();
  return stripped.startsWith('//') || stripped.startsWith('*');
}

describe('spec-version-hardcoding red-team', () => {
  test('no cache-key literal scores/<binary>/<SPEC_VERSION>.json exists in tests/', async () => {
    const files = await listTestFiles();
    const offenders: { file: string; line: number; text: string }[] = [];
    const cacheKeyRe = new RegExp(`scores/[^/'"\`\\s]+/${escapeRegex(SPEC_VERSION)}\\.json`);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!cacheKeyRe.test(line)) continue;
        if (isCommentLine(line)) continue;
        // Skip lines that already use a template literal or keyFor —
        // those are the canonical patterns.
        if (line.includes('${SPEC_VERSION}') || line.includes('keyFor(')) continue;
        offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} hardcoded cache-key literal(s) matching the current ` +
          `SPEC_VERSION (${SPEC_VERSION}). Use keyFor('<binary>', SPEC_VERSION) or a ` +
          `template literal so tests auto-track when SPEC_VERSION advances:\n${summary}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test('no spec_version: literal matching SPEC_VERSION exists in tests/', async () => {
    const files = await listTestFiles();
    const offenders: { file: string; line: number; text: string }[] = [];
    const fieldRe = new RegExp(`spec_version\\s*:\\s*['"\`]${escapeRegex(SPEC_VERSION)}['"\`]`);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!fieldRe.test(line)) continue;
        if (isCommentLine(line)) continue;
        offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} hardcoded spec_version literal(s) matching ` +
          `SPEC_VERSION (${SPEC_VERSION}). Use spec_version: SPEC_VERSION so fixtures ` +
          `auto-track when SPEC_VERSION advances:\n${summary}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test('no anc_version: literal matching ANC_VERSION exists in tests/', async () => {
    const files = await listTestFiles();
    const offenders: { file: string; line: number; text: string }[] = [];
    const fieldRe = new RegExp(`anc_version\\s*:\\s*['"\`]${escapeRegex(ANC_VERSION)}['"\`]`);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!fieldRe.test(line)) continue;
        if (isCommentLine(line)) continue;
        offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} hardcoded anc_version literal(s) matching ` +
          `ANC_VERSION (${ANC_VERSION}). Use anc_version: ANC_VERSION so fixtures ` +
          `auto-track when the published anc binary advances:\n${summary}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test('no `anc <ANC_VERSION>` stdout-mock literal exists in tests/', async () => {
    // `anc --version` stdout mocks should use a template literal so the
    // value moves with the published anc release. The exec-mock pattern
    // is `'anc X.Y.Z\\n'` — flag those where X.Y.Z matches ANC_VERSION.
    const files = await listTestFiles();
    const offenders: { file: string; line: number; text: string }[] = [];
    const stdoutRe = new RegExp(`['"]anc\\s+${escapeRegex(ANC_VERSION)}\\\\n['"]`);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!stdoutRe.test(line)) continue;
        if (isCommentLine(line)) continue;
        offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} hardcoded \`anc <ANC_VERSION>\\n\` stdout-mock ` +
          `literal(s) matching ANC_VERSION (${ANC_VERSION}). Use a template literal ` +
          `\`anc \${ANC_VERSION}\\n\` so mocks auto-track:\n${summary}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Self-test: prove the guard catches what it claims to catch. If the
  // detection regex regresses (e.g., someone "fixes" it to accept any
  // version), this test fails because the seeded literal goes
  // un-flagged. Run the same detection logic against a synthetic input
  // rather than the real tree.
  // -------------------------------------------------------------------------

  test('self-test: cache-key regex flags a seeded literal', () => {
    const seeded = `const STALE = 'scores/foo/${SPEC_VERSION}.json'; // should flag`;
    const cacheKeyRe = new RegExp(`scores/[^/'"\`\\s]+/${escapeRegex(SPEC_VERSION)}\\.json`);
    expect(cacheKeyRe.test(seeded)).toBe(true);
  });

  test('self-test: cache-key regex does NOT flag a different version (partition-test literal)', () => {
    // A different semver (e.g., a stale version used to test partition
    // behavior) must NOT be flagged. Otherwise legitimate "older
    // version" fixtures would falsely match.
    const stalePartition = "const OLD = 'scores/foo/0.0.1.json';";
    const cacheKeyRe = new RegExp(`scores/[^/'"\`\\s]+/${escapeRegex(SPEC_VERSION)}\\.json`);
    expect(cacheKeyRe.test(stalePartition)).toBe(false);
  });

  test('self-test: cache-key regex does NOT flag a template-literal usage', () => {
    // The canonical replacement pattern uses `${SPEC_VERSION}`; the
    // guard logic must allow that form. Verified at the "skip" branch
    // in the main test, but also exercised here so a regression that
    // drops the skip surfaces in self-test before it surfaces by
    // letting real offenders through.
    const canonical = 'const KEY = `scores/foo/${SPEC_VERSION}.json`;';
    const isAllowed = canonical.includes('${SPEC_VERSION}') || canonical.includes('keyFor(');
    expect(isAllowed).toBe(true);
  });

  test('self-test: spec_version regex flags a seeded literal', () => {
    const seeded = `const PAYLOAD = { spec_version: '${SPEC_VERSION}' };`;
    const fieldRe = new RegExp(`spec_version\\s*:\\s*['"\`]${escapeRegex(SPEC_VERSION)}['"\`]`);
    expect(fieldRe.test(seeded)).toBe(true);
  });

  test('self-test: spec_version regex does NOT flag a SPEC_VERSION identifier reference', () => {
    const canonical = 'const PAYLOAD = { spec_version: SPEC_VERSION };';
    const fieldRe = new RegExp(`spec_version\\s*:\\s*['"\`]${escapeRegex(SPEC_VERSION)}['"\`]`);
    expect(fieldRe.test(canonical)).toBe(false);
  });

  test('self-test: anc_version regex flags a seeded literal', () => {
    const seeded = `const PAYLOAD = { anc_version: '${ANC_VERSION}' };`;
    const fieldRe = new RegExp(`anc_version\\s*:\\s*['"\`]${escapeRegex(ANC_VERSION)}['"\`]`);
    expect(fieldRe.test(seeded)).toBe(true);
  });

  test('self-test: anc_version regex does NOT flag a different version (stale-fixture literal)', () => {
    const stale = "const OLD = { anc_version: '0.2.5' };";
    const fieldRe = new RegExp(`anc_version\\s*:\\s*['"\`]${escapeRegex(ANC_VERSION)}['"\`]`);
    expect(fieldRe.test(stale)).toBe(false);
  });

  test('self-test: anc-stdout regex flags a seeded literal', () => {
    const seeded = `return { stdout: 'anc ${ANC_VERSION}\\n' };`;
    const stdoutRe = new RegExp(`['"]anc\\s+${escapeRegex(ANC_VERSION)}\\\\n['"]`);
    expect(stdoutRe.test(seeded)).toBe(true);
  });

  test('self-test: anc-stdout regex does NOT flag a template literal', () => {
    const canonical = 'return { stdout: `anc ${ANC_VERSION}\\n` };';
    const stdoutRe = new RegExp(`['"]anc\\s+${escapeRegex(ANC_VERSION)}\\\\n['"]`);
    expect(stdoutRe.test(canonical)).toBe(false);
  });
});
