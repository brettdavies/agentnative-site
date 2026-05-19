// Live-scoring orchestration — install + anc check inside a Sandbox DO,
// with two-phase egress enforced via the SDK's named outbound handlers.
//
// Plan U6 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1854-1944). The DO class in ./do.ts holds the static
// `outboundHandlers` map; this module orchestrates the per-request
// install + score flow by calling `setOutboundHandler` and `exec`
// against the DO instance it's passed.
//
// Pure orchestration — no SDK class imports beyond a type-only reference
// for the parameter type. Lets `tests/score-do.test.ts` exercise the
// two-phase ordering invariant against a hand-rolled Container-like
// stub without instantiating the real Sandbox class.
//
// Per-PM install command table mirrors the security audit in the plan
// K-decision row "Per-package-manager script-execution audit": `npm` and
// `bun` carry `--ignore-scripts`; `pip` carries `--only-binary=:all:`;
// `cargo binstall` is binary-only by design; `uv tool install` uses uv's
// own resolver (binary-only by default for wheel-bearing packages).
// `brew` returns null from installCommandFor() so the resolveSpec()
// discovery-fallback in do.ts (2026-05-18 rework) can translate
// `brew install <tool>` inputs to whatever cargo / npm / pip / go
// alternative the discovery chain finds for the brew formula's GitHub
// repo. brew-only tools (no other PM) bounce as install_unsupported
// with pm=brew_only. `go install` is kept per the 2026-05-18
// K-decision re-evaluation (commit 9b45b96 on dev): `gc` does not
// execute user code at compile time, so the blast radius is bounded
// by the same 60 s combined install + score timeout.

import type { Sandbox } from '@cloudflare/sandbox';
import type { InstallSpec } from './discover-binary';

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

export type ScoreSuccess = {
  ok: true;
  value: {
    scorecard: unknown;
    anc_version: string;
  };
};

export type ScoreFailure = {
  ok: false;
  error: ScoreErrorCode;
  details?: string;
};

export type ScoreResult = ScoreSuccess | ScoreFailure;

export type ScoreErrorCode =
  // Install path classes (gate F4 — three distinct error tags).
  | 'install_unsupported' // brew on Alpine; bounce at the install table.
  | 'chain_resolved_install_failed' // install command returned non-zero.
  | 'chain_resolved_no_binary_produced' // install succeeded but `which <binary>` missed.
  // Exec failure classes.
  | 'anc_version_unreadable' // anc --version returned no parseable version.
  | 'anc_check_failed' // anc check returned non-zero AND no parseable JSON envelope.
  // Wall-clock.
  | 'timeout';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Capability surface this module needs from the DO instance. Typed as a
// structural subset of the real Sandbox class so tests can pass a plain
// object with these two methods and the call-order invariant is
// observable from outside the class.
export type ContainerLike = {
  setOutboundHandler<P = unknown>(name: string, params?: P): Promise<void>;
  exec(command: string, options?: { timeout?: number }): Promise<ExecLike>;
};

export type ExecLike = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
};

// Quick static-shape sanity check: the real Sandbox class implements
// the ContainerLike surface (the assignability check fires at compile
// time if SDK drift removes either method).
type _ContainerLikeShapeCheck = Sandbox extends ContainerLike ? true : never;
const _shapeCheck: _ContainerLikeShapeCheck = true;
void _shapeCheck;

const TOTAL_TIMEOUT_MS = 60_000; // R7 / plan U6 — install + score combined.
const SHORT_EXEC_TIMEOUT_MS = 5_000; // `which`, `anc --version`.

