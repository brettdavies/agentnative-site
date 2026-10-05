// The live-scoring image bakes whichever anc release its Dockerfile
// downloads, while the site advertises src/data/anc/VERSION; nothing at
// runtime connects the two. The Dockerfile is the offline record of what
// the next image build runs, so the PR that bumps VERSION has to bump it
// too. `scripts/release/preflight.sh coord` checks the pinned images.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const DOCKERFILE = 'docker/sandbox/Dockerfile';
const VERSION_FILE = 'src/data/anc/VERSION';

const ANC_TARBALL_URL =
  /https:\/\/github\.com\/brettdavies\/agentnative-cli\/releases\/download\/v([^/\s]+)\/agentnative-x86_64-unknown-linux-gnu\.tar\.gz/;

const FIX =
  `advance the sandbox image per RELEASES.md § Sandbox image releases: set the ${DOCKERFILE} tarball URL ` +
  "and its sha256 from the release's sha256sum.txt, build and push with `wrangler containers build -p`, " +
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

function ancInstall(): { version: string; block: string } {
  const dockerfile = readFileSync(join(REPO_ROOT, DOCKERFILE), 'utf8');
  const block = instructions(dockerfile).find((b) => ANC_TARBALL_URL.test(b));
  if (!block) throw new Error(`${DOCKERFILE} downloads no agentnative-cli release tarball; ${FIX}`);
  const version = block.match(ANC_TARBALL_URL)?.[1] ?? '';
  return { version, block };
}

describe('the sandbox image installs the published anc release', () => {
  test(`${VERSION_FILE} holds a bare semver`, () => {
    expect(published).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test(`the ${DOCKERFILE} anc tarball is the release ${VERSION_FILE} names`, () => {
    const { version } = ancInstall();
    expect(version, `${DOCKERFILE} downloads anc v${version} but ${VERSION_FILE} is ${published}; ${FIX}`).toBe(
      published,
    );
  });

  test('the anc tarball is verified against a 64-hex sha256', () => {
    const { block } = ancInstall();
    const dest = block.match(/curl\b[^\n]*?\s-\w*o\s+(\S+)/)?.[1];
    expect(dest, `the curl that fetches the anc tarball in ${DOCKERFILE} names no -o destination`).toBeDefined();
    const check = block
      .split('\n')
      .find((line) => line.includes('sha256sum -c') && dest !== undefined && line.includes(dest));
    expect(
      check?.match(/\b[0-9a-f]{64}\b/)?.[0] ?? '',
      `${DOCKERFILE} does not pin the anc tarball (${dest}) to a 64-hex sha256 on its sha256sum -c line; ${FIX}`,
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
