# Homebrew 6.0 live-scoring spike harness

Measurement-only image and harness for the three-arm spike that decides whether the live-scoring DO image should carry
Linuxbrew now that Homebrew 6.0 shipped. The spike measures wall-clock viability of three install paths against the full
anc100 list and produces a comparison report that the brainstorm's decision matrix is applied against.

Plan:
[`docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md`](../../docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md)

Origin:
[`docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md`](../../docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md)

## KD1 firewall — read this first

**This image must never reach a production registry.** The spike harness exists to measure brew install behavior in
disposable containers; the report it produces decides whether brew lands on the live-scoring image at all. Pushing a
spike image into the production registry would invert that decision-making.

Two layers of enforcement:

1. **The label.** The Dockerfile sets `LABEL com.agentnative.image-class=spike`, and Docker propagates labels through
   `docker tag`. Re-tagging the spike as `anc-sandbox:something` does **not** strip the label.
2. **The CI gate.** [`.github/workflows/spike-image-firewall.yml`](../../.github/workflows/spike-image-firewall.yml)
   validates the label on every change to `docker/spike/**` and fails closed on missing labels. Any image-push workflow
   that targets the production registry MUST consult this workflow's check before pushing — the firewall workflow is the
   single source of truth for the gate.

The third layer is the convention: after the spike report writes, dispose of the local image immediately (`docker image
rm anc-sandbox-spike:<sha>`). U7's `run-spike.sh --dispose` automates this.

## Layout

```text
docker/spike/
├── Dockerfile              # spike image (this directory)
├── .dockerignore
├── build.sh                # build wrapper (this script)
├── README.md               # this file
├── probe.sh                # U2: R6 single-formula compatibility probe
├── measure-entry.sh        # U3: common per-entry measurement harness
├── run-arm1.sh             # U4: current production install path
├── run-arm2.sh             # U4: brew exec (gated by probe-result.json)
├── run-arm3.sh             # U4: resolveBrewFallback translation
├── capture-hosts.sh        # U5: network egress capture (arms 2 + 3)
├── report.sh               # U6: decision-matrix + supply-chain report
└── run-spike.sh            # U7: top-level orchestrator (local mode)
```

Only the U1 deliverables (`Dockerfile`, `.dockerignore`, `build.sh`, this `README.md`) ship in the first commit. The
remaining scripts land as U2-U7 complete.

## Prerequisites

