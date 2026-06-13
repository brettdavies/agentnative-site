# Homebrew 6.0 live-scoring spike — report

| Field | Value |
| --- | --- |
| Spike report generated | 2026-06-12T22:04:27Z |
| Brew version | Homebrew 6.0.1 |
| Spike image tag | `anc-sandbox-spike:fa84b12` |
| Mode | local (CF Sandbox follow-up deferred per KTD5) |
| Plan | [`docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md`](../../plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md) |
| Brainstorm | [`docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md`](../../brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md) |

## R6 probe verdict

| Field | Value |
| --- | --- |
| Outcome | **succeeded** |
| Formula | `ripgrep` |
| Attempts | 1 |
| Elapsed seconds | 6 |
| Binary path | `brew exec --formulae=ripgrep -- rg` |
| Glue | _(none — direct invocation)_ |

Arm 2 measurement proceeded. Shape C is on the table per the success-criteria bands below.

## Per-entry comparison

Total elapsed (install + audit), one row per registry entry. `—` denotes skipped (not applicable to the arm) or
errored. Deltas are vs arm 1 (today's production path); negative means the alternative is faster.

| Entry | Arm 1 (fallback) | Arm 2 (brew exec) | Arm 3 (fallback') | Arm 4 (brew install) | Δ(2−1) | Δ(4−1) |
| --- | --- | --- | --- | --- | --- | --- |
| act | 0.665s | 5.322s | 0.691s | 4.979s | 4.657s | 4.314s |
| actionlint | — | 6.679s | — | 5.404s | — | — |
| age | 0.742s | 4.828s | 0.705s | 3.586s | 4.086s | 2.844s |
| anc | — | 19.548s | — | 18.291s | — | — |
| ast-grep | 1.135s | 5.546s | 0.935s | 4.064s | 4.411s | 2.929s |
| atuin | — | 5.835s | — | 4.488s | — | — |
| aws-cli | — | 29.622s | — | 28.654s | — | — |
| bandwhich | 0.777s | 5.655s | 0.713s | 3.7s | 4.878s | 2.923s |
| bat | 0.414s | 15.116s | 0.507s | 14.093s | 14.702s | 13.679s |
| biome | — | 6.314s | — | 4.795s | — | — |
| bird | — | 19.868s | — | 19.258s | — | — |
| bottom | — | 5.794s | — | 4.583s | — | — |
| broot | — | 7.801s | — | 6.827s | — | — |
| bun | — | 9.795s | — | 8.433s | — | — |
| cargo-binstall | 0.762s | — | 0.843s | 3.826s | — | 3.064s |
| cmake | — | 16.127s | — | 17.28s | — | — |
| cosign | — | — | — | 5.719s | — | — |
| curl | — | 26.862s | — | 25.875s | — | — |
| dasel | — | — | — | 3.575s | — | — |
| delta | 0.531s | 15.028s | 0.508s | 13.408s | 14.497s | 12.877s |
| deno | — | 14.655s | — | 12.527s | — | — |
| direnv | — | 8.108s | — | 6.824s | — | — |
| docker | — | 5.478s | — | 3.915s | — | — |
| doggo | — | 4.917s | — | 3.526s | — | — |
| dust | 0.584s | 4.874s | 0.662s | 3.615s | 4.29s | 3.031s |
| eza | 0.34s | 14.319s | 0.439s | 13.758s | 13.979s | 13.418s |
| fd | 0.558s | 4.761s | 0.584s | 3.652s | 4.203s | 3.094s |
| ffmpeg | — | — | — | 48.29s | — | — |
| flyctl | — | 5.714s | — | 4.541s | — | — |
| fzf | 0.398s | 5.924s | 0.403s | 4.695s | 5.526s | 4.297s |
| gh | — | 5.577s | — | 4.131s | — | — |
| git | — | 29.878s | — | 28.727s | — | — |
| git-cliff | — | 14.587s | — | 13.351s | — | — |
| gitleaks | — | 5.408s | — | 3.634s | — | — |
| gitui | 0.623s | 13.429s | 0.645s | 12.008s | 12.806s | 11.385s |
| glow | 0.85s | 4.969s | 0.858s | 3.684s | 4.119s | 2.834s |
| goose | — | 5.537s | — | 4.29s | — | — |
| gum | 1.261s | 5.657s | 1.329s | 4.411s | 4.396s | 3.15s |
| helm | — | — | — | 4.282s | — | — |
| hyperfine | 0.383s | 4.75s | 0.522s | 3.49s | 4.367s | 3.107s |
| jj | 1.5s | 6.185s | 1.258s | 4.592s | 4.685s | 3.092s |
| jnv | 0.526s | 4.727s | 0.517s | 3.453s | 4.201s | 2.927s |
| jq | — | 5.099s | — | 3.601s | — | — |
| just | 0.719s | 5.162s | 0.621s | 3.774s | 4.443s | 3.055s |
| kubectl | — | — | — | 4.274s | — | — |
| lazygit | 0.771s | 4.902s | 0.809s | 3.663s | 4.131s | 2.892s |
| llm | — | 40.747s | — | 39.348s | — | — |
| lsd | 0.494s | 5.014s | 0.527s | 3.693s | 4.52s | 3.199s |
| make | — | 4.566s | — | 3.458s | — | — |
| miller | 1.113s | 5.113s | 0.916s | 3.707s | 4.0s | 2.594s |
| miniserve | — | 4.893s | — | 3.635s | — | — |
| mise | — | 16.228s | — | 16.41s | — | — |
| mods | 1.212s | 5.262s | 1.067s | 4.024s | 4.05s | 2.812s |
| navi | 1.289s | 11.185s | 1.309s | 10.05s | 9.896s | 8.761s |
| nushell | — | 71.61s | — | 33.012s | — | — |
| ollama | — | 6.377s | — | 5.153s | — | — |
| opencode | — | — | — | — | — | — |
| pandoc | — | 9.808s | — | 8.427s | — | — |
| pastel | 0.678s | 4.828s | 0.639s | 3.788s | 4.15s | 3.11s |
| pixi | — | 16.493s | — | 15.771s | — | — |
| procs | 0.565s | 4.834s | 0.651s | 3.581s | 4.269s | 3.016s |
| rclone | — | 6.691s | — | 5.555s | — | — |
| ripgrep | 0.43s | 6.073s | 0.395s | 4.822s | 5.643s | 4.392s |
| rsync | — | 13.684s | — | 12.574s | — | — |
| ruff | — | 5.59s | — | 4.308s | — | — |
| scc | 7.195s | 11.842s | 7.404s | 10.409s | 4.647s | 3.214s |
| sd | 0.332s | 4.578s | 0.495s | 3.453s | 4.246s | 3.121s |
| shellcheck | — | 5.656s | — | 4.364s | — | — |
| starship | — | 7.303s | — | 5.858s | — | — |
| supabase | — | 36.125s | — | 34.232s | — | — |
| tealdeer | — | 4.695s | — | 3.502s | — | — |
| terraform | — | — | — | — | — | — |
| tmux | — | — | — | 12.969s | — | — |
| tokei | — | 5.598s | — | 4.604s | — | — |
| trivy | — | 9.133s | — | 8.0s | — | — |
| typst | — | 13.882s | — | 12.673s | — | — |
| uv | — | 7.278s | — | 5.457s | — | — |
| vhs | 0.991s | 54.435s | 1.372s | 53.752s | 53.444s | 52.761s |
| watchexec | — | 5.075s | — | 3.899s | — | — |
| wrangler | — | 39.387s | — | 37.31s | — | — |
| xh | 0.75s | 5.094s | 0.606s | 3.714s | 4.344s | 2.964s |
| xr | — | 22.594s | — | 19.209s | — | — |
| xsv | 0.981s | 5.592s | 0.951s | 4.127s | 4.611s | 3.146s |
| yazi | 1.009s | 5.215s | 0.908s | 4.1s | 4.206s | 3.091s |
| yq | 0.55s | 4.88s | 0.95s | 3.57s | 4.33s | 3.02s |
| zoxide | 0.38s | 4.763s | 0.438s | 3.544s | 4.383s | 3.164s |

## Summary band

Pass rate is the fraction of non-skipped, non-errored entries that completed inside the 60-second DNF threshold.
Median / p75 / p95 / max are over `total_elapsed` for the same set.

| Arm | n | pass rate | median (s) | p75 (s) | p95 (s) | max (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Arm 1 (fallback) | 34 | 94% | 0.719 | 0.991 | 1.500 | 7.195 |
| Arm 2 (brew exec) | 77 | 88% | 5.835 | 13.882 | 39.387 | 71.610 |
| Arm 3 (fallback') | 34 | 39% | 0.691 | 0.935 | 1.372 | 7.404 |
| Arm 4 (brew install) | 84 | 97% | 4.604 | 12.673 | 34.232 | 53.752 |

### Exclusions

- **Arm 1 production-bounce count: 50.** Entries where the resolved `resolveBrewFallback` returned
  `install_unsupported` — production users TODAY get a `pm=brew_only` bounce for the same input. Treat as a
  failure-of-the-current-path signal, not as "out of scope": each one is an anc100 entry that the live sandbox
  cannot score TODAY.
- **Arm 3 R15 no-result count: 50.** `resolveBrewFallback` could not translate these entries to a peer PM
  (no GitHub release, no matching pip / npm / crates package). Per the R15 contract these are recorded with
  `error: r15-no-result` and excluded from arm 3's wall-clock distribution.

## Headroom panel (arm 1)

Distribution of arm 1's `total_elapsed` across non-skipped, non-errored entries, bucketed against the 60-second
budget. The R2 DNF threshold is included as the rightmost bucket.

| Bucket | Count | Bar |
| --- | --- | --- |
| 0-5s | 33 | █████████████████████████████████ |
| 5-10s | 1 | █ |
| 10-30s | 0 |  |
| 30-60s | 0 |  |
| DNF (>60s) | 0 |  |

## Decision matrix verdict

Bands committed pre-spike (per the brainstorm's success criteria):

- arm 2 ≥ 80% AND probe verdict in {`succeeded`, `succeeded-with-shim`} → **shape C is viable**
- arm 2 50–80% AND probe verdict ok → **shape A+D candidate** (pending brew_only second-pass)
- arm 2 < 50% OR probe failed → **status quo or shape B** (planning revisits)

**Verdict:** **shape C is viable** (arm 2 pass rate 88%, probe succeeded).

## Arm 3 competitive-band verdict (R15)

Arm 3 is competitive when its pass rate is within 10 percentage points of arm 2's AND its median wall-clock is within
5 seconds of arm 2's median.

| Arm | pass rate | median (s) |
| --- | --- | --- |
| Arm 2 | 88% | 5.835 |
| Arm 3 | 39% | 0.691 |

**Verdict:** arm 3 is the wall-clock floor arm 2 must beat (delta: 49pp pass rate, 5.144s median).

### R15 failure rate

52 / 86 non-skipped entries failed (60.5%).

## Supply-chain summary

### R9 — Freshness gate

The spike image sets `HOMEBREW_NO_AUTO_UPDATE=1` so `brew update` does not silently fire on every install (which
would have made wall-clock measurement non-deterministic). The freshness gate proper (a configurable acceptance
window for bottle release date) is NOT enforced by the spike — that is a production posture decision orthogonal to
the wall-clock data this spike gathers.

### R10 — Tap-trust state

`HOMEBREW_REQUIRE_TAP_TRUST=FALSE` was set at the image level for measurement parity (arm 1 has no equivalent gate,
so trust-on-arm-2/3 would have biased the comparison). Production adoption of any shape re-evaluates this; the v6
canonical pre-trust command is `brew trust <tap>` and trusted entries persist to `~/.homebrew/trust.json` per user.

### R11 — Bubblewrap state

`HOMEBREW_NO_SANDBOX` was intentionally unset for the spike (R11 default — Bubblewrap enforced by brew during build /
postinstall). Per-entry env snapshots in `arm{1,2,3}-results.json` surface any entry where the fallback to
`HOMEBREW_NO_SANDBOX=1` was applied; if the count is non-zero the report should be revisited before shape adoption.

### R13 — Captured egress hosts

Capture method: `homebrew_curl_verbose`. Captured at: 2026-06-12T22:04:27Z.

**Arm 2 hosts:**
- `ghcr.io`

**Arm 3 hosts:**
- `ghcr.io`

### R14 — Trust model comparison

(Manual paragraph — written during report review.)

The arm 1 install path inherits whatever trust the registered PM enforces (cargo-binstall verifies upstream
release SHA via the lockfile; uv applies its own upload-delay gate; bun resolves through the npm registry's
signature chain). Arm 2 and arm 3 add brew's tap-trust model on top — disabled here for measurement parity, but a
production adoption of shape C / A+D / B re-enables the tap-trust ceremony and inherits brew's per-tap
signature-verification convention. The comparison cuts both ways: brew adds an explicit trust seam that the
current registered PMs do not gate on per-formula, AND the brew chain adds an additional verification surface
(bottle signatures, tap signatures) the current path skips. Shape adoption needs to decide which trust model the
live sandbox stands behind.

## v5-era closure verdict

The original "no brew on the live image" decision was driven by Homebrew-on-Linux v4/v5 performance characteristics
(per-formula JSON metadata fetches, sequential bottle downloads, Ruby cold-start cost, glibc baseline chasing).
v6.0.0 (2026-06-11) closed each of those specific gaps (internal JSON API default, parallelized bottle fetching,
install-steps framework eliminating Ruby evaluation for many formulae, Ubuntu 24.04 / glibc 2.39 baseline that
Trixie's 2.41 over-spec).

**Closure verdict:** viable — shape C (or A+D) moves forward. The v5-era perf objection is no longer load-bearing.

## anc100 vs brew_only caveat

Per R8, this spike's data does NOT answer the `pm=brew_only` tail-coverage question — entries that have no peer PM
(no cargo-binstall, no uv, no GitHub release) are NOT in anc100 and were NOT measured here. The deferred
second-pass spike against the `pm=brew_only` tail is the gate for A+D / B adoption. The current data only tells the
shape-C-vs-status-quo story for the common case.

