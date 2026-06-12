---
date: 2026-06-12
topic: brew-v6-live-scoring-spike
---

# Homebrew v6 live-scoring spike: requirements

## Summary

Measure whether Homebrew 6.0's `brew exec` fits the live sandbox's 60s combined install + score budget by running a
three-arm spike against the full anc100 list — current production install path, `brew exec`, and the current
`resolveBrewFallback` translation path. The spike's data decides whether the live image moves toward a `brew exec`-based
path (shape C), an A+D hybrid (bake brew + a curated transitive-dep set into the live image), a two-tier sandbox (shape
B), or stays on the current translate-and-bounce shape (status quo). The four shapes are defined in KD3.

## Problem frame

The live sandbox (`docker/sandbox/Dockerfile`) does not carry Homebrew. The 2026-05-18 image rework formalized that call
after concluding Linuxbrew on Linux could not fit the 60s combined install + score budget under the v5-era release line.
Today, a user pasting `brew install <pkg>` is translated by `resolveBrewFallback` (in
`src/worker/score/resolve-spec.ts`) to an alternative package manager via the discovery chain — cargo-binstall, uv tool,
bun add, pip, npm, or a GitHub release binary — and the resulting non-brew install is what gets scored.

Translation can be a fidelity concern: `anc audit` is deterministic given the binary, but different distribution
channels can produce different binaries for the same nominal tool — different build flags, dependency versions,
toolchains, signing. Whether anc100 tools materially exhibit this divergence (vs many Rust/Go tools where the brew
bottle wraps the upstream release) is unverified and the spike does not aim to verify it. The primary motivation for
revisiting the no-brew call is the v5-era wall-clock objection, not artifact fidelity; fidelity is a secondary outcome
the spike's data may incidentally surface.

Homebrew 6.0.0 (released 2026-06-11) introduces changes that materially affect the v5-era perf objection: the internal
JSON API is now default (one metadata fetch instead of per-formula), bottle-tab fetching parallelises on upgrade, the
install steps framework lets common postinstall behaviour run as DSL data without downloading Ruby files, the Linux
baseline tracks Ubuntu 24.04 (glibc 2.39, libstdc++ 6.0.33), and `brew exec` ships as an npx-style one-shot runner. The
research note at `.context/research/2026-06-12-homebrew-6-live-scoring-do-image-assessment.md` captured the broad delta.
What that note did not produce — and what the live-image decision needs — is wall-clock data on representative inputs
against the 60s budget.

A spike before any image-level commit is the cheap step: the cost of being wrong on commit (image growth, broken
non-brew traffic, retired infrastructure) is much higher than the cost of measuring first.

## Key decisions

- **KD1. Measure-then-commit, behind a spike-image firewall.** v6's release-note perf claims raise the cost of being
  wrong on a shape commit. The spike gathers wall-clock data before any *production* image change. The spike harness
  will produce a brew-equipped image to measure arm 2, but that image is measurement-only: it MUST NOT be tagged,
  registered, or referenced by any production deploy path, and adoption of brew-in-image requires re-building from the
  production Dockerfile after the shape decision lands. The spike image's disposal is tracked as a deferred-to-planning
  question.
- **KD2. Artifact fidelity is a secondary motivation, not load-bearing.** `anc audit` is deterministic given the binary,
  but different distribution channels can produce different binaries for the same nominal tool. Whether this materially
  shifts scores for anc100 is unverified and the spike does not test it. Wall-clock viability of brew under the 60s
  budget is the primary driver; fidelity is a nice-to-have that the spike's data may incidentally surface.
- **KD3. Three-arm comparison feeds a four-shape downstream decision.** Arm 1 (current production path) establishes the
  baseline. Arm 2 (`brew exec`) measures v6's one-shot runner. Arm 3 (`resolveBrewFallback` on the same anc100 entries
  reformulated as `brew install <pkg>` inputs) exposes the current translation path's wall-clock on known-good inputs.
  The four downstream shapes the spike's data informs are: **status quo** (current translate-and-bounce path via
  `resolveBrewFallback` only, no brew in the live image), **shape C** (v6's `brew exec` in-image — one-shot runner, no
  persistent install), **shape A+D** (bake brew + a curated transitive-dependency set into the live image; brew installs
  run at scoring time), and **shape B** (two-tier sandbox — a separate image carrying brew, routed by `pm=brew` at
  handoff).

