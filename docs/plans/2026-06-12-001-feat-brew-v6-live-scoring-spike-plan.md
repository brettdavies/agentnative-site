---
date: 2026-06-12
type: feat
origin: docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md
---

# feat: Homebrew v6 live-scoring three-arm spike

## Summary

Build the measurement harness that produces wall-clock data for three install paths against the full anc100 list —
current production path, `brew exec`, and the `resolveBrewFallback` translation — inside a measurement-only spike image
isolated from production deploy paths. Output lands in `docs/research/2026-06-12-brew-v6-anc100/` as a comparison report
with decision-matrix verdict (status quo / shape C / A+D candidate / shape B candidate).

---

## Problem frame

The brainstorm (`docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md`) demoted artifact fidelity to
secondary motivation and made wall-clock viability of Homebrew 6.0 under the 60s combined install + score budget the
primary driver. This plan implements the spike that gathers that data. No production image change lands until the data
is in hand; the spike harness lives behind a firewall (R11/KD1) so a working brew-equipped image cannot drift into a
production deploy path.

The spike answers the wall-clock question for the common case (anc100); the `pm=brew_only` tail-coverage question is
explicitly deferred and is not addressed by this plan. The decision matrix in the brainstorm's success criteria maps arm
2's entries-inside-60s rate to a shape candidate; the plan's output enables that mapping to fire without re-litigation.

---

## Key technical decisions

- **KTD1. Spike harness lives in new `docker/spike/` directory.** Mirrors the existing `docker/score/` pattern
  (build.sh, Dockerfile, run script, README) so contributors familiar with batch scoring can navigate the spike. Per the
  related learning at `docs/solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md`,
  the spike image is built as a layer on top of `cloudflare/sandbox:0.9.2` + the live sandbox's runtime stage, with brew
  added in a dedicated stage. Spike image is tagged `anc-sandbox-spike-<git-sha>` to make it visually distinct from
  production tags and impossible to confuse with `anc-sandbox`.

- **KTD2. Report tooling is bash + jaq.** Matches existing `docker/score/score-anc100.sh` conventions and avoids
  introducing a Python or Bun dependency for distribution math. `jaq` handles per-arm JSON aggregation; bash awk
  computes p75/p95/median/max; markdown is emitted via heredoc. Tradeoff accepted: the headroom-panel math is uglier in
  bash than in Python, but the surface stays consistent with `docker/score/`.

- **KTD3. R6 probe is a strict gate before any arm 2 wall-clock collection.** The brainstorm's R6 wording is
  unambiguous: probe-fail cancels arm 2 and records C as inviable. The orchestrator implements this as a hard sequencing
  constraint — arm 2's measurement script refuses to run unless `probe-result.json` exists and records `succeeded` or
  `succeeded-with-shim`. Arm 1 and arm 3 are not gated by the probe; they can run while the probe and arm 2 are sorted
  out.

- **KTD4. Per-entry measurement runs in disposable containers.** Each anc100 entry's install + anc audit happens in a
  fresh ephemeral container spawned from the spike image — not in a single long-lived container. Mirrors how the
  live-scoring DO actually invokes scoring (one container per request). Per-entry isolation also keeps
  `HOMEBREW_NO_SANDBOX` fallback decisions per-entry (per R11) and keeps brew exec's cache state from poisoning
  subsequent runs (matches the deferred-question concern about brew exec cache poisoning across DOs).

- **KTD5. Spike runs locally first, CF Sandbox second.** R4 was reframed during doc-review to CF-Sandbox-primary with
  local as a noted fallback. The plan honors the spirit: local runs are the iteration loop for getting the harness
  right; the authoritative wall-clock data comes from CF Sandbox runs. The local-vs-cloud delta is captured as
  observation in the report, not as a primary metric. CF Sandbox runs are gated to U7 (after the harness is stable
  locally).

- **KTD6. v5-vs-v6 cross-check is not included in v1 of the spike.** Origin deferred-to-planning notes this as "adds
  work; may not change the action." Confirmed not in scope — if downstream analysis disputes whether v6 changed the
  wall-clock picture, a separate cross-check runs then.

---

## Output structure

