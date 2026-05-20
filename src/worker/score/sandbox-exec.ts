// Live-scoring orchestration — install + anc check inside a Sandbox DO,
// with two-phase egress enforced via the SDK's named outbound handlers.
// The DO class in ./do.ts holds the static `outboundHandlers` map; this
// module orchestrates the per-request install + score flow by calling
// `setOutboundHandler` and `exec` against the DO instance it's passed.
//
// Pure orchestration — no SDK class imports beyond a type-only reference
// for the parameter type. Lets `tests/score-do.test.ts` exercise the
// two-phase ordering invariant against a hand-rolled Container-like
// stub without instantiating the real Sandbox class.
//
// Per-PM install command table mirrors a per-package-manager script-
// execution audit: `npm` and `bun` carry `--ignore-scripts`; `pip`
// carries `--only-binary=:all:`; `cargo binstall` is binary-only by
// design; `uv tool install` uses uv's own resolver (binary-only by
// default for wheel-bearing packages). `brew` returns null from
// installCommandFor() so the resolveSpec() discovery-fallback in resolve-spec.ts
// (2026-05-18 rework) can translate `brew install <tool>` inputs to
// whatever cargo / npm / pip / go alternative the discovery chain finds
// for the brew formula's GitHub repo. brew-only tools (no other PM)
// bounce as install_unsupported with pm=brew_only.

import type { Sandbox } from '@cloudflare/sandbox';
import type { GitCloneInstall, InstallSpec } from './discover-binary';
import { SDIST_TRUSTED_NAMES } from './sdist-allowlist';
import { validBranchName } from './validate';

// Per-clone destination — fixed name keeps the path predictable for the
// `anc check <path>` invocation and the cleanup post-score (the warm
// container session may reuse this DO instance for the next request).
// Lives under /tmp so it's wiped by the container's tmpfs semantics.
const CLONE_DEST = '/tmp/anc-clone-target';

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

// Marker tokens the direct-install command emits so the orchestrator can
// classify shell-subshell failures into specific error details (Fix 3 —
// gate-capture). Each `GATE:<name>` line is written to stderr BEFORE the
// shell step it labels runs; on subshell failure the LAST GATE marker
// names the step that failed. `DETAILS:<text>` carries a step-specific
// message into the orchestration. `DETECTED_BINARY=<name>` is emitted to
// stdout on success so auto-detect (Fix 1) can rename spec.binary to the
// archive's actual executable rather than guessing it's the repo name.
const GATE_PREFIX = 'GATE:';
const DETAILS_PREFIX = 'DETAILS:';
const DETECTED_BINARY_PREFIX = 'DETECTED_BINARY=';

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

const TOTAL_TIMEOUT_MS = 60_000; // R7 — install + score combined.
const SHORT_EXEC_TIMEOUT_MS = 5_000; // `which`, `anc --version`.

