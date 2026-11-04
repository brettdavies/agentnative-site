// scripts/release/postflight.sh's pages gate reads each page from the deployed
// edge and looks for a marker in the body. A stand-in `curl` on PATH answers from
// fixed bodies, so what runs is the gate's own shell, under its own pipefail.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const FAKE_CURL = `#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in https://*) url="$arg" ;; esac
done
case "$url" in
  */scorecards) cat "$FAKE_CURL_DIR/scorecards.html" ;;
  */api/score) cat "$FAKE_CURL_DIR/score.json" ;;
  *) cat "$FAKE_CURL_DIR/home.html" ;;
esac
`;

const SCORE = JSON.stringify({
  tier: 'registry',
  scorecard_url: 'https://fixture.invalid/score/ripgrep',
  spec_version: '0.0.0',
});

// 264 KB, past twice the 64 KB pipe buffer, so a writer feeding `grep -q` is still
// blocked when grep matches in its first read and exits. Just past one buffer the
// writer can finish first: a 90 KB body, /scorecards' size on anc.dev, fails 39 of 40.
const PADDING = `${'x'.repeat(79)}\n`.repeat(3300);

/** A page past the pipe buffer, in lines, with `marker` where the first read reaches it. */
function largePage(marker: string): string {
  return `<!doctype html>\n${marker}\n${PADDING}`;
}

function gatePages(home: string, scorecards: string): { status: number; output: string } {
  const bin = mkdtempSync(join(tmpdir(), 'postflight-pages-'));
  try {
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(bin, 'home.html'), home);
    writeFileSync(join(bin, 'scorecards.html'), scorecards);
    writeFileSync(join(bin, 'score.json'), SCORE);
    const proc = Bun.spawnSync(
      [
        'bash',
        join(REPO_ROOT, 'scripts/release/postflight.sh'),
        '--env',
        'prod',
        '--prod-url',
        'https://fixture.invalid',
        'pages',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CURL_DIR: bin, NO_COLOR: '1' },
      },
    );
    return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('postflight pages gate', () => {
  test('passes a page past the pipe buffer whose marker is on an early line', () => {
    const { status, output } = gatePages(largePage('<title>anc</title>'), largePage('<div class="lrow">'));
    expect(output).toContain('home page renders (has <title>)');
    expect(output).toContain('/scorecards renders (has lrow)');
    expect(status).toBe(0);
  });

  test('fails a page past the pipe buffer that lacks its marker', () => {
    const { status, output } = gatePages(largePage('<p>no heading</p>'), largePage('<p>no rows</p>'));
    expect(output).toContain('did not return HTML with <title>');
    expect(output).toContain('did not return HTML with lrow');
    expect(status).toBe(1);
  });
});
