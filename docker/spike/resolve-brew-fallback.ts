#!/usr/bin/env bun
//
// resolve-brew-fallback.ts — CLI shim that calls the production
// `resolveBrewFallback()` from `src/worker/score/resolve-spec.ts`
// against a single brew package name and prints the resolved install
// command as JSON.
//
// Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md U4
// (option 3 follow-up to the spike's initial scaffolding).
//
// Why this exists:
//   The spike's arm 1 measures "current production install path." For
//   the 86 brew-pinned anc100 entries the live sandbox does NOT run
//   `brew install <pkg>` directly — it runs the input through
//   `resolveBrewFallback`, which fetches formula metadata, parses the
//   GitHub homepage, and asks `discoverBinary` to find an alternative
//   PM (cargo-binstall, uv, bun, pip, etc.). This shim lets the spike
//   measure the actually-used install path rather than approximating
//   it with `brew install`.
//
// The shim:
//   - Imports `resolveBrewFallback` and types from the worker source.
//   - Loads `dist/discovery-hints-index.json` to bootstrap the
//     `DiscoveryHintsIndex` (matches what the production Worker does
//     via `loadHintsIndex` in `src/worker/score/orchestrate.ts`).
//   - Calls `resolveBrewFallback(pkg, hintsIndex)` with the default
//     fetcher (`globalThis.fetch`).
//   - Prints a JSON record that arm wrappers can pipe into jaq.
//
// Result schema:
//   { ok: true, pkg, pm, package, binary, install_cmd, resolved_step }
//   { ok: false, pkg, error, details }
//
// Usage:
//   bun docker/spike/resolve-brew-fallback.ts ripgrep
//   bun docker/spike/resolve-brew-fallback.ts datasette
//   bun docker/spike/resolve-brew-fallback.ts xxxxxxx          # no formula

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveBrewFallback } from '../../src/worker/score/resolve-spec';
import type { DiscoveryHintsIndex } from '../../src/worker/score/registry-lookup';
import type { InstallSpec } from '../../src/worker/score/discover-binary';