```text
docker/spike/
├── Dockerfile                    # spike image (extends docker/sandbox/Dockerfile + brew)
├── .dockerignore
├── build.sh                      # build wrapper with cache mounts + per-run tagging
├── README.md                     # harness usage + disposal instructions
├── probe.sh                      # R6 single-formula probe (gates arm 2)
├── measure-entry.sh              # common per-entry harness (install + audit + wall-clock)
├── run-arm1.sh                   # current production install path
├── run-arm2.sh                   # brew exec (gated by probe-result.json)
├── run-arm3.sh                   # resolveBrewFallback translation
├── capture-hosts.sh              # network egress capture during arms 2+3
├── report.sh                     # report generator (decision matrix + supply-chain)
└── run-spike.sh                  # top-level orchestrator

docs/research/2026-06-12-brew-v6-anc100/
├── README.md                     # spike artifact index + interpretation guide
├── probe-result.json             # R6 outcome
├── arm1-results.json             # per-entry arm 1 wall-clocks
├── arm2-results.json             # per-entry arm 2 wall-clocks (absent if probe failed)
├── arm2-cancelled.json           # cancellation record (present only if probe failed)
├── arm3-results.json             # per-entry arm 3 wall-clocks + failure rate
├── egress-hosts.json             # captured outbound hosts (R13)
├── env-state.json                # per-arm brew env state (R5)
└── report.md                     # final report consumed by shape-decision discussion
```

---

## Implementation units

### U1. Spike image scaffolding

**Goal:** Produce a buildable `docker/spike/Dockerfile` extending the live sandbox base with Linuxbrew 6.0+ installed,
supply-chain env vars wired (R9 freshness gate flag, R10 tap-trust bypass, R11 Bubblewrap default-enabled), and the
harness scripts copied in.

**Requirements:** R1 (harness builds on both Docker images), R5 (env state recordable), R10 (tap-trust bypass var), R11
(Bubblewrap default), KD1 (measurement-only image firewall).

**Dependencies:** none (greenfield).

**Files:**

- `docker/spike/Dockerfile` (new)
- `docker/spike/.dockerignore` (new)
- `docker/spike/build.sh` (new)
- `docker/spike/README.md` (new)

**Approach:**

- Multi-stage Dockerfile: stage 1 `FROM cloudflare/sandbox:0.9.2@sha256:...` (pinned digest from
  `docker/sandbox/Dockerfile`); stage 2 `FROM python:3.12-slim-trixie@sha256:...` final stage copying sandbox + adding
  brew per `docker/score/Dockerfile:67-74` pattern (non-root user, `/home/linuxbrew/.linuxbrew` prefix).
- Env vars set: `HOMEBREW_NO_AUTO_UPDATE=1`, tap-trust bypass var (planning to resolve exact var name during U1;
  placeholder `HOMEBREW_NO_TAP_TRUST_CHECK` per security-lens residual; confirm against actual v6 behavior at build
  time), no `HOMEBREW_NO_SANDBOX` set (R11 default).
- Image tag: `anc-sandbox-spike:<git-sha>` — distinct from production `anc-sandbox` tag.
- `build.sh` wraps `docker build` with BuildKit cache mounts on `/home/linuxbrew/.cache/Homebrew` and the apt cache
  layer, mirroring `docker/score/Dockerfile:78-86` conventions.
- `README.md` documents: how to build the spike image, how to dispose of it after the report lands (per KD1 firewall),
  explicit warning that the spike image must not be tagged `anc-sandbox` or pushed to production registries.

**Patterns to follow:**

- `docker/score/Dockerfile` (build-time brew install pattern, non-root user, cache mounts)
- `docker/sandbox/Dockerfile` (multi-stage base layering, glibc 2.41 baseline, env-var conventions)
- `docs/solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md` (image-layer override
  pattern, cache-friendly install ordering)

**Test scenarios:**

- Image builds cleanly from a fresh local docker daemon (no prior cache); `docker images` shows
  `anc-sandbox-spike:<sha>` tag.
- `docker run --rm anc-sandbox-spike:<sha> brew --version` returns `Homebrew 6.0.x` or newer.
- `docker run --rm anc-sandbox-spike:<sha> env | grep HOMEBREW` shows the expected env vars set (auto-update disabled,
  tap-trust bypass active, sandbox NOT disabled).
- `docker run --rm anc-sandbox-spike:<sha> brew config` shows the expected prefix, glibc version, internal API mode
  default.