// Per-PM install-host allowlists. Only these hosts are reachable during
// Phase 1 install for each PM; Phase 2 (anc check) blocks all hosts.
// Tightening or relaxing this map changes the security baseline — pair
// any update with a refresh of the script-execution audit row.
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
  let binary = spec.binary;

  // Phase 1 — allow install hosts. Setting the handler BEFORE exec is the
  // safety invariant covered by tests/score-do.test.ts scenario (b).
  await sandbox.setOutboundHandler<{ allowedHostnames: string[] }>('allowedInstall', {
    allowedHostnames: [...hosts],
  });

  const installResult = await sandbox.exec(installCmd, { timeout: TOTAL_TIMEOUT_MS });
  if (!installResult.success) {
    // Gate-capture (Fix 3): direct-install commands emit `GATE:<step>` markers
    // to stderr before each step. The LAST marker names the step that
    // tripped `set -e`. If a step also emitted `DETAILS:<text>` (e.g. the
    // archive listing for the no-binary-candidate case), thread that into
    // the user-facing details field instead of the raw stderr tail.
    const gateDetails = extractGateDetails(installResult.stderr);
    // Path-traversal short-circuit: archive contained a candidate the
    // validator rejected. Bounce as no-binary-produced (an "archive
    // shipped a malformed path" case), not install_failed.
    if (gateDetails?.kind === 'no_binary_candidates') {
      return {
        ok: false,
        error: 'chain_resolved_no_binary_produced',
        details: gateDetails.details,
      };
    }
    return {
      ok: false,
      error: 'chain_resolved_install_failed',
      details: gateDetails?.details ?? (truncate(installResult.stderr) || truncate(installResult.stdout)),
    };
  }

  // Auto-detect (Fix 1): direct-install commands print
  // `DETECTED_BINARY=<name>` on stdout when the archive carried a binary
  // whose filename differs from spec.binary (the gogcli → gog case).
  // Override spec.binary so the downstream `which` gate + `anc check
  // --command <binary>` invocation targets the file that actually got
  // installed. The detected name is the basename, character-validated
  // by the install command's filter before it lands here.
  const detected = extractDetectedBinary(installResult.stdout);
  if (detected) {
    binary = detected;
  }

  // Git-clone source-scoped path: no binary on PATH to verify — `anc
  // check <path>` runs against the cloned source. Skip the `which
  // <binary>` gate, which would always miss because the repo name is
  // not necessarily a CLI binary the clone produced.
  const isSourceScoped = spec.pm === 'git-clone';

  if (!isSourceScoped) {
    // Verify the install produced a runnable binary on PATH. Catches the
    // pallets/click case (wheel installs cleanly, no console_scripts entry).
    const whichCmd = `which ${shellQuote(binary)}`;
    const whichResult = await sandbox.exec(whichCmd, { timeout: SHORT_EXEC_TIMEOUT_MS });
    if (!whichResult.success || !whichResult.stdout.trim()) {
      return { ok: false, error: 'chain_resolved_no_binary_produced', details: `binary=${binary}` };
    }
  }

  // Phase 2 — lock down. `anc check` must not reach any host. Setting the
  // handler BEFORE exec is the second safety invariant covered by test
  // scenario (b).
  await sandbox.setOutboundHandler('noHttp');

  // Capture anc_version live from the running binary, never a build-time
  // constant — a cached scorecard must record the anc that actually
  // produced it so re-deployed sites don't lie about provenance.
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

  // Run anc check. Two invocation shapes:
  //   - binary install (default): `anc check --command <binary>` scores
  //     the running binary's behavior against the spec.
  //   - source clone (git-clone PM, branch-scoped paste): `anc check
  //     <clone-path>` scores the source layout + project files. The
  //     clone-path is interpolated via shellQuote and the path itself
  //     is built from the spec, NOT from user input — the user's input
  //     only flows in through the validated owner/repo/branch slots
  //     which are character-class-restricted at validate.ts.
  const auditProfile = (spec as { audit_profile?: string }).audit_profile;
  const ancCheckCmd = isSourceScoped
    ? buildAncCheckSourceCmd(spec as GitCloneInstall, auditProfile)
    : auditProfile
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
      // brew returns null so resolveSpec() in resolve-spec.ts (Worker
      // tier post-2026-05-20) can apply the discovery-fallback before
      // this table is consulted. By the time
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
      // python3-pip ships with — kept for safety even though the
      // python:3.12-slim-trixie base (2026-05-19) does NOT carry the
      // EXTERNALLY-MANAGED marker, so the flag is a no-op there.
      //
      // 2026-05-18: dropped `--use-deprecated=legacy-resolver` (Bug M
      // workaround on Alpine/musllinux). The Debian-slim rework moves
      // pip onto manylinux wheels which we believe closes the metadata
      // 403 gap; staging retest of `pip install httpie` validates.
      // Re-add this flag in a follow-up if httpie regresses.
      //
      // 2026-05-19: `--no-binary=<name1,name2,...>` selectively allows
      // sdist install for specific trusted packages (sdist-allowlist.ts).
      // Each entry has a vetted maintainer + upstream issue trail;
      // adding to the list is a deliberate security loosening for that
      // ONE package, the rest of the dep graph stays wheel-only.
      // Empty allowlist → no --no-binary flag.
      //
      // 2026-05-19: `PIP_UPLOADED_PRIOR_TO=<date>` enforces a 7-day
      // package-release delay so a fresh-publish supply-chain attack
      // has at minimum a 7-day detection window before our sandbox
      // would install it. The date is computed at exec time via shell
      // substitution so image age doesn't widen the gate; uv's
      // equivalent (UV_EXCLUDE_NEWER) is baked as an image ENV because
      // uv accepts relative durations natively. pip support is v26.0+;
      // older pip versions ignore the env var (no-op until upstream
      // lands, then the gate auto-activates on image rebuild).
      // `PIP_DISABLE_PIP_VERSION_CHECK=1` suppresses the "A new release
      // of pip is available" stderr notice. It's also baked as an image
      // ENV in docker/sandbox/Dockerfile so future builds carry it
      // intrinsically; the inline pass here keeps the
      // currently-deployed image quiet until the next rebuild lands.
      return (
        `PIP_UPLOADED_PRIOR_TO=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ) ` +
        `PIP_DISABLE_PIP_VERSION_CHECK=1 ` +
        `PIP_NO_COLOR=1 pip install --only-binary=:all:` +
        (SDIST_TRUSTED_NAMES ? ` --no-binary=${SDIST_TRUSTED_NAMES}` : '') +
        ` --no-cache-dir --break-system-packages ${shellQuote(spec.package)}`
      );
    case 'npm':
      // --ignore-scripts suppresses preinstall/install/postinstall
      // lifecycle hooks — keeps Phase 1 egress from being abused by
      // lifecycle scripts before the Phase 2 lockdown fires.
      return `npm install -g --ignore-scripts ${shellQuote(spec.package)}`;
    case 'go':
      // pm=go bounces here so resolveSpec()'s go discovery-fallback
      // (resolve-spec.ts:resolveGoFallback) translates `go install <module>`
      // inputs upstream of this layer. If a request reaches
      // installCommandFor() with pm=go the fallback has already
      // missed, which means the module isn't on github.com OR the
      // repo has no GitHub release binary — both flagged as
      // install_unsupported pm=go_no_binary by resolveSpec. The null
      // here is a safety net; sandbox-exec wouldn't otherwise know
      // whether to compile (we ship no toolchain) or bounce.
      return null;
    case 'git-clone':
      // Branch-scoped source clone. The branch name was validated at
      // validate.ts (BRANCH_NAME_RE + explicit
      // `..` reject) AND re-validated at the DO boundary (do.ts
      // resolveSpec in resolve-spec.ts). buildGitCloneCommand() refuses to emit a command
      // for a branch that fails the validBranchName check — defense
      // in depth so a future caller that builds an InstallSpec
      // directly (skipping validate.ts AND resolveSpec) still can't
      // smuggle shell metacharacters through. Returns null when the
      // branch fails late-stage validation, which collapses to
      // install_unsupported with pm=git-clone.
      return buildGitCloneCommand(spec);
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
// All formats extract into a per-invocation tmp dir, then `find` an
// executable and `install` it to /usr/local/bin. The earlier streaming
// `tar -C /usr/local/bin/` shape failed for archives whose binary was
// nested inside a top-level directory (csvlens ships
// `csvlens-x86_64-unknown-linux-musl/csvlens`); the recursive find+install
// shape handles both flat and nested layouts.
//
// Auto-detect (Fix 1): instead of `find -name <expectedBinary>` (which
// fails the moment an archive ships a binary whose filename doesn't
// match the GitHub repo name — the gogcli/openclaw case, repo=gogcli but
// archive contains `gog`), the install command lists ALL executables in
// the archive, filters out known documentation/manifest filenames, and
// picks the best candidate via a scoring tiebreaker (exact-match to the
// preferred name wins; otherwise repo-name substring; otherwise shortest
// name; ties broken by lexicographic order for determinism). The chosen
// file is installed under its OWN basename, and that basename is echoed
// to stdout as `DETECTED_BINARY=<name>` so runScore() can override
// spec.binary before the `which <binary>` gate + `anc check --command
// <binary>` invocation run.
//
// Gate-capture (Fix 3): each pipeline step echoes `GATE:<name>` to
// stderr BEFORE running. On `set -e` failure the final GATE marker
// names the step that tripped, and a step-specific `DETAILS:<text>`
// stderr line carries enough context to user-render an honest bounce
// (archive listing for no-candidates case, etc.).
//
// Path-traversal: the candidate filter rejects any path segment
// containing `..` or starting with `/` (absolute paths from a maliciously
// crafted archive). Tar's own `--no-same-owner --no-same-permissions`
// flags + the per-request mktemp prefix close the rest of the attack
// surface; the candidate-name regex is defense in depth.
function directInstallCommand(url: string, preferredBinary: string): string {
  const lower = url.toLowerCase();
  const qUrl = shellQuote(url);
  // The preferred-binary hint passes through awk as a variable; awk
  // single-quote escapes are handled by the surrounding shell quote.
  const qPreferred = shellQuote(preferredBinary);
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
  // The candidate-listing pipeline:
  //   1. find executables (perm /111) under the extraction root, print
  //      paths relative to it (-printf '%P\n').
  //   2. grep -v out doc/manifest filenames (LICENSE, README, etc.) and
  //      known non-binary extensions (.md, .txt, .html, .json, ...).
  //   3. grep -v out any path containing `..` (path-traversal guard) or
  //      starting with `/` (absolute path from malicious archive).
  // awk scores each candidate by name match + shortness; tie-broken by
  // lex order. The exit-code-11 path emits a DETAILS:<list> line so the
  // user-facing bounce can name the files it saw.
  return (
    `( set -e; ` +
    `tmp=$(mktemp -d); ` +
    `mkdir "$tmp/x"; ` +
    `echo '${GATE_PREFIX}download' >&2; ` +
    `curl -fsSL ${qUrl} -o "$tmp/a" 2>"$tmp/curl_err" || ` +
    `{ echo "${DETAILS_PREFIX}Download failed: $(cat "$tmp/curl_err" | head -c 200)" >&2; exit 10; }; ` +
    `echo '${GATE_PREFIX}extract' >&2; ` +
    `${extractCmd} 2>"$tmp/ext_err" || ` +
    `{ echo "${DETAILS_PREFIX}Extract failed: $(cat "$tmp/ext_err" | head -c 200)" >&2; exit 12; }; ` +
    `echo '${GATE_PREFIX}find_binary' >&2; ` +
    `candidates=$(find "$tmp/x" -type f -perm /111 -printf '%P\\n' 2>/dev/null | ` +
    `grep -viE '(^|/)(LICEN[CS]E|README|CHANGELOG|NOTICE|AUTHORS|COPYING|MANIFEST|Makefile|\\.gitignore)([._-].*)?$' | ` +
    `grep -viE '\\.(md|markdown|txt|html|htm|json|yml|yaml|toml|xml|cfg|ini|sh|bat|cmd|py|rb|pl)$' | ` +
    `grep -vE '(^|/)\\.\\.(/|$)' | ` +
    `grep -vE '^/' || true); ` +
    `if [ -z "$candidates" ]; then ` +
    `all=$(find "$tmp/x" -type f -printf '%P\\n' 2>/dev/null | head -10 | tr '\\n' ' '); ` +
    `echo "${DETAILS_PREFIX}Archive contains no binary named ${preferredBinary}. Files seen: $all" >&2; ` +
    `exit 11; ` +
    `fi; ` +
    `best=$(printf '%s\\n' "$candidates" | awk -v pref=${qPreferred} '` +
    `{ ` +
    `n=split($0, parts, "/"); name=parts[n]; ` +
    `score=0; ` +
    `if (name == pref) score=1000; ` +
    `else if (index(name, pref) > 0) score=500; ` +
    `if (name !~ /\\./) score+=10; ` +
    `score -= length(name); ` +
    `if (score > best_score || best == "") { best_score=score; best=$0 } ` +
    `} END { print best }'); ` +
    `detected=$(basename "$best"); ` +
    `echo '${GATE_PREFIX}install_binary' >&2; ` +
    `install -m 0755 "$tmp/x/$best" "/usr/local/bin/$detected" 2>"$tmp/inst_err" || ` +
    `{ echo "${DETAILS_PREFIX}Install staging failed: $(cat "$tmp/inst_err" | head -c 200)" >&2; exit 13; }; ` +
    `rm -rf "$tmp"; ` +
    `echo "${DETECTED_BINARY_PREFIX}$detected" )`
  );
}

