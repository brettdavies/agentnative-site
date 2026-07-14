# syntax=docker/dockerfile:1.7
#
# Spike harness image for the Homebrew 6.0 live-scoring measurement
# spike. Plan: docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md
# Origin: docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md
#
# Extends the live-scoring sandbox image with Linuxbrew 6.0+ so the
# three-arm spike (arm 1 = current production install path, arm 2 = brew
# exec, arm 3 = resolveBrewFallback translation) runs each anc100 entry
# in a fresh ephemeral container against EXACTLY the same install
# tooling the live-scoring DO inherits. Brew is the only delta over the
# sandbox base — cargo-binstall, uv, bun, anc, Go, etc. come in for free
# via the base.
#
# KD1 FIREWALL — DO NOT PUSH THIS IMAGE TO PRODUCTION REGISTRIES.
# The image self-identifies via `LABEL com.agentnative.image-class=spike`,
# which propagates through any `docker tag` operation.
# .github/workflows/spike-image-firewall.yml validates the label on
# every change to docker/spike/** and serves as the gate any
# image-push workflow must consult before pushing to the production
# registry. Image is local-disposable; U7's run-spike.sh --dispose
# removes it after the report writes.

# Stage 1 brings in the live-scoring sandbox runtime. build.sh ensures
# the tag passed in via SANDBOX_TAG exists locally (defaults to
# anc-sandbox:local; rebuilds from docker/sandbox/Dockerfile when
# missing). Using the sandbox image as the base — instead of duplicating
# its install steps — keeps the spike strictly inheriting from the live
# install path; any drift between the live image and the spike's
# arm 1 measurement is impossible by construction.
ARG SANDBOX_TAG=anc-sandbox:local
FROM ${SANDBOX_TAG} AS sandbox-base

FROM ${SANDBOX_TAG} AS final

LABEL com.agentnative.image-class=spike
LABEL com.agentnative.spike-plan="docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md"

# Supply-chain env vars surfaced per-arm by U3's env-snapshot so the
# U6 report can name exactly which trust + sandbox state was active
# for which entry (R9 freshness gate, R10 tap-trust record, R11
# Bubblewrap state). Set early so build-time brew commands (install,
# tap, trust) inherit the same flags the runtime arms do.
#
#   HOMEBREW_NO_AUTO_UPDATE=1
#       suppress the implicit `brew update` on every install. Wall-
#       clock measurement requires deterministic install paths; auto-
#       update adds nondeterministic network latency to every entry.
#
#   HOMEBREW_NO_ANALYTICS=1
#       opt out of Google Analytics on every brew command — eliminates
#       per-invocation telemetry latency and one less host to surface
#       in U5's egress capture.
#
#   HOMEBREW_REQUIRE_TAP_TRUST=FALSE
#       turn off v6's tap-trust enforcement for this MEASUREMENT-ONLY
#       image. v6 added tap-trust as a supply-chain control that
#       gates third-party formula evaluation behind explicit prior
#       trust; in v6.0.1 it is default-on (verified via `brew config`).
#       Tap-trust enforcement adds wall-clock noise to arm 2 + arm 3
#       installs (per-tap trust ceremony + per-formula re-check) and
#       — more importantly — couples the spike's measurements to a
#       prior `brew trust` admin action that has no analog in the
#       production `brew exec` path the spike is measuring against.
#       Disabling here keeps arm 2/3 numbers comparable to arm 1
#       (which has no equivalent gate). The plan's pre-spike
#       placeholder var name `HOMEBREW_NO_TAP_TRUST_CHECK` was
#       confirmed at build time to be a no-op against v6.0.1; the
#       real control var requires the value `FALSE` (or empty) to
#       disable — `0` is treated as truthy and leaves enforcement on.
#       Production adoption of any spike shape (C, A+D, B) needs to
#       re-evaluate tap-trust posture separately; it is a security
#       posture decision orthogonal to the wall-clock data this spike
#       gathers.
#
# HOMEBREW_NO_SANDBOX is intentionally unset — R11 keeps Bubblewrap
# default-enabled. U3's measure-entry.sh sets it per-entry only on
# documented Bubblewrap-interaction failures (R11 fallback path) and
# the per-entry env_snapshot captures which entries fell back.
ENV HOMEBREW_NO_AUTO_UPDATE=1 \
    HOMEBREW_NO_ANALYTICS=1 \
    HOMEBREW_NO_EMOJI=1 \
    HOMEBREW_REQUIRE_TAP_TRUST=FALSE