- Build a second time hot — cache hits expected on brew install layer (BuildKit `--mount=type=cache` working).

**Verification:** Image builds in under 5 minutes cold; image carries brew 6.0+ at the expected prefix; env state is
queryable from a one-shot `docker run`.

---

### U2. R6 single-formula compatibility probe

**Goal:** Run a single anc100 entry through `brew exec <formula> -- <binary>` plus `anc audit` to determine whether anc
audit can see the brew-exec'd binary. Record one of three outcomes (`succeeded`, `succeeded-with-shim`, `failed`) plus
glue description when applicable, within a 4-hour time-box. Probe-failure cancels arm 2.

**Requirements:** R6 (probe pre-condition, 4-hour time-box, three outcomes, cancels arm 2 on fail).

**Dependencies:** U1.

**Files:**

- `docker/spike/probe.sh` (new)
- `docs/research/2026-06-12-brew-v6-anc100/probe-result.json` (output, written by probe)

**Approach:**

- `probe.sh` accepts one formula argument (a known anc100 entry — `ripgrep` as the recommended default per being
  widely-bottled and well-known).
- Inside the spike image: run `brew exec <formula> -- <binary> --version` to verify brew exec resolves the formula and
  runs the binary; then run `anc audit` pointed at whatever path the binary surfaces during exec (this is the discovery
  work).
- Three outcomes recorded as JSON:
- `succeeded` — anc audit measured the binary without shim; record the binary path it found.
- `succeeded-with-shim` — anc audit measured the binary after a documented glue step (e.g., reading `brew exec --print`
  to extract the path, then invoking anc audit against it); record the glue verbatim.
- `failed` — anc audit cannot locate or measure the binary within 4 hours; record the attempts tried.
- Time-box enforced via `timeout 14400 probe.sh ...` at the orchestrator level.
- Output `probe-result.json` schema: `{outcome, formula, binary_path, glue, attempts, elapsed_seconds, brew_version,
  probe_started_at, probe_ended_at}`.

**Patterns to follow:**

- Existing `anc audit` invocation patterns in `src/worker/score/sandbox-exec.ts` (how the production sandbox runs anc
  audit today — probe should approximate that invocation as closely as possible).
- Test fixture timeout discipline from `docs/solutions/best-practices/test-fixture-exec-sleep-for-kill-on-timeout.md`
  (kill-on-timeout semantics so the 4-hour budget actually bounds).

**Test scenarios:**

- Probe succeeds-without-shim: ripgrep `brew exec` runs, anc audit measures the binary, outcome JSON recorded with
  `binary_path` set.
- Probe succeeds-with-shim: a tool where `brew exec` runs but anc audit needs a path-discovery shim — record the shim,
  outcome JSON recorded with `glue` populated.
- Probe fails: a synthetic formula where `brew exec` runs but anc audit cannot measure within the time-box — outcome
  JSON records `failed` with attempts logged.
- Time-box fires: probe artificially blocked beyond 4 hours, orchestrator kills cleanly and records `failed` outcome
  with `elapsed_seconds=14400`.
- Probe outcome is JSON-parseable by downstream report generator (U6 reads it).

**Verification:** `probe-result.json` exists at `docs/research/2026-06-12-brew-v6-anc100/probe-result.json`; outcome is
one of the three documented values; if `succeeded-with-shim`, the glue is named in plain text; arm 2 script reads this
file as its entry gate.

---

### U3. Common per-entry measurement harness

**Goal:** Provide a single shell function that takes (anc100-entry-name, install-command, audit-invocation) and returns
(wall-clock-seconds, anc-audit-result-json, env-snapshot, dnf-flag). Reused by arms 1/2/3 wrappers.

**Requirements:** R2 (combined install + score wall-clock, no 60s enforcement, DNF grouping in analysis), R5 (env state
recorded per arm).

**Dependencies:** U1.

**Files:**

- `docker/spike/measure-entry.sh` (new)

**Approach:**

- Function signature: `measure_entry <entry_name> <install_cmd_string> <audit_cmd_string>` (the arm-wrapper scripts
  produce the install + audit command strings; the harness just times them).
- Wall-clock measurement: bash `EPOCHREALTIME` before/after the full `install_cmd && audit_cmd` invocation (or
  equivalent monotonic timing — must capture sub-second precision).
