// Static shape assertions for the live-scoring sandbox image (plan U2).
//
// The image-size + smoke-test verifications require a working Docker
// daemon (CI doesn't have one) and live in docker/sandbox/README.md as
// manual steps. This test covers the parts that survive without docker:
// SHA-pin discipline, no-toolchains invariant, and pm coverage.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const DOCKERFILE = join(REPO_ROOT, 'docker', 'sandbox', 'Dockerfile');

async function loadDockerfile(): Promise<string> {
  return readFile(DOCKERFILE, 'utf8');
}

describe('docker/sandbox/Dockerfile — SHA-pin discipline', () => {
  test('every FROM line carries a sha256 digest pin', async () => {
    const df = await loadDockerfile();
    const fromLines = df.split('\n').filter((l) => l.trim().startsWith('FROM '));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect({ line, hasDigest: /@sha256:[0-9a-f]{64}/.test(line) }).toEqual({ line, hasDigest: true });
    }
  });

  test('cargo-binstall download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/cargo-binstall.*\.tgz/);
    // The verification line: echo '<sha>  /tmp/cb.tgz' | sha256sum -c -
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/cb\.tgz' \| sha256sum -c -/);
  });

  test('agentnative musl tarball download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/agentnative-x86_64-unknown-linux-musl\.tar\.gz/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/anc\.tgz' \| sha256sum -c -/);
  });

  test('pinned anc release matches v0.3.1 (the one whose sha256 is in the file)', async () => {
    const df = await loadDockerfile();
    // The plan's musl HARD BLOCKER was satisfied by v0.3.1; later bumps need
    // the URL AND the sha256 line updated together. This guard catches the
    // half-bumped state where one was changed and the other wasn't.
    expect(df).toContain('agentnative-cli/releases/download/v0.3.1/');
  });
});

describe('docker/sandbox/Dockerfile — no-toolchains invariant (Premise #2)', () => {
  test('apk add does NOT install rust, cargo (the compiler), or build-base', async () => {
    const df = await loadDockerfile();
    const apkLines = df.match(/^RUN apk add[^\n]*(\n[ ]+[^\n]*)*/gm) || [];
    expect(apkLines.length).toBeGreaterThan(0);
    for (const block of apkLines) {
      // Block-level: tokenize to whole words so "rustup-init" or "go" pass while
      // "rust" alone fails.
      const tokens = block.split(/\s+/).filter((t) => t && !t.startsWith('-'));
      // Forbidden compiler/toolchain packages.
      const forbidden = ['rust', 'rustup', 'cargo', 'build-base', 'gcc', 'g++', 'clang', 'make'];
      for (const f of forbidden) {
        expect({ apkBlock: block.slice(0, 80), token: f, present: tokens.includes(f) }).toEqual({
          apkBlock: block.slice(0, 80),
          token: f,
          present: false,
        });
      }
    }
  });

  test('go is present (runtime needed for `go install` of precompiled modules)', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/apk add[^\n]*(\n[ ]+[^\n]*)*\bgo\b/);
  });
});

describe('docker/sandbox/Dockerfile — package manager coverage', () => {
  test('cargo-binstall is installed (cargo-bins/cargo-binstall release)', async () => {
    const df = await loadDockerfile();
    expect(df).toContain('cargo-bins/cargo-binstall/releases/download/');
    expect(df).toMatch(/cargo-binstall --version/);
  });

  test('all four U4-supported pms have a runtime in the image: cargo-binstall, pip, npm, go', async () => {
    const df = await loadDockerfile();
    // py3-pip / npm / go come from apk; cargo-binstall comes from the curl step.
    expect(df).toMatch(/\bpy3-pip\b/);
    expect(df).toMatch(/\bnpm\b/);
    expect(df).toMatch(/\bgo\b/);
    expect(df).toMatch(/cargo-binstall/);
  });

  test('brew is intentionally absent and the rationale is documented in-file', async () => {
    const df = await loadDockerfile();
    // Strip comment lines (anything that begins with optional whitespace + `#`)
    // so the negation only catches real install steps. Comments are allowed
    // to discuss linuxbrew/homebrew as part of the rationale block.
    const code = df
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\bbrew install\b/);
    expect(code).not.toMatch(/\b(linuxbrew|homebrew)\b/i);
    // Positive: comment block names brew + bounce class explicitly so a
    // future maintainer doesn't silently re-add brew without revisiting
    // the chain_resolved_install_failed CTA work in U8.
    expect(df).toMatch(/brew is intentionally OMITTED/);
    expect(df).toMatch(/chain_resolved_install_failed/);
  });
});

describe('docker/sandbox/Dockerfile — sandbox runtime', () => {
  test('copies the sandbox server binary from the upstream sandbox image', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/COPY --from=sandbox-base \/container-server\/sandbox \/sandbox/);
  });

  test('ENTRYPOINT is /sandbox', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/ENTRYPOINT \["\/sandbox"\]/);
  });

  test('PATH includes every binary-install destination across pms', async () => {
    const df = await loadDockerfile();
    const envPath = df.match(/^ENV PATH="([^"]+)"/m)?.[1] ?? '';
    expect(envPath).toContain('/usr/local/bin');
    expect(envPath).toContain('/usr/local/cargo/bin');
    expect(envPath).toContain('/usr/local/go/bin');
    expect(envPath).toContain('/root/.local/bin'); // pip user-installs
  });
});
