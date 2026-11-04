// The vendoring contract is what the CLI reads instead of this repo's sources,
// so a stale or unpinned file is a wrong input in another repo. This suite is
// the check that stops one here: `bun test` runs it on every PR.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRegistry, stubFetchFor } from '../scripts/web-audit/conformance-corpus';
import { assertScheduleIndependent, requestsJson, sortedRequests } from '../scripts/web-audit/conformance-requests';
import { SCENARIOS } from '../scripts/web-audit/conformance-scenarios';
import {
  contractDrift,
  contractDriftMessage,
  generateContract,
  generateContractBuild,
} from '../scripts/web-audit/contract';
import {
  CONTRACT_BUILD_DIR,
  CONTRACT_DIR,
  CONTRACT_LISTING,
  REGENERATE_COMMAND,
  REGISTRY_PATH,
  REMEDIATION_PATH,
  REPO_ROOT,
  SCENARIOS_DIR,
} from '../scripts/web-audit/contract-paths';
import { emitWebAuditRegistry, emitWebRemediation } from '../src/build/13-web-audit-registry.mjs';
import { VENDORED_CARD_SCHEMA_PATH } from '../src/build/web-audit-card-schema.mjs';
import { runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET } from '../src/worker/audit-web/follow-requests';
import { registryFingerprintPrefix } from '../src/worker/audit-web/registry';
import { type HopRequest, requestIdentityKey } from '../src/worker/audit-web/request-hop';

const registry = loadRegistry();
const generated = await generateContract(registry);
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
    const dist = scratchDir();
    mkdirSync(join(dist, '_internal'));
    await emitWebAuditRegistry({ registryPath: REGISTRY_PATH, distDir: dist });
    await emitWebRemediation({ remediationPath: REMEDIATION_PATH, registryPath: REGISTRY_PATH, distDir: dist });
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
    const proc = Bun.spawnSync(['bun', join(REPO_ROOT, 'scripts', 'web-audit', 'gen-fixtures.ts'), '--check']);
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    expect(proc.exitCode).toBe(0);
  }, 30_000);
});

describe("each scenario's requests.json", () => {
  type Recorded = Omit<HopRequest, 'body'> & { body: string | null };

  const recorded = (name: string): HopRequest[] =>
    (JSON.parse(readFileSync(join(SCENARIOS_DIR, name, 'requests.json'), 'utf8')) as Recorded[]).map((request) => ({
      ...request,
      body: request.body ?? undefined,
    }));

  test('run-healthy lists every request its audit sent, sorted by the identity key, each once', async () => {
    const scenario = SCENARIOS['run-healthy'];
    const stub = stubFetchFor(scenario, { unmatched: [] });
    const received: string[] = [];
    const fetchImpl = ((input: string, init?: RequestInit) => {
      received.push(`${init?.method ?? 'GET'} ${input}`);
      return stub(input, init);
    }) as typeof fetch;
    for await (const _event of runWebAudit({
      url: scenario.target,
      registry,
      siteType: scenario.site_type,
      specVersion: scenario.spec_version,
      followDeclarations: scenario.follow_declarations ?? true,
      domainBudget: ALWAYS_ADMIT_BUDGET,
      fetchOptions: { fetchImpl },
      now: () => 0,
    })) {
      // drain the audit
    }
    const requests = recorded('run-healthy');
    expect(received.length).toBeGreaterThan(0);
    expect(requests.map(({ method, url }) => `${method} ${url}`).sort()).toEqual(received.sort());
    const keys = requests.map(requestIdentityKey);
    expect(keys).toEqual([...new Set(keys)].sort());
  });

  test('every scenario records a sorted set of its requests, and at least one request', () => {
    for (const name of Object.keys(SCENARIOS)) {
      const keys = recorded(name).map(requestIdentityKey);
      expect({ name, sorted: keys }).toEqual({ name, sorted: [...new Set(keys)].sort() });
      expect({ name, some: keys.length > 0 }).toEqual({ name, some: true });
    }
  });

  const request = (url: string): HopRequest => ({ method: 'GET', url, headers: {}, body: undefined });

  test('a scenario that sends one request twice fails generation, naming the scenario and the request', () => {
    expect(() => sortedRequests('twice', [request('https://a.test/'), request('https://a.test/')])).toThrow(
      /scenario twice sent one request twice: .*https:\/\/a\.test\//,
    );
  });

  test('a scenario whose scorecard differs at concurrency 1 fails generation, naming the scenario', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    expect(() => assertScheduleIndependent('moves', concurrent, { ...concurrent, output: 'b' })).toThrow(
      'scenario moves: the scorecard at concurrency 1 differs',
    );
  });

  test('a scenario whose request set differs at concurrency 1 fails generation, naming the request', () => {
    const concurrent = { output: 'a', requests: [request('https://a.test/')] };
    const serial = { output: 'a', requests: [request('https://b.test/')] };
    expect(() => assertScheduleIndependent('moves', concurrent, serial)).toThrow(
      /scenario moves: the request set at concurrency 1 differs.*only at concurrency 1: .*b\.test.*only at the default: .*a\.test/,
    );
  });

  test('the file form names an absent body null and sorts headers by name', () => {
    const entry = { method: 'POST', url: 'https://a.test/', headers: { b: '2', a: '1' }, body: undefined };
    expect(requestsJson([entry])).toBe(
      `${JSON.stringify([{ method: 'POST', url: 'https://a.test/', headers: { a: '1', b: '2' }, body: null }], null, 2)}\n`,
    );
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