- Each invocation runs in a fresh ephemeral container spawned via `docker run --rm anc-sandbox-spike:<sha> ...` per
  KTD4. The harness passes install + audit commands into the container via `bash -c`.
- Env snapshot: at the start of each entry, capture `env | grep -E '^(HOMEBREW|UV|PIP)_'` plus `brew --version` into the
  per-arm `env-state.json` so the report can show whether NO_SANDBOX fell back per R11.
- DNF flag: if wall-clock > 60s, mark `dnf: true` in the per-entry record; the install/audit still completes (no 60s
  enforcement per R2).
- Output schema per entry: `{entry, arm, install_cmd, install_elapsed, audit_elapsed, total_elapsed, dnf, audit_result,
  env_snapshot, error?}`.

**Test scenarios:**

- A known-fast install (cargo-binstall ripgrep) measured: total_elapsed < 30s, `dnf: false`, audit_result populated.
- A simulated slow install that exceeds 60s: total_elapsed > 60s, `dnf: true`, audit still completes and is captured.
- Install failure (synthetic command returning nonzero): `error` populated, `audit_elapsed` absent, `dnf: false`, entry
  still recorded so the failure rate is computable.
- Env snapshot captures HOMEBREW_NO_SANDBOX when set vs unset (verify R11 visibility).
- Wall-clock has sub-second precision (verify on a known sub-second install — e.g., `which ls`).

**Verification:** `measure-entry.sh` is reusable across three call sites (arms 1/2/3 wrappers); per-entry JSON output is
parseable by jaq.

---

### U4. Arm wrappers (arm 1, arm 2, arm 3)

**Goal:** Wire each arm's specific install-command logic into the U3 measurement harness, with arm 2 gated by U2 probe
result and arm 3 implementing R15 failure handling for `resolveBrewFallback` no-result outcomes.

**Requirements:** R1 (three install paths), R3 (full anc100 list), R15 (arm 3 failure handling), KTD3 (arm 2 strict
gate), KTD4 (per-entry disposable containers).

**Dependencies:** U2 (arm 2 only), U3.

**Files:**

- `docker/spike/run-arm1.sh` (new)
- `docker/spike/run-arm2.sh` (new)
- `docker/spike/run-arm3.sh` (new)

**Approach:**

- **Arm 1:** parses the anc100 registry (location: `registry.yaml` at repo root, per existing batch-scoring
  conventions), iterates each entry, builds the install command per the entry's registered PM (cargo-binstall, uv tool,
  bun add, pip, npm, or GitHub-release fetch), passes to `measure_entry` from U3. Output → `arm1-results.json`.
- **Arm 2:** first reads `docs/research/2026-06-12-brew-v6-anc100/probe-result.json`; if outcome is not `succeeded` or
  `succeeded-with-shim`, refuses to run and writes a one-line cancellation record to `arm2-cancelled.json`. Otherwise,
  for each anc100 entry, builds `brew exec <formula> -- <binary>` install command (with shim applied per probe outcome),
  passes to `measure_entry`. Output → `arm2-results.json`.
- **Arm 3:** for each anc100 entry, reformulates the registered install command as `brew install <pkg>`, invokes
  `resolveBrewFallback` via a thin script wrapper that calls the live worker code
  (`src/worker/score/resolve-spec.ts:resolveBrewFallback()` exposed via a tiny Node/Bun script or via curl against a
  local dev wrangler — whichever is simpler at implementation time). If `resolveBrewFallback` returns no-result, the
  entry is recorded as `{result: "fail", wall_clock: null, reason: "resolveBrewFallback no-result"}` per R15 and the run
  continues. Otherwise the resolved install runs through `measure_entry`. Output → `arm3-results.json`.

**Patterns to follow:**

- `docker/score/score-anc100.sh` (existing per-entry registry iteration and JSON aggregation patterns).
- `src/worker/score/resolve-spec.ts` (the resolveBrewFallback function arm 3 exercises — repo-relative path; do not
  vendor).

**Test scenarios:**

- Arm 1 happy path: 5 representative anc100 entries spanning all PM types (cargo-binstall, uv, bun, pip, github-release)
  each produce a populated result row.
