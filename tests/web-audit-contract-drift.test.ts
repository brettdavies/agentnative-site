// How a drifted vendoring contract reads, on small synthetic contracts, so a stale
// file or an unpinned entry reports the file and what settles it.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contractDrift, contractDriftMessage, contractFingerprint, mirroredFiles } from '../scripts/web-audit/contract';
import { emitWebAuditContractFingerprint } from '../src/build/13-web-audit-registry.mjs';
import {
  CONTRACT_FINGERPRINT_FILE,
  CONTRACT_FINGERPRINT_PATH,
  CONTRACT_LISTING,
  REGENERATE_COMMAND,
} from '../src/build/web-audit-contract-paths.mjs';

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anc-contract-'));
  scratchDirs.push(dir);
  return dir;
}

/** A minimal contract that matches the pinned listing, with its own generated set, for a test to damage. */
function cleanContract(): { root: string; files: Map<string, string> } {
  const root = scratchDir();
  const files = new Map<string, string>([
    ...CONTRACT_LISTING.build.map((name): [string, string] => [`build/${name}`, `${name}\n`]),
    ['test/conformance/scores.json', 'scores\n'],
  ]);
  for (const name of [...files.keys(), '.editorconfig', 'README.md', 'test/score-parity.json']) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), files.get(name) ?? 'hand-authored\n');
  }
  expect(contractDrift(files, root)).toEqual({ stale: [], listing: [] });
  return { root, files };
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the contract fingerprint', () => {
  const base = new Map([
    ['build/a.json', 'a\n'],
    ['test/b.json', 'b\n'],
  ]);

  test('does not depend on the order files are listed in', () => {
    expect(contractFingerprint(new Map([...base].reverse()))).toBe(contractFingerprint(base));
  });

  test.each([
    ['one byte of a file', new Map([...base, ['test/b.json', 'c\n']])],
    [
      'a path',
      new Map([
        ['build/a.json', 'a\n'],
        ['test/c.json', 'b\n'],
      ]),
    ],
    ['an added file', new Map([...base, ['test/c.json', '']])],
    [
      'where one file ends and the next begins',
      new Map([
        ['build/a.json', 'a\nb'],
        ['test/b.json', '\n'],
      ]),
    ],
  ])('moves with %s', (_what, changed) => {
    expect(contractFingerprint(changed)).not.toBe(contractFingerprint(base));
  });

  test('leaves out its own line', () => {
    expect(contractFingerprint(new Map([...base, [CONTRACT_FINGERPRINT_FILE, 'ffffffffffff\n']]))).toBe(
      contractFingerprint(base),
    );
  });

  // A prose edit must not make every older CLI report that it differs.
  test('over the real contract, a README edit leaves it still and a scorecard edit moves it', () => {
    const committed = readFileSync(CONTRACT_FINGERPRINT_PATH, 'utf8');
    const readme = mirroredFiles();
    readme.set('test/conformance/README.md', Buffer.from('edited prose\n'));
    expect(contractFingerprint(readme)).toBe(committed);
    const scorecard = mirroredFiles();
    scorecard.set('test/conformance/scenarios/run-healthy/scorecard.json', Buffer.from('{}\n'));
    expect(contractFingerprint(scorecard)).not.toBe(committed);
  });

  test('a malformed FINGERPRINT aborts the build naming the regenerate command', async () => {
    const dist = scratchDir();
    mkdirSync(join(dist, '_internal'));
    const fingerprintPath = join(dist, 'FINGERPRINT');
    writeFileSync(fingerprintPath, 'not-a-fingerprint\n');
    await expect(emitWebAuditContractFingerprint({ distDir: dist, fingerprintPath })).rejects.toThrow(
      REGENERATE_COMMAND,
    );
  });

  test('a stale FINGERPRINT fails naming it and the regenerate command', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, CONTRACT_FINGERPRINT_FILE), 'ffffffffffff\n');
    const message = contractDriftMessage(contractDrift(files, root));
    expect(message).toContain(CONTRACT_FINGERPRINT_FILE);
    expect(message).toContain(REGENERATE_COMMAND);
  });
});

describe('a contract that has drifted', () => {
  test('a stale generated file fails naming it and the regenerate command', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, 'build', 'registry.json'), '{}\n');
    const message = contractDriftMessage(contractDrift(files, root));
    expect(message).toContain('build/registry.json');
    expect(message).toContain(REGENERATE_COMMAND);
  });

  test('a one-byte difference counts as stale', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, 'build', 'remediation.json'), `${files.get('build/remediation.json')}\n`);
    expect(contractDrift(files, root)).toEqual({ stale: ['build/remediation.json'], listing: [] });
  });

  test('a stale corpus file fails the same way', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, 'test', 'conformance', 'scores.json'), '{}\n');
    expect(contractDrift(files, root)).toEqual({ stale: ['test/conformance/scores.json'], listing: [] });
  });

  test('a generated file gone from the tree is stale and missing from the pin', () => {
    const { root, files } = cleanContract();
    rmSync(join(root, 'build', 'server-card.schema.json'));
    expect(contractDrift(files, root)).toEqual({
      stale: ['build/server-card.schema.json (missing)'],
      listing: ['build/server-card.schema.json (pinned but missing)'],
    });
  });

  test('a file no generator writes fails in build/ as stale and against the pin', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, 'build', 'extra.json'), '{}\n');
    expect(contractDrift(files, root)).toEqual({
      stale: ['build/extra.json (no longer generated)'],
      listing: ['build/extra.json (not in the pinned listing)'],
    });
  });

  test.each([
    ['the contract root', 'extra.md', 'extra.md (not in the pinned listing)'],
    ['test/', 'test/extra.json', 'test/extra.json (not in the pinned listing)'],
  ])('a file added to %s without pinning it fails naming the listing to edit', (_where, added, reported) => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, added), 'x\n');
    const drift = contractDrift(files, root);
    expect(drift).toEqual({ stale: [], listing: [reported] });
    expect(contractDriftMessage(drift)).toContain('CONTRACT_LISTING');
  });

  test('a generated file the pin does not name fails once it is written', () => {
    const { root, files } = cleanContract();
    writeFileSync(join(root, 'build', 'unpinned.json'), '{}\n');
    const widened = new Map([...files, ['build/unpinned.json', '{}\n']]);
    expect(contractDrift(widened, root)).toEqual({
      stale: [],
      listing: ['build/unpinned.json (not in the pinned listing)'],
    });
  });
});
