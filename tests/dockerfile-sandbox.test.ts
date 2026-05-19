// Static shape assertions for the live-scoring sandbox image (plan U6
// base-image rework, 2026-05-18 — debian-trixie-slim / glibc).
//
// The image-size + smoke-test verifications require a working Docker
// daemon (CI doesn't have one) and live in docker/sandbox/README.md as
// manual steps. This test covers the parts that survive without docker:
// SHA-pin discipline, no-toolchains invariant, pm coverage, and the
// brew-omitted rationale.

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

  test('base images are CF Sandbox SDK 0.9.x (glibc) + debian-trixie-slim', async () => {
    const df = await loadDockerfile();
    // The 0.9.4 (non-suffixed) tag is the glibc base; -musl/-python/etc are
    // siblings. Mismatching the variant against the apt/binary install
    // table (e.g. picking -musl while installing libstdc++6) breaks the
    // sandbox-server runtime contract.
    expect(df).toMatch(/cloudflare\/sandbox:0\.9\.\d+@sha256:/);
    expect(df).not.toMatch(/cloudflare\/sandbox:0\.9\.\d+-musl@/);
    expect(df).toMatch(/debian:trixie-slim@sha256:/);
  });

  test('cargo-binstall download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/cargo-binstall.*\.tgz/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/cb\.tgz' \| sha256sum -c -/);
  });

  test('agentnative gnu tarball download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    // The rework switched anc from the musl static-pie binary to the
    // gnu variant matched to the new glibc base image. The half-bumped
    // state (URL pointing at gnu but sha256 still the musl one) would
    // fail at build time loudly, but the dual-match guard below catches
    // a quieter half-bump where someone updates the URL fragment but
    // leaves the .tar.gz filename unchanged.
    expect(df).toMatch(/agentnative-x86_64-unknown-linux-gnu\.tar\.gz/);
    expect(df).not.toMatch(/agentnative-x86_64-unknown-linux-musl\.tar\.gz/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/anc\.tgz' \| sha256sum -c -/);
  });

  test('bun zip download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    // Bun is added in the rework as part of the native-PM pivot. Pinned
    // for the same reason cargo-binstall and anc are pinned: prevent
    // upstream re-tag attacks from silently changing what we ship.
    expect(df).toMatch(/bun-linux-x64\.zip/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/bun\.zip' \| sha256sum -c -/);
  });

  test('uv tarball download verifies via sha256sum -c', async () => {
    const df = await loadDockerfile();
    expect(df).toMatch(/uv-x86_64-unknown-linux-gnu\.tar\.gz/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/uv\.tgz' \| sha256sum -c -/);
  });

  test('pinned anc release matches v0.3.1 (the one whose sha256 is in the file)', async () => {
    const df = await loadDockerfile();
    expect(df).toContain('agentnative-cli/releases/download/v0.3.1/');
  });
});

describe('docker/sandbox/Dockerfile — no-toolchains invariant (Premise #2)', () => {
  test('apt install does NOT pull in compilers or build toolchains', async () => {
    const df = await loadDockerfile();
    const aptBlocks = df.match(/^RUN apt-get[^\n]*(\n[ ]+[^\n]*)*/gm) || [];
    expect(aptBlocks.length).toBeGreaterThan(0);
    // Forbidden packages — anything that lets a user input build C/Rust/Go
    // from source. golang-go ships the go toolchain (we rely on `go install`
    // pulling precompiled module artifacts in practice; modules that build
    // from source bounce at U6 install time). The forbidden set is the
    // CGO / native-extension surface that would let an attacker stretch
    // exec time past the 60 s budget by triggering long compiles.
    const forbidden = ['build-essential', 'gcc', 'g++', 'clang', 'make', 'cmake', 'rustc', 'cargo', 'rustup'];
    for (const block of aptBlocks) {
      const tokens = block.split(/\s+/).filter((t) => t && !t.startsWith('-') && !t.startsWith('&&'));
      for (const f of forbidden) {
        expect({ aptBlock: block.slice(0, 80), token: f, present: tokens.includes(f) }).toEqual({
          aptBlock: block.slice(0, 80),
          token: f,
          present: false,
        });
      }
    }
  });

  test('upstream Go runtime (cgo-enabled) is installed from go.dev/dl', async () => {
    const df = await loadDockerfile();
    // Debian's golang-go is built with CGO_ENABLED=0 — that silently
    // disables GODEBUG=netdns=cgo and makes go install hang on CF
    // Containers' IPv6 path. Upstream Go ships with cgo enabled.
    expect(df).toMatch(/go\.dev\/dl\/go[0-9.]+\.linux-amd64\.tar\.gz/);
    expect(df).toMatch(/echo '[0-9a-f]{64} {2}\/tmp\/go\.tgz' \| sha256sum -c -/);
  });
});

