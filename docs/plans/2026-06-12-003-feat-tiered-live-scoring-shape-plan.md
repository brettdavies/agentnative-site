---
title: 'feat: Tiered live-scoring shape — brew install fallback after resolveBrewFallback bounce'
date: 2026-06-12
type: feat
depth: deep
related:
  - docs/research/2026-06-12-brew-v6-anc100/report.md
  - docs/solutions/tooling-decisions/brew-install-vs-exec-ephemeral-container-scoring.md
  - docs/solutions/developer-experience/brew-v6-cli-scripting-gotchas.md
  - docs/solutions/design-patterns/discovery-fallback-pattern-for-hostile-pms-2026-05-18.md
  - docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md
---

# feat: Tiered live-scoring shape — brew install fallback after resolveBrewFallback bounce

## Summary

Turns today's `resolveBrewFallback` + bounce shape into a tier-1 + tier-2 hybrid. Tier 1 stays as the existing fast path
(sub-second median, ~40% anc100 coverage). Tier 2 adds literal `brew install <pkg>` in a brew-equipped sandbox image,
dispatched when tier 1 returns `install_unsupported pm=brew_only`. Coverage lifts from 34/86 brew-pinned anc100 entries
to 84/86 (98%) at 4.6s median, 0 DNF — measured directly in the v6 spike (PR #187).

The plan ships behind a `wrangler secret put`-gated feature flag with a staging soak before the production flip and a
batch re-score of the 50 newly-coverable anc100 entries after the flip lands.

---

## Problem Frame

The live-scoring sandbox at anc.dev currently serves a `brew install <pkg>` user input by translating it via
`resolveBrewFallback`, which fetches `formulae.brew.sh` metadata, parses the GitHub homepage, and runs `discoverBinary`
to find an alternative PM (cargo-binstall, uv, direct, etc.). When discovery returns a non-brew spec, the install
proceeds via that PM — fast (~0.7s median), works for 34/86 brew-pinned anc100 entries.

When `resolveBrewFallback` returns `install_unsupported pm=brew_only`, the user gets bounced. Today this happens for 50
of 86 brew-pinned anc100 entries (~58%). Users typing `brew install <commonly-used-tool>` see a bounce — not because
brew is fundamentally incompatible with the sandbox, but because the alternative-PM discovery missed.

The brew v6 measurement spike showed a literal `brew install <pkg>` in a brew-equipped sandbox image covers those 50
entries in 4.6s median, 34s p95, 53s max, 0 DNF — well under the production 60s budget. Brew exec was rejected by the
spike data (covers fewer entries at slower median, see
[`docs/solutions/tooling-decisions/brew-install-vs-exec-ephemeral-container-scoring.md`](../solutions/tooling-decisions/brew-install-vs-exec-ephemeral-container-scoring.md)).
The plan adopts brew install as the tier-2 fallback layer behind today's tier 1.

---

## High-Level Technical Design

**Dispatch flow:**

```text
User input: "brew install <pkg>"
        ↓
[Worker handler] → metered gates → cache check → resolveSpec()
        ↓
        ↓ pm === 'brew'
        ↓
resolveBrewFallback()
        ↓
        ├─ ok: true  → tier-1 spec (cargo-binstall / uv / direct / etc.)
        │              → DO dispatch → install + audit → response  [~0.7s median]
        │
        └─ ok: false, error='install_unsupported', details='pm=brew_only'
                 ↓
        [feature flag: LIVE_BREW_TIER2_ENABLED]
                 ↓
                 ├─ off (default)  → today's bounce: install_unsupported pm=brew_only
                 │
                 └─ on             → synthesize BrewInstallSpec(package=<pkg>, binary=<pkg>)
                                       → DO dispatch → install + audit → response  [~4.6s median]
                                       → on install failure: bounce with brew_install_failed
```

**Tier 1 stays untouched.** Tier 2 attaches *after* the existing `pm=brew_only` bounce code path. The feature flag gate
sits between `resolveBrewFallback`'s bounce and the new tier-2 synthesis so production stays at today's behavior until
the flag flips.

**Two image variants are NOT needed.** Per scoping decision, the existing `anc-sandbox` image gains a Linuxbrew layer;
budget revises from ≤350 MB to ≤1 GB compressed (CF Containers `basic` is 2 GB, headroom exists). Both tier 1 and tier 2
dispatch into the same image; tier 2 just adds a new `case 'brew-install':` arm to the install table.

**Egress allow-list table extension.** The existing `INSTALL_HOSTS` table in `src/worker/score/sandbox-exec.ts` gains a
`'brew-install'` entry covering the bottle CDN hosts the spike's R13 egress capture observed (`ghcr.io` + any
third-party tap hosts). Two-phase egress (`allowedInstall` → `noHttp`) stays as-is.