## Requirements

### Spike scope and measurement

- R1. The spike measures three install paths for each anc100 entry: arm 1 the current production install path as it runs
  in the live sandbox (per `src/worker/score/sandbox-exec.ts` install semantics), arm 2 `brew exec <formula> --
  <binary>` in a spike-modified sandbox image carrying brew, arm 3 reformulating the entry as `brew install <pkg>` and
  letting `src/worker/score/resolve-spec.ts:resolveBrewFallback()` resolve it. The harness builds on both existing
  Docker images (`docker/sandbox/Dockerfile` for the runtime environment; `docker/score/install-tools.sh` as the
  canonical source of registry-pinned brew formulae) with spike-specific modifications where needed.
- R2. Each arm measures combined install + score wall-clock and records the actual elapsed time per entry. The spike
  does NOT enforce the 60s budget (`TOTAL_TIMEOUT_MS` in `src/worker/score/sandbox-exec.ts`) — long-running audits are
  allowed to complete so the wall-clock signal isn't truncated. Analysis groups runs over 60s as `DNF` (Did Not Finish
  under production budget) when computing pass rates against the production constraint, but the actual wall-clock is the
  primary measurement.
- R3. Coverage is the full anc100 list, not a sample. The whole list is small enough that sampling would only delay the
  same data without adding signal.
- R4. The spike runs primarily inside an actual ephemeral CF Sandbox container — that is the environment whose
  60s-budget verdict the spike exists to produce. A local run against an approximation of `cloudflare/sandbox:0.9.2`
  (Debian Trixie / glibc 2.41 mirroring the final stage of `docker/sandbox/Dockerfile`) is recorded only when CF Sandbox
  scheduling or quota constraints block timely completion; the substitution is noted explicitly in the report. If both
  environments are run, the local-vs-cloud wall-clock delta is reported as an observation, not as a primary measurement
  output of the spike.
- R5. The spike records the brew environment state per arm: `HOMEBREW_NO_SANDBOX`, `HOMEBREW_NO_AUTO_UPDATE`, internal
  API mode, and the brew version. State changes between arms should be intentional and documented in the report, not
  silent.

### `anc audit` compatibility gate

- R6. Before any arm 2 wall-clock collection runs, the spike executes a single-formula probe: run `brew exec` against
  one anc100 entry and invoke `anc audit` against the resulting process. Record one of three outcomes — succeeds without
  modification, succeeds with a named shim (glue path documented), or fails. If the probe fails, arm 2 collection is
  cancelled and the report records shape C as inviable rather than producing moot wall-clock data. The probe is
  time-boxed at 4 hours; if unresolved at the deadline, treat as a fail.

### Reporting and interpretation

- R7. The spike report renders a comparison row per anc100 entry: wall-clock per arm, DNF flag per arm (wall-clock >
  60s), delta vs arm 1 as baseline. A summary band records per-arm pass rate (entries inside 60s) plus the per-arm
  wall-clock distribution — median, p75, p95, max. The report includes an independent "headroom panel" for arm 1 that
  answers "how much headroom does the current production path have against the 60s budget today, and how much of that
  headroom does each brew arm consume?" — not just "does each arm pass." Artifacts land in
  `docs/research/2026-06-12-brew-v6-anc100/`.
- R8. The report distinguishes two questions the data can answer: "is v6 wall-clock-viable for the common (anc100)
  case?" — answerable directly from arms 1-3 — and "does v6 close the `pm=brew_only` tail coverage problem?" —
  answerable only by a second pass against the brew-only formulae the current `resolveBrewFallback` bounces. The first
  does not substitute for the second.
- R15. Arm 3 failure handling is committed: when `resolveBrewFallback` returns no result for an anc100 entry, arm 3
  records that entry as a failure (budget exceeded = fail, wall-clock = N/A) and continues to the next entry. The arm-3
  failure rate is reported as a measurement alongside pass rate. The spike is not aborted on partial
  `resolveBrewFallback` failure.

### Supply-chain posture

