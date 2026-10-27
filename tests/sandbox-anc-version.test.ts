// The live-scoring image and the leaderboard scorer image each bake whichever
// anc release their Dockerfile downloads, while the site advertises
// src/data/anc/VERSION; nothing at runtime connects them. Each Dockerfile is
// the offline record of what its next image build runs, so the PR that bumps
// VERSION bumps both, to the same archive. `scripts/release/preflight.sh
// coord` checks the pinned live-scoring images.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const DOCKERFILES = ['docker/sandbox/Dockerfile', 'docker/score/Dockerfile'] as const;
const VERSION_FILE = 'src/data/anc/VERSION';

const ANC_TARBALL_URL =
  /https:\/\/github\.com\/brettdavies\/agentnative-cli\/releases\/download\/v([^/\s]+)\/agentnative-x86_64-unknown-linux-gnu\.tar\.gz/;

const FIX =
  "advance both images per RELEASES.md § Sandbox image releases: set the tarball URL and its sha256 from the release's " +
  `sha256sum.txt in ${DOCKERFILES.join(' and ')}, build and push the sandbox image with \`wrangler containers build -p\`, ` +
  'and move env.staging.containers[0].image in wrangler.jsonc to the new tag';

const published = readFileSync(join(REPO_ROOT, VERSION_FILE), 'utf8').trim();

/** Each RUN/COPY/... instruction with its backslash continuations joined into one block. */
function instructions(dockerfile: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of dockerfile.split('\n')) {
    if (current.length === 0 && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    current.push(line);
    if (!line.trimEnd().endsWith('\\')) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

function ancInstall(dockerfilePath: string): { version: string; block: string } {
  const dockerfile = readFileSync(join(REPO_ROOT, dockerfilePath), 'utf8');
  const block = instructions(dockerfile).find((b) => ANC_TARBALL_URL.test(b));
  if (!block) throw new Error(`${dockerfilePath} downloads no agentnative-cli release tarball; ${FIX}`);
  const version = block.match(ANC_TARBALL_URL)?.[1] ?? '';
  return { version, block };
}

/** The 64-hex digest on the `sha256sum -c` line that checks the anc tarball's curl destination. */
function pinnedDigest(dockerfilePath: string): string {
  const { block } = ancInstall(dockerfilePath);
  const dest = block.match(/curl\b[^\n]*?\s-\w*o\s+(\S+)/)?.[1];
  if (dest === undefined) return '';
  const check = block.split('\n').find((line) => line.includes('sha256sum -c') && line.includes(dest));
  return check?.match(/\b[0-9a-f]{64}\b/)?.[0] ?? '';
}

test(`${VERSION_FILE} holds a bare semver`, () => {
  expect(published).toMatch(/^\d+\.\d+\.\d+$/);
});

for (const dockerfile of DOCKERFILES) {
  describe(`${dockerfile} installs the published anc release`, () => {
    test(`its anc tarball is the release ${VERSION_FILE} names`, () => {
      const { version } = ancInstall(dockerfile);
      expect(version, `${dockerfile} downloads anc v${version} but ${VERSION_FILE} is ${published}; ${FIX}`).toBe(
        published,
      );
    });

    test('the anc tarball is verified against a 64-hex sha256', () => {
      expect(
        pinnedDigest(dockerfile),
        `${dockerfile} does not pin the anc tarball to a 64-hex sha256 on its sha256sum -c line; ${FIX}`,
      ).toMatch(/^[0-9a-f]{64}$/);
    });
  });
}

test('both images pin the same anc archive digest', () => {
  const [sandbox, score] = DOCKERFILES.map(pinnedDigest);
  expect(score, `${DOCKERFILES[1]} pins a different anc archive than ${DOCKERFILES[0]}; ${FIX}`).toBe(sandbox);
});
