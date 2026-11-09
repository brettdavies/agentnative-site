// scripts/release/withhold-telemetry-lake.py ends with a residue check that fails the cut when any marker the lake
// owns survives in the release tree. Each case builds a throwaway tree holding the script, guarded-paths.sh and the
// guard workflow, and none of the files the script edits, so every removal is a no-op and only the scan runs.
//
// The ubuntu runner image ships no ripgrep, so the scan's `rg -l -e <pattern>` resolves to a stand-in that lists the
// matching files, hidden ones skipped as rg does. Like rg, it searches a piped or redirected stdin instead of the tree
// when it is given no path. The cases pin how the script filters and trusts that listing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const SCRIPT = 'scripts/release/withhold-telemetry-lake.py';
const COPIED = [SCRIPT, 'scripts/release/guarded-paths.sh', '.github/workflows/guard-main-docs.yml'];

const RG_STAND_IN = `#!/usr/bin/env bash
pattern=
while (($#)); do
  case "$1" in
    -e) pattern="$2"; shift 2 ;;
    --glob) shift 2 ;;
    *) shift ;;
  esac
done
if [ -p /dev/stdin ] || [ -f /dev/stdin ]; then
  grep -qE -e "$pattern" && echo '<stdin>'
  exit 0
fi
grep -rlE --exclude-dir='.?*' --exclude='.?*' -e "$pattern" . | sed 's|^\\./||'
`;

function residueMarkers(): string[] {
  const source = readFileSync(join(REPO_ROOT, SCRIPT), 'utf8');
  const block = /^RESIDUE = \(\n([\s\S]*?)^\)/m.exec(source)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

const MARKERS = residueMarkers();
const EVERY_MARKER = MARKERS.join('\n');

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

let tree = '';
let bin = '';

function plant(path: string, body: string): void {
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), body);
}

function standIn(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}`);
  chmodSync(join(bin, name), 0o755);
}

function withhold(args: string[] = [], stdin?: string): { status: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['python3', '-B', join(tree, SCRIPT), ...args], {
    cwd: tree,
    env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}` },
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
  });
  return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'withhold-lake-'));
  bin = mkdtempSync(join(tmpdir(), 'withhold-lake-bin-'));
  for (const path of COPIED) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), join(tree, path));
  }
  standIn('rg', RG_STAND_IN.replace('#!/usr/bin/env bash\n', ''));
  standIn('bun', 'exit 0\n');
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe('withhold-telemetry-lake.py residue check', () => {
  test('reads the markers it is meant to scan for', () => {
    expect(MARKERS).toContain('logpush');
    expect(MARKERS).toContain('/privacy');
  });

  test('passes on a tree that carries no marker', () => {
    plant('src/worker/index.ts', 'export {};\n');
    const { status, stdout } = withhold();
    expect(stdout).toContain('already withheld');
    expect(status).toBe(0);
  });

  test('passes when top-level scorecard JSON names a marker', () => {
    plant('scorecards/cf-v1.0.0.json', JSON.stringify({ evidence: `subcommands: access, logpush\n${EVERY_MARKER}` }));
    const { status, stdout, stderr } = withhold();
    expect(stderr).toBe('');
    expect(stdout).toContain('already withheld');
    expect(status).toBe(0);
  });

  test.each([
    'src/worker/index.ts',
    'wrangler.jsonc',
    'tests/wrangler-config.test.ts',
    'content/about.md',
    'package.json',
    'scripts/release/preflight.sh',
    'docs/runbooks/mcp-operator.md',
  ])('fails on a marker in %s', (path) => {
    plant(path, EVERY_MARKER);
    const { status, stderr } = withhold();
    expect(stderr).toContain('telemetry-lake references survive in:');
    expect(stderr).toContain(`  ${path}\n`);
    expect(status).toBe(1);
  });

  test.each([
    'src/worker/scorecards/cf-v1.0.0.json',
    'scorecards/nested/cf-v1.0.0.json',
    'scorecards/cf-v1.0.0.ts',
    'scorecards/README.md',
    'scorecards/cf-v1.0.0.json.bak',
  ])('fails on a marker in %s, which is not top-level scorecard JSON', (path) => {
    plant(path, EVERY_MARKER);
    const { status, stderr } = withhold();
    expect(stderr).toContain(`  ${path}\n`);
    expect(status).toBe(1);
  });

  test('lists the code path and not the scorecard when both carry a marker', () => {
    plant('scorecards/cf-v1.0.0.json', EVERY_MARKER);
    plant('src/worker/index.ts', EVERY_MARKER);
    const { status, stderr } = withhold();
    expect(stderr).toContain('  src/worker/index.ts\n');
    expect(stderr).not.toContain('scorecards/cf-v1.0.0.json');
    expect(status).toBe(1);
  });
});

