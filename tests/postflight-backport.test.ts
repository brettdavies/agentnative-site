// scripts/release/postflight.sh's backport gate finds the PR that
// sync-dev-after-release.sh opens against dev by the release tag in its title.
// With no --release-slug, the tag comes from the newest release/v<version>
// head merged into main. A stand-in `gh` on PATH answers each query from fixed
// PR lists, applying the query's own --jq the way gh does.
//
// The gate requires jaq, which the CI runner does not install while jq ships
// with it. When jq is on PATH, a `jaq` that runs it stands in, so every
// machine evaluates the gate's programs with the same tool.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const STAMP = 'v0.0.1762200000-gabc1234';

const MAIN_PRS = [
  {
    title: 'release: answer GET /mcp with 405 (#476)',
    headRefName: 'release/2026-10-30-mcp-get-405',
    mergedAt: '2026-10-30T18:00:00Z',
  },
  {
    title: 'release: the first stamped release (#510)',
    headRefName: `release/${STAMP}`,
    mergedAt: '2026-11-05T18:00:00Z',
  },
];

const DEV_PRS = [
  {
    number: 511,
    title: `chore(release): sync dev after ${STAMP}`,
    headRefName: `chore/sync-dev-after-${STAMP}`,
    mergedAt: '2026-11-05T19:00:00Z',
  },
];

const FAKE_GH = `#!/usr/bin/env bash
jq_expr="" base=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --jq) jq_expr="\${args[i + 1]}" ;;
    --base) base="\${args[i + 1]}" ;;
  esac
done
case "$1 $2" in
  "repo view") data='{"nameWithOwner":"brettdavies/agentnative-site"}' ;;
  "pr list") data=$(cat "$FAKE_GH_DIR/prs-$base.json") ;;
  *) exit 1 ;;
esac
if [ -n "$jq_expr" ]; then printf '%s' "$data" | jaq -r "$jq_expr"; else printf '%s\\n' "$data"; fi
`;

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'postflight-backport-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  const jq = Bun.which('jq');
  if (jq) {
    writeFileSync(join(dir, 'jaq'), `#!/usr/bin/env bash\nexec ${jq} "$@"\n`);
    chmodSync(join(dir, 'jaq'), 0o755);
  }
  writeFileSync(join(dir, 'prs-main.json'), JSON.stringify(MAIN_PRS));
  writeFileSync(join(dir, 'prs-dev.json'), JSON.stringify(DEV_PRS));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function backport(...args: string[]): { status: number; output: string } {
  const proc = Bun.spawnSync(
    ['bash', join(REPO_ROOT, 'scripts/release/postflight.sh'), '--env', 'prod', ...args, 'backport'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_DIR: dir, NO_COLOR: '1' },
    },
  );
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe('postflight backport gate', () => {
  test('reads the release tag from the newest merged release/v<version> head', () => {
    const { status, output } = backport();
    expect(output).toContain(`backport PR #511 merged to dev from chore/sync-dev-after-${STAMP}`);
    expect(status).toBe(0);
  });

  test('--release-slug overrides the detected tag', () => {
    const { output } = backport('--release-slug', 'v0.0.1700000000-g0000000');
    expect(output).toContain("no PR titled '*v0.0.1700000000-g0000000*' merged to dev");
  });
});