- R9. The spike assesses whether the brew path can carry a release-delay gate equivalent to `UV_EXCLUDE_NEWER` (uv) and
  `PIP_UPLOADED_PRIOR_TO` (pip) — specifically (a) whether `HOMEBREW_BOTTLE_DOMAIN` or a custom bottle mirror with a
  configurable embargo window is feasible, and (b) whether `brew install --build-from-source` is a viable fallback for
  formulae without a bottle in the window. If neither mechanism produces an equivalent gate, the report documents the
  brew path as accepting a weaker supply-chain posture than the existing uv/pip paths and surfaces that delta as an
  accepted risk requiring explicit sign-off before any shape adoption.
- R10. The spike disables tap trust enforcement via the appropriate Homebrew environment variable for the duration of
  the spike, so arm 2 (`brew exec`) and arm 3 (`brew install` translation) can run against the full anc100 without
  per-tap trust prompts blocking measurement. Tap-trust policy for production adoption (which taps are trusted, who
  controls the list, whether `brew tap <user-input>` is supported at all) is deferred to planning and evaluated against
  the data the spike produces.
- R11. The spike defaults to running with Homebrew's Bubblewrap sandbox enabled (`HOMEBREW_NO_SANDBOX` unset) — the
  mainstream brew-in-container use case is expected to operate within CF Sandbox's nested namespacing. If Bubblewrap
  fails to start inside CF Sandbox during the spike (capability or seccomp constraints empirically blocking it), the run
  falls back to `HOMEBREW_NO_SANDBOX=1` for the affected arm and the report records it as a named accepted risk,
  documenting what class of formula-install actions Bubblewrap would have prevented (filesystem writes outside Cellar,
  child-process spawning, device access) and asserting whether CF Sandbox SDK's outbound controls are an acceptable
  substitute for any downstream shape decision.
- R13. The spike records the complete set of outbound hosts brew contacts during arms 2 (`brew exec`) and 3 (`brew
  install` translation) — formula metadata endpoints, bottle CDN hosts, tap index hosts, and any other endpoints
  touched. The captured host list is the input the `INSTALL_HOSTS` map in `src/worker/score/sandbox-exec.ts` extends to
  before any shape adopts brew, so the per-PM Phase 1 egress allowlist gets a security review pre-commit rather than
  being widened reactively at implementation time.
- R14. The spike report includes a one-paragraph trust-model comparison between the current path (author-published
  binaries via cargo-binstall, uv tool, bun add, pip, npm, GitHub releases) and the brew path (Homebrew-rebuilt,
  Homebrew-signed bottles served from the bottle CDN), naming which trust assumptions change per candidate shape. The
  paragraph is anchor material for security review at shape adoption, not a control on its own.

## Success criteria

The spike's data is sufficient to commit to status quo or shape C directly and to name the candidate shape (A+D or B)
the second-pass spike would validate. The spike produces a defensible v6-era wall-clock verdict on brew: either "viable"
(shape C or an A+D candidate moves forward) or "not viable — status quo persists with current-data justification." Both
outcomes are legitimate spike results; the null result is the v5-era conclusion re-confirmed against v6 data, not a
spike failure. Specifically:

- Decision matrix mapping arm 2 outcomes to downstream shapes, committed pre-spike (bands evaluated against arm 2
  entries-inside-60s with DNF grouping applied per R2): arm 2 ≥ 80% AND R6 verdict green or glued → shape C is viable;
  arm 2 50–80% AND R6 verdict green or glued → shape A+D is the candidate (image-heavy with selective dep prebake); arm
  2 < 50% OR R6 verdict fail → status quo or shape B, planning revisits with the wall-clock data in hand. The arm-2
  thresholds are committed before the spike runs and are not re-negotiated against the data. Even when the matrix names
  A+D or B as the candidate, formal adoption requires the deferred `pm=brew_only` second-pass spike to validate that
  coverage value justifies implementation cost — the matrix is the wall-clock gate, the second pass is the coverage
  gate.
- Arm 3 is competitive with arm 2 when its pass rate is within 10 percentage points of arm 2's pass rate AND its median
  wall-clock is within 5 seconds of arm 2's median. Inside that band, the report flags arm 3 as a competitive
  translation path and surfaces it for product re-discussion of the broader translation-path value question. Outside it,
  arm 3 is the wall-clock floor arm 2 needs to beat. The 10pp / 5s thresholds are committed before the spike runs and
  are not re-negotiated against the data.