// Per-PM install-host allowlists. Only these hosts are reachable during
// Phase 1 install for each PM; Phase 2 (anc check) blocks all hosts.
// Tightening or relaxing this map changes the security baseline — pair
// any update with a refresh of the K-decision audit row.
//
// GitHub release downloads (cargo-binstall, go install with GitHub-hosted
// modules, direct binary URLs) hit api.github.com for release metadata,
// then github.com for the download URL, which 302-redirects to one of
// several CDN hosts under `*.githubusercontent.com`
// (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
// `codeload.githubusercontent.com`, `raw.githubusercontent.com`, etc.).
// The list shifts over time — GitHub moved release assets from
// `objects.` to `release-assets.` mid-2024 and may shift again. The
// wildcard `*.githubusercontent.com` entry (matched by the
// hostnameAllowed helper in do.ts) covers the moving CDN target so we
// don't keep playing whack-a-mole as GitHub rotates infrastructure.
// api.github.com queries are subject to the anonymous rate limit
// (60/hr/IP, pooled across CF egress IPs) — separate runtime risk.
const GITHUB_RELEASE_HOSTS = [
  'api.github.com',
  'github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
] as const;

const INSTALL_HOSTS: Record<string, readonly string[]> = {
  // `index.crates.io` is the sparse-index host (default in cargo
  // 1.70+); cargo-binstall hits it for `config.json` before any crate
  // download. Older `crates.io` redirects there, but the sparse index
  // is the direct path. Without it, cargo-binstall fails with
  // `403 Forbidden for url (https://index.crates.io/config.json)`.
  'cargo-binstall': ['crates.io', 'static.crates.io', 'index.crates.io', ...GITHUB_RELEASE_HOSTS],
  pip: ['pypi.org', 'files.pythonhosted.org'],
  // uv hits the same wheel-hosting hosts as pip — pypi.org for metadata
  // and files.pythonhosted.org for wheel downloads — but via a
  // different client + resolver path that we hope sidesteps Bug M
  // (pip metadata 403 via CF fetch passthrough).
  uv: ['pypi.org', 'files.pythonhosted.org'],
  npm: ['registry.npmjs.org'],
  // bun's `add -g` resolves from npm — `registry.npmjs.org` is the
  // only host the install path needs.
  bun: ['registry.npmjs.org'],
  go: ['proxy.golang.org', 'sum.golang.org', ...GITHUB_RELEASE_HOSTS],
} as const;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function score(sandbox: ContainerLike, spec: InstallSpec): Promise<ScoreResult> {
  return await Promise.race([runScore(sandbox, spec), timeoutAfter(TOTAL_TIMEOUT_MS)]);
}

