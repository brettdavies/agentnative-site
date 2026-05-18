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
// `cargo binstall` is binary-only by design. `brew` bounces at the
// `install_unsupported` gate (Linuxbrew/musl incompatibility — Finding
// F3). `go install` is kept per the 2026-05-18 K-decision re-evaluation
// (commit 9b45b96 on dev): `gc` does not execute user code at compile
// time, so the blast radius is bounded by the same 60 s combined
// install + score timeout that bounds the other PMs.

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
  npm: ['registry.npmjs.org'],
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
      // Linuxbrew/musl is non-viable on Alpine (Finding F3). Bounce.
      return null;
    case 'bun':
      // Bun runtime is not in the sandbox image (no Alpine apk package,
      // not installed via tarball). pm=bun parses cleanly at U4 but has
      // no runtime to invoke; bounce as install_unsupported. Future work
      // can either add bun to the image or translate to npm install
      // since bun's package source IS the npm registry — current choice
      // is to bounce honestly so the user-facing CTA points at
      // install-anc-locally rather than silently substituting semantics.
      return null;
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
      // "externally-managed-environment" refusal that Alpine's py3-pip
      // ships with — appropriate for our throwaway sandbox where there
      // is no system Python to protect. --use-deprecated=legacy-resolver
      // disables pip 24+'s wheel-metadata fast-path (PEP 658 .metadata
      // range-request fetch) that returns 403 from files.pythonhosted.org
      // for some packages when the request flows through the CF Workers
      // fetch passthrough (Bug M, root cause unknown but the legacy
      // resolver downloads full wheels and works reliably). Legacy
      // resolver is scheduled for removal in pip 25+; this is a
      // temporary workaround until either a wheel-fetch shape fix lands
      // or we switch to pipx.
      return (
        `PIP_NO_COLOR=1 pip install --only-binary=:all: --no-cache-dir ` +
        `--break-system-packages --use-deprecated=legacy-resolver ` +
        shellQuote(spec.package)
      );
    case 'npm':
      // --ignore-scripts suppresses preinstall/install/postinstall
      // lifecycle hooks — keeps Phase 1 egress from being abused by
      // lifecycle scripts before the Phase 2 lockdown fires.
      return `npm install -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'go':
      // Toolchain retained per the 2026-05-18 K-decision (commit 9b45b96
      // on dev). `gc` does not execute user code at compile time, so the
      // blast radius is bounded by the 60 s combined timeout.
      //
      // GOBIN=/usr/local/bin overrides go's default of $GOPATH/bin
      // (= ~/go/bin), which isn't on our PATH. Same fix as the
      // cargo-binstall --install-path flag — keeps the post-install
      // `which <binary>` gate from missing on a successful install.
      return `GOBIN=/usr/local/bin go install ${shellQuote(spec.package)}@latest`;
    case 'direct':
      // Tarball download + extract to /usr/local/bin. The user-pasted URL
      // is the trust boundary; SHA verification is not done at this
      // layer (no known-good SHA available for arbitrary user input).
      // -L follows redirects so github.com release URLs that 302 to
      // objects.githubusercontent.com resolve correctly (the allowlist
      // expansion in installHostsFor covers the CDN host).
      return `curl -fsSL ${shellQuote(spec.url)} | tar xz -C /usr/local/bin/`;
    default: {
      // Exhaustiveness check — adding a new PM to the InstallSpec union
      // is a compile error here until the table is updated.
      const _exhaustive: never = spec;
      void _exhaustive;
      return null;
    }
  }
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