**Bubblewrap stays default-on unless the probe (U1) says otherwise.** Production `brew install` runs in Bubblewrap by
default in v6; if the probe finds Bubblewrap cannot run inside `cloudflare/sandbox:0.9.x`, the image sets
`HOMEBREW_NO_SANDBOX=1` with the accepted-risk note in the Dockerfile comment (matches R11's documented fallback).

---

## Key Technical Decisions

### KTD1. Brew install, not brew exec

Spike arm 4 (brew install) beats arm 2 (brew exec) on coverage (84/86 vs 77/86), median (4.6s vs 5.8s), p95 (34s vs
39s), max (53s/0 DNF vs 71s/1 DNF), and pass rate under 60s (97% vs 88%). Brew exec's one-shot framing pays the same
bottle-download cost as brew install plus per-invocation resolution overhead. For ephemeral containers (one container
per scoring request), the persistent-install of brew install isn't a drawback.

### KTD2. Image budget revised to ≤1 GB compressed

Current Dockerfile comment pins ≤350 MB compressed. Adding Linuxbrew adds ~500 MB (prefix tree + bundled Ruby + bottle
metadata). CF Containers `basic` is 2 GB compressed; revising the ceiling to ≤1 GB leaves ~50% headroom while
accommodating brew. The plan adds a CI guard (U3) — today's budget is documentation-only with no CI enforcement.

### KTD3. `HOMEBREW_REQUIRE_TAP_TRUST=""` (empty string), NOT `=FALSE`

Per
[`docs/solutions/developer-experience/brew-v6-cli-scripting-gotchas.md`](../solutions/developer-experience/brew-v6-cli-scripting-gotchas.md),
v6's tap-trust enforcement treats ANY non-empty string as truthy — including the literal `FALSE`. The spike image used
`=FALSE` and `brew config` reported "set"; behavior was actually disabled because v6's enforcement code path treats
`FALSE` as off. Production should use empty string OR unset entirely to remove any cosmetic disagreement. `ENV
HOMEBREW_REQUIRE_TAP_TRUST=""` in the Dockerfile is the explicit form.

Production accepts the supply-chain trade-off: ALL third-party tap formulae install without prompt. `terraform`
(hashicorp/tap), `opencode` (anomalyco/tap), and any future third-party-tap registry entry work natively. The decision
rests on the existing trust the live sandbox already places in brew's bottle signing (homebrew/core) and the user-input
gating upstream of the install.

### KTD4. No brew analog to per-PM freshness gates — accept the gap

Today's PMs have freshness gates (`UV_EXCLUDE_NEWER="7 days"`, `PIP_UPLOADED_PRIOR_TO=<computed-at-exec>`, supply-chain
release-delay window). Brew has no native equivalent. Wiring a custom gate (e.g., parsing bottle build dates from
formula JSON and refusing fresh bottles) is non-trivial and adds image complexity for marginal benefit given the
homebrew/core trust posture. The plan documents the gap explicitly in the U2 Dockerfile comment and the U10
documentation refresh.

If a freshness gate becomes load-bearing later (e.g., post a security incident), the implementation seam is the per-pm
install command in `installCommandFor` — wrap the brew install with a Ruby/jaq one-liner that asserts the bottle's
`bottle.stable.tag.sha256` is older than N days. Out of scope here.

### KTD5. Feature flag is a `wrangler secret put`, not a `vars` entry

Per
[`docs/solutions/conventions/wrangler-kill-switches-must-be-secrets-not-vars.md`](../solutions/conventions/wrangler-kill-switches-must-be-secrets-not-vars.md),
secret-shaped flags propagate in 5-10s across warm isolates; var-shaped flags trigger CF API code 10053 on `wrangler
secret put`. The new `LIVE_BREW_TIER2_ENABLED` secret follows the same contract as `MCP_LIVE_SCORING_ENABLED`. Worker
code defaults to off (`env.LIVE_BREW_TIER2_ENABLED !== 'true'`).

### KTD6. New `'brew-install'` PM tag on `ParsedInstall.pm` union

The existing `'brew'` tag means "user typed brew install, route through fallback" (the tier-1 input shape). Tier 2 needs
a distinct tag so the install table can distinguish "fallback failed, escalate to literal brew install" from the legacy
"always bounce" path. Adding `'brew-install'` to the union cascades through `installCommandFor` exhaustiveness,
`installHostsFor`, `mapDoError`, `PmTag` (telemetry), and the share-url derivation — all caught by TypeScript on the
first compile.

### KTD7. Subshell-wrap the brew install command

Per
[`docs/solutions/integration-issues/cf-sandbox-sdk-persistent-shell-set-e-kills-session-2026-05-18.md`](../solutions/integration-issues/cf-sandbox-sdk-persistent-shell-set-e-kills-session-2026-05-18.md),
any multi-command `set -e` pipeline in `sandbox.exec()` must be wrapped in `( ... )` to prevent killing the persistent
shell on failure. The tier-2 install command is `brew install <pkg>` followed by the post-install `which <binary>` gate.
Wrap as `( set -e; brew install --quiet ${pkg}; )` so install failure bounces this request but doesn't poison the DO
instance.

### KTD8. Image bake stays single-image, single-pin contract

Per
[`docs/solutions/tooling-decisions/cf-containers-docker-hub-to-managed-registry-migration-2026-05-14.md`](../solutions/tooling-decisions/cf-containers-docker-hub-to-managed-registry-migration-2026-05-14.md),
the existing `anc-sandbox:<git-sha>` pin contract in `wrangler.jsonc` (staging leads prod, soak-and-promote) carries the
brew layer change forward. No new image, no new wrangler binding. The image-size CI guard (U3) protects the revised
ceiling.

### KTD9. PATH order — brew bin AFTER /usr/local/bin

Per
[`docs/solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md`](../solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md),
Linuxbrew at `/home/linuxbrew/.linuxbrew/bin` claims precedence ahead of `/usr/local/bin` by default. The sandbox
image's existing entries (anc, cargo-binstall, uv, bun) live in `/usr/local/bin`. Brew bin appends AFTER
`/usr/local/bin` so registry-baked entries win over brew-resolved alternatives when names collide.

---

## Scope Boundaries

### In scope

- Linuxbrew layer added to `docker/sandbox/Dockerfile` with the env-var posture defined in KTD3-KTD4-KTD9.
- New `BrewInstallSpec` (or `ParsedInstall` with `pm: 'brew-install'`) in `src/worker/score/discover-binary.ts` and
  downstream union exhaustiveness fixes.
- Routing layer in `src/worker/score/resolve-spec.ts` that synthesizes the tier-2 spec on `pm=brew_only` bounce when the
  feature flag is on.