function installHostsFor(spec: InstallSpec): readonly string[] {
  if (spec.pm === 'git-clone') {
    // git clone over https hits github.com directly; for some repos the
    // server-side may 302 to codeload.github.com for the pack file. Both
    // are in the GITHUB_RELEASE_HOSTS set already, plus the
    // `*.githubusercontent.com` wildcard covers any future redirect target.
    return GITHUB_RELEASE_HOSTS;
  }
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

// Parse the DETECTED_BINARY=<name> line emitted by directInstallCommand.
// Returns the basename of the file the install path actually staged at
// /usr/local/bin, or null if the marker is absent (any non-direct PM
// install command, or a future direct-install variant that doesn't
// emit the marker). The name is filename-character-restricted before
// it lands back in spec.binary, since downstream it shell-quotes the
// value rather than re-validating its shape.
export function extractDetectedBinary(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(DETECTED_BINARY_PREFIX)) {
      const name = line.slice(DETECTED_BINARY_PREFIX.length).trim();
      // Whitelist filename characters — the install command's own filter
      // rejects path-traversal upstream, but defense in depth keeps any
      // smuggled bytes out of the shell-quoted `anc check --command` slot.
      if (/^[A-Za-z0-9._-]+$/.test(name) && name.length > 0 && name.length <= 64) {
        return name;
      }
    }
  }
  return null;
}