async function runScore(sandbox: ContainerLike, spec: InstallSpec): Promise<ScoreResult> {
  const installCmd = installCommandFor(spec);
  if (!installCmd) {
    return { ok: false, error: 'install_unsupported', details: `pm=${spec.pm}` };
  }
  const hosts = installHostsFor(spec);
  const binary = spec.binary;

  // Phase 1 — allow install hosts. Setting the handler BEFORE exec is the
  // safety invariant covered by tests/score-do.test.ts scenario (b).
  await sandbox.setOutboundHandler<{ allowedHostnames: string[] }>('allowedInstall', {
    allowedHostnames: [...hosts],
  });

  const installResult = await sandbox.exec(installCmd, { timeout: TOTAL_TIMEOUT_MS });
  if (!installResult.success) {
    return {
      ok: false,
      error: 'chain_resolved_install_failed',
      details: truncate(installResult.stderr) || truncate(installResult.stdout),
    };
  }

  // Verify the install produced a runnable binary on PATH. Catches the
  // pallets/click case (wheel installs cleanly, no console_scripts entry).
  const whichCmd = `which ${shellQuote(binary)}`;
  const whichResult = await sandbox.exec(whichCmd, { timeout: SHORT_EXEC_TIMEOUT_MS });
  if (!whichResult.success || !whichResult.stdout.trim()) {
    return { ok: false, error: 'chain_resolved_no_binary_produced', details: `binary=${binary}` };
  }

  // Phase 2 — lock down. `anc check` must not reach any host. Setting the
  // handler BEFORE exec is the second safety invariant covered by test
  // scenario (b).
  await sandbox.setOutboundHandler('noHttp');

  // Capture anc_version live (R11 — anc_version from running binary,
  // never a build-time constant).
  const versionResult = await sandbox.exec('anc --version', { timeout: SHORT_EXEC_TIMEOUT_MS });
  if (!versionResult.success) {
    return { ok: false, error: 'anc_version_unreadable' };
  }
  const ancVersion = parseAncVersion(versionResult.stdout);
  if (!ancVersion) {
    return {
      ok: false,
      error: 'anc_version_unreadable',
      details: truncate(versionResult.stdout, 120),
    };
  }

  // Run anc check. audit_profile is propagated from a registry entry if
  // U4 attached one to the install spec (registry-known tools get
  // category-specific checks); unknown tools omit the flag and `anc`
  // runs its default check set.
  const auditProfile = (spec as { audit_profile?: string }).audit_profile;
  const ancCheckCmd = auditProfile
    ? `anc check --command ${shellQuote(binary)} --output json --audit-profile ${shellQuote(auditProfile)}`
    : `anc check --command ${shellQuote(binary)} --output json`;
  const checkResult = await sandbox.exec(ancCheckCmd, { timeout: TOTAL_TIMEOUT_MS });

  // anc emits a structured envelope on stdout even on non-zero exit when
  // a check produced findings. Try to parse before declaring failure.
  let scorecard: unknown;
  try {
    scorecard = JSON.parse(checkResult.stdout);
  } catch {
    if (!checkResult.success) {
      return {
        ok: false,
        error: 'anc_check_failed',
        details: truncate(checkResult.stderr) || truncate(checkResult.stdout),
      };
    }
    return { ok: false, error: 'anc_check_failed', details: 'anc returned non-JSON stdout' };
  }

  return { ok: true, value: { scorecard, anc_version: ancVersion } };
}

// ---------------------------------------------------------------------------
// Install table
// ---------------------------------------------------------------------------