- The R6 compatibility check produces a definitive verdict on whether `brew exec` is even comparable to a persistent
  install in the scoring pipeline. A "maybe with glue" verdict is acceptable provided the glue is named.

## Scope boundaries

### Deferred for later

- Committing to shape A+D (bake brew + a curated transitive-dep set into the live image), shape B (two-tier sandbox), or
  shape C (`brew exec` in-image) — pending spike data.
- Curating the transitive-dependency prebake list — only material if A+D becomes the chosen shape.
- A second-pass spike against `pm=brew_only` formulae (the actual fidelity surface today) — meaningful only if the
  anc100 spike shows v6 is viable in principle.
- Wiring tap trust (`brew tap brettdavies/tap --trust` and similar) into image build — only material if A+D or B is the
  chosen shape.

### Outside this product's identity

- Changing the anc100 leaderboard methodology to account for distribution-channel artifact differences. The leaderboard
  scores what the user tells us to score; that contract is upstream of this spike.
- Supporting arbitrary brew formula installation beyond inputs the user explicitly types as `brew install <pkg>`. The
  live sandbox is a scoring surface, not a general brew runtime.
- Bubblewrap-in-CF-Sandbox validation as a standalone workstream. The spike observes the interaction in passing but does
  not constitute the validation.

## Dependencies and assumptions

- Assumes Homebrew ≥ 6.0.0 for the perf changes (default internal JSON API, parallel bottle-tab fetching, install steps
  framework) and for `brew exec`. v5 releases do not produce comparable wall-clock and should not be substituted.
- Assumes `cloudflare/sandbox:0.9.2` is the right environment to test against (current pinned digest in
  `docker/sandbox/Dockerfile`). If the CF Sandbox SDK version bumps before the spike runs, re-pin and note.
- Assumes the anc100 list is representative of the wall-clock surface the live sandbox needs to handle for
  non-`brew_only` inputs. Out-of-distribution inputs (rare languages, unusual install paths, very large binaries) are
  not covered by anc100 alone.
- Treats KD2 (artifact fidelity) as a secondary motivation only — the spike does not measure score divergence between
  brew bottles and non-brew artifacts for anc100 entries. If a downstream shape decision wants to lean on fidelity as a
  justification, a separate measurement is required first.

## Outstanding questions

### Deferred to planning

- Update the code comment in `src/worker/score/sandbox-exec.ts:115` from `R7` to `R2` so the comment matches the current
  doc numbering. Code-side change, handled outside this requirements doc.
- Whether the spike also runs a v5 vs v6 cross-check on the current production image (build a v5-brew image alongside
  the v6-brew image, run both against arms 2 and 3) to harden the "v6 made the perf objection obsolete" claim. Adds
  work; may not change the action.
- How the spike reports image-size deltas if the eventual A+D / B shapes are still in play after the data lands — image
  size is a separate budget the spike does not directly measure but planning will need.
- How the spike-image is disposed of after the report lands so it cannot drift into a production deploy path (registry
  tag, CI cache, accidental reference from a Workers binding).

## Sources and research

- `.context/research/2026-06-12-homebrew-6-live-scoring-do-image-assessment.md` — the upstream research note on v6 vs
  v5, image budget, tap trust, and Bubblewrap implications.
- `docker/sandbox/Dockerfile` — current live-image structure; 350 MB image budget at line 24; multi-stage
  cloudflare/sandbox + python:3.12-slim-trixie base.
- `docker/score/Dockerfile` — batch-scoring image that already uses brew at build time; not the same image as the live
  sandbox.
- `src/worker/score/resolve-spec.ts` — `resolveBrewFallback` implementation (lines 146-169); the path arm 3 exercises.
- `src/worker/score/sandbox-exec.ts` — `TOTAL_TIMEOUT_MS = 60_000` at line 115; the budget the spike measures against.
- `docs/brainstorms/live-scoring-spike.md` — the original (April 2026) live-scoring spike that proposed brew-in-image
  before the May 2026 image rework reversed the call.
- `docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md` — the plan that absorbed the original spike.
- [Homebrew 6.0.0 release notes](https://brew.sh/2026/06/11/homebrew-6.0.0/)
- [Tap-Trust documentation](https://docs.brew.sh/Tap-Trust)
- [Supply Chain Security documentation](https://docs.brew.sh/Supply-Chain-Security)