- Arm 1 failure path: an entry whose PM install returns nonzero is recorded with `error` populated (no spike abort).
- Arm 2 gated-off: probe-result.json has `outcome: failed` → arm2-cancelled.json is the only output; no per-entry
  measurement attempted.
- Arm 2 gated-on: probe succeeded → arm 2 runs full anc100, results.json populated.
- Arm 3 happy path: entry where resolveBrewFallback resolves to a non-brew PM → measure_entry runs that install, result
  recorded.
- Arm 3 R15 failure: synthetic entry where resolveBrewFallback returns no-result → entry recorded as fail, run continues
  to next entry, failure rate computable from final JSON.
- Arm 3 doesn't abort on partial failure (per R15).

**Verification:** Three JSON output files exist (arm1, arm3 always; arm2 only when probe passed); each has one row per
anc100 entry; failure-rate metric for arm 3 is computable.

---

### U5. Egress host capture during arms 2 and 3

**Goal:** Capture the complete set of outbound hosts brew contacts during arms 2 and 3 so the captured list can feed
`INSTALL_HOSTS` extension during shape adoption.

**Requirements:** R13 (egress host enumeration during arms 2 + 3).

**Dependencies:** U4.

**Files:**

- `docker/spike/capture-hosts.sh` (new)
- `docs/research/2026-06-12-brew-v6-anc100/egress-hosts.json` (output)

**Approach:**

- Wraps arm 2 + arm 3 container invocations with `HOMEBREW_CURL_VERBOSE=1` (or `HOMEBREW_VERBOSE=1`) and stream-parses
  brew's stderr for `* Connected to <host>` lines, deduplicating into a per-arm host list.
- Alternative if HOMEBREW_VERBOSE doesn't surface enough: side-load `tcpdump -i any -n 'tcp[tcpflags] & tcp-syn != 0'`
  in the container (requires `--cap-add=NET_ADMIN` on the docker run, which is acceptable for the spike-only image but
  must be documented in `docker/spike/README.md`).
- Output JSON shape: `{arm2: ["ghcr.io", "formulae.brew.sh", "..."], arm3: ["..."], capture_method: "homebrew_verbose" |
  "tcpdump"}`.

**Test scenarios:**

- Capture during arm 2 records ghcr.io (bottle CDN) and formulae.brew.sh (metadata).
- Capture during arm 3 records the hosts of whatever PM resolveBrewFallback chose for each entry.
- Capture survives a single-entry network failure (one entry's egress doesn't crash the capture for the rest).
- Output is parseable for U6's report — supply-chain summary lists captured hosts.

**Verification:** `egress-hosts.json` exists with non-empty per-arm host arrays; documented capture method is one of the
two supported.

---

### U6. Report generator

**Goal:** Emit `report.md` that the brainstorm's success criteria can be applied against directly — per-entry comparison
rows, summary band with distribution, headroom panel, decision-matrix verdict, supply-chain summary
(R9/R10/R11/R13/R14), v5-era objection closure verdict.

**Requirements:** R7 (per-entry comparison + distribution + headroom panel), R8 (anc100 vs brew_only question split), R9
(supply-chain freshness gate assessment), R10 (tap-trust bypass record), R11 (Bubblewrap state record), R13 (egress host
list), R14 (trust-model comparison paragraph), R15 (arm 3 failure rate as metric), Success criteria (decision matrix +
arm 3 competitive band + R6 verdict).

**Dependencies:** U2, U4, U5.

**Files:**

- `docker/spike/report.sh` (new)
- `docs/research/2026-06-12-brew-v6-anc100/report.md` (output)
- `docs/research/2026-06-12-brew-v6-anc100/env-state.json` (consumed; produced by U3 invocations)

**Approach:**

- `report.sh` reads all JSON artifacts (probe-result, arm1/2/3-results, egress-hosts, env-state) via jaq, aggregates,
  and emits markdown.
- Sections in the emitted report:

1. **Header** — spike date, brew version, image SHA, environments run (local / CF Sandbox), env-state summary per arm.
2. **Per-entry comparison table** — one row per anc100 entry: name, arm 1 wall-clock + DNF flag, arm 2 wall-clock + DNF
   flag (or "cancelled — R6 failed"), arm 3 wall-clock + DNF flag, delta arm-2-vs-arm-1, delta arm-3-vs-arm-1.