# Linuxbrew refuses to run as root, so introduce a runner user and
# grant passwordless sudo for the brew install script's internal
# apt-get calls. The /sandbox entrypoint still runs as root (preserves
# the Cloudflare Sandbox SDK's expected init); brew commands wrap in
# `sudo -u runner brew <args>` at measurement time, concentrated in
# U3's measure-entry.sh per KTD7. The wall-clock noise from sudo is
# sub-millisecond against the install + audit measurements (seconds),
# so timing fidelity is preserved.
#
# Explicit uid 1000 so the BuildKit cache mount uid below matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash -u 1000 -G sudo runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && mkdir -p /home/linuxbrew \
    && chown runner:runner /home/linuxbrew

USER runner
WORKDIR /home/runner

# Linuxbrew install via upstream script. NONINTERACTIVE=1 skips the
# script's confirmation prompt; CI=1 forces sudo-less brew-install
# behavior. The brew bottle cache is mounted via BuildKit so cold
# builds populate the cache for warm rebuilds — material when
# iterating on docker/spike/ during the spike run.
ENV NONINTERACTIVE=1 CI=1
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}
RUN brew --version

# Two sudoers tweaks let `sudo -u runner brew <args>` resolve the
# binary AND inherit the spike's supply-chain env vars without a
# per-invocation `env PATH=... HOMEBREW_*=...` wrapper. U3's
# measure-entry.sh hits this seam on every entry; the wrapper-free
# form keeps the measured command string legible in the per-entry
# JSON record (`sudo -u runner brew install ...`) and trims a few
# microseconds per call.
#
# secure_path: brew on the sudoers PATH allowlist.
# env_keep: HOMEBREW_* and CI vars propagate through sudo so the
#   runner sees the same trust + auto-update + analytics state the
#   spike configures at the image level.
#
# /etc/profile.d/brew.sh is the parallel non-sudo fallback for login
# shells (bash -lc, sudo -i).
USER root
RUN printf 'Defaults secure_path="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nDefaults env_keep += "HOMEBREW_NO_AUTO_UPDATE HOMEBREW_NO_ANALYTICS HOMEBREW_NO_EMOJI HOMEBREW_REQUIRE_TAP_TRUST HOMEBREW_NO_SANDBOX HOMEBREW_VERBOSE HOMEBREW_CURL_VERBOSE CI"\n' > /etc/sudoers.d/spike \
    && chmod 0440 /etc/sudoers.d/spike \
    && printf 'export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"\nexport HOMEBREW_NO_AUTO_UPDATE=1\nexport HOMEBREW_NO_ANALYTICS=1\nexport HOMEBREW_NO_EMOJI=1\nexport HOMEBREW_REQUIRE_TAP_TRUST=FALSE\n' > /etc/profile.d/brew.sh \
    && chmod 0644 /etc/profile.d/brew.sh
USER runner

# No explicit `brew trust <tap>` pre-trust step is needed —
# HOMEBREW_REQUIRE_TAP_TRUST=0 set above disables v6's trust gate for
# this spike image. If a future spike variant re-enables tap-trust
# (e.g., to measure trust-on overhead specifically), the canonical
# pre-trust command is `brew trust <tap>` and entries persist to
# `~/.homebrew/trust.json` for the runner user.

USER root
WORKDIR /

ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}

# Inherited from sandbox-base; restated so the spike image's
# `docker inspect` shows the entrypoint without chasing the base
# layer.
EXPOSE 8080
ENTRYPOINT ["/sandbox"]