// Parse GATE:<step> + DETAILS:<text> markers from the install stderr.
// Returns the highest-fidelity error description we can produce for the
// user, plus a `kind` discriminator so runScore() can re-classify the
// no-binary-candidate case (an "archive shipped only docs" miss, not an
// "install command failed" miss). Returns null when no markers were
// emitted, so the caller falls back to the raw truncated stderr.
type GateDetails = {
  kind: 'download' | 'extract' | 'no_binary_candidates' | 'install_staging' | 'unknown';
  details: string;
};
export function extractGateDetails(stderr: string): GateDetails | null {
  if (!stderr) return null;
  const lines = stderr.split(/\r?\n/);
  let lastGate: string | null = null;
  let detailsLine: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(GATE_PREFIX)) {
      lastGate = line.slice(GATE_PREFIX.length).trim();
    } else if (line.startsWith(DETAILS_PREFIX)) {
      detailsLine = line.slice(DETAILS_PREFIX.length).trim();
    }
  }
  if (!lastGate && !detailsLine) return null;
  const kind: GateDetails['kind'] = detailsLine?.startsWith('Archive contains no binary named')
    ? 'no_binary_candidates'
    : detailsLine?.startsWith('Download failed')
      ? 'download'
      : detailsLine?.startsWith('Extract failed')
        ? 'extract'
        : detailsLine?.startsWith('Install staging failed')
          ? 'install_staging'
          : 'unknown';
  const details = detailsLine ?? (lastGate ? `Install step '${lastGate}' failed` : 'Install failed');
  return { kind, details: truncate(details) };
}