describe('docker/sandbox/Dockerfile — package manager coverage', () => {
  test('cargo-binstall is installed (gnu variant)', async () => {
    const df = await loadDockerfile();
    expect(df).toContain('cargo-bins/cargo-binstall/releases/download/');
    expect(df).toContain('cargo-binstall-x86_64-unknown-linux-gnu.full.tgz');
    // cargo-binstall uses `-V` for binary version (its `--version` is reserved
    // for specifying the package version to install — different semantic).
    expect(df).toMatch(/cargo-binstall -V/);
  });

  test('all six U4-supported pms have a runtime in the image: cargo-binstall, pip, npm, go, bun, uv', async () => {
    const df = await loadDockerfile();
    // python3-pip / npm come from apt; cargo-binstall + bun + uv + go
    // come from pinned tarball downloads.
    expect(df).toMatch(/\bpython3-pip\b/);
    expect(df).toMatch(/\bnpm\b/);
    expect(df).toMatch(/go\.dev\/dl\/go[0-9.]+\.linux-amd64/);
    expect(df).toMatch(/cargo-binstall/);
    expect(df).toMatch(/bun-linux-x64\.zip/);
    expect(df).toMatch(/uv-x86_64-unknown-linux-gnu\.tar\.gz/);
  });

  test('archive extraction tools cover .tar.gz / .tar.xz / .tar.bz2 / .zip (Bug N)', async () => {
    const df = await loadDockerfile();
    // The direct-PM install path now dispatches extraction on URL
    // extension (sandbox-exec.ts directInstallCommand). The image must
    // carry the matching userspace tools; missing xz-utils would surface
    // as cryptic `tar: xz utility not present` failures on csvlens-style
    // .tar.xz releases.
    expect(df).toMatch(/\bbzip2\b/);
    expect(df).toMatch(/\bunzip\b/);
    expect(df).toMatch(/\bxz-utils\b/);
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
    // Rationale + the bounce contract token (pm=brew_only) must be
    // documented so a future maintainer doesn't reinstate brew without
    // revisiting the discovery-fallback in do.ts.
    expect(df).toMatch(/brew is NOT installed/);
    expect(df).toMatch(/brew_only/);
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
  });

  test('every PM redirects global installs to /usr/local/bin (single dest)', async () => {
    // Consistency invariant: the post-install `which <binary>` gate in
    // sandbox-exec.ts looks on PATH; centralising every PM at
    // /usr/local/bin avoids the per-PM "where does this binary land"
    // game. BUN_INSTALL/bin = /usr/local/bin; UV_TOOL_BIN_DIR =
    // /usr/local/bin; cargo-binstall --install-path + GOBIN in the
    // sandbox-exec install commands also target /usr/local/bin.
    const df = await loadDockerfile();
    expect(df).toMatch(/^ENV BUN_INSTALL=\/usr\/local$/m);
    expect(df).toMatch(/^ENV UV_TOOL_BIN_DIR=\/usr\/local\/bin$/m);
  });

  test('Go uses cgo resolver to honor /etc/gai.conf IPv4 precedence', async () => {
    // CF Containers IPv6 outbound is unreliable. /etc/gai.conf is
    // patched to prefer IPv4 for glibc's getaddrinfo. Go's pure-Go
    // resolver bypasses gai.conf; GODEBUG=netdns=cgo forces Go to use
    // getaddrinfo and honor the precedence. Requires Go built with
    // CGO (upstream tarball, not Debian's CGO_ENABLED=0 build).
    const df = await loadDockerfile();
    expect(df).toMatch(/^ENV GODEBUG=netdns=cgo$/m);
    expect(df).toMatch(/sed -i .* \/etc\/gai\.conf/);
  });

  test('declares at least one EXPOSE so wrangler dev --local accepts the container binding', async () => {
    // deep-check.yml unblock — see U6 K-decision in the plan. Port 3000
    // is reserved by the CF Sandbox SDK's internal Bun server, so any
    // placeholder must avoid it. 8080 is the U6 choice.
    const df = await loadDockerfile();
    const exposeLines = df.split('\n').filter((l) => /^EXPOSE\s+\d+/.test(l));
    expect(exposeLines.length).toBeGreaterThanOrEqual(1);
    expect(df).not.toMatch(/^EXPOSE\s+3000\b/m);
  });
});