- Per-PM install command + INSTALL_HOSTS entry in `src/worker/score/sandbox-exec.ts`.
- Telemetry append: `PmTag` union and tier-dispatch counters in `src/worker/score/telemetry.ts`.
- Feature flag (`LIVE_BREW_TIER2_ENABLED`) wired as a secret per KTD5.
- Bubblewrap-in-CF-Sandbox probe (U1) gating the rest.
- Image-size CI guard (U3) enforcing the revised ≤1 GB ceiling.
- Staging soak (env flag on staging) + batch re-score of the 50 newly-coverable anc100 entries against staging before
  production flip.
- Production rollout (image pin alignment + secret flip).
- Documentation refresh for the three affected solutions docs.

### Deferred to follow-up work

- A brew freshness gate (KTD4): defer until a security incident makes it load-bearing. Implementation seam noted in
  KTD4.
- Per-tap allowlist policy: scoping decision was to disable tap-trust entirely; if the trade-off needs to be reversed
  later, a separate plan re-introduces per-tap trust.
- A separate `pm=brew_install_failed` UX surface in the homepage form: tier 2's install failures bounce with the same
  shape as today's `chain_resolved_install_failed`; differentiating in the UI is a small follow-up.

### Out of scope

- **Brew exec.** Rejected by the spike data. Not measured further in this plan.
- **`pm=brew_only` tail-coverage spike.** Separate spike against the brew-only formulae the anc100 doesn't cover.
- **Image registry / bake automation changes.** Existing `wrangler containers build` flow carries the change.
- **Cache invalidation policy review.** The 50 batch re-scores write fresh cache entries; existing cache TTL stays
  as-is.

---

## Requirements & Success Criteria

| ID  | Requirement                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | When `LIVE_BREW_TIER2_ENABLED !== 'true'`, the system MUST behave exactly as today: `pm=brew_only` bounces remain bounces.                                                                                                              |
| R2  | When the flag is on AND `resolveBrewFallback` returns `install_unsupported pm=brew_only`, the system MUST synthesize a `BrewInstallSpec` and dispatch to the DO via the same `getRandom(env.SCORE)` path as tier 1.                     |
| R3  | The tier-2 install command MUST be `( set -e; brew install --quiet ${pkg}; )` per KTD7.                                                                                                                                                 |
| R4  | The sandbox image MUST set `ENV HOMEBREW_REQUIRE_TAP_TRUST=""` (empty string) per KTD3.                                                                                                                                                 |
| R5  | The sandbox image MUST size ≤1 GB compressed; a CI guard (U3) verifies this on every PR touching `docker/sandbox/Dockerfile`.                                                                                                           |
| R6  | Tier-2 dispatch MUST emit a telemetry row with `pm: 'brew-install'` and the existing AE blob shape (slot order preserved).                                                                                                              |
| R7  | The Bubblewrap-in-CF-Sandbox probe (U1) MUST complete before the Dockerfile lands; if Bubblewrap cannot run in `cloudflare/sandbox:0.9.x`, the image carries `ENV HOMEBREW_NO_SANDBOX=1` with an accepted-risk comment.                 |
| R8  | Production rollout MUST stage on staging first: image pin lands on staging, soak verifies tier-2 dispatch end-to-end against the 50 batch re-score targets, then production pin + secret flip.                                          |
| R9  | The 50 newly-coverable anc100 entries MUST be re-scored against staging (with the flag on) and against production (post-flip), with scorecards written to the cache layer.                                                              |
| R10 | The 3 affected solutions docs MUST be refreshed after production rollout: discovery-fallback-pattern (tier 1/tier 2 framing), multi-pm-install-destination (brew row), brew-install-vs-exec-ephemeral-container (production-validated). |

**Success criteria (post-rollout):**

- Live-scoring coverage of the anc100 brew-pinned set rises from 34/86 to 84/86 (98%) within one week of production
  flip.
- p95 wall-clock for tier-2 dispatches stays ≤45s (spike measured 34.2s; production budget is 60s).
- Tier-2 install failure rate stays <5% over a rolling 24-hour window (spike measured 2.3%, 2/86).
- No tier-1 regression: tier-1 dispatch median stays at today's ~0.7s; pass rate stays ≥94%.

---

## Implementation Units

### U1. Bubblewrap-in-CF-Sandbox compatibility probe

**Goal:** Determine whether `brew install` can run with Bubblewrap default-on inside `cloudflare/sandbox:0.9.x`, or
whether the image must carry `HOMEBREW_NO_SANDBOX=1`. This unit is a hard gate — U2 cannot land without its decision.

**Requirements:** R7.

**Dependencies:** None.

**Files:**

- `docker/spike/probe-bubblewrap.sh` (new — smoke probe script)
- `.github/workflows/spike-image-firewall.yml` (modify — add a `bubblewrap-probe` job)

**Approach:**