const SITEMAP_PENDING = "[\n    '/privacy',\n]\n";

describe('withhold-telemetry-lake.py --check', () => {
  test('passes on a tree that carries no marker', () => {
    const { status, stdout } = withhold(['--check']);
    expect(stdout).toContain('already withheld');
    expect(status).toBe(0);
  });

  test('passes when top-level scorecard JSON names a marker', () => {
    plant('scorecards/cf-v1.0.0.json', EVERY_MARKER);
    const { status, stderr } = withhold(['--check']);
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });

  test('reports DRIFT for a marker in code', () => {
    plant('src/worker/index.ts', EVERY_MARKER);
    const { status, stderr } = withhold(['--check']);
    expect(stderr).toContain('telemetry-lake references survive in:');
    expect(stderr).toContain('  src/worker/index.ts\n');
    expect(status).toBe(1);
  });

  test('lists the code path and not the scorecard when both carry a marker', () => {
    plant('scorecards/cf-v1.0.0.json', EVERY_MARKER);
    plant('src/worker/index.ts', EVERY_MARKER);
    const { status, stderr } = withhold(['--check']);
    expect(stderr).toContain('  src/worker/index.ts\n');
    expect(stderr).not.toContain('scorecards/cf-v1.0.0.json');
    expect(status).toBe(1);
  });

  test('reports pending removals, not residue, for markers a removal takes away', () => {
    plant('content/privacy.md', EVERY_MARKER);
    plant('src/build/10-sitemap.mjs', SITEMAP_PENDING);
    const { status, stdout, stderr } = withhold(['--check']);
    expect(stderr).toBe('');
    expect(stdout).toContain('would withhold the telemetry lake (2 change(s))');
    expect(status).toBe(2);
  });

  test.each([
    ['takes away every marker', SITEMAP_PENDING, 0],
    ['leaves a marker behind', `${SITEMAP_PENDING}    '/privacy-policy',\n`, 1],
  ])('agrees with the cut when a pending removal %s', (_name, sitemap, expected) => {
    plant('src/build/10-sitemap.mjs', sitemap);
    const check = withhold(['--check']);
    expect(check.status).toBe(expected === 0 ? 2 : 1);
    const cut = withhold();
    expect(cut.status).toBe(expected);
    if (expected === 1) {
      expect(check.stderr).toContain('  src/build/10-sitemap.mjs\n');
      expect(cut.stderr).toBe(check.stderr);
    }
  });
});

describe('withhold-telemetry-lake.py residue scan trust', () => {
  test.each([[[]], [['--check']]])('scans the tree when stdin is a pipe (%j)', (args) => {
    plant('src/worker/index.ts', EVERY_MARKER);
    const { status, stderr } = withhold(args, 'x');
    expect(stderr).toContain('  src/worker/index.ts\n');
    expect(status).toBe(1);
  });

  test.each([[[]], [['--check']]])('fails, not clean, when rg exits 2 (%j)', (args) => {
    standIn('rg', 'echo "rg: simulated scan failure" >&2\nexit 2\n');
    const { status, stdout, stderr } = withhold(args);
    expect(stderr).toContain('the residue scan could not run: rg exited 2: rg: simulated scan failure');
    expect(stdout).not.toContain('already withheld');
    expect(status).toBe(1);
  });
});