3. **Summary band** — per-arm pass rate (entries inside 60s with DNF grouping), median, p75, p95, max wall-clock.
4. **Headroom panel for arm 1** — distribution histogram (bash text histogram or table), and per-brew-arm "headroom
   consumed" metric (median delta from arm 1).
5. **Arm 3 failure rate** — count and percentage of R15-failure entries (resolveBrewFallback no-result).
6. **Decision-matrix verdict** — applies success-criteria bands: if arm 2 ≥ 80% AND probe verdict in {`succeeded`,
   `succeeded-with-shim`} → "shape C viable"; if 50-80% AND probe verdict OK → "shape A+D candidate, pending brew_only
   second-pass"; if <50% OR probe failed → "status quo or shape B, planning revisits."
7. **Arm 3 competitive-band verdict** — within 10pp pass-rate AND 5s median of arm 2 → flag arm 3 as competitive
   translation path for product re-discussion; otherwise → arm 3 is the wall-clock floor arm 2 needs to beat.
8. **Supply-chain summary** — R9 freshness gate feasibility (assessed during spike), R10 tap-trust state (recorded), R11
   Bubblewrap state (recorded; if any arm fell back to NO_SANDBOX=1, named accepted risks), R13 captured egress hosts
   (full list per arm), R14 trust-model comparison paragraph (one paragraph drafted manually as part of this unit; not
   generated).
9. **v5-era closure verdict** — either "viable" (shape C or A+D candidate moves forward) or "not viable — status quo
   persists with current-data justification." Both outcomes are legitimate per success-criteria reframing.
10. **anc100 vs brew_only caveat** — per R8, explicit note that this spike's data does not answer the `pm=brew_only`
    tail-coverage question; the deferred second-pass spike is the gate for A+D/B adoption.

**Patterns to follow:**

- `docker/score/score-anc100.sh` (jaq aggregation and markdown emit patterns).
- Markdown table conventions in `docs/research/2026-04-28-cloudflare-live-scoring-v2.md` (existing research artifact in
  the same subtree).

**Test scenarios:**

- Synthetic input: all anc100 entries inside 60s on arms 1/2 + probe succeeded → report says "shape C viable" verdict.
- Synthetic input: arm 2 lands in 65% pass rate + probe succeeded → report says "shape A+D candidate."
- Synthetic input: arm 2 at 30% pass rate → report says "status quo or shape B, planning revisits."
- Synthetic input: probe failed → report says arm 2 cancelled, "shape C inviable," and runs the decision matrix
  excluding the C band.
- Synthetic input: arm 3 within 10pp AND 5s of arm 2 → report flags arm 3 as competitive.
- Headroom panel computes correctly when arm 1 distribution has a long tail (e.g., median 5s, p95 45s — headroom panel
  shows arm 1 sits well under budget at median but tail is tight).
- Supply-chain summary lists all hosts captured in U5.

**Verification:** `report.md` reads as a complete artifact a shape-decision discussion can be held against; the verdict
is one of the four committed bands; supply-chain summary names per-arm Bubblewrap state and the captured host list.

---

### U7. Top-level orchestrator + local + CF Sandbox runs

**Goal:** Single entry point that runs the full spike sequence locally for iteration, then in actual CF Sandbox for the
authoritative numbers. Includes the post-run README index and spike-image disposal step (KD1 firewall).

**Requirements:** R4 (CF-Sandbox-primary, local-as-noted-fallback), KD1 (spike-image firewall + disposal), All R-IDs
orchestrated end-to-end.

**Dependencies:** U1, U2, U3, U4, U5, U6.

**Files:**

- `docker/spike/run-spike.sh` (new)
- `docs/research/2026-06-12-brew-v6-anc100/README.md` (new)

**Approach:**

- `run-spike.sh` runs sequence: U1 build → U2 probe → U4 arm 1 + arm 3 in parallel (independent of probe), U4 arm 2 if
  probe passed (sequentially after probe), U5 host capture wraps arms 2 + 3 → U6 report.
- Two run modes:
- `run-spike.sh --local` runs in the current docker daemon; fast iteration; produces a local report tagged
  `report.md.local`.
- `run-spike.sh --cf-sandbox` runs inside an actual ephemeral CF Sandbox container (requires CF Sandbox SDK harness —
  implementation will use the existing `cloudflare/sandbox:0.9.2` invocation pattern from `src/worker/score/do.ts`);
  produces the authoritative `report.md`. Local report is moved to an `appendix` subdirectory if both modes ran.