function installCommandFor(spec: InstallSpec): string | null {
  switch (spec.pm) {
    case 'brew':
      // brew returns null so resolveSpec() in do.ts can apply the
      // discovery-fallback before this table is consulted. By the time
      // a request reaches installCommandFor() with pm=brew, the
      // fallback has already missed — i.e. no alternative PM exists
      // for the formula. score() catches the null and bounces as
      // install_unsupported with pm=brew_only (mapped through
      // resolveSpec, not here, so the user-facing detail surfaces the
      // brew_only case rather than the legacy pm=brew message).
      return null;
    case 'bun':
      // Native bun runtime ships in the image (2026-05-18 rework).
      // --ignore-scripts suppresses npm-style lifecycle hooks since
      // bun resolves from the npm registry and runs the same script
      // lifecycle as npm. --no-summary cuts noise from the install
      // output that would otherwise pollute the truncated details
      // field on failure.
      return `bun add -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'uv':
      // Native uv (2026-05-18 rework — split from pm=pip). uv tool
      // install places the binary at $UV_TOOL_BIN_DIR (default
      // $HOME/.local/bin, covered by Dockerfile PATH). uv's resolver
      // sidesteps the pip 24+ PEP 658 metadata fast-path that 403s
      // through CF fetch passthrough for some packages (Bug M).
      return `uv tool install ${shellQuote(spec.package)}`;
    case 'cargo-binstall':
      // Standalone `cargo-binstall` binary lives at /usr/local/bin/
      // (Dockerfile lines 73-80). The image ships NO rust toolchain per
      // Premise #2 ("no compilers, no toolchains"), so the `cargo` CLI
      // does not exist — calling `cargo binstall <pkg>` would fail with
      // `cargo: command not found`. The binstall README documents the
      // standalone use case.
      //
      // --install-path /usr/local/bin overrides cargo-binstall's default
      // of $CARGO_HOME/bin (= ~/.cargo/bin), which isn't on our PATH.
      // Without it, the binary installs successfully but the post-install
      // `which <binary>` gate misses and the request bounces as
      // chain_resolved_no_binary_produced.
      return `cargo-binstall --no-confirm --no-symlinks --install-path /usr/local/bin ${shellQuote(spec.package)}`;
    case 'pip':
      // --only-binary=:all: refuses sdist execution (the setup.py
      // arbitrary-code-exec class). --no-cache-dir keeps the container
      // filesystem clean across requests on a warm DO. PIP_NO_COLOR=1
      // suppresses ANSI escape sequences in pip's progress output that
      // pollute the orchestration's error `details` field when an
      // install fails. --break-system-packages overrides PEP 668's
      // "externally-managed-environment" refusal that Debian's
      // python3-pip ships with — appropriate for our throwaway sandbox
      // where there is no system Python to protect.
      //
      // 2026-05-18: dropped `--use-deprecated=legacy-resolver` (Bug M
      // workaround on Alpine/musllinux). The Debian-slim rework moves
      // pip onto manylinux wheels which we believe closes the metadata
      // 403 gap; staging retest of `pip install httpie` validates.
      // Re-add this flag in a follow-up if httpie regresses.
      return (
        `PIP_NO_COLOR=1 pip install --only-binary=:all: --no-cache-dir ` +
        `--break-system-packages ${shellQuote(spec.package)}`
      );
    case 'npm':
      // --ignore-scripts suppresses preinstall/install/postinstall
      // lifecycle hooks — keeps Phase 1 egress from being abused by
      // lifecycle scripts before the Phase 2 lockdown fires.
      return `npm install -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'go':
      // pm=go bounces here so resolveSpec()'s go discovery-fallback
      // (do.ts:resolveGoFallback) translates `go install <module>`
      // inputs upstream of this layer. If a request reaches
      // installCommandFor() with pm=go the fallback has already
      // missed, which means the module isn't on github.com OR the
      // repo has no GitHub release binary — both flagged as
      // install_unsupported pm=go_no_binary by resolveSpec. The null
      // here is a safety net; sandbox-exec wouldn't otherwise know
      // whether to compile (would violate U2 binary-only) or bounce.
      return null;
    case 'direct':
      // Archive download + extract to /usr/local/bin. The user-pasted
      // URL is the trust boundary; SHA verification is not done at
      // this layer (no known-good SHA available for arbitrary user
      // input). -L follows redirects so github.com release URLs that
      // 302 to objects.githubusercontent.com resolve correctly (the
      // allowlist expansion in installHostsFor covers the CDN host).
      //
      // 2026-05-18 (Bug N): dispatch extraction on URL extension. The
      // legacy single-form `tar xz` worked for .tar.gz/.tgz only;
      // many newer Rust tools (csvlens, etc.) ship .tar.xz exclusively
      // for compression, plus .zip / .tar.bz2 appear in the wild.
      // .tar.gz / .tgz   → tar xz
      // .tar.xz / .txz   → tar xJ  (requires xz-utils in image)
      // .tar.bz2 / .tbz2 → tar xj  (requires bzip2 in image)
      // .zip             → unzip into a tmp dir, install matched binary
      // Anything else    → falls through to tar xz (preserves legacy
      //                    behavior, will fail loud on unsupported
      //                    formats so the bounce is visible).
      return directInstallCommand(spec.url, spec.binary);
    default: {
      // Exhaustiveness check — adding a new PM to the InstallSpec union
      // is a compile error here until the table is updated.
      const _exhaustive: never = spec;
      void _exhaustive;
      return null;
    }
  }
}