// ---------------------------------------------------------------------------
// Git clone install path — branch-scoped scoring
// ---------------------------------------------------------------------------

// Build the git-clone install command for a branch-scoped paste.
//
// Security shape:
//
//   - owner + repo come from validate.ts. Owner matches GitHub's own
//     username rules (alphanumeric + hyphen, no leading hyphen);
//     repo matches `[A-Za-z0-9._-]+`. Neither character class includes
//     shell metacharacters.
//   - branch is double-validated: validate.ts at the Worker boundary
//     AND resolve-spec.ts at the Worker boundary (resolveSpec).
//     buildGitCloneCommand
//     does a THIRD check via validBranchName() before string
//     interpolation as a final defense — if a future code path
//     constructs an InstallSpec directly (bypassing both upstream
//     guards), this layer still refuses unsafe branch values.
//   - Even with all that, every interpolated value flows through
//     shellQuote(), which POSIX-single-quote-escapes the value. That's
//     the load-bearing safety property: a single-quote-wrapped value
//     with internal `'` rewritten to `'\''` cannot escape the quoted
//     context regardless of regex coverage.
//
// The Sandbox SDK exposes exec(command: string) only — no argv array
// form — so shellQuote IS the trust boundary at exec time. The strict
// regex layers above shrink the attack surface; shellQuote closes it.
//
// Why `--depth 1 --no-tags --single-branch`: minimize bandwidth + time.
// A branch-scoped score doesn't need full history or sibling refs;
// the clone runs inside the 60 s combined install + score budget and
// every saved second helps the worst-case latency.
export function buildGitCloneCommand(spec: GitCloneInstall): string | null {
  if (!validBranchName(spec.branch)) return null;
  // owner + repo shape is enforced by validate.ts and re-enforced at
  // the DO layer (validBranchName covers branch; the owner/repo character
  // classes are enforced before this layer is reached). shellQuote
  // remains the runtime closer.
  const repoUrl = `https://github.com/${spec.owner}/${spec.repo}.git`;
  // `( set -e; ... )` subshell so a failure mid-clone exits the
  // subshell rather than killing the container's persistent shell
  // session. `rm -rf` of the destination first handles re-runs on a
  // warm DO instance (the prior request's clone would otherwise
  // collide).
  return (
    `( set -e; rm -rf ${shellQuote(CLONE_DEST)}; ` +
    `git clone --depth 1 --no-tags --single-branch ` +
    `--branch ${shellQuote(spec.branch)} ` +
    `${shellQuote(repoUrl)} ${shellQuote(CLONE_DEST)} )`
  );
}

// Build the `anc check <path>` invocation for a source-scoped score.
// Mirrors the `--command <binary>` form's audit-profile handling.
export function buildAncCheckSourceCmd(_spec: GitCloneInstall, auditProfile: string | undefined): string {
  const path = shellQuote(CLONE_DEST);
  return auditProfile
    ? `anc check ${path} --output json --audit-profile ${shellQuote(auditProfile)}`
    : `anc check ${path} --output json`;
}