- After the report is written, `run-spike.sh` prompts (or auto-runs with `--dispose`): `docker image rm
  anc-sandbox-spike:<sha>` and removes any local cache layers for the spike's BuildKit cache mount. This is the KD1
  firewall enforcement step.
- `README.md` in the research subdirectory: artifact index (what each JSON file is), how to re-run the spike, where the
  authoritative report is, explicit "do not deploy this image to production" warning, link back to the brainstorm + this
  plan.

**Test scenarios:**

- `run-spike.sh --local` end-to-end produces all artifact JSONs + `report.md.local`; takes under 2 hours wall-clock on a
  representative dev machine.
- `run-spike.sh --cf-sandbox` invokes against an actual CF Sandbox container and produces the authoritative report; CF
  Sandbox bind/wrangler config wiring is documented in README.
- Both modes run sequentially in one invocation (`run-spike.sh --local --cf-sandbox`) and produce both reports + a
  local-vs-cloud delta observation per KTD5.
- Probe-fail path: orchestrator skips arm 2 cleanly, runs arm 1 + arm 3 + capture + report; report acknowledges arm 2
  cancellation.
- Disposal step: `docker images` after `--dispose` shows no `anc-sandbox-spike:*` tags remaining.

**Verification:** Running `bash docker/spike/run-spike.sh --cf-sandbox --dispose` produces `report.md` in the research
directory AND leaves no spike image in the docker daemon AND leaves the production `anc-sandbox` image untouched.

---

## Scope boundaries

### Deferred to follow-up work

- Updating the code comment in `src/worker/score/sandbox-exec.ts:115` from `R7` to `R2` to match the brainstorm's
  current requirement numbering. Separate code-only PR.
- v5 vs v6 cross-check (origin-deferred). If the spike's data is disputed on the question of whether v6 changed the
  picture vs v5, a separate cross-check spike runs then; not v1.
- The `pm=brew_only` second-pass spike (origin-deferred). This is the gate for A+D/B adoption; runs only after this
  spike's data justifies the effort.

### Outside this plan's scope

- Adopting any shape (A+D, B, C). Shape commitment requires the spike's verdict + downstream review; the plan ends at
  producing the report.
- Bubblewrap-in-CF-Sandbox standalone validation. The spike observes the interaction in passing per origin scope
  boundary; standalone validation is a separate workstream.
- Changing anc100 leaderboard methodology to account for distribution-channel artifact differences. Origin "outside
  identity" boundary preserved.
- Supporting arbitrary user-input `brew install <anything>` beyond the anc100 reformulations arm 3 exercises. The spike
  is a measurement, not a runtime expansion.

---

## Open questions

### Resolved during planning

- Harness location → `docker/spike/` (KTD1, confirmed during synthesis).
- Report tooling → bash + jaq (KTD2, confirmed during synthesis).
- R6 sequencing → strict gate before arm 2 (KTD3, confirmed during synthesis).
- Per-entry container model → fresh ephemeral container per entry (KTD4).
- Local vs CF Sandbox → both supported, CF Sandbox authoritative (KTD5).
- v5 cross-check → not in v1 (KTD6).

### Deferred to implementation

- **Exact v6 env var name for tap-trust bypass** — placeholder `HOMEBREW_NO_TAP_TRUST_CHECK` per security-lens residual;
  implementer confirms against actual v6 behavior at U1 build time. If no such var exists, fallback is pre-trusting taps
  via `brew tap-trust <each-tap>` during image build.
- **Egress capture method** — `HOMEBREW_VERBOSE` parse vs `tcpdump` side-load. Implementer picks based on what surfaces
  enough hosts during a dry run; documented in U5.
- **Whether resolveBrewFallback is best exercised via wrangler dev or via a thin Node/Bun script that imports the
  function** — implementer picks based on harness simplicity. Either approximates production semantics for arm 3.
- **CF Sandbox harness wiring** — exact invocation pattern (Worker binding, ephemeral container lifecycle) discovered
  during U7 implementation; documented in `docker/spike/README.md`.
- **Whether the headroom panel renders as bash text histogram or as a sorted table** — U6 implementer picks based on
  what reads cleanest in the markdown report.