- Reuse the spike harness pattern. The probe builds a temporary `anc-sandbox-spike-bwrap:<sha>` image with Linuxbrew + a
  single brew install attempt (e.g., `brew install ripgrep`) and runs it inside an actual `cloudflare/sandbox:0.9.x`
  container via the SDK (NOT via plain docker run — Bubblewrap's behavior under CF's nested-namespace stack is what's
  under test, and plain docker run doesn't replicate that stack).
- Two outcomes:
- **Bubblewrap works:** record `bubblewrap-ok` and proceed; U2 keeps `HOMEBREW_NO_SANDBOX` unset.
- **Bubblewrap fails** (CAP_SYS_ADMIN denied, seccomp filters bite, nested user namespaces refused, etc.): record
  `bubblewrap-needs-fallback` with the specific error, and U2 sets `ENV HOMEBREW_NO_SANDBOX=1` with the accepted-risk
  comment.
- Outcome lands in `docs/research/2026-06-12-brew-v6-anc100/bubblewrap-probe-result.json` for U2 to read.

**Patterns to follow:**

- `docker/spike/probe.sh` (R6 probe shape — JSON-out, time-boxed, idempotent rerun)
- `.github/workflows/spike-image-firewall.yml` (CI job for spike-class images)

**Test scenarios:**

- Happy path: probe runs `brew install ripgrep` inside CF Sandbox, exits 0, writes `bubblewrap-probe-result.json` with
  `{outcome: "bubblewrap-ok", evidence: <brew config | head 20>}`.
- Failure path: probe runs in a deliberately misconfigured container (e.g., container with `--security-opt
  no-new-privileges`) and records `bubblewrap-needs-fallback` with the specific error.
- Idempotency: re-running the probe with a probe-result.json present skips and re-uses the cached outcome unless
  `--regenerate` is passed.

**Verification:** `bubblewrap-probe-result.json` exists at the documented path; outcome field is one of `bubblewrap-ok`
or `bubblewrap-needs-fallback`; U2's Dockerfile decision references this outcome.

---

### U2. Linuxbrew layer in sandbox Dockerfile

**Goal:** Add Linuxbrew to `docker/sandbox/Dockerfile` with the env-var posture defined by KTD3, KTD4, KTD9, and U1's
outcome.

**Requirements:** R3, R4, R5 (image-size guard is U3), R7.

**Dependencies:** U1.

**Files:**

- `docker/sandbox/Dockerfile` (modify — add Linuxbrew layer)
- `docker/sandbox/README.md` (modify — document new budget, new env vars, new bottle-hosts in egress section)

**Approach:**

- Mirror the per-asset SHA-pin pattern (`docker/sandbox/Dockerfile` lines 65-121): `curl -fsSL ... -o /tmp/x.tgz; echo
  '<sha256> /tmp/x.tgz' | sha256sum -c -; ...; <binary> --version`.
- Linuxbrew install: use the upstream installer script. Pin the installer commit SHA in the Dockerfile.
- Set runner user for brew (Linuxbrew refuses root): create `linuxbrew` user, install under their home, then symlink
  `/home/linuxbrew/.linuxbrew/bin/brew` to `/usr/local/sbin/brew` so it's reachable from the default execution user.
- ENV vars:
- `ENV HOMEBREW_REQUIRE_TAP_TRUST=""` (KTD3 — empty string, NOT `FALSE`)
- `ENV HOMEBREW_NO_ANALYTICS=1` (no telemetry from brew itself)
- `ENV HOMEBREW_NO_AUTO_UPDATE=1` (deterministic builds; user-time refresh is opt-in)
- `ENV HOMEBREW_NO_INSTALL_CLEANUP=1` (skip post-install cleanup, marginal speed win)
- Conditional from U1: if `bubblewrap-needs-fallback`, add `ENV HOMEBREW_NO_SANDBOX=1` with the accepted-risk comment.
- PATH: extend AFTER `/usr/local/bin` per KTD9.

```dockerfile
# Existing line:
ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:${PATH}"
# Becomes:
ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:/home/linuxbrew/.linuxbrew/bin:${PATH}"
```

- Dockerfile comment block updates:
- Header line 23 "Image budget: <=350 MB compressed" updates to `Image budget: <=1 GB compressed`.
- Document the supply-chain gap (KTD4): "brew has no analog to UV_EXCLUDE_NEWER / PIP_UPLOADED_PRIOR_TO; accepted gap
  per plan KTD4."

**Patterns to follow:**

- `docker/sandbox/Dockerfile` lines 27-167 (multi-stage, SHA-pinned, ENV-driven destinations)
- `docker/score/Dockerfile` lines 72-87 (Linuxbrew install pattern — though that image is a different shape, the brew
  install steps mirror)

**Test scenarios:**

- Build smoke (existing): `docker build` succeeds end-to-end against the modified Dockerfile.
- Brew probe: `docker run --rm anc-sandbox:<git-sha> brew --version` returns `Homebrew 6.0.x`.
- Env-var probe: `docker run --rm anc-sandbox:<git-sha> env | grep HOMEBREW_REQUIRE_TAP_TRUST` returns empty (the var IS
  set, value IS empty).
- PATH ordering probe: `docker run --rm anc-sandbox:<git-sha> sh -c 'command -v rg && echo OK'` returns
  `/usr/local/bin/rg` (registry-baked path wins over any brew-resolved rg).
- Trust probe: `docker run --rm anc-sandbox:<git-sha> brew tap hashicorp/tap; brew install terraform` succeeds without a
  trust prompt.
- Image-size probe (U3 enforces, but the Dockerfile change should anticipate): `docker image inspect
  anc-sandbox:<git-sha> --format '{{.Size}}'` ≤ 1 GB.

**Verification:** Build is green; smoke probes all pass; README documents the new budget and env vars; image-size CI
guard (U3) passes.

---

### U3. Image-size CI guard

**Goal:** Enforce the revised ≤1 GB compressed budget in CI. Today the budget is documentation-only.

**Requirements:** R5.

**Dependencies:** None (parallel with U2).

**Files:**

- `.github/workflows/ci.yml` (modify — add `Image size check` job)

**Approach:**

- New job in `ci.yml` parallel to the existing `Verify pinned sandbox image exists in CF registry`:
- On any PR touching `docker/sandbox/**` or `wrangler.jsonc` containers section.
- Steps: `docker build -f docker/sandbox/Dockerfile docker/sandbox/`, then `docker image inspect <built-tag> --format
  '{{.Size}}'`, then assert ≤ 1 GB (1073741824 bytes).
- Failure mode: fail the check with the actual size and the budget delta. Operator sees `Image size 1.2 GB exceeds
  budget 1.0 GB by 200 MB`.
- Document the budget in the job's name so it shows in the CI UI: `Image size <=1 GB compressed`.

**Patterns to follow:**

- `.github/workflows/ci.yml` lines 96-175 (image-pin existence check job shape).

**Test scenarios:**

- Pass case: a PR that does not change image size passes the check.
- Fail case: a PR adding a 500 MB blob to the image fails the check with the actual-vs-budget delta.
- Idempotency: re-running the check on the same commit returns the same outcome.

**Verification:** CI surface shows the new check; PR builds run it on relevant path changes; failure mode is clear.

---

### U4. Worker routing — tier-2 dispatch after resolveBrewFallback bounce

**Goal:** Add the tier-2 synthesis seam in `resolveSpec()`. On `pm=brew_only` bounce AND `LIVE_BREW_TIER2_ENABLED ===
'true'`, synthesize a `BrewInstallSpec` and return `{ok: true, spec}` instead of bouncing.

**Requirements:** R1, R2, R6 (new PmTag — actual telemetry append is U6).

**Dependencies:** U7 (feature-flag wiring lands first OR U4 reads `env` directly; pick one).

**Files:**

- `src/worker/score/discover-binary.ts` (modify — add `'brew-install'` to the InstallSpec union (see Approach for the
  spec-vs-PM-tag choice), and append `'4-brew-install-fallback'` to the `ResolvedStep` literal-union type)
- `src/worker/score/resolve-spec.ts` (modify — extend `resolveSpec` to read the flag + synthesize on tier-1 bounce)
- `src/worker/score/resolve-spec.ts` may also export a small `synthesizeBrewInstallSpec(pkg)` helper.
- `tests/score-resolve-spec.test.ts` (modify — add tier-2 dispatch test scenarios)

**Approach:**

- New PM tag: extend `ParsedInstall.pm` union to include `'brew-install'`. TypeScript exhaustiveness checks in
  `installCommandFor`, `installHostsFor`, `mapDoError`, and `PmTag` will surface compile errors at every union site; fix
  each as a discrete edit.
- `resolveSpec`: when `input.kind === 'install-command'` AND `input.spec.pm === 'brew'`, call `resolveBrewFallback`. If
  `result.ok`, return as today. If `!result.ok && result.error === 'install_unsupported'` AND
  `env.LIVE_BREW_TIER2_ENABLED === 'true'`:
- Synthesize `{pm: 'brew-install', package: input.spec.package, binary: input.spec.package}` (binary defaults to
  package; if the spike's manual override file showed a different binary, that mapping carries forward into U4's logic).
- Return `{ok: true, spec, resolved_step: '4-brew-install-fallback'}`.
- The `resolved_step` field gets a new enum value to distinguish tier-2 dispatches in telemetry (matches the existing
  pattern of `'2-releases-asset'`, `'3-brew'`, etc.).

**Execution note:** Test-first. Write the resolve-spec tier-2 dispatch test before extending the union. The test asserts
that on `pm=brew_only` bounce + flag on, the result is `{ok: true, spec: {pm: 'brew-install', ...}}`; on flag off, the
result is the original bounce.

**Patterns to follow:**

- `src/worker/score/resolve-spec.ts` lines 76-129 (existing `resolveSpec` switch on `input.spec.pm`)
- `tests/score-do-brew-fallback.test.ts` (fetcher-injection pattern, ScoreSuccess/ScoreFailure assertion shape)

**Test scenarios:**

- Tier-1 hit (today's behavior): `pm=brew, package=ripgrep` → `resolveBrewFallback` returns ok → return as today; no
  tier-2 path entered.
- Tier-2 dispatch (flag on): `pm=brew, package=<entry-resolveBrewFallback-bounces>` AND `env.LIVE_BREW_TIER2_ENABLED ===
  'true'` → result is `{ok: true, spec: {pm: 'brew-install', package: <entry>, binary: <entry>}}`.
- Flag off: `pm=brew, package=<bounce-entry>` AND `env.LIVE_BREW_TIER2_ENABLED !== 'true'` → result is `{ok: false,
  error: 'install_unsupported', details: 'pm=brew_only'}` (today's behavior).
- Edge: `pm=brew, package=undefined` (malformed input) → bounce as today, tier 2 doesn't trigger.
- Edge: `pm=brew, package=<entry>` AND `resolveBrewFallback` throws (network error to formulae.brew.sh) → bounce per
  existing error handling, tier 2 doesn't trigger.

**Verification:** Tests pass; exhaustiveness checks pass; no tier-1 regression in `tests/score-resolve-spec.test.ts`
baseline.

---

### U5. DO install dispatch — brew install spec

**Goal:** Add the `case 'brew-install':` arm to `installCommandFor` plus the matching `INSTALL_HOSTS` entry, and a smoke
test against a known-good brew-pinned anc100 entry.

**Requirements:** R3, R6 (new PmTag).

**Dependencies:** U2 (image must carry brew), U4 (spec type exists).

**Files:**

- `src/worker/score/sandbox-exec.ts` (modify — add `case 'brew-install':` arm to `installCommandFor`; add
  `INSTALL_HOSTS['brew-install']` entry)
- `tests/score-do.test.ts` (modify — add per-PM coverage for `'brew-install'`)

**Approach:**

- `installCommandFor` case:

```typescript
case 'brew-install':
  // Subshell-wrap per KTD7 to prevent set -e from killing the persistent shell.
  // --quiet suppresses brew's progress chatter on stderr; it does NOT suppress
  // the wrapped command's output (that's the brew exec --quiet pitfall, not
  // brew install's).
  return `( set -e; brew install --quiet ${shellQuote(spec.package)}; )`;
```

- `INSTALL_HOSTS` entry: derived from the spike's R13 egress capture
  (`docs/research/2026-06-12-brew-v6-anc100/egress-hosts.json`). At minimum: `ghcr.io` (bottle CDN), `formulae.brew.sh`
  (formula metadata), `github.com` + `codeload.github.com` (any direct release URL embedded in formula). Third-party tap
  hosts get added as needed (when the U6 batch re-score surfaces new hosts, append).

- The post-install `which <binary>` gate already works as-is for any new PM; brew install's binary lands in
  `/home/linuxbrew/.linuxbrew/bin/<binary>` which is on PATH per U2 KTD9.

**Patterns to follow:**

- `src/worker/score/sandbox-exec.ts` `installCommandFor`'s `case 'pip':` arm (env-var prefix + shell-quoted package,
  similar shape)
- `src/worker/score/sandbox-exec.ts` lines 143-161 (`INSTALL_HOSTS` table)
- `tests/score-do.test.ts` (50.9 KB, exhaustive per-PM coverage; the test shape for new PM additions is well-established
  there)

**Test scenarios:**

- Install command shape: `installCommandFor({pm: 'brew-install', package: 'ripgrep', binary: 'rg'})` returns `( set -e;
  brew install --quiet 'ripgrep'; )`.
- Shell-quote correctness: package name with shell metacharacters (`brew install --quiet 'foo;bar'`) — assert quoting
  holds.
- `INSTALL_HOSTS` lookup: `installHostsFor({pm: 'brew-install', ...})` returns the bottle CDN hosts.
- Subshell wrap: assert command starts with `( set -e;` and ends with `; )` (regression guard for KTD7 / the
  persistent-shell issue).
- End-to-end DO test (mocked container): brew-install spec → install → which gate → audit; result is `ScoreSuccess` with
  `install_ms` + `anc_audit_ms` populated.

**Verification:** Tests pass; exhaustiveness checks pass; the existing two-phase egress flow accepts the new
INSTALL_HOSTS entry without regression.

---

### U6. Telemetry — tier-2 counters

**Goal:** Append tier-2 dispatch counters to the existing AE blob. No schema reordering.

**Requirements:** R6.

**Dependencies:** U4 (spec type exists).

**Files:**

- `src/worker/score/telemetry.ts` (modify — extend `PmTag` union; add tier-2 accumulator slots)
- `src/worker/score/handler.ts` (modify — write the tier-2 counters in the response path)
- `tests/score-telemetry.test.ts` (modify — assert the new PmTag value; assert slot order unchanged)

**Approach:**

- Extend `PmTag` union: add `'brew-install'` as a new allowed value (append, no reorder).
- Extend `Telemetry` accumulator: add `tier_2_attempted: boolean`, `tier_2_ok: boolean`, `tier_2_failure_reason: string
  | undefined`. These are doubles/blobs that append to existing slots (the schema-pinning test in
  `tests/score-telemetry.test.ts` will catch any reorder).
- Handler writes the counters in the same try/finally as today's `recordScoreEvent`.
- Cloudflare Analytics Engine dataset stays the same (`SCORE_TELEMETRY` binding). No new bindings, no migration.

**Patterns to follow:**

- `src/worker/score/telemetry.ts` `PmTag` union + the append-only slot contract documented in the module header
- `tests/score-telemetry.test.ts` (regression test for slot order)

**Test scenarios:**

- Append-only: `PmTag` union now includes `'brew-install'` AND the existing values are unchanged.
- Slot order: `tests/score-telemetry.test.ts` baseline still passes; new slots are appended.
- Tier-2 attempt counter increments: a request whose tier-1 bounces + tier-2 dispatches writes `tier_2_attempted: true`,
  `tier_2_ok: true` on install success.
- Tier-2 failure counter increments: a request whose tier-1 bounces + tier-2 install fails writes `tier_2_attempted:
  true`, `tier_2_ok: false`, `tier_2_failure_reason: <error>`.

**Verification:** Tests pass; AE schema regression test stays green; the existing dashboard queries continue to work
(slot order preserved).

---

### U7. Feature flag — `LIVE_BREW_TIER2_ENABLED` as secret

**Goal:** Wire the secret-shaped feature flag per KTD5.

**Requirements:** R1.

**Dependencies:** None (can land first or in parallel with U4-U6).

**Files:**

- `wrangler.jsonc` (NO change — secrets aren't declared here; they're set via `wrangler secret put`)
- `src/worker/score/resolve-spec.ts` (already modified in U4 to read `env.LIVE_BREW_TIER2_ENABLED`)
- `docs/runbooks/live-scoring-feature-flags.md` (new or modify — document the new secret and its rollout)
- `tests/score-resolve-spec.test.ts` (already covered in U4 — flag off vs flag on scenarios)

**Approach:**

- Set the secret on staging (`bun x wrangler secret put LIVE_BREW_TIER2_ENABLED --env staging`, value `"true"`) AS PART
  of U8 deploy, not as code change.
- Set the secret on production AS PART of U9 deploy, after staging soak passes.
- Worker code defaults to off (`env.LIVE_BREW_TIER2_ENABLED !== 'true'`); no env declaration needed in `wrangler.jsonc`
  because the absence-as-default pattern works.
- Runbook documents the rollback contract: `bun x wrangler secret put LIVE_BREW_TIER2_ENABLED --env production`, value
  `"false"` — propagates in 5-10s across warm isolates.

**Patterns to follow:**

- `docs/solutions/conventions/wrangler-kill-switches-must-be-secrets-not-vars.md` (the secret pattern; runbook shape)
- Existing `MCP_LIVE_SCORING_ENABLED` secret as a template

**Test scenarios:**

- Default off: `env.LIVE_BREW_TIER2_ENABLED` undefined → tier 2 doesn't dispatch (R1).
- Explicit off: `env.LIVE_BREW_TIER2_ENABLED === 'false'` → tier 2 doesn't dispatch.
- Explicit on: `env.LIVE_BREW_TIER2_ENABLED === 'true'` → tier 2 dispatches.

**Verification:** Worker code defaults off; runbook documents the secret and rollback; CI dry-run doesn't break.

---

### U8. Staging soak + batch re-score 50 newly-coverable entries

**Goal:** Land the new image pin on staging, flip the secret on, batch-re-score the 50 anc100 entries that bounce today,
verify wall-clock and failure-rate stay within budget.

**Requirements:** R8, R9.

**Dependencies:** U1, U2, U3, U4, U5, U6, U7.

**Files:**

- `wrangler.jsonc` (modify — `env.staging.containers[0].image` pinned to new image SHA)
- `scripts/batch-rescore-50.sh` (new — driver that hits `/api/score?fromCache=false` for the 50 entries against staging)
- `docs/research/2026-06-12-brew-v6-anc100/tier2-staging-soak.md` (new — observation log)

**Approach:**

- Image pin: `bun x wrangler containers build -p -t "anc-sandbox:$GIT_SHA" docker/sandbox/`, update
  `env.staging.containers[0].image`, `bun x wrangler deploy --env staging`.
- Secret flip: `bun x wrangler secret put LIVE_BREW_TIER2_ENABLED --env staging`, value `"true"`.
- Batch driver: shell script that reads the 50 entry names from a comma-list (the spike's `arm1-results.json` filtered
  to `error: r15-no-result`), and for each, POSTs `https://agentnative-site-staging.brettdavies.workers.dev/api/score`
  with `{install_command: "brew install <pkg>"}` and the staging Turnstile test secret.
- Observation log: per-entry record of wall-clock, scorecard URL, success/failure, install error tail.
- Soak duration: 24 hours minimum. Look for tier-2 dispatch rate, p95 wall-clock, failure rate.

**Patterns to follow:**

- `scripts/release/mcp-smoke.sh` (driver shape against staging URL with bypass auth)
- `docs/research/2026-06-12-brew-v6-anc100/report.md` (data observation format)

**Test scenarios:**

- Image build succeeds; image-size CI guard passes (U3).
- Staging deploy succeeds; new image pin in `wrangler.jsonc env.staging`.
- Batch driver hits all 50 entries; each gets either a scorecard or a structured bounce.
- Per-entry wall-clock distribution matches spike's measurement within ±20% (sanity check: production CF Sandbox isn't
  dramatically different from spike's local docker).
- Failure rate <5% (success criterion); failures categorized (network, install, audit).

**Verification:** Soak log committed to `docs/research/2026-06-12-brew-v6-anc100/tier2-staging-soak.md`; coverage delta
documented; no tier-1 regression observed.

---

### U9. Production rollout

**Goal:** Move the new image pin and the secret to production after staging soak passes.

**Requirements:** R8, R9.

**Dependencies:** U8 (soak must pass).

**Files:**

- `wrangler.jsonc` (modify — top-level `containers[0].image` pinned to the same SHA as staging)
- `docs/research/2026-06-12-brew-v6-anc100/tier2-production-rollout.md` (new — production observation log)

**Approach:**

- Confirm staging soak's success criteria (R8, R9; success criteria in plan summary).
- Open a `release/<date>-tier2` PR per the repo convention. Image pin alignment is the only top-level change; the dev →
  main PR template tracks the soak evidence.
- Secret flip: `bun x wrangler secret put LIVE_BREW_TIER2_ENABLED --env production`, value `"true"` (after merge, NOT
  before — merge ships the routing change behind the OFF default; secret flip turns the feature on).
- Re-run the batch-driver against production (same 50 entries) post-flip to populate the production cache layer with
  fresh scorecards.
- Open the observation log on production. Watch tier_2_failure_rate; <5% rolling 24h is the success threshold per plan
  summary.

**Patterns to follow:**

- `RELEASES.md § Sandbox image releases` (soak-and-promote contract)
- `docs/runbooks/live-scoring-feature-flags.md` (rollback contract from U7)

**Test scenarios:**

- Image pin alignment: production pin matches the soaked staging pin SHA.
- CI green: main-targeting PR passes (lint, build, test, wrangler dry-run, image-size guard from U3).
- Production secret flip propagates within 30s (existing pattern; per the conventions doc).
- Production batch re-score: 50 entries scored, scorecards written to cache, no tier-1 regression.

**Verification:** Production observation log shows tier-2 dispatch active; coverage delta (production) documented; no
rollback triggered within the first 7 days.

---

### U10. Documentation refresh

**Goal:** Update the three solutions docs affected by tier-2 going live.

**Requirements:** R10.

**Dependencies:** U9 (refresh after production validation).

**Files:**

- `docs/solutions/design-patterns/discovery-fallback-pattern-for-hostile-pms-2026-05-18.md` (modify — extend the v6
  caveat with the tier-1/tier-2 framing now that it's production-validated)
- `docs/solutions/best-practices/multi-pm-install-destination-consistency-2026-05-18.md` (modify — add a brew row to the
  per-PM table per KTD9)
- `docs/solutions/tooling-decisions/brew-install-vs-exec-ephemeral-container-scoring.md` (modify — add a footnote that
  the recommendation went production)

**Approach:**

- `discovery-fallback-pattern`: replace the 2026-06-12 caveat with a longer section naming the tier-1 → tier-2 dispatch
  model. Reference U9's observation log.
- `multi-pm-install-destination`: add a brew row to the per-PM table showing the env-var posture
  (`HOMEBREW_REQUIRE_TAP_TRUST=""`, `HOMEBREW_NO_AUTO_UPDATE=1`, `HOMEBREW_NO_ANALYTICS=1`,
  `HOMEBREW_NO_INSTALL_CLEANUP=1`) and the destination semantics (`/home/linuxbrew/.linuxbrew/bin`, on PATH per KTD9).
  Update the "prefer env vars over per-command flags" framing to note brew's value-shape semantic exception.
- `brew-install-vs-exec`: add a "Production-validated" footnote at the end noting the tier-2 deploy lands per U9.

**Test scenarios:**

- Markdownlint clean on all three.
- `python3 scripts/validate-frontmatter.py` clean on all three.
- Cross-references resolve.

**Verification:** All three docs refreshed; markdownlint + frontmatter validation clean; commit to solutions-docs repo
per the symlink contract.

---

## Open Questions (deferred to implementation)

- **Bubblewrap probe result.** Whether `HOMEBREW_NO_SANDBOX=1` lands in the Dockerfile depends on U1's outcome. The plan
  accommodates both branches.
- **Third-party tap host enumeration.** U5's INSTALL_HOSTS entry includes a baseline (`ghcr.io`, `formulae.brew.sh`,
  `github.com`, `codeload.github.com`). The U8 staging soak will surface any additional hosts third-party taps reach;
  append to INSTALL_HOSTS if any appear.
- **Brew install failure UX surface.** Tier 2's install failures bounce with `chain_resolved_install_failed`.
  Differentiating in the UI to show "brew couldn't install `<pkg>`" rather than the generic install-failed copy is a
  follow-up; deferred per Scope Boundaries.
- **Telemetry alerting threshold.** The plan documents the metric (tier_2_failure_rate >10% over 1 hour) but the
  alerting surface is Cloudflare Analytics Engine dashboards, NOT PagerDuty (no PagerDuty integration in repo). A
  dashboard query for the metric lands during U6 implementation.
- **Cold-pull observation.** Production `getRandom` pool of `MAX_INSTANCES=3` plus a larger image means the first
  request per instance pays a longer cold-pull. U8 soak captures the cold-vs-warm distribution; production rollout (U9)
  watches for this pattern. If cold-pulls add >5s to median, consider larger `min_instances` (currently absent in
  `wrangler.jsonc`).

---

## System-Wide Impact

- **Live-scoring path:** new tier-2 dispatch after `resolveBrewFallback` bounce. Tier-1 path unchanged.
- **Sandbox image:** brew layer added, image size grows ~3× (~250 MB → ~750 MB compressed); CI guard prevents accidental
  growth past 1 GB.
- **`InstallSpec` type:** `'brew-install'` added to `ParsedInstall.pm` union. TypeScript catches every downstream union
  site.
- **Telemetry:** `PmTag` extended; AE blob slot order unchanged.
- **Cache layer:** the 50 newly-coverable entries write fresh scorecards to R2 cache. Existing cache TTL applies. No
  invalidation needed for entries that were bouncing (they had no cache entry to invalidate).
- **Secret surface:** new `LIVE_BREW_TIER2_ENABLED` joins existing `MCP_*` flags. Operator runbook updates.
- **Egress allow-list:** `INSTALL_HOSTS['brew-install']` adds bottle CDN hosts. Two-phase egress contract unchanged.

---

## Risks & Dependencies

| Risk                                                                        | Mitigation                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bubblewrap incompatibility with CF Sandbox (CAP_SYS_ADMIN, seccomp)         | U1 probe gates U2; `HOMEBREW_NO_SANDBOX=1` fallback documented per R7                                                                                                                                                        |
| Image size grows past 1 GB                                                  | U3 CI guard fails the PR with the actual-vs-budget delta                                                                                                                                                                     |
| Cold-pull time inflates p95 past 60s budget                                 | Production observation in U9; remediation is `min_instances` bump if needed                                                                                                                                                  |
| Brew bottle host IP reputation differs from spike (intercept-on production) | U8 staging soak observes egress; failure-mode is a retry budget tweak, not a routing change                                                                                                                                  |
| Stale derivations (cache key, share URL) for tier-2 specs                   | Per [`docs/solutions/architecture-patterns/stale-derivations-across-tier-migrations.md`](../solutions/architecture-patterns/stale-derivations-across-tier-migrations.md), U4 audit runs the migration checklist before merge |
| Production tap-trust posture (off) audited as too permissive                | Documented as KTD3 trade-off; reversible via a separate plan that adds per-tap allowlist; no in-flight rollback path                                                                                                         |
| Secret flip propagation lag (>30s observed)                                 | Per the conventions doc, secret-shape is 5-10s typical; if a flip lags, the rollback path is the same `wrangler secret put` to `false`                                                                                       |
| AE schema regression from telemetry slot reorder                            | `tests/score-telemetry.test.ts` regression test pins the order; appended slots only                                                                                                                                          |

---

## Sources & Research

- `docs/research/2026-06-12-brew-v6-anc100/report.md` — spike data (86 brew-pinned entries × 4 install paths)
- `docs/research/2026-06-12-brew-v6-anc100/arm1-results.json` — tier-1 baseline (resolveBrewFallback today)
- `docs/research/2026-06-12-brew-v6-anc100/arm4-results.json` — tier-2 candidate (literal brew install)
- `docs/research/2026-06-12-brew-v6-anc100/egress-hosts.json` — bottle CDN host list for INSTALL_HOSTS
- `docs/solutions/tooling-decisions/brew-install-vs-exec-ephemeral-container-scoring.md` — the install vs exec
  measurement
- `docs/solutions/developer-experience/brew-v6-cli-scripting-gotchas.md` — `HOMEBREW_REQUIRE_TAP_TRUST` semantics; `brew
  exec --quiet` gotcha
- `docs/solutions/design-patterns/discovery-fallback-pattern-for-hostile-pms-2026-05-18.md` — tier-1 pattern with v6
  caveat
- `docs/solutions/tooling-decisions/docker-anc-binary-override-and-runtime-refresh-2026-05-24.md` — PATH ordering trap
  (KTD9)
- `docs/solutions/conventions/wrangler-kill-switches-must-be-secrets-not-vars.md` — feature flag pattern (KTD5)
- `docs/solutions/integration-issues/cf-sandbox-sdk-persistent-shell-set-e-kills-session-2026-05-18.md` — subshell wrap
  (KTD7)
- `docs/solutions/tooling-decisions/cf-containers-docker-hub-to-managed-registry-migration-2026-05-14.md` — image pin
  contract (KTD8)
- `docs/solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md` — gate
  ordering for tier-2 dispatch
- `docs/solutions/architecture-patterns/stale-derivations-across-tier-migrations.md` — migration audit checklist
- `docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md` — spike's R9, R11, R13 (supply-chain,
  Bubblewrap, host capture)