// Dispatch the direct-PM install command on archive extension. Kept
// alongside installCommandFor() (vs. inlined) so the per-extension
// shapes are individually testable and the test file pins each form.
//
// All formats extract into a per-invocation tmp dir, then `find` the
// binary by name and `install` it to /usr/local/bin. The earlier
// streaming `tar -C /usr/local/bin/` shape failed for archives whose
// binary was nested inside a top-level directory (csvlens ships
// `csvlens-x86_64-unknown-linux-musl/csvlens`, which would land at
// `/usr/local/bin/csvlens-x86_64-unknown-linux-musl/csvlens` instead
// of `/usr/local/bin/csvlens`). The find+install shape handles both
// flat and nested archive layouts.
function directInstallCommand(url: string, binary: string): string {
  const lower = url.toLowerCase();
  const qUrl = shellQuote(url);
  const qBin = shellQuote(binary);
  let extractCmd: string;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    extractCmd = `tar xzf "$tmp/a" -C "$tmp/x"`;
  } else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    extractCmd = `tar xJf "$tmp/a" -C "$tmp/x"`;
  } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    extractCmd = `tar xjf "$tmp/a" -C "$tmp/x"`;
  } else if (lower.endsWith('.zip')) {
    extractCmd = `unzip -q "$tmp/a" -d "$tmp/x"`;
  } else {
    // Unknown extension: attempt gzip-tar as a last resort. Fails loud
    // on mismatch; orchestration bounces as chain_resolved_install_failed.
    extractCmd = `tar xzf "$tmp/a" -C "$tmp/x"`;
  }
  // Wrapped in `( ... )` subshell so `set -e` exits the subshell on
  // failure rather than the persistent container shell session (which
  // would kill the session and 1101-error every subsequent request
  // routed to this DO instance — SessionTerminatedError).
  //
  // find -perm /111 narrows to executable matches so non-binary
  // `<binary>.txt`-style decoys don't shadow the real target.
  // -print -quit returns the first hit.
  return (
    `( set -e; ` +
    `tmp=$(mktemp -d); ` +
    `mkdir "$tmp/x"; ` +
    `curl -fsSL ${qUrl} -o "$tmp/a"; ` +
    `${extractCmd}; ` +
    `found=$(find "$tmp/x" -type f -name ${qBin} -perm /111 -print -quit); ` +
    `test -n "$found"; ` +
    `install -m 0755 "$found" /usr/local/bin/${qBin}; ` +
    `rm -rf "$tmp" )`
  );
}

function installHostsFor(spec: InstallSpec): readonly string[] {
  if (spec.pm === 'direct') {
    try {
      const host = new URL(spec.url).hostname;
      // GitHub release download URLs (`github.com/.../releases/download/...`)
      // HTTP 302 redirect to `objects.githubusercontent.com`, sometimes
      // via `codeload.github.com` for source archives. Allow all three
      // together so `curl -fsSL` can follow the redirect chain to the
      // actual asset without the allowlist handler 403-ing the redirect
      // target. Other hosts (e.g. a direct CDN URL) get only the
      // declared hostname.
      if (host === 'github.com' || GITHUB_RELEASE_HOSTS.includes(host as (typeof GITHUB_RELEASE_HOSTS)[number])) {
        return GITHUB_RELEASE_HOSTS;
      }
      return [host];
    } catch {
      return [];
    }
  }
  return INSTALL_HOSTS[spec.pm] ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// POSIX single-quote shell escape — wraps in `'...'` and replaces internal
// `'` with `'\''`. Safe for arbitrary user-pasted package names and URLs.
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function parseAncVersion(stdout: string): string | null {
  // Expected forms: `anc 0.3.1`, `anc version 0.3.1`, `anc 0.3.1 (commit
  // <sha>)`. The semver match is the load-bearing part.
  const match = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

// CSI (Control Sequence Introducer) escape sequences emitted by terminal-
// aware tools (pip progress bars, npm spinners) pollute the details
// field that surfaces back to the user. Strip before truncation so the
// truncated tail isn't a mangled partial escape sequence. The ESC
// (\x1b) byte is the load-bearing prefix of every ANSI CSI sequence —
// matching it literally is the point of this pattern, so the biome
// noControlCharactersInRegex lint is deliberately suppressed here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the CSI prefix; matching it is intentional
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function truncate(s: string | undefined, n = 500): string {
  if (!s) return '';
  const clean = s.replace(ANSI_CSI_RE, '');
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function timeoutAfter(ms: number): Promise<ScoreFailure> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms);
  });
}