// Quote a string for safe interpolation into a single-quoted bash
// argument. Bash single quotes preserve everything except `'`; the
// `'\''` sequence closes the quote, inserts a literal `'`, then
// reopens it.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Map an InstallSpec back to the actual install command the live
// sandbox executes. This mirrors the per-pm dispatch in
// `src/worker/score/sandbox-exec.ts` at a high level (the spike
// command does not need the production --install-path / GOBIN flags
// — those redirect installs into /usr/local/bin so the post-install
// `which <binary>` gate works; for the spike's measurement loop we
// trust the PM's default install location plus the spike image's
// PATH).
function specToInstallCommand(spec: InstallSpec): string {
  switch (spec.pm) {
    case 'brew':
      return `sudo -u runner brew install --quiet ${shellQuote(spec.package)}`;
    case 'cargo-binstall':
      // --install-path /usr/local/bin matches production
      // (sandbox-exec.ts:347). Without it cargo-binstall installs to
      // /root/.cargo/bin which isn't on the spike image's PATH.
      return `cargo-binstall --no-confirm --no-symlinks --install-path /usr/local/bin ${shellQuote(spec.package)}`;
    case 'bun':
      // --ignore-scripts matches production (sandbox-exec.ts:325).
      // Binary lands in $BUN_INSTALL/bin (= /usr/local/bin per
      // sandbox image's ENV BUN_INSTALL=/usr/local).
      return `bun add -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'pip':
      // --only-binary=:all: + --break-system-packages match
      // production sandbox-exec.ts:387. Production also computes
      // PIP_UPLOADED_PRIOR_TO at exec time for the 7-day freshness
      // gate; the spike skips that gate (matches the freshness-gate
      // posture in U6's supply-chain summary: spike does NOT enforce
      // freshness for measurement parity).
      return `pip install --only-binary=:all: --no-cache-dir --break-system-packages ${shellQuote(spec.package)}`;
    case 'uv':
      // Production sandbox-exec.ts:333. UV_EXCLUDE_NEWER is baked
      // into the docker/sandbox image as an ENV ("7 days"); the
      // spike inherits the same env from anc-sandbox base.
      return `uv tool install ${shellQuote(spec.package)}`;
    case 'npm':
      return `npm install -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'go':
      // Production resolveSpec redirects pm=go through resolveGoFallback
      // before reaching install command construction; if a go spec
      // reaches the spike, it means the fallback resolved it through
      // discovery to the same module path. Production has no go install
      // command in sandbox-exec; spike approximates.
      return `go install ${shellQuote(spec.package)}@latest`;
    case 'direct': {
      // Mirrors `directInstallCommand` from sandbox-exec.ts at a high
      // level: download to tmp, extract by extension, install the
      // first executable matching the preferred binary name to
      // /usr/local/bin/<binary>. Production has more sophisticated
      // candidate-scoring; the spike's simplification covers >90% of
      // real-world archive shapes and is good enough for wall-clock
      // measurement.
      const lower = spec.url.toLowerCase();
      let extract: string;
      if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
        extract = `tar xzf "$tmp/a" -C "$tmp/x"`;
      } else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
        extract = `tar xJf "$tmp/a" -C "$tmp/x"`;
      } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
        extract = `tar xjf "$tmp/a" -C "$tmp/x"`;
      } else if (lower.endsWith('.zip')) {
        extract = `unzip -q "$tmp/a" -d "$tmp/x"`;
      } else {
        // Treat as a bare binary; copy directly.
        extract = `cp "$tmp/a" "$tmp/x/${spec.binary}" && chmod +x "$tmp/x/${spec.binary}"`;
      }
      return (
        `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
        `curl -fsSL ${shellQuote(spec.url)} -o "$tmp/a"; ` +
        `${extract}; ` +
        `cand=$(find "$tmp/x" -type f -perm /111 -name ${shellQuote(spec.binary)} 2>/dev/null | head -1); ` +
        `if [ -z "$cand" ]; then cand=$(find "$tmp/x" -type f -perm /111 2>/dev/null | head -1); fi; ` +
        `install -m 0755 "$cand" /usr/local/bin/${shellQuote(spec.binary)}; ` +
        `rm -rf "$tmp" )`
      );
    }
    case 'git-clone':
      return `git clone --depth 1 --branch ${spec.branch} https://github.com/${spec.owner}/${spec.repo}.git /tmp/${spec.repo}`;
    default: {
      const _exhaustive: never = spec;
      return `# unsupported install spec: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

async function loadHintsIndex(): Promise<DiscoveryHintsIndex> {
  // Match the production Worker's loadHintsIndex location. The build
  // pipeline (`src/build/registry-index.mjs`) emits this artifact to
  // dist/ on every `bun run build`; if it is missing, the spike asks
  // the operator to run the build first.
  const distPath = join(import.meta.dir, '..', '..', 'dist', 'discovery-hints-index.json');
  try {
    const raw = await readFile(distPath, 'utf8');
    return JSON.parse(raw) as DiscoveryHintsIndex;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `discovery-hints-index.json not found at ${distPath} (run 'bun run build' first): ${msg}`,
    );
  }
}

async function main(): Promise<void> {
  const pkg = process.argv[2];
  if (!pkg) {
    console.error('usage: bun docker/spike/resolve-brew-fallback.ts <brew-package-name>');
    process.exit(2);
  }

  const hintsIndex = await loadHintsIndex();
  const result = await resolveBrewFallback(pkg, hintsIndex);

  if (result.ok) {
    const installCmd = specToInstallCommand(result.value);
    console.log(
      JSON.stringify({
        ok: true,
        pkg,
        pm: result.value.pm,
        package: 'package' in result.value ? result.value.package : null,
        binary: result.value.binary,
        install_cmd: installCmd,
        resolved_step: result.resolved_step ?? null,
      }),
    );
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      ok: false,
      pkg,
      error: result.error,
      details: result.details,
    }),
  );
  process.exit(0);
}

await main();
