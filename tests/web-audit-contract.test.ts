// The vendoring contract is what the CLI reads instead of this repo's sources,
// so a stale or unpinned file is a wrong input in another repo. This suite is
// the check that stops one here: `bun test` runs it on every PR.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import {
  contractDrift,
  contractDriftMessage,
  contractFingerprint,
  generateContract,
  generateContractBuild,
  mirroredFiles,
} from '../scripts/web-audit/contract';
import { emitWebAuditRegistry, emitWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { VENDORED_CARD_SCHEMA_PATH } from '../src/build/web-audit-card-schema.mjs';
import {
  CONTRACT_BUILD_DIR,
  CONTRACT_DIR,
  CONTRACT_FINGERPRINT_FILE,
  CONTRACT_FINGERPRINT_PATH,
  CONTRACT_LISTING,
  REPO_ROOT,
  WEB_AUDIT_REGISTRY_PATH,
  WEB_AUDIT_REMEDIATION_PATH,
} from '../src/build/web-audit-contract-paths.mjs';
import { CONTRACT_FINGERPRINT_ASSET_PATH } from '../src/shared/web-audit-contract';
import { registryFingerprintPrefix } from '../src/worker/audit-web/registry';
import { handleWebAuditVersion } from '../src/worker/audit-web/version-signal';

const registry = loadRegistry();
const generated = await generateContract(registry);

describe('the committed web-audit vendoring contract', () => {
  test('equals a fresh generation byte for byte and matches the pinned listing', () => {
    expect(contractDriftMessage(contractDrift(generated))).toBeNull();
  });

  test('two generations of build/ produce identical bytes', async () => {
    const first = await generateContractBuild(registry);
    const second = await generateContractBuild(registry);
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, content] of first) {
      if (second.get(name) !== content) throw new Error(`${name} differs between two generations`);
    }
  });

  test('registry.json and remediation.json are the bytes the build emits to dist/_internal', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'anc-contract-'));
    try {
      mkdirSync(join(dist, '_internal'));
      await emitWebAuditRegistry({ registryPath: WEB_AUDIT_REGISTRY_PATH, distDir: dist });
      await emitWebRemediation({
        remediationPath: WEB_AUDIT_REMEDIATION_PATH,
        registryPath: WEB_AUDIT_REGISTRY_PATH,
        distDir: dist,
      });
      const emitted = {
        'registry.json': join(dist, '_internal', 'web-audit-registry.json'),
        'remediation.json': join(dist, '_internal', 'web-remediation.json'),
      };
      for (const [name, path] of Object.entries(emitted)) {
        expect({ name, same: readFileSync(path).equals(readFileSync(join(CONTRACT_BUILD_DIR, name))) }).toEqual({
          name,
          same: true,
        });
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test('server-card.schema.json is the vendored schema byte for byte', () => {
    const copy = readFileSync(join(CONTRACT_BUILD_DIR, 'server-card.schema.json'));
    expect(copy.equals(readFileSync(VENDORED_CARD_SCHEMA_PATH))).toBe(true);
  });

  // A stored scorecard records this prefix, so the port compares it to know
  // which registry version a score was computed under.
  test('constants.json carries the fingerprint the Worker computes from registry.json', async () => {
    const constants = JSON.parse(readFileSync(join(CONTRACT_BUILD_DIR, 'constants.json'), 'utf8'));
    const shipped = JSON.parse(readFileSync(join(CONTRACT_BUILD_DIR, 'registry.json'), 'utf8'));
    expect(constants.REGISTRY_FINGERPRINT).toBe(await registryFingerprintPrefix(shipped));
  });

  test('FINGERPRINT is one line, over every file build/ and test/ hold on disk', () => {
    const committed = readFileSync(CONTRACT_FINGERPRINT_PATH, 'utf8');
    expect(committed).toMatch(/^[0-9a-f]{12}\n$/);
    expect(committed).toBe(contractFingerprint(mirroredFiles()));
  });

  test('the version endpoint serves the committed FINGERPRINT and the registry fingerprint constants.json carries', async () => {
    const assets: Record<string, string> = {
      '/_internal/web-audit-registry.json': join(CONTRACT_BUILD_DIR, 'registry.json'),
      [CONTRACT_FINGERPRINT_ASSET_PATH]: CONTRACT_FINGERPRINT_PATH,
    };
    const env = {
      ASSETS: {
        fetch: async (request: Request) => new Response(readFileSync(assets[new URL(request.url).pathname])),
      },
    } as unknown as Parameters<typeof handleWebAuditVersion>[1];
    const res = await handleWebAuditVersion(new Request('https://anc.dev/api/web-audit/version'), env);
    const signal = (await res.json()) as { contract_fingerprint: string; registry_fingerprint: string };
    const constants = JSON.parse(readFileSync(join(CONTRACT_BUILD_DIR, 'constants.json'), 'utf8'));
    expect(signal.contract_fingerprint).toBe(readFileSync(CONTRACT_FINGERPRINT_PATH, 'utf8').trim());
    expect(signal.registry_fingerprint).toBe(constants.REGISTRY_FINGERPRINT);
  });

  // Without this the deploy smoke accepts any fingerprint, so on a deploy that moves it an isolate still on the
  // previous deploy could pass. The production value travels from the deploying job, because the smoke job's own
  // checkout of the branch can be newer than what was deployed.
  test('both deploy jobs smoke the version signal against the FINGERPRINT they deployed', () => {
    const deploy = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
    const path = relative(REPO_ROOT, CONTRACT_FINGERPRINT_PATH);
    expect(deploy).toContain(`expected="$(tr -d '[:space:]' < ${path})"\n          test -n "$expected"\n`);
    expect(deploy).toContain(
      'SMOKE_EXPECT_CONTRACT_FINGERPRINT="$expected" scripts/smoke-web-audit-version.sh "$PUBLIC_BASE_URL"',
    );
    // The production job reads it before anything else, so a redeploy of a ref without the file must get past this step.
    expect(deploy).toContain(
      [
        `file=${path}`,
        'if [ -e "$file" ]; then',
        `  fingerprint="$(tr -d '[:space:]' < "$file")"`,
        '  test -n "$fingerprint"',
        '  echo "fingerprint=$fingerprint" >> "$GITHUB_OUTPUT"',
        'fi',
      ].join('\n          '),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(deploy).toContain('contract_fingerprint: ${{ steps.contract.outputs.fingerprint }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(deploy).toContain('SMOKE_EXPECT_CONTRACT_FINGERPRINT: ${{ needs.production.outputs.contract_fingerprint }}');
    expect(deploy).not.toContain('test -n "$SMOKE_EXPECT_CONTRACT_FINGERPRINT"');
  });

  test('the contract root, build/ and test/ list exactly the pinned entries', () => {
    for (const [dir, pinned] of Object.entries(CONTRACT_LISTING)) {
      expect({ dir, entries: readdirSync(join(CONTRACT_DIR, dir)).sort() }).toEqual({
        dir,
        entries: [...pinned].sort(),
      });
    }
  });

  test("tests/fixtures holds no copy of the contract's fixtures", () => {
    expect(existsSync(join(REPO_ROOT, 'tests', 'fixtures', 'web-audit-conformance'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'tests', 'fixtures', 'web-audit-score-parity.json'))).toBe(false);
  });

  test('gen-fixtures --check passes on the committed tree', () => {
    const proc = Bun.spawnSync([
      process.execPath,
      join(REPO_ROOT, 'scripts', 'web-audit', 'gen-fixtures.ts'),
      '--check',
    ]);
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    expect(proc.exitCode).toBe(0);
  }, 30_000);

  // Generation does not write this fixture, and the CLI mirrors it, so the hash has to reach it.
  test('covers the hand-authored fixture no generator writes', () => {
    const fromGenerator = new Map(generated);
    fromGenerator.delete(CONTRACT_FINGERPRINT_FILE);
    expect(contractFingerprint(fromGenerator)).not.toBe(generated.get(CONTRACT_FINGERPRINT_FILE));
    expect(fromGenerator.has('test/score-parity.json')).toBe(false);
  });
});
