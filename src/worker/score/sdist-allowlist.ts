// Python packages allowed to install from sdist inside the sandbox,
// overriding the default `--only-binary=:all:` enforcement on the pip
// install path.
//
// Plan U7 follow-up (option C from the install-path triage on 2026-05-19).
//
// Background
// ----------
// `sandbox-exec.ts:installCommandFor()` runs `pip install
// --only-binary=:all:` so installs MUST come from a precompiled wheel.
// This removes the install-time arbitrary-code-exec surface (setup.py
// runs during sdist builds) and was a hard-line security default from
// plan U6's K-decision audit.
//
// The cost: any transitive dep that ships sdist-only on PyPI for the
// current Python + linux_x86_64 fails the install. Pip's resolver
// surfaces this as `ResolutionImpossible` after backing off through
// many older versions, not as "no wheel for X". The error is opaque to
// users.
//
// Specific blockers identified on 2026-05-19:
//   - Aider-AI/aider#4105: `pyperclip==1.9.0` ships sdist-only.
//   - Aider-AI/aider#4309: `numpy==1.24.3` triggers a build error path.
//   - Aider-AI/aider#3037, #3660, #4340: combined evidence that aider's
//     dep graph requires sdist for at least one path under
//     `--only-binary=:all:`.
//
// Trust criteria for adding an entry
// ----------------------------------
// Each allowlisted package gets `--no-binary=<name>` on the pip install
// command, which lets pip fall back to sdist (running setup.py) for
// that specific package only. The rest of the dep graph stays
// wheel-only. Adding a package to this list is a meaningful security
// loosening for that one package, so every entry must satisfy:
//
//   1. Mature, well-known maintainer or PyPI org (no anonymous individual
//      maintainers with low download counts).
//   2. Clear reason this package can't always ship a wheel (legacy
//      project, build-step at install, conditional native deps).
//   3. Upstream issue link if a specific bug report drove the addition.
//   4. Date added + commit/PR reference for the vetting trail.
//
// Removing an entry is always safe: the only consequence is the
// previously-allowlisted package returns to `--only-binary` enforcement,
// which may break tools that depend on it.
//
// How it's wired
// --------------
// `sandbox-exec.ts:installCommandFor()` joins `SDIST_TRUSTED_NAMES` into
// the `--no-binary=<comma-list>` portion of the pip install command.
// Empty list emits no `--no-binary` flag at all. uv installs already
// fall back to sdist automatically (no equivalent flag needed); this
// file targets the pip path specifically.

export type SdistTrustedEntry = {
  /** PyPI package name exactly as it appears in `--no-binary=<name>`. */
  name: string;
  /** Why this package needs sdist install (manylinux gap, legacy, etc.). */
  reason: string;
  /** Date added (YYYY-MM-DD) for chronological auditing. */
  added: string;
  /** Upstream issues, PRs, or maintainer docs that motivated the addition. */
  evidence: readonly string[];
  /**
   * Lowest version where the sdist-only condition applies. Inclusive.
   * Omit (or use `0.0.0`) when the condition applies to all known versions.
   */
  affected_min_version?: string;
  /**
   * Highest version where the sdist-only condition applies. Inclusive.
   * Versions above this are expected to ship a wheel and won't need the
   * allowlist entry; re-evaluate removal when the package's pinned
   * version in aider-chat or other consumers crosses this threshold.
   */
  affected_max_version?: string;
  /**
   * Optional recommended pin a downstream consumer could use to avoid
   * the sdist condition entirely. Documentary only — not enforced.
   */
  safe_pin?: string;
};

export type SdistRejectedEntry = {
  /** PyPI package name. */
  name: string;
  /** Why allowlisting this package would NOT fix the underlying issue. */
  reason: string;
  /** Date investigated (YYYY-MM-DD). */
  investigated: string;
  /** Lowest version where the issue described in `reason` applies. */
  affected_min_version?: string;
  /** Highest version where the issue applies. Inclusive. */
  affected_max_version?: string;
  /**
   * Optional pin recommendation that sidesteps the issue without
   * touching `--only-binary`. The right fix for these rejected
   * entries usually involves pinning, not allowlisting.
   */
  safe_pin?: string;
};

export const SDIST_TRUSTED_DEPS: readonly SdistTrustedEntry[] = [
  {
    name: 'pyperclip',
    reason:
      'Cross-platform clipboard utility. Pure Python (~300 lines) with no C compilation, no install-time network calls, no setup.py beyond a sys import. PyPI publishes sdist-only for 1.8.x and 1.9.0 (the versions aider-chat 0.83-0.86 pins); v1.11.0 finally ships a wheel. Maintained by Al Sweigart (well-known PyPI author, author of Automate the Boring Stuff with Python). No CVEs.',
    added: '2026-05-19',
    evidence: ['https://github.com/Aider-AI/aider/issues/4105', 'https://github.com/asweigart/pyperclip/issues/213'],
    affected_min_version: '0.0.0',
    affected_max_version: '1.10.0',
    safe_pin: '>=1.11.0',
  },
  {
    name: 'pycparser',
    reason:
      'Pure-Python C grammar parser, no wheel through v2.23 on PyPI (v3.0 published 2026-01-21 finally ships py3-none-any.whl). Maintained by Eli Bendersky (long-time PyPI author, also maintains pyelftools). Widely audited because cffi depends on it for OpenSSL bindings used across the cryptography ecosystem. No CVEs.',
    added: '2026-05-19',
    evidence: ['https://github.com/eliben/pycparser/issues/288', 'https://github.com/eliben/pycparser/issues/359'],
    affected_min_version: '0.0.0',
    affected_max_version: '2.23',
    safe_pin: '>=3.0',
  },
];

// Packages explicitly investigated and REJECTED for the allowlist. Kept
// here so a future "should we add X?" question gets a quick "no, here's
// why" rather than a re-investigation.
export const SDIST_REJECTED_NOTES: readonly SdistRejectedEntry[] = [
  {
    name: 'numpy',
    reason:
      "numpy==1.24.3 (the version aider-chat pins via its playwright extra) predates cp312 wheel publication AND fails to build from sdist on Python 3.12 because the standard library dropped `distutils` in 3.12. Allowlisting wouldn't fix the install; a real fix needs numpy>=1.26 (which has cp312 wheels). Don't add.",
    investigated: '2026-05-19',
    affected_min_version: '0.0.0',
    affected_max_version: '1.25.99',
    safe_pin: '>=1.26.0',
  },
  {
    name: 'cffi',
    reason:
      'cffi 2.0.0 wheels are tagged `manylinux_2_17_x86_64` only (not dual-tagged with `manylinux2014_x86_64`). Modern pip (>=22.3) understands PEP 600 tags and resolves the wheel correctly. cffi 1.17.1 has confirmed `cp312-manylinux2014_x86_64` wheels and is the safe pin. Allowlisting is not the right tool; pin cffi instead if needed.',
    investigated: '2026-05-19',
    affected_min_version: '2.0.0',
    affected_max_version: '2.99.99',
    safe_pin: '==1.17.1',
  },
];

/** Comma-joined name list for the pip `--no-binary=<a,b,c>` flag. Empty string when no entries. */
export const SDIST_TRUSTED_NAMES: string = SDIST_TRUSTED_DEPS.map((d) => d.name).join(',');