- **Docker Engine + BuildKit.** Same engine the batch-scoring image depends on; see
  [`docker/score/README.md`](../score/README.md#prerequisites-host) for the one-time Ubuntu setup script. Docker Desktop
  is not supported.
- **The sandbox base image (`anc-sandbox:local` by default).** The spike extends the live-scoring sandbox runtime so arm
  1's "current production install path" measurement reflects the exact tooling the live DO inherits. `build.sh`
  bootstraps the sandbox image from [`docker/sandbox/Dockerfile`](../sandbox/Dockerfile) if it's not present locally.

## Build

From the repo root:

```sh
bash docker/spike/build.sh
```

The script:

1. Resolves the short git SHA of HEAD and uses it as the spike tag suffix (`anc-sandbox-spike:<git-sha>`).
2. Verifies the sandbox base image (`$SANDBOX_TAG`, default `anc-sandbox:local`) exists locally; rebuilds it from
   `docker/sandbox/Dockerfile` if missing.
3. Builds the spike image with BuildKit cache mounts on the Linuxbrew bottle cache.
4. Asserts the `com.agentnative.image-class=spike` label landed (KD1 firewall pre-check).
5. Prints disposal instructions.

To build against a specific sandbox tag (e.g., a pinned per-PR sandbox build):

```sh
SANDBOX_TAG=anc-sandbox:abc1234 bash docker/spike/build.sh
```

To print the resulting tag on stdout for piping into a subsequent `docker run`:

```sh
SPIKE_TAG="$(bash docker/spike/build.sh --print-tag)"
docker run --rm --entrypoint /bin/bash "$SPIKE_TAG" -c 'brew --version'
```

## `docker run` and the `/sandbox` ENTRYPOINT

The spike image inherits the live-scoring sandbox's `ENTRYPOINT ["/sandbox"]`, which starts the Cloudflare Sandbox SDK
server and never returns control to `docker run`'s positional command. For local one-shot invocations (the verification
checks below, U2's probe, U3's measurement harness, U7's orchestrator), override the entrypoint:

```sh
docker run --rm --entrypoint /bin/bash anc-sandbox-spike:<sha> -c '<command>'
```

The deferred CF Sandbox follow-up (KTD5) is the path that calls the spike image via the SDK; local mode does not.

## Verify

The U1 verification gate. Replace `<sha>` with the actual short git SHA.

Linuxbrew refuses to run as root, so wrap brew invocations in `sudo -u runner` per KTD7 — the same seam U3's
`measure-entry.sh` uses for arm 2 + 3 measurements.

```sh
# brew is present at the expected v6 prefix.
docker run --rm --entrypoint /bin/bash anc-sandbox-spike:<sha> -c 'sudo -u runner brew --version'
# expect: Homebrew 6.x.x

# Supply-chain env vars surface in `env`.
docker run --rm --entrypoint /bin/bash anc-sandbox-spike:<sha> -c 'env | grep ^HOMEBREW | sort'
# expect: HOMEBREW_NO_ANALYTICS=1
#         HOMEBREW_NO_AUTO_UPDATE=1
#         HOMEBREW_NO_EMOJI=1
#         HOMEBREW_REQUIRE_TAP_TRUST=FALSE
# NOT expected: HOMEBREW_NO_SANDBOX — Bubblewrap default-enabled per R11.

# Tap-trust enforcement is off for this measurement-only image so arm 2
# and arm 3 numbers stay comparable to arm 1 (which has no equivalent
# gate). Production adoption of any spike shape re-evaluates trust
# posture separately. Tap an untrusted third-party tap and confirm it
# succeeds without a trust prompt — that's the functional verification.
docker run --rm --entrypoint /bin/bash anc-sandbox-spike:<sha> -c 'sudo -u runner brew tap oven-sh/bun 2>&1' | tail -5
# expect: ==> Tapping oven-sh/bun
#         Cloning into '/home/linuxbrew/.linuxbrew/Homebrew/Library/Taps/oven-sh/homebrew-bun'...
#         Tapped 166 formulae (... KB).
# NOT expected: any "trust" or "untrusted tap" prompt — that would
# indicate HOMEBREW_REQUIRE_TAP_TRUST is still being enforced.
#
# Cosmetic note: `brew config` reports `HOMEBREW_REQUIRE_TAP_TRUST: set`
# whenever the env var has any non-empty value (including `FALSE`); the
# enforcement code treats `FALSE` and empty as "off" regardless of
# what `brew config` displays. The above tap test is the actual gate.

# Label is set and propagates through retag.
docker inspect --format '{{ index .Config.Labels "com.agentnative.image-class" }}' anc-sandbox-spike:<sha>
# expect: spike

docker tag anc-sandbox-spike:<sha> anc-sandbox-fake-prod:test
docker inspect --format '{{ index .Config.Labels "com.agentnative.image-class" }}' anc-sandbox-fake-prod:test
# expect: spike — confirms retag cannot strip the label.
docker image rm anc-sandbox-fake-prod:test
```

The cold-build wall-clock budget is 5 minutes (per the plan's U1 verification line); warm rebuilds reuse the cache mount
on `/home/runner/.cache/Homebrew` and complete in seconds.

## Dispose

After the spike report writes, dispose of the local image so it cannot be accidentally pushed or referenced by a stale
docker compose:

```sh
docker image rm anc-sandbox-spike:<sha>
```

U7's `run-spike.sh --dispose` automates this. Disposal is best-effort — the label + CI gate is the load-bearing
firewall, not the cleanup.

## What the spike measures

Three arms run in fresh ephemeral containers per anc100 entry:

- **Arm 1:** current production install path (registry-pinned PM via `sandbox-exec.ts` semantics).
- **Arm 2:** `brew exec <formula> -- <binary>` (gated by the R6 probe; cancelled cleanly if the probe fails).
- **Arm 3:** reformulating each entry as `brew install <pkg>` and letting `resolveBrewFallback()` resolve it. R15
  failure semantics apply for no-result entries.

The report applies the decision matrix bands committed pre-spike:

- arm 2 ≥ 80% AND probe verdict green/glued → shape C is viable.
- arm 2 50-80% AND probe verdict green/glued → shape A+D candidate.
- arm 2 < 50% OR probe failed → status quo or shape B (planning revisits).

Arm 3 competitive band: within 10pp pass-rate and 5s median of arm 2.

The spike answers the wall-clock question for the common case (anc100). The `pm=brew_only` tail-coverage question is
deferred to a follow-up spike per the brainstorm's R8.