### Deferred to follow-up work

- Image-size deltas reporting — only material when planning A+D/B adoption; not measured by this spike (origin
  deferred-to-planning).
- Spike-image disposal automation beyond U7's `--dispose` flag — registry-tag policy, CI cache invalidation, accidental
  Workers binding references. Tracked in origin deferred-to-planning.

---

## System-wide impact

- **No production code touched.** `src/worker/score/resolve-spec.ts` and `src/worker/score/sandbox-exec.ts` are READ by
  arm 3 (resolveBrewFallback is invoked, not modified); no edits.
- **No production Docker image touched.** `docker/sandbox/Dockerfile` and `docker/score/Dockerfile` are read-only
  references for the spike image's base layer.
- **New surface: `docker/spike/` directory and `docs/research/2026-06-12-brew-v6-anc100/` directory.** Both are
  measurement artifacts; neither is referenced by production deploys.
- **Image registry impact: temporary `anc-sandbox-spike:<git-sha>` tags exist locally during the spike run; U7 disposal
  removes them.** Per KD1 firewall, these tags MUST NOT be pushed to any production registry.
- **Spike runtime impact (CF Sandbox):** running arm 2 and arm 3 against the full anc100 inside actual CF Sandbox
  containers consumes CF Workers + Containers quota. Estimated bound: 100 entries × 3 arms × ~30s median = ~150 minutes
  of container time per `--cf-sandbox` invocation; one or two invocations are sufficient. Budget impact is documented in
  U7's README.

---

## Risks and dependencies

- **R6 probe fails.** Arm 2 collection is cancelled by design (per R6); shape C is recorded as inviable. The spike still
  produces actionable data on arms 1 and 3; no remediation needed beyond what R6 already commits.
- **Bubblewrap in CF Sandbox fails (R11 fallback fires for some arms).** Per R11, the affected arm runs with
  `HOMEBREW_NO_SANDBOX=1` and the report records it as a named accepted risk. The spike continues; the security delta is
  surfaced in U6's report rather than blocking.
- **v6.0.0 has an undisclosed regression.** Surfaced as adversarial residual risk in doc-review round 1; not
  specifically mitigated by this plan. If wall-clock looks anomalous, U7's local-vs-cloud delta and a v5 cross-check
  (deferred) are escape valves.
- **anc100 list location not pinned in brainstorm.** Plan assumes `registry.yaml` at repo root per existing
  batch-scoring conventions (`docker/score/install-tools.sh` reads it). Implementer confirms at U4.
- **CF Sandbox SDK version bumps before spike runs.** Origin assumption already records this risk; plan inherits it. U7
  documents the pinned digest used.
- **Implementation dependency: `jaq` installed locally and in the spike image.** Check current `Dockerfile` apt-installs
  (likely present per `docker/sandbox/Dockerfile`); if not, add to U1.

---

## Sources and research

- Origin: `docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md`.
- `.context/research/2026-06-12-homebrew-6-live-scoring-do-image-assessment.md` — v6 vs v5 delta, image budget,
  tap-trust mechanics.
- `docs/solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md` — docker image-layer
  override pattern; informed KTD1 + U1.
- `docs/solutions/best-practices/test-fixture-exec-sleep-for-kill-on-timeout.md` — informed U2 time-box discipline.
- `docs/solutions/tooling-decisions/cloudflare-sandbox-python-3.12-base-2026-05-19.md` — base image decision context
  (Python 3.12 baseline that arms 1/2/3 inherit).
- `docker/sandbox/Dockerfile` — base image structure arms inherit from.
- `docker/score/Dockerfile` + `docker/score/install-tools.sh` + `docker/score/score-anc100.sh` — patterns for spike
  harness (build script conventions, per-entry registry iteration, jaq + markdown report emit).
- `src/worker/score/resolve-spec.ts` — `resolveBrewFallback` (lines 146-169) which arm 3 exercises.
- `src/worker/score/sandbox-exec.ts` — `TOTAL_TIMEOUT_MS` and existing PM dispatch patterns.
- [Homebrew 6.0.0 release notes](https://brew.sh/2026/06/11/homebrew-6.0.0/)
- [Tap-Trust documentation](https://docs.brew.sh/Tap-Trust)
